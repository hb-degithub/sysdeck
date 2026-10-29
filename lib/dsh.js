'use strict';

/**
 * DSH（DeepSeek Harness）集成
 *
 * 提供四块能力，全部零第三方依赖：
 *  1. 状态探测：dsh 可执行文件 / DSH_HOME 是否存在、web 服务是否可达、进程信息
 *  2. 控制台 URL：从 journalctl 读取最新一次性 token，并按访问方 host 改写 origin
 *  3. 会话列表：扫描 $DSH_HOME/sessions/*\/session-*\/session.v4.jsonl.zstd，只解压首行元数据
 *  4. headless 任务：spawn `dsh --profile headless --json`，单并发 + 超时 kill + SSE 事件环形缓冲
 *
 * 安全约束：
 *  - 所有外部命令一律 spawn/execFile 数组传参，绝不拼接 shell 字符串
 *  - 读取 journalctl 有硬超时与输出字节上限
 *  - 解压会话文件有输出上限，超限直接跳过
 *  - 任务只在 config.dsh.allowTask === true 时可启动，且同时只允许一个
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOME_DIR = os.homedir();
const DEFAULT_HOME = process.env.DSH_HOME || path.join(HOME_DIR, '.local', 'share', 'deepseek-harness', 'data');
const DEFAULT_WEB_PORT = 3080;
const DEFAULT_UNIT = 'deepseek-harness';
const DEFAULT_HOME_DIR = HOME_DIR;
const REPO_ROOT = path.resolve(__dirname, '..');
// 示例补丁路径（不默认加载；用户可在 config.dsh.patch 显式指定）
const DEFAULT_PATCH = path.join(REPO_ROOT, 'config', 'dsh-headless.patch.example.yml');

/** 在 PATH 中查找可执行文件（开源通用：不写死本机绝对路径） */
function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch (e) {
      /* continue */
    }
  }
  return '';
}

/**
 * dsh 可执行文件解析（开源通用）：env DSH_BIN → PATH 中的 dsh →
 * <home>/runtime/... 或 <home 的上一级>/runtime/...（DSH 默认布局），取第一个真实存在的。
 */
function resolveDshBin(home) {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  const onPath = findOnPath('dsh');
  if (onPath) return onPath;
  const base = home || DEFAULT_HOME;
  const candidates = [
    path.join(base, 'runtime', 'node_modules', '.bin', 'dsh'),
    path.join(path.dirname(base), 'runtime', 'node_modules', '.bin', 'dsh'),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      /* continue */
    }
  }
  return candidates[0];
}

const DEFAULT_BIN = resolveDshBin(DEFAULT_HOME);
// 局域网 / 公网地址默认空：由请求 Host 推导（可被 config.dsh.lanHost / publicUrl 覆盖）
const DEFAULT_PUBLIC_URL = '';
const DEFAULT_LAN_HOST = '';

/** 代码内默认值（契约 1.9 + 扩展项），不写入用户 config.json */
const DEFAULTS = Object.freeze({
  enabled: true,
  home: process.env.DSH_HOME || DEFAULT_HOME,
  bin: DEFAULT_BIN,
  profile: 'headless',
  allowTask: false,
  taskTimeoutMs: 300000,
  consoleUrlCustom: '',
  // headless 任务的模型路由补丁：默认空 = 不加载（开源通用，避免绑定本机 provider 配置）
  patch: '',
  // refs 来源：默认 $DSH_HOME/.credentials.yaml
  credentialsFile: '',
  credentialsMaxBytes: 64 * 1024,
  // 额外注入的环境变量（覆盖同名 refs）
  env: Object.freeze({}),
  // 按访问方 host 改写控制台 origin 时使用
  lanHost: DEFAULT_LAN_HOST,
  publicUrl: DEFAULT_PUBLIC_URL,
  // 探测主机：默认空 = 依次探测 127.0.0.1 与本机所有 IPv4 地址
  webHost: '',
  webPort: DEFAULT_WEB_PORT,
  unit: DEFAULT_UNIT,
  // 运行 headless 任务时显式注入的 HOME
  homeDir: DEFAULT_HOME_DIR,
  // 任务工作目录（默认继承面板进程 cwd）
  cwd: '',
  // 探测 / 读取上限
  probeTimeoutMs: 800,
  journalTimeoutMs: 3000,
  journalMaxBytes: 256 * 1024,
  journalSince: '30 days ago',
  journalTailLines: 200,
  tokenCacheMs: 60000,
  sessionsCacheMs: 15000,
  sessionMaxBytes: 8 * 1024 * 1024,
  // 单个 SSE 任务的事件回放缓冲上限
  taskBufferBytes: 256 * 1024,
  taskMaxPromptBytes: 64 * 1024,
  taskKeepMs: 30 * 60 * 1000,
  taskMaxRetained: 20,
  // 全局追加的 patch 文件（用于把 Web 侧非 UI 插件带进 headless；存在才加）
  taskPatches: Object.freeze([]),
  // SDK 高级续聊（dsh --profile sdk，可续聊带 agentPreset 的 Web 会话）
  allowSdkResume: false,
  sdkProfile: 'sdk',
  sdkPresetPatches: Object.freeze([]),
  sdkProvidersPatch: '',
  sdkTimeoutMs: 180000,
});

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function safeExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch (e) {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

/* ---------------- credentials refs（最小 YAML 解析） ---------------- */

/**
 * 解析 credentials 文件中顶层 `refs:` 下一层的 NAME: value。
 * 只做最小解析（不引入 YAML 依赖）：忽略空行/注释/非匹配行，
 * 支持单/双引号包裹的值；值内允许出现冒号。
 * 注意：返回值是密钥，调用方绝不能把它写进日志/接口/审计。
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseCredentialsRefs(text) {
  const refs = {};
  if (typeof text !== 'string' || !text) return refs;

  let inRefs = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
    const trimmed = rawLine.trim();

    if (!inRefs) {
      if (indent === 0 && /^refs\s*:\s*$/.test(trimmed)) inRefs = true;
      continue;
    }
    // 回到顶层其它键（如 records:）即离开 refs 段
    if (indent === 0) {
      inRefs = false;
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) continue; // 畸形行直接忽略，不抛异常
    const key = match[1];
    let value = match[2].trim();
    if (!value) continue;
    value = unquoteValue(value);
    if (value) refs[key] = value;
  }
  return refs;
}

/** 去掉 YAML 标量两侧的对称引号（最小处理，不解析完整 escape 语法） */
function unquoteValue(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * 读取 credentials 文件并返回 refs。任何失败都只返回错误码（不含值、不含文件内容），
 * 文件缺失时静默降级（任务会自然失败，stderr 会说明原因）。
 * @returns {{refs: Record<string,string>, error: string|null, missing: boolean}}
 */
function loadCredentialsRefs(file, maxBytes = 64 * 1024) {
  if (!file) return { refs: {}, error: null, missing: false };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return { refs: {}, error: null, missing: true };
  }
  if (!stat.isFile()) return { refs: {}, error: 'not_a_file', missing: false };
  if (stat.size > maxBytes) return { refs: {}, error: 'size_exceeded', missing: false };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { refs: {}, error: 'read_failed', missing: false };
  }
  try {
    return { refs: parseCredentialsRefs(text), error: null, missing: false };
  } catch (e) {
    return { refs: {}, error: 'parse_failed', missing: false };
  }
}

/**
 * 合并代码内默认值与用户 config.dsh。
 * 注意：只有 allowTask === true 才算开启（字符串 "true" 不算）。
 */
function resolveDshConfig(config) {
  const raw = config && typeof config.dsh === 'object' && config.dsh ? config.dsh : {};
  const cfg = { ...DEFAULTS };

  // DSH_HOME 环境变量只在用户未显式配置时生效
  if (!raw.home && process.env.DSH_HOME) cfg.home = process.env.DSH_HOME;
  if (!raw.bin && process.env.DSH_BIN) cfg.bin = process.env.DSH_BIN;

  const stringKeys = [
    'home', 'bin', 'profile', 'consoleUrlCustom', 'lanHost', 'publicUrl',
    'webHost', 'unit', 'homeDir', 'cwd', 'journalSince',
  ];
  for (const key of stringKeys) {
    if (raw[key] !== undefined && raw[key] !== null) cfg[key] = String(raw[key]);
  }
  // 空字符串视为"用默认/自动推导"（开源 config.example 会写空值）
  if (!cfg.home) cfg.home = DEFAULT_HOME;
  if (!cfg.profile) cfg.profile = DEFAULTS.profile;
  if (!cfg.unit) cfg.unit = DEFAULTS.unit;
  if (!cfg.homeDir) cfg.homeDir = DEFAULT_HOME_DIR;
  if (!cfg.journalSince) cfg.journalSince = DEFAULTS.journalSince;
  // bin 未显式配置（或为空）时按最终 home 推导
  if (!cfg.bin) cfg.bin = resolveDshBin(cfg.home);

  // headless 补丁：默认不加载（空字符串）；用户可在 config.dsh.patch 显式指定
  if (raw.patch === false || raw.patch === '') {
    cfg.patch = '';
  } else if (raw.patch !== undefined && raw.patch !== null) {
    cfg.patch = String(raw.patch);
  }

  // credentials 文件默认跟随最终生效的 DSH_HOME
  if (raw.credentialsFile !== undefined && raw.credentialsFile !== null && raw.credentialsFile !== '') {
    cfg.credentialsFile = String(raw.credentialsFile);
  } else if (raw.credentialsFile === '') {
    cfg.credentialsFile = '';
  } else {
    cfg.credentialsFile = path.join(cfg.home, '.credentials.yaml');
  }

  // SDK 高级续聊配置
  cfg.allowSdkResume = raw.allowSdkResume === true;
  if (raw.sdkProfile !== undefined && raw.sdkProfile !== null && String(raw.sdkProfile).trim()) {
    cfg.sdkProfile = String(raw.sdkProfile).trim();
  }
  cfg.sdkProvidersPatch = raw.sdkProvidersPatch === undefined || raw.sdkProvidersPatch === null ? '' : String(raw.sdkProvidersPatch);
  cfg.sdkPresetPatches = [];
  const presetList = Array.isArray(raw.sdkPresetPatches) ? raw.sdkPresetPatches : typeof raw.sdkPresetPatches === 'string' && raw.sdkPresetPatches ? [raw.sdkPresetPatches] : [];
  for (const item of presetList.slice(0, 20)) {
    if (typeof item === 'string' && item.trim()) cfg.sdkPresetPatches.push(item.trim());
  }
  cfg.sdkTimeoutMs = clampInt(raw.sdkTimeoutMs, 1000, 30 * 60 * 1000, DEFAULTS.sdkTimeoutMs);

  // 全局追加 patch：字符串或数组，最多 10 个（不校验存在性，spawn 时跳过缺失文件）
  cfg.taskPatches = [];
  const rawPatches = raw.taskPatches;
  const list = Array.isArray(rawPatches) ? rawPatches : typeof rawPatches === 'string' && rawPatches ? [rawPatches] : [];
  for (const item of list.slice(0, 10)) {
    if (typeof item === 'string' && item.trim()) cfg.taskPatches.push(item.trim());
  }

  // 额外注入的 env：只接受普通对象里合法的环境变量名，值统一字符串化
  cfg.env = {};
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    let count = 0;
    for (const [name, value] of Object.entries(raw.env)) {
      if (count >= 100) break;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (value === undefined || value === null) continue;
      cfg.env[name] = String(value);
      count += 1;
    }
  }

  const numberKeys = [
    'probeTimeoutMs', 'journalTimeoutMs', 'journalMaxBytes', 'journalTailLines',
    'tokenCacheMs', 'sessionsCacheMs', 'sessionMaxBytes', 'taskBufferBytes',
    'taskMaxPromptBytes', 'taskKeepMs', 'taskMaxRetained', 'credentialsMaxBytes',
  ];
  for (const key of numberKeys) {
    if (raw[key] !== undefined && raw[key] !== null) {
      const n = Number(raw[key]);
      if (Number.isFinite(n) && n > 0) cfg[key] = Math.trunc(n);
    }
  }

  cfg.enabled = raw.enabled !== false;
  cfg.allowTask = raw.allowTask === true;
  cfg.taskTimeoutMs = clampInt(raw.taskTimeoutMs, 100, 60 * 60 * 1000, DEFAULTS.taskTimeoutMs);
  cfg.webPort = clampInt(raw.webPort, 1, 65535, DEFAULTS.webPort);
  cfg.probeTimeoutMs = clampInt(cfg.probeTimeoutMs, 50, 5000, DEFAULTS.probeTimeoutMs);
  cfg.journalTimeoutMs = clampInt(cfg.journalTimeoutMs, 100, 3000, DEFAULTS.journalTimeoutMs);
  cfg.sessionMaxBytes = clampInt(cfg.sessionMaxBytes, 64 * 1024, 64 * 1024 * 1024, DEFAULTS.sessionMaxBytes);
  cfg.taskBufferBytes = clampInt(cfg.taskBufferBytes, 4 * 1024, 8 * 1024 * 1024, DEFAULTS.taskBufferBytes);

  return cfg;
}

/* ---------------- 通用有界命令执行 ---------------- */

/**
 * 以数组参数 spawn 一个命令，限制执行时间与输出字节数。
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, truncated:boolean, error?:string, code?:number|null}>}
 */
function runBounded(file, args, options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const maxBytes = options.maxBytes || 64 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timer = null;
    let child;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const out = {
        ok: Boolean(result.ok),
        stdout,
        stderr,
        truncated,
        error: result.error,
        code: result.code === undefined ? null : result.code,
      };
      if (!out.ok && !out.error) out.error = 'unknown_error';
      resolve(out);
    }

    function killChild(signal) {
      try {
        if (child && !child.killed) child.kill(signal);
      } catch (e) {
        /* ignore */
      }
    }

    try {
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', truncated: false, error: e.message, code: null });
      return;
    }

    timer = setTimeout(() => {
      killChild('SIGKILL');
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    function account(chunk) {
      const text = chunk.toString('utf8');
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remain = maxBytes - bytes;
      const slice = Buffer.byteLength(text, 'utf8') > remain
        ? Buffer.from(text, 'utf8').subarray(0, remain).toString('utf8')
        : text;
      bytes += Buffer.byteLength(slice, 'utf8');
      if (slice.length < text.length) {
        truncated = true;
        killChild('SIGKILL');
      }
      return slice;
    }

    child.stdout.on('data', (chunk) => {
      const text = account(chunk);
      if (text) stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      const text = account(chunk);
      if (text) stderr += text;
    });
    child.on('error', (e) => {
      finish({ ok: false, error: e.code || e.message });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, error: code === 0 ? undefined : `exit_${code}` });
    });
  });
}

/* ---------------- 控制台 token 提取 ---------------- */

const TOKEN_LINE_RE = /dsh web:\s*(https?:\/\/\S*?[?&]token=([A-Za-z0-9._~+/=-]+))/g;
const ISO_TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)/;

/**
 * 从 journalctl 输出中提取最新的 token 行。
 * 输出可能是 journalctl 的任意顺序，因此优先按行首 ISO 时间戳取最新；
 * 没有时间戳时退化为“最后一条匹配”。
 * @param {string} text
 * @returns {{token:string, sourceUrl:string, at:number|null}|null}
 */
function extractDshToken(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  let best = null;
  for (const line of lines) {
    TOKEN_LINE_RE.lastIndex = 0;
    const match = TOKEN_LINE_RE.exec(line);
    if (!match) continue;
    const tsMatch = ISO_TS_RE.exec(line);
    let at = null;
    if (tsMatch) {
      const parsed = Date.parse(tsMatch[1]);
      if (Number.isFinite(parsed)) at = parsed;
    }
    const candidate = { token: match[2], sourceUrl: match[1], at };
    if (!best) {
      best = candidate;
      continue;
    }
    if (at !== null && best.at !== null) {
      if (at > best.at) best = candidate;
      else if (at === best.at && match[1].startsWith('https://') && !best.sourceUrl.startsWith('https://')) {
        best = candidate;
      }
    } else {
      best = candidate; // 无时间戳信息时取最后一条
    }
  }
  return best;
}

/** 取出 Host 头里的主机名（去端口 / 去 IPv6 方括号） */
function hostOnly(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host.slice(1);
  }
  return host.replace(/:\d+$/, '');
}

/** 判断请求 Host 属于 tailnet（public）还是局域网（lan） */
function classifyHost(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  // 去掉端口与 IPv6 方括号
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else {
    host = host.replace(/:\d+$/, '');
  }
  if (!host) return 'lan';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'lan';
  if (host.endsWith('.ts.net')) return 'public';
  // Tailscale 使用 100.64.0.0/10 网段
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 100 && b >= 64 && b <= 127) return 'public';
  }
  return 'lan';
}

/**
 * 读取本机 Tailscale 主机名（`tailscale status --json` 的 Self.DNSName）。
 * 用于在未配置 dsh.publicUrl 时，给 tailnet 访问者推导出可用的 HTTPS 控制台地址。
 * 无 tailscale / 未运行 / 超时一律返回 null，不影响其它逻辑。
 */
function detectTailnetHostname(options = {}) {
  const timeoutMs = options.timeoutMs || 3000;
  const cacheMs = options.cacheMs || 300000;
  const now = Date.now();
  if (detectTailnetHostname._cache && now - detectTailnetHostname._cache.at < cacheMs) {
    return Promise.resolve(detectTailnetHostname._cache.value);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      detectTailnetHostname._cache = { at: Date.now(), value };
      resolve(value);
    };
    let child;
    try {
      child = spawn('tailscale', ['status', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return finish(null);
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (out.length < 512 * 1024) out += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        const name = String(parsed?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
        finish(name && name.endsWith('.ts.net') ? name : null);
      } catch (e) {
        finish(null);
      }
    });
  });
}

/**
 * 推导控制台 base URL（纯函数，便于单测）。
 * @param {object} input
 * @param {'lan'|'public'} input.mode classifyHost 的结果
 * @param {object} input.cfg  {lanHost, publicUrl, webHost, webPort}
 * @param {string} input.reqHost 请求 Host（去掉端口）
 * @param {string|null} input.tailnetHost 本机 tailnet 主机名（可为空）
 * @returns {{base:string, mode:'lan'|'public'}}
 */
function deriveConsoleBase({ mode, cfg, reqHost, tailnetHost }) {
  const webPort = cfg.webPort || DEFAULT_WEB_PORT;
  if (mode === 'public') {
    // 1) 显式配置的 publicUrl
    if (cfg.publicUrl) return { base: cfg.publicUrl, mode: 'public' };
    // 2) 请求本身就是 tailnet 主机名（tailscale serve 反代 443 → DSH）
    if (reqHost && reqHost.endsWith('.ts.net')) return { base: `https://${reqHost}/`, mode: 'public' };
    // 3) 从本机 tailscale 读到的主机名
    if (tailnetHost) return { base: `https://${tailnetHost}/`, mode: 'public' };
    // 4) 都没有：tailnet IP 上没有 HTTPS 服务，绝不返回 https://<裸 IP>；退回局域网地址
    const host = cfg.lanHost || cfg.webHost;
    if (host) return { base: `http://${host}:${webPort}/`, mode: 'lan' };
    return { base: '', mode: 'public' };
  }
  const host = cfg.lanHost || reqHost;
  return { base: host ? `http://${host}:${webPort}/` : '', mode: 'lan' };
}

/** 在 URL 上附加 token 查询参数（保留原有 path/query） */
function withToken(baseUrl, token) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  } catch (e) {
    const joiner = String(baseUrl).includes('?') ? '&' : '?';
    return `${baseUrl}${joiner}token=${encodeURIComponent(token)}`;
  }
}

/* ---------------- 端口 / 进程探测 ---------------- */

/** 建立一次 TCP 连接，超时返回 false */
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) { /* ignore */ }
      resolve({ reachable: ok, error: error || null });
    };
    const timer = setTimeout(() => done(false, 'timeout'), timeoutMs);
    if (timer.unref) timer.unref();
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false, 'timeout'));
    socket.on('error', (e) => done(false, e.code || e.message));
  });
}

function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * 探测 DSH web 进程：优先 systemctl show，失败时退回 pgrep。
 * 返回的 profile 从 /proc/<pid>/cmdline 推断（web / headless / null）。
 */
async function detectWebProcess(cfg) {
  let pid = 0;
  let activeState = '';
  let activeEnterTimestamp = '';

  const show = await runBounded(
    'systemctl',
    ['show', cfg.unit, '--property=MainPID', '--property=ActiveState', '--property=ActiveEnterTimestamp'],
    { timeoutMs: 1500, maxBytes: 16 * 1024 }
  );
  if (show.ok) {
    for (const line of show.stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === 'MainPID') pid = Number(value) || 0;
      else if (key === 'ActiveState') activeState = value;
      else if (key === 'ActiveEnterTimestamp') activeEnterTimestamp = value;
    }
  }

  if (!pid || activeState === 'inactive' || activeState === 'failed') {
    const pg = await runBounded('pgrep', ['-af', 'dsh'], { timeoutMs: 1500, maxBytes: 64 * 1024 });
    if (pg.ok) {
      for (const line of pg.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 只认 web 子命令，避免把 headless 任务或本进程误判为 web
        if (!/\bweb\b/.test(trimmed)) continue;
        if (!/dsh/.test(trimmed)) continue;
        const m = /^(\d+)\s+/.exec(trimmed);
        if (m) {
          pid = Number(m[1]) || 0;
          if (pid) break;
        }
      }
    }
  }

  if (!pid) {
    return { running: false, pid: null, profile: null, uptimeSec: null };
  }

  const argv = readProcCmdline(pid);
  let profile = null;
  const profileIdx = argv.indexOf('--profile');
  if (profileIdx >= 0 && argv[profileIdx + 1]) profile = argv[profileIdx + 1];
  if (!profile) {
    if (argv.includes('web')) profile = 'web';
    else if (argv.includes('headless')) profile = 'headless';
  }

  let uptimeSec = null;
  if (activeEnterTimestamp) {
    const startedAt = Date.parse(activeEnterTimestamp);
    if (Number.isFinite(startedAt)) uptimeSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  return { running: true, pid, profile, uptimeSec };
}

/* ---------------- 会话扫描 ---------------- */

function readSessionMeta(file, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return null;
  }
  // 压缩后已超过上限的文件没必要再读（解压只会更大）
  if (stat.size > maxBytes) return null;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return null;
  }
  let text;
  try {
    text = zlib.zstdDecompressSync(buf, { maxOutputLength: maxBytes }).toString('utf8');
  } catch (e) {
    return null; // 解压失败或超过上限：跳过该文件
  }
  const newline = text.indexOf('\n');
  const firstLine = newline >= 0 ? text.slice(0, newline) : text;
  let meta;
  try {
    meta = JSON.parse(firstLine);
  } catch (e) {
    return null;
  }
  if (!meta || meta.type !== 'session') return null;
  return {
    id: String(meta.id || ''),
    cwd: String(meta.cwd || ''),
    createdAt: Number(meta.createdAt) || Math.round(stat.birthtimeMs || stat.ctimeMs || 0),
    updatedAt: Math.round(stat.mtimeMs || 0),
    sizeBytes: stat.size,
  };
}

function scanSessions(cfg) {
  const root = path.join(cfg.home, 'sessions');
  const list = [];
  let total = 0;
  let skipped = 0;

  for (const workspace of safeReaddir(root)) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    for (const entry of safeReaddir(workspacePath)) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
      const file = path.join(workspacePath, entry.name, 'session.v4.jsonl.zstd');
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (e) {
        continue;
      }
      if (!stat.isFile()) continue;
      total += 1;
      const meta = readSessionMeta(file, cfg.sessionMaxBytes);
      if (!meta) {
        skipped += 1;
        continue;
      }
      if (!meta.id) meta.id = entry.name;
      list.push(meta);
    }
  }

  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return { list, total, skipped };
}

/* ---------------- 任务调度的单条输出 ---------------- */

function pickSessionId(event) {
  if (!event || typeof event !== 'object') return null;
  const direct = event.sessionId || event.session_id;
  if (typeof direct === 'string' && direct) return direct;
  if (event.session && typeof event.session === 'object' && typeof event.session.id === 'string') {
    return event.session.id;
  }
  if (event.data && typeof event.data === 'object') {
    const nested = event.data.sessionId || event.data.session_id;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

/* ---------------- 主管理器 ---------------- */

class DshManager {
  /**
   * @param {{config?:object, audit?:(message:string, req?:object)=>void, cwd?:string}} options
   */
  constructor(options = {}) {
    this.cfg = resolveDshConfig(options.config || {});
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    this.cwd = this.cfg.cwd || options.cwd || process.cwd();

    this.tokenCache = null; // { token, sourceUrl, at }
    this.tokenPending = null;
    this.sessionsCache = null; // { at, list, total, skipped }

    // 降级告警只打一次，避免每个任务刷屏（不得包含任何密钥值）
    this._warnedMissingPatch = false;
    this._warnedCredentials = false;

    this.tasks = new Map();
    this.current = null;

    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  get allowTask() {
    return this.cfg.allowTask === true;
  }

  /* ----- 状态 ----- */

  async status() {
    const errors = [];
    const binOk = safeExists(this.cfg.bin);
    const homeOk = safeExists(this.cfg.home);
    if (!this.enabled) errors.push('dsh_disabled');
    if (!binOk) errors.push(`dsh_bin_missing: ${this.cfg.bin}`);
    if (!homeOk) errors.push(`dsh_home_missing: ${this.cfg.home}`);

    const [probe, processInfo] = await Promise.all([
      this._probeWeb(),
      detectWebProcess(this.cfg),
    ]);

    const reachable = probe.reachable || processInfo.running;
    if (!reachable) errors.push(`dsh_web_unreachable: ${this.cfg.webHost}:${this.cfg.webPort}`);

    let tokenFound = false;
    try {
      const token = await this._readToken();
      tokenFound = Boolean(token && token.token);
    } catch (e) {
      errors.push(String(e.detail || e.message || 'dsh_token_unavailable'));
    }

    return {
      available: this.enabled && binOk && homeOk,
      home: this.cfg.home,
      web: {
        reachable,
        // 配置了公网地址才返回；否则 null（由前端用请求地址推导）
        url: this.cfg.publicUrl || null,
        pid: processInfo.pid,
        profile: processInfo.profile,
        uptimeSec: processInfo.uptimeSec,
      },
      tokenFound,
      allowTask: this.allowTask,
      errors,
    };
  }

  /** 探测 DSH web：显式 webHost 优先，否则依次试 127.0.0.1 与本机 IPv4 */
  async _probeWeb() {
    const cfg = this.cfg;
    const candidates = [];
    if (cfg.webHost) candidates.push(cfg.webHost);
    candidates.push('127.0.0.1');
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const item of list || []) {
          if (item.family !== 'IPv4' || item.internal) continue;
          if (!candidates.includes(item.address)) candidates.push(item.address);
        }
      }
    } catch (e) {
      /* ignore */
    }
    let last = { reachable: false, error: 'unreachable' };
    for (const host of candidates) {
      const result = await probeTcp(host, cfg.webPort, cfg.probeTimeoutMs);
      if (result.reachable) return result;
      last = result;
    }
    return last;
  }

  /* ----- 控制台 URL ----- */

  async _readToken(force = false) {
    const now = Date.now();
    if (!force && this.tokenCache && now - this.tokenCache.at < this.cfg.tokenCacheMs) {
      return this.tokenCache;
    }
    if (this.tokenPending) return this.tokenPending;

    this.tokenPending = (async () => {
      const since = this.cfg.journalSince;
      const baseArgs = [
        '-u', this.cfg.unit,
        '--since', since,
        '--no-pager',
        '-o', 'short-iso',
        '-n', String(this.cfg.journalTailLines),
      ];
      // -g 让 journalctl 在服务端过滤，输出量小且能覆盖最新行；旧版本不支持时退回全量
      let result = await runBounded(
        'journalctl',
        [...baseArgs, '-g', 'dsh web'],
        { timeoutMs: this.cfg.journalTimeoutMs, maxBytes: this.cfg.journalMaxBytes }
      );
      if (!result.ok) {
        const fallback = await runBounded(
          'journalctl',
          [...baseArgs, '--grep', 'dsh web'],
          { timeoutMs: this.cfg.journalTimeoutMs, maxBytes: this.cfg.journalMaxBytes }
        );
        if (fallback.ok) result = fallback;
      }

      const parsed = extractDshToken(result.stdout || '');
      if (!parsed || !parsed.token) {
        const detail = result.ok
          ? 'token_not_found_in_journal'
          : `journalctl_failed: ${result.error || 'unknown'}`;
        const err = new Error(detail);
        err.code = 'dsh_console_unavailable';
        err.detail = detail;
        throw err;
      }
      this.tokenCache = { token: parsed.token, sourceUrl: parsed.sourceUrl, at: Date.now() };
      return this.tokenCache;
    })().finally(() => {
      this.tokenPending = null;
    });

    return this.tokenPending;
  }

  /**
   * 返回按访问方 host 改写后的控制台 URL。
   * @param {string|undefined} hostHeader req.headers.host
   * @returns {Promise<{url:string, mode:'lan'|'public'|'custom'}>}
   */
  async consoleUrl(hostHeader) {
    if (!this.enabled) {
      const err = new Error('dsh_disabled');
      err.code = 'dsh_console_unavailable';
      err.detail = 'dsh_disabled';
      throw err;
    }
    if (this.cfg.consoleUrlCustom) {
      return { url: this.cfg.consoleUrlCustom, mode: 'custom' };
    }

    const token = await this._readToken();
    const reqHost = hostOnly(hostHeader);
    const classify = classifyHost(hostHeader);
    const tailnetHost = classify === 'public' && !this.cfg.publicUrl ? await detectTailnetHostname() : null;
    const derived = deriveConsoleBase({
      mode: classify,
      cfg: this.cfg,
      reqHost,
      tailnetHost,
    });
    const mode = derived.mode;
    const base = derived.base;
    if (!base) {
      const err = new Error('dsh_console_unavailable');
      err.code = 'dsh_console_unavailable';
      err.detail = 'host_unknown: 无法从请求 Host 推导控制台地址，请配置 dsh.lanHost / dsh.publicUrl';
      throw err;
    }
    return { url: withToken(base, token.token), mode };
  }

  /* ----- 会话列表 ----- */

  listSessions(limit = 20) {
    const lim = clampInt(limit, 1, 100, 20);
    if (!this.enabled) return { sessions: [], total: 0, truncated: false };

    const now = Date.now();
    if (!this.sessionsCache || now - this.sessionsCache.at >= this.cfg.sessionsCacheMs) {
      try {
        const scanned = scanSessions(this.cfg);
        this.sessionsCache = { at: now, ...scanned };
      } catch (e) {
        this.sessionsCache = { at: now, list: [], total: 0, skipped: 0 };
      }
    }

    const cached = this.sessionsCache;
    const sessions = cached.list.slice(0, lim).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      sizeBytes: s.sizeBytes,
    }));
    return {
      sessions,
      total: cached.total,
      truncated: cached.total > sessions.length,
    };
  }

  /* ----- 任务执行 ----- */

  _taskError(code, detail) {
    const err = new Error(detail || code);
    err.code = code;
    err.detail = detail || code;
    return err;
  }

  /**
   * 启动一个 headless 任务。仅 allowTask === true 且无并发任务时可用。
   * @returns {{id:string}}
   */
  startTask(input = {}, req) {
    if (!this.enabled) throw this._taskError('dsh_disabled', 'DSH 已被禁用');
    if (!this.allowTask) throw this._taskError('dsh_task_disabled', '需在 config.json 开启 dsh.allowTask');

    const prompt = String(input.prompt === undefined || input.prompt === null ? '' : input.prompt);
    let sessionId = input.sessionId === undefined || input.sessionId === null || input.sessionId === ''
      ? null
      : String(input.sessionId);

    if (!prompt.trim()) throw this._taskError('dsh_task_invalid', 'prompt 不能为空');
    if (Buffer.byteLength(prompt, 'utf8') > this.cfg.taskMaxPromptBytes) {
      throw this._taskError('dsh_task_invalid', `prompt 超过 ${this.cfg.taskMaxPromptBytes} 字节上限`);
    }
    if (sessionId && !/^session-[A-Za-z0-9._-]{1,200}$/.test(sessionId)) {
      throw this._taskError('dsh_task_invalid', 'sessionId 格式无效');
    }
    if (!safeExists(this.cfg.bin)) {
      throw this._taskError('dsh_bin_missing', `dsh 可执行文件不存在: ${this.cfg.bin}`);
    }
    if (this.current) throw this._taskError('dsh_task_busy', '已有 DSH 任务在运行');

    const id = `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

    // 每次任务的 patch 列表：config.dsh.patch → config.dsh.taskPatches → 调用方 extraPatches
    // 只有 extraPatches 缺失视为错误（调用方显式请求，不能静默忽略）
    const patchPaths = [];
    const resolveExisting = (file, required) => {
      try {
        if (fs.statSync(file).isFile()) return true;
      } catch (e) {
        /* fallthrough */
      }
      if (required) throw this._taskError('dsh_patch_missing', `patch 文件不存在: ${file}`);
      if (!this._warnedMissingPatch) {
        this._warnedMissingPatch = true;
        console.warn(`[dsh] patch 文件不存在，已跳过: ${file}`);
      }
      return false;
    };
    if (this.cfg.patch && resolveExisting(this.cfg.patch, false)) patchPaths.push(this.cfg.patch);
    for (const extra of Array.isArray(this.cfg.taskPatches) ? this.cfg.taskPatches : []) {
      if (resolveExisting(extra, false) && !patchPaths.includes(extra)) patchPaths.push(extra);
    }
    const callerPatches = Array.isArray(input.extraPatches) ? input.extraPatches : [];
    if (callerPatches.length > 10) throw this._taskError('dsh_task_invalid', 'extraPatches 最多 10 个');
    for (const extra of callerPatches) {
      const file = String(extra || '');
      if (!file) continue;
      resolveExisting(file, true);
      if (!patchPaths.includes(file)) patchPaths.push(file);
    }

    // 每次任务的工作目录（默认 config.dsh.cwd 或面板根）
    let taskCwd = this.cwd;
    if (input.cwd) {
      const candidate = path.resolve(String(input.cwd));
      let stat;
      try {
        stat = fs.statSync(candidate);
      } catch (e) {
        throw this._taskError('dsh_task_invalid', '工作目录不存在');
      }
      if (!stat.isDirectory()) throw this._taskError('dsh_task_invalid', '工作目录不是目录');
      taskCwd = candidate;
    }

    const args = ['--profile', this.cfg.profile];
    for (const patch of patchPaths) args.push('--patch', patch);
    args.push('--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push(prompt);

    // credentials refs：仅注入 spawn env，绝不写入日志/接口/审计
    const credential = loadCredentialsRefs(this.cfg.credentialsFile, this.cfg.credentialsMaxBytes);
    if (credential.error && !this._warnedCredentials) {
      this._warnedCredentials = true;
      console.warn(`[dsh] credentials 读取失败（跳过 refs 注入）: ${credential.error}`);
    }
    const refCount = Object.keys(credential.refs).length;

    const env = {
      ...process.env,
      DSH_HOME: this.cfg.home,
      HOME: this.cfg.homeDir || DEFAULT_HOME_DIR,
      ...credential.refs,
      ...this.cfg.env,
    };

    const task = {
      id,
      prompt,
      requestedSessionId: sessionId,
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      timedOut: false,
      finished: false,
      patchPath: patchPaths[0] || null,
      patchPaths,
      cwd: taskCwd,
      refCount,
      buffer: [],
      bufferBytes: 0,
      subscribers: new Set(),
      child: null,
      timer: null,
      killTimer: null,
      argv: args,
    };

    let child;
    try {
      child = spawn(this.cfg.bin, args, {
        cwd: taskCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      throw this._taskError('dsh_spawn_failed', e.message);
    }

    task.child = child;
    this.current = task;
    this.tasks.set(id, task);

    // 审计：动作 dsh.task，含 prompt 前 200 字符（按字符截断，避免截断多字节字符）
    const promptPreview = Array.from(prompt).slice(0, 200).join('');
    this.audit(`dsh.task ${id} session=${sessionId || 'new'} prompt=${JSON.stringify(promptPreview)}`, req);

    this._emit(task, { type: 'start', sessionId: sessionId || undefined });

    const stdoutState = { buf: '' };
    const stderrState = { buf: '' };

    child.stdout.on('data', (chunk) => {
      for (const line of drainLines(stdoutState, chunk)) this._onStdoutLine(task, line);
    });
    child.stderr.on('data', (chunk) => {
      for (const line of drainLines(stderrState, chunk)) this._onStderrLine(task, line);
    });
    child.on('error', (e) => {
      task.exitCode = null;
      this._finish(task, 'error', { message: e.code || e.message });
    });
    child.on('close', (code, signal) => {
      // 收尾只处理一次
      if (stdoutState.buf.trim()) {
        this._onStdoutLine(task, stdoutState.buf);
        stdoutState.buf = '';
      }
      if (stderrState.buf.trim()) {
        this._onStderrLine(task, stderrState.buf);
        stderrState.buf = '';
      }
      task.exitCode = code;
      if (task.timedOut) {
        this._finish(task, 'error', { message: 'timeout' });
      } else {
        this._finish(task, 'done', { code, sessionId: task.sessionId || undefined });
      }
      void signal;
    });

    const timeoutMs = this.cfg.taskTimeoutMs;
    task.timer = setTimeout(() => {
      if (task.finished) return;
      task.timedOut = true;
      this._emit(task, { type: 'stderr', line: `[dsh] 任务超时（${timeoutMs}ms），正在终止` });
      try {
        if (task.child && !task.child.killed) task.child.kill('SIGTERM');
      } catch (e) {
        /* ignore */
      }
      task.killTimer = setTimeout(() => {
        try {
          if (task.child && !task.child.killed) task.child.kill('SIGKILL');
        } catch (e) {
          /* ignore */
        }
      }, 2000);
      if (task.killTimer.unref) task.killTimer.unref();
    }, timeoutMs);
    if (task.timer.unref) task.timer.unref();

    return { id };
  }

  _onStdoutLine(task, line) {
    const text = String(line || '').replace(/\r$/, '');
    if (!text.trim()) return;
    const trimmed = text.trim();
    let parsed = null;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        parsed = null;
      }
    }
    if (parsed && typeof parsed === 'object') {
      const sid = pickSessionId(parsed);
      if (sid) task.sessionId = sid;
      this._emit(task, {
        type: 'event',
        line: trimmed.slice(0, 16000),
        sessionId: sid || undefined,
      });
      return;
    }
    this._emit(task, { type: 'stdout', line: text.slice(0, 16000) });
  }

  _onStderrLine(task, line) {
    const text = String(line || '').replace(/\r$/, '');
    if (!text.trim()) return;
    this._emit(task, { type: 'stderr', line: text.slice(0, 16000) });
  }

  _emit(task, event) {
    const payload = JSON.stringify(event);
    task.buffer.push(payload);
    task.bufferBytes += Buffer.byteLength(payload, 'utf8') + 1;
    while (task.bufferBytes > this.cfg.taskBufferBytes && task.buffer.length > 1) {
      const dropped = task.buffer.shift();
      task.bufferBytes -= Buffer.byteLength(dropped, 'utf8') + 1;
    }
    for (const listener of task.subscribers) {
      try {
        listener(payload);
      } catch (e) {
        task.subscribers.delete(listener);
      }
    }
  }

  _finish(task, kind, extra = {}) {
    if (task.finished) return;
    task.finished = true;
    task.status = kind === 'error' ? 'error' : 'done';
    task.endedAt = Date.now();
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    if (task.killTimer) {
      clearTimeout(task.killTimer);
      task.killTimer = null;
    }
    if (this.current === task) this.current = null;

    const event = kind === 'error'
      ? { type: 'error', ...extra }
      : { type: 'done', code: extra.code === undefined ? null : extra.code, ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) };
    this._emit(task, event);

    for (const listener of task.subscribers) {
      try {
        listener(null);
      } catch (e) {
        /* ignore */
      }
    }
    task.subscribers.clear();
    task.child = null;
    this._prune();
  }

  getTask(id) {
    const task = this.tasks.get(String(id || ''));
    return task || null;
  }

  /**
   * 订阅任务事件（自动回放缓冲）。任务已结束时回放后立即回调 null。
   * @param {string} id
   * @param {(payload:string|null)=>void} listener
   * @returns {(()=>void)|null} 取消订阅；任务不存在返回 null
   */
  subscribeTask(id, listener) {
    const task = this.getTask(id);
    if (!task) return null;
    for (const payload of task.buffer.slice()) {
      try {
        listener(payload);
      } catch (e) {
        return () => {};
      }
    }
    if (task.finished) {
      try {
        listener(null);
      } catch (e) {
        /* ignore */
      }
      return () => {};
    }
    task.subscribers.add(listener);
    return () => {
      task.subscribers.delete(listener);
    };
  }

  _prune() {
    // 已完成任务超过保留数量时，按插入顺序淘汰最旧的
    if (this.tasks.size <= this.cfg.taskMaxRetained) return;
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= this.cfg.taskMaxRetained) break;
      if (task === this.current) continue;
      if (task.finished) this.tasks.delete(id);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task === this.current) continue;
      if (task.finished && task.endedAt && now - task.endedAt > this.cfg.taskKeepMs) {
        this.tasks.delete(id);
      }
    }
    this._prune();
  }

  /** 关闭时清理：终止运行中的任务并停止定时器 */
  closeAll() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const task of this.tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
      if (task.killTimer) clearTimeout(task.killTimer);
      try {
        if (task.child && !task.child.killed) task.child.kill('SIGTERM');
      } catch (e) {
        /* ignore */
      }
    }
    this.tasks.clear();
    this.current = null;
  }
}

/** 将 chunk 拆成完整行，返回可迭代的行数组，残余写入 state.buf */
function drainLines(state, chunk) {
  state.buf += chunk.toString('utf8');
  const lines = [];
  // 单行上限，防止异常输出撑爆内存
  const maxLine = 1024 * 1024;
  if (state.buf.length > maxLine) {
    lines.push(state.buf.slice(0, maxLine) + '…(truncated)');
    state.buf = '';
    return lines;
  }
  let index = state.buf.indexOf('\n');
  while (index >= 0) {
    lines.push(state.buf.slice(0, index));
    state.buf = state.buf.slice(index + 1);
    index = state.buf.indexOf('\n');
  }
  return lines;
}

module.exports = {
  DEFAULTS,
  DshManager,
  detectTailnetHostname,
  deriveConsoleBase,
  resolveDshConfig,
  extractDshToken,
  classifyHost,
  withToken,
  runBounded,
  probeTcp,
  detectWebProcess,
  parseCredentialsRefs,
  loadCredentialsRefs,
  DEFAULT_PATCH,
  resolveDshBin,
  findOnPath,
  hostOnly,
};
