'use strict';

/**
 * HTTP 服务主体
 * - 静态文件 + API 路由 + SSE 实时推送
 * - 无第三方依赖，仅用 node: 内置模块
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { loadConfig, saveConfig, DATA_DIR, CONFIG_PATH } = require('./lib/config');
const { Auth, COOKIE_NAME, CSRF_HEADER, REMEMBER_COOKIE, parseCookies, buildSetCookie } = require('./lib/auth');
const { Collector, readStaticInfo, readProcessSummary } = require('./lib/collector');
const { Store } = require('./lib/store');
const { listProcesses, listServices, readLogs } = require('./lib/procs');
const extra = require('./lib/extra');
const { getDockerClient, groupComposeProjects, validateContainerRef } = require('./lib/docker');
const smart = require('./lib/smart');
const { BenchManager } = require('./lib/bench');
const files = require('./lib/files');
const { TerminalManager } = require('./lib/terminal');
const { DshManager } = require('./lib/dsh');
const { ShareStore, parseRange, mimeFor, contentDisposition, generateQrSvg } = require('./lib/share');
const { AlertEngine } = require('./lib/alerts');
const { Notifier } = require('./lib/notify');
const { BackupManager } = require('./lib/backup');
const { AppUpdateManager } = require('./lib/appUpdate');
const { readAuditEntries } = require('./lib/auditlog');
const { ChatStore, ChatService } = require('./lib/chat');
const { SessionCatalog, DshCapabilities } = require('./lib/dshSessions');
const { SdkTaskRunner, detectPresetPatches } = require('./lib/dshSdk');
const { HelperClient, HelperError, HELPER_VERSION } = require('./lib/helper');
const helperValidate = require('./helper/validate');

const ROOT = path.resolve(__dirname);
const PUBLIC_DIR = path.join(ROOT, 'public');
/** App 集成契约版本（docs/app-contract.md 1.1），不随 package.json 变动 */
const APP_VERSION = '0.2.0';

/* ---------------- 初始化 ---------------- */

const { config, created, generatedPassword } = loadConfig();

if (created) {
  console.log('');
  console.log('='.repeat(60));
  console.log('  首次启动，已生成配置文件：config.json');
  console.log('');
  console.log(`  用户名：${config.panel.username}`);
  console.log(`  密  码：${generatedPassword}`);
  console.log('');
  console.log('  请立即登录并修改密码。此密码只显示这一次。');
  console.log('='.repeat(60));
  console.log('');
}

const auth = new Auth(config, saveConfig, { dataDir: DATA_DIR });
const collector = new Collector({ intervalMs: config.sampleIntervalMs || 1000 });
const bench = new BenchManager({
  tempLimitC: config.thresholds?.cpuTempC || 90,
  maxDurationMs: 5 * 60 * 1000,
});
const terminals = new TerminalManager();
const store = new Store(path.join(DATA_DIR, 'metrics.db'), {
  retentionDays: config.retention?.archiveDays || 30,
});
const dsh = new DshManager({
  config,
  // 复用现有审计机制：动作写入 data/audit.log
  audit: (message, req) => auditLog(message, req),
  cwd: ROOT,
});
// 文件下载分享（持久化到 data/shares.json；进程重启后仍有效）
const shares = new ShareStore({
  ...(config.download || {}),
  dataDir: DATA_DIR,
  warn: (message) => console.warn(message),
});
// 回收站目录 + 保留天数（启动时与每天自动清理）
const TRASH_ROOT = path.join(DATA_DIR, 'trash');
const TRASH_RETENTION_DAYS = Number(config.fileManager?.trashRetentionDays) || 7;
let lastTrashCleanup = Date.now();
files
  .trashCleanup(TRASH_ROOT, TRASH_RETENTION_DAYS)
  .then((result) => {
    if (result.count > 0) console.log(`[trash] 启动清理过期条目 ${result.count} 个`);
  })
  .catch(() => {});
// 通知渠道 + 告警引擎（规则/开关来自 config.alerts，可经 PUT 接口修改并持久化）
const notifier = new Notifier({ config: config.notify });
const alertsEngine = new AlertEngine({
  config: config.alerts,
  store,
  notifier,
  audit: (message) => auditLog(message),
});
// 备份/恢复（含自动备份）与 App 自动更新
const backupManager = new BackupManager({
  configPath: CONFIG_PATH,
  dataDir: DATA_DIR,
  store,
  backupConfig: config.backup || {},
});
const appUpdate = new AppUpdateManager({ distDir: config.appUpdate?.distDir || path.join(ROOT, 'dist') });
// App 原生聊天：会话/消息持久化 + 通过 DshTaskManager 执行
const chatStore = new ChatStore({
  dataDir: DATA_DIR,
  warn: (message) => console.warn(message),
});
const chatService = new ChatService({
  store: chatStore,
  dsh,
  audit: (message) => auditLog(message),
});
// DSH 会话目录 / 历史解析 / 能力探测（会话文件为多帧 zstd，优先 zstd CLI）
const sessionCatalog = new SessionCatalog({
  dshHome: dsh.cfg.home,
  warn: (message) => console.warn(message),
});
// SDK 高级续聊：dsh --profile sdk（可续聊带 agentPreset 的 DSH Web 会话）
const sdkRunner = new SdkTaskRunner({
  timeoutMs: dsh.cfg.sdkTimeoutMs,
  audit: (message) => auditLog(message),
  resolveClientOptions: async ({ cwd }) => ({
    dshBin: dsh.cfg.bin,
    profile: dsh.cfg.sdkProfile || 'sdk',
    providersPatch: dsh.cfg.sdkProvidersPatch || dsh.cfg.patch || '',
    presetPatches: detectPresetPatches(dsh.cfg.bin, dsh.cfg.sdkPresetPatches),
    cwd: cwd || dsh.cfg.cwd || ROOT,
    home: dsh.cfg.home,
    homeDir: dsh.cfg.homeDir,
    credentialsFile: dsh.cfg.credentialsFile,
    env: dsh.cfg.env || {},
  }),
});

const dshCapabilities = new DshCapabilities({
  dshBin: dsh.cfg.bin,
  profile: dsh.cfg.profile,
  patches: [dsh.cfg.patch].filter(Boolean),
  allowTask: dsh.allowTask,
  taskPatches: Array.isArray(dsh.cfg.taskPatches) ? dsh.cfg.taskPatches : [],
});
// B2 root 特权助手客户端（不可用时统一 503 helper_unavailable）
const helperClient = new HelperClient({
  socketPath: config.helper?.socketPath,
  secretFile: config.helper?.secretFile,
  timeoutMs: config.helper?.timeoutMs,
});

async function callHelper(op, args = {}) {
  if (config.helper && config.helper.enabled === false) {
    throw new HelperError('helper_unavailable', 'helper 已在 config.helper.enabled 中禁用');
  }
  return helperClient.call(op, args);
}

function sendHelperError(res, err) {
  const code = err && err.code ? err.code : 'helper_error';
  if (code === 'helper_unavailable') {
    return sendJson(res, 503, { error: 'helper_unavailable', detail: '需要安装 panel-helper' });
  }
  if (code === 'helper_timeout') {
    return sendJson(res, 503, { error: 'helper_timeout', detail: 'helper 响应超时' });
  }
  if (code === 'helper_denied') {
    return sendJson(res, 400, { error: 'helper_denied', detail: (err && err.detail) || '操作被拒绝' });
  }
  return sendJson(res, 502, { error: 'helper_error', detail: (err && err.detail) || 'helper 执行失败' });
}

function sendInvalidArgs(res, detail) {
  return sendJson(res, 400, { error: 'invalid_args', detail });
}

/* ---------------- 归档定时器 ---------------- */

let lastArchive = 0;
function archiveTick(sample) {
  const now = Date.now();
  if (now - lastArchive >= 60_000) {
    lastArchive = now;
    try {
      store.insert(sample);
    } catch (e) {
      console.error('[store] 写入失败:', e.message);
    }
  }
}

collector.subscribe(archiveTick);
// 告警引擎：每次采集快照评估（引擎内部 10s 节流）
collector.subscribe((snapshot) => alertsEngine.evaluate(snapshot));

/* ---------------- 每日清理 ---------------- */

const pruneTimer = setInterval(() => {
  try {
    const n = store.prune();
    if (n > 0) console.log(`[store] 清理过期数据 ${n} 行`);
  } catch (e) {
    console.error('[store] 清理失败:', e.message);
  }
}, 6 * 60 * 60 * 1000);
pruneTimer.unref();

/* ---------------- 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function readBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 审计日志：记录敏感操作
 */
const AUDIT_PATH = path.join(DATA_DIR, 'audit.log');
function auditLog(message, req) {
  // 无请求上下文的审计（如规则/通知配置变更）也写 IP 占位符 '-', 保证行格式稳定
  const ip = req ? clientIp(req) : '-';
  const line = `${new Date().toISOString()} ${ip} ${message}\n`;
  try {
    fs.appendFileSync(AUDIT_PATH, line, { mode: 0o600 });
  } catch (e) {
    /* 审计失败不影响主流程 */
  }
}

function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/** 从请求中解析并校验会话 */
function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies[COOKIE_NAME];
  return auth.getSession(sid);
}

/** 需要登录的 API 包装 */
function requireAuth(handler) {
  // 注意：保留额外参数（如正则路由的 match），最后追加 session
  return async (req, res, url, ...rest) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      return sendError(res, 401, '未登录');
    }
    return handler(req, res, url, ...rest, session);
  };
}

/** 需要 CSRF 的写操作包装 */
function requireCsrf(handler) {
  return async (req, res, url, ...rest) => {
    const session = rest.length > 0 ? rest[rest.length - 1] : null;
    const token = req.headers[CSRF_HEADER];
    if (!Auth.csrfValid(session, token)) {
      return sendError(res, 403, 'CSRF 校验失败，请刷新页面');
    }
    return handler(req, res, url, ...rest);
  };
}

/* ---------------- Cookie 辅助（记住密码） ---------------- */

/** 判断当前请求是否 HTTPS（直连 TLS 或反向代理 X-Forwarded-Proto） */
function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return proto === 'https';
}

/** 构造 panel_remember cookie（HttpOnly + SameSite=Strict + 可选 Secure） */
function buildRememberCookie(req, token, maxAgeSeconds) {
  return buildSetCookie(REMEMBER_COOKIE, token, {
    maxAge: maxAgeSeconds,
    secure: isSecureRequest(req),
  });
}

/** 多条 Set-Cookie 必须用数组，单条保持字符串兼容旧测试 */
function setCookieHeaders(res, cookies) {
  if (cookies.length === 0) return;
  res.setHeader('Set-Cookie', cookies.length === 1 ? cookies[0] : cookies);
}

/** 记住登录 cookie 的有效秒数（最长 365 天） */
function rememberMaxAgeSeconds() {
  const days = Number(auth.remember.days) || 0;
  return Math.max(0, Math.min(365, days)) * 86400;
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, urlPath) {
  // API 路径永远不走静态回退（避免未知 /api/* 被 SPA 回退成 HTML 200）
  if (urlPath === '/api' || urlPath.startsWith('/api/')) {
    return sendError(res, 404, '接口不存在');
  }

  let rel = urlPath === '/' ? '/index.html' : urlPath;
  try {
    rel = decodeURIComponent(rel);
  } catch (e) {
    return sendError(res, 400, '路径编码无效');
  }

  // 防目录穿越
  const safePath = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendError(res, 403, '禁止访问');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA 回退
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (e2, data) => {
        if (e2) return sendError(res, 404, '页面不存在');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';
    const baseName = path.basename(filePath);

    const headers = {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
    };

    // PWA：Service Worker 必须不缓存，且允许控制根作用域
    if (baseName === 'sw.js') {
      headers['Cache-Control'] = 'no-cache';
      headers['Service-Worker-Allowed'] = '/';
    } else if (baseName === 'manifest.webmanifest') {
      headers['Cache-Control'] = 'no-cache';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- SSE ---------------- */

const sseClients = new Set();

collector.subscribe((snapshot) => {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify(snapshot);
  for (const client of sseClients) {
    try {
      client.write(`event: metrics\ndata: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
});

function handleSse(req, res) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return sendError(res, 401, '未登录');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 3000\n\n');
  // 立即推送一份当前快照
  const latest = collector.getLatest();
  if (latest) res.write(`event: metrics\ndata: ${JSON.stringify(latest)}\n\n`);

  sseClients.add(res);

  const heartbeat = setInterval(() => {
    // res.writableEnded 为真说明连接已结束，无需再写
    if (res.writableEnded) return cleanup();
    try {
      res.write(': ping\n\n');
    } catch (e) {
      cleanup();
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  // 幂等清理：从广播集合移除 + 关闭响应，主动释放 socket
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    sseClients.delete(res);
    try {
      if (!res.writableEnded) res.end();
    } catch (e) {
      /* 连接可能已被对端重置 */
    }
    // 兜底：确保底层 socket 被释放
    try {
      if (!res.socket?.destroyed) res.socket?.destroy?.();
    } catch (e) {
      /* ignore */
    }
  }

  // 客户端断开可能体现在 req 或 res 上，两个都监听
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/* ---------------- 终端输出流 ---------------- */

function handleTerminalStream(req, res, url) {
  const session = getSessionFromRequest(req);
  if (!session) return sendError(res, 401, '未登录');

  const id = url.searchParams.get('id');
  const term = terminals.get(String(id || ''), session.csrf);
  if (!term) return sendError(res, 404, '会话不存在');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  // 订阅输出（自动回放最近的缓冲内容）
  const unsubscribe = term.subscribe((text) => {
    if (text === null) {
      // 会话结束
      try {
        res.write('event: exit\ndata: {}\n\n');
        res.end();
      } catch (e) {
        /* ignore */
      }
      return;
    }
    try {
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    } catch (e) {
      /* ignore */
    }
  }, true);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return cleanup();
    try {
      res.write(': ping\n\n');
    } catch (e) {
      cleanup();
    }
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    try {
      if (!res.writableEnded) res.end();
    } catch (e) {
      /* ignore */
    }
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/* ---------------- DSH 任务事件流（SSE） ---------------- */

function handleDshTaskStream(req, res, url) {
  const session = getSessionFromRequest(req);
  if (!session) return sendError(res, 401, '未登录');

  const id = String(url.searchParams.get('id') || '');
  // sdk- 前缀：SDK 续聊任务（与 headless 任务同构的事件流）
  const isSdkTask = id.startsWith('sdk-');
  const taskRunner = isSdkTask ? sdkRunner : dsh;
  if (!taskRunner.getTask(id)) return sendError(res, 404, '任务不存在');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let cleaned = false;
  let heartbeat = null;
  let unsubscribe = null;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    if (typeof unsubscribe === 'function') unsubscribe();
    try {
      if (!res.writableEnded) res.end();
    } catch (e) {
      /* ignore */
    }
  }

  // 订阅会立即回放已缓冲事件；已完成任务回放后回调 null
  unsubscribe = taskRunner.subscribeTask(id, (payload) => {
    if (cleaned) return;
    if (payload === null) {
      cleanup();
      return;
    }
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      cleanup();
    }
  });

  // 已完成任务在 subscribeTask 内已回放并结束响应：不要再挂心跳，避免连接已结束仍留定时器
  if (cleaned) return;
  if (!unsubscribe) {
    // 任务在查找与订阅之间被清理
    return cleanup();
  }

  heartbeat = setInterval(() => {
    if (res.writableEnded) return cleanup();
    try {
      res.write(': ping\n\n');
    } catch (e) {
      cleanup();
    }
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/* ---------------- 公开下载分享（免登录） ---------------- */

/** 公开端点统一 404：不区分不存在/过期/撤销/用尽，返回简短文本（扫码器友好） */
function sendShareNotFound(res, status = 404) {
  if (res.headersSent) {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
    return;
  }
  const body = '链接无效或已过期\n';
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 按请求 Host 拼公开下载绝对地址（兼容局域网 / tailnet / 反代 HTTPS） */
function publicShareUrl(req, token) {
  const proto = isSecureRequest(req) ? 'https' : 'http';
  let host = String(req.headers.host || '').trim();
  if (!/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) host = `127.0.0.1:${PORT}`;
  return `${proto}://${host}/d/${token}`;
}

/* ---------------- App 自动更新（免登录） ---------------- */

function handleLatestApk(req, res) {
  const latest = appUpdate.latest();
  if (!latest) {
    const body = 'APK 不存在\n';
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  }

  const size = latest.size;
  const range = parseRange(req.headers.range, size);
  if (range && range.invalid) {
    const body = 'Range Not Satisfiable\n';
    res.writeHead(416, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Range': `bytes */${size}`,
    });
    return res.end(body);
  }

  const headers = {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': contentDisposition(latest.filename),
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else {
    headers['Content-Length'] = size;
  }
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = range
    ? fs.createReadStream(latest.filePath, { start: range.start, end: range.end })
    : fs.createReadStream(latest.filePath);
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  stream.pipe(res);
}

function handlePublicShare(req, res, url) {
  const match = /^\/d\/([0-9a-f]{32})(\/qr\.svg)?$/.exec(url.pathname);
  if (!match) return sendShareNotFound(res);

  const token = match[1];
  const isQr = Boolean(match[2]);
  const share = shares.get(token);
  if (!share) return sendShareNotFound(res);

  const shareUrl = publicShareUrl(req, token);

  // 二维码：内容始终是当前请求 Host 下的绝对下载地址
  if (isQr) {
    let svg;
    try {
      svg = generateQrSvg(shareUrl, url.searchParams.get('size'));
    } catch (e) {
      return sendShareNotFound(res);
    }
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(svg),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(svg);
  }

  // 下载：每次请求重新 stat（文件可能已被删除/替换）
  let stat;
  try {
    stat = fs.statSync(share.path);
  } catch (e) {
    shares.revoke(token);
    return sendShareNotFound(res);
  }
  if (!stat.isFile()) {
    shares.revoke(token);
    return sendShareNotFound(res);
  }
  const size = stat.size;

  const range = parseRange(req.headers.range, size);
  if (range && range.invalid) {
    const body = 'Range Not Satisfiable\n';
    res.writeHead(416, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Range': `bytes */${size}`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  const headers = {
    'Content-Type': mimeFor(share.filename),
    'Content-Disposition': contentDisposition(share.filename),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = range.end - range.start + 1;
  } else {
    headers['Content-Length'] = size;
  }
  res.writeHead(range ? 206 : 200, headers);

  // HEAD 只回响应头：不计数、不消耗一次性次数
  if (req.method === 'HEAD') return res.end();

  shares.registerHit(token);
  const deliveredStart = range ? range.start : 0;
  const deliveredEnd = range ? range.end : size - 1;
  res.on('finish', () => shares.noteDelivery(token, size, deliveredStart, deliveredEnd));

  let stream;
  try {
    stream = range
      ? fs.createReadStream(share.path, { start: range.start, end: range.end })
      : fs.createReadStream(share.path);
  } catch (e) {
    try {
      res.destroy();
    } catch (err) {
      /* ignore */
    }
    return;
  }
  stream.on('error', () => {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  res.on('close', () => {
    try {
      stream.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  stream.pipe(res);
}

/* ---------------- API 路由表 ---------------- */

const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

/* ===== 鉴权相关 ===== */

route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const { username, password, remember } = body;
  const result = auth.login(String(username || ''), String(password || ''), clientIp(req), {
    ua: req.headers['user-agent'],
  });
  if (!result.ok) {
    return sendJson(res, 401, { ok: false, error: result.error });
  }

  const cookies = [
    buildSetCookie(COOKIE_NAME, result.session.sid, { maxAge: config.session.ttlSeconds }),
  ];
  const payload = {
    ok: true,
    csrf: result.session.csrf,
    username: result.session.username,
    mustChangePassword: Boolean(config.panel.mustChangePassword),
  };

  // remember=true：额外下发 30 天免登录令牌（服务端只存摘要，响应里只出现过期时间）
  if (remember === true) {
    const issued = auth.issueRemember(result.session.username, req);
    if (issued) {
      cookies.push(buildRememberCookie(req, issued.token, rememberMaxAgeSeconds()));
      payload.remember = { expiresAt: issued.expiresAt };
    }
  }

  setCookieHeaders(res, cookies);
  sendJson(res, 200, payload);
});

route('POST', '/api/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  auth.destroySession(cookies[COOKIE_NAME]);
  const rememberRevoked = auth.revokeRemember(cookies[REMEMBER_COOKIE]);
  setCookieHeaders(res, [
    buildSetCookie(COOKIE_NAME, '', { maxAge: 0 }),
    buildRememberCookie(req, '', 0),
  ]);
  sendJson(res, 200, { ok: true, rememberRevoked });
});

route('GET', '/api/session', async (req, res) => {
  const session = getSessionFromRequest(req);
  if (session) {
    return sendJson(res, 200, {
      ok: true,
      authenticated: true,
      username: session.username,
      csrf: session.csrf,
      mustChangePassword: Boolean(config.panel.mustChangePassword),
    });
  }

  // 会话不存在：尝试用 remember token 自动登录（成功即轮换令牌）
  const cookies = parseCookies(req.headers.cookie);
  const rememberToken = cookies[REMEMBER_COOKIE];
  if (rememberToken) {
    const resumed = auth.resumeRemember(rememberToken, req);
    if (resumed) {
      const remainingSec = Math.max(1, Math.ceil((resumed.remember.expiresAt - Date.now()) / 1000));
      setCookieHeaders(res, [
        buildSetCookie(COOKIE_NAME, resumed.session.sid, { maxAge: config.session.ttlSeconds }),
        buildRememberCookie(req, resumed.remember.token, remainingSec),
      ]);
      return sendJson(res, 200, {
        ok: true,
        authenticated: true,
        username: resumed.session.username,
        csrf: resumed.session.csrf,
        mustChangePassword: Boolean(config.panel.mustChangePassword),
        resumed: true,
        remember: { expiresAt: resumed.remember.expiresAt },
      });
    }
    // token 无效/过期：清 cookie 后按未登录处理
    setCookieHeaders(res, [buildRememberCookie(req, '', 0)]);
  }

  sendJson(res, 200, { ok: true, authenticated: false });
});

// 撤销当前 remember token（幂等，无需登录/CSRF，只认 cookie）
route('POST', '/api/remember/forget', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const revoked = auth.revokeRemember(cookies[REMEMBER_COOKIE]);
  setCookieHeaders(res, [buildRememberCookie(req, '', 0)]);
  sendJson(res, 200, { ok: true, revoked });
});

route('POST', '/api/password', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req);
  const r = auth.changePassword(String(body.currentPassword || ''), String(body.newPassword || ''));
  if (!r.ok) return sendError(res, 400, r.error);
  sendJson(res, 200, { ok: true });
})));

route('POST', '/api/username', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req);
  const r = auth.changeUsername(String(body.password || ''), String(body.username || ''));
  if (!r.ok) return sendError(res, 400, r.error);
  sendJson(res, 200, { ok: true });
})));

/* ===== 系统信息 ===== */

route('GET', '/api/public-info', async (req, res) => {
  const info = readStaticInfo();
  sendJson(res, 200, {
    ok: true,
    hostname: info.hostname,
    osName: info.osName,
    title: config.panel.title,
  });
});

/* ===== App 集成信息（免登录） ===== */

route('GET', '/api/app/info', async (req, res) => {
  sendJson(res, 200, {
    app: 'server-panel',
    version: APP_VERSION,
    name: config.panel.title || '服务器控制面板',
    features: {
      dsh: dsh.enabled,
      pwa: true,
      dshTask: dsh.allowTask,
    },
    endpoints: {
      dshConsole: '/api/dsh/console-url',
    },
  });
});

/* ===== DSH 远程控制 ===== */

route('GET', '/api/dsh/status', requireAuth(async (req, res) => {
  const status = await dsh.status();
  sendJson(res, 200, status);
}));

route('GET', '/api/dsh/console-url', requireAuth(async (req, res) => {
  try {
    const result = await dsh.consoleUrl(req.headers.host);
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 502, {
      error: 'dsh_console_unavailable',
      detail: String(e.detail || e.message || 'unknown'),
    });
  }
}));

/* ===== DSH 会话目录 / 历史 / 能力 ===== */

route('GET', '/api/dsh/sessions', requireAuth(async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit')) || 50;
  const q = url.searchParams.get('q') || '';
  const workspace = url.searchParams.get('workspace') || '';
  try {
    sendJson(res, 200, await sessionCatalog.list({ limit, q, workspace }));
  } catch (e) {
    sendJson(res, 200, { sessions: [], total: 0, truncated: false, error: 'dsh_sessions_failed', detail: String(e.message || e) });
  }
}));

const DSH_HISTORY_RE = /^\/api\/dsh\/sessions\/([A-Za-z0-9_-]{1,80})\/messages$/;

route('GET', DSH_HISTORY_RE, requireAuth(async (req, res, url, match) => {
  const id = match[1];
  const limit = Number(url.searchParams.get('limit')) || 200;
  try {
    const result = await sessionCatalog.messages(id, { limit });
    if (!result) return sendJson(res, 404, { error: 'dsh_session_not_found', detail: '会话不存在' });
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { error: 'dsh_history_failed', detail: String(e.message || e) });
  }
}));

route('GET', '/api/dsh/sdk/status', requireAuth(async (req, res) => {
  const binExists = (() => {
    try {
      return Boolean(dsh.cfg.bin) && fs.statSync(dsh.cfg.bin).isFile();
    } catch (e) {
      return false;
    }
  })();
  const presets = detectPresetPatches(dsh.cfg.bin, dsh.cfg.sdkPresetPatches);
  const providersPatch = dsh.cfg.sdkProvidersPatch || dsh.cfg.patch || '';
  const providersPatchExists = (() => {
    try {
      return Boolean(providersPatch) && fs.statSync(providersPatch).isFile();
    } catch (e) {
      return false;
    }
  })();
  const allowSdkResume = dsh.cfg.allowSdkResume === true;
  const reasons = [];
  if (!allowSdkResume) reasons.push('allowSdkResume=false（在 config.json 的 dsh 中开启）');
  if (!binExists) reasons.push('dsh 可执行文件不存在');
  if (presets.length === 0) reasons.push('未找到 preset patch（dsh-web-app/presets/*.patch.yml 或 config.dsh.sdkPresetPatches）');
  if (!providersPatchExists) reasons.push('providers patch 不存在（dsh.patch / dsh.sdkProvidersPatch）');
  sendJson(res, 200, {
    available: reasons.length === 0,
    allowSdkResume,
    profile: dsh.cfg.sdkProfile || 'sdk',
    presets: presets.map((item) => item.name),
    presetPatches: presets.map((item) => item.path),
    providersPatch: providersPatch || null,
    providersPatchExists,
    reason: reasons.length ? reasons.join('；') : null,
  });
}));

route('GET', '/api/dsh/capabilities', requireAuth(async (req, res) => {
  try {
    sendJson(res, 200, await dshCapabilities.get());
  } catch (e) {
    sendJson(res, 200, { ok: false, error: 'dsh_capabilities_failed', detail: String(e.message || e), historyDecode: sessionCatalog.historyDecode });
  }
}));

const DSH_TASK_ERROR_STATUS = {
  dsh_task_disabled: 403,
  dsh_task_busy: 409,
  dsh_task_invalid: 400,
  dsh_bin_missing: 503,
  dsh_disabled: 503,
  dsh_spawn_failed: 500,
};

route('POST', '/api/dsh/task', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req, 2 * 1024 * 1024);
  try {
    const result = dsh.startTask({ prompt: body.prompt, sessionId: body.sessionId }, req);
    sendJson(res, 200, { id: result.id });
  } catch (e) {
    const code = e.code || 'dsh_task_failed';
    const status = DSH_TASK_ERROR_STATUS[code] || 500;
    sendJson(res, status, { error: code, detail: String(e.detail || e.message || code) });
  }
})));

/* ===== DSH 原生聊天（App 原生聊天页） ===== */

const CHAT_SESSION_RE = /^\/api\/dsh\/chat\/sessions\/([A-Za-z0-9_-]{1,64})$/;
const CHAT_MESSAGES_RE = /^\/api\/dsh\/chat\/sessions\/([A-Za-z0-9_-]{1,64})\/messages$/;

route('GET', '/api/dsh/chat/sessions', requireAuth(async (req, res) => {
  sendJson(res, 200, { sessions: chatStore.listSessions() });
}));

route('POST', '/api/dsh/chat/sessions', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  let title = body.title === undefined || body.title === null ? '' : String(body.title);
  if (title.length > 120) return sendJson(res, 400, { error: 'invalid_title', detail: 'title 不能超过 120 字符' });

  let cwd = '';
  if (body.cwd !== undefined && body.cwd !== null && body.cwd !== '') {
    const candidate = path.resolve(String(body.cwd));
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch (e) {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      return sendJson(res, 400, { error: 'cwd_invalid', detail: 'cwd 必须是已存在的目录' });
    }
    cwd = candidate;
  }

  // 导入已有 DSH 会话：仅 resumable=true 的可由面板续聊（headless 拒绝带 agentPreset 的会话）
  let dshSessionId = null;
  if (body.dshSessionId !== undefined && body.dshSessionId !== null && body.dshSessionId !== '') {
    const targetId = String(body.dshSessionId);
    const meta = await sessionCatalog.get(targetId);
    if (!meta) return sendJson(res, 404, { error: 'dsh_session_not_found', detail: 'DSH 会话不存在' });
    if (!meta.resumable) {
      // 带 agentPreset 的会话 headless 无法续聊；force=true 时用 SDK 通道绑定
      if (body.force === true) {
        if (dsh.cfg.allowSdkResume !== true) {
          return sendJson(res, 400, { error: 'sdk_resume_disabled', detail: 'SDK 续聊未开启（config.dsh.allowSdkResume）' });
        }
        const sdkPresets = detectPresetPatches(dsh.cfg.bin, dsh.cfg.sdkPresetPatches);
        if (sdkPresets.length === 0) {
          return sendJson(res, 400, { error: 'dsh_preset_missing', detail: '未找到 preset patch，无法通过 SDK 续聊' });
        }
      } else {
        const preset = meta.agentPreset ? `agent preset: ${meta.agentPreset}` : '该会话不可续聊';
        return sendJson(res, 400, {
          error: 'dsh_session_not_resumable',
          detail: `该会话由 DSH Web 创建（${preset}），headless 无法续聊；可在 DSH 控制台继续`,
          agentPreset: meta.agentPreset || null,
          hint: dsh.cfg.allowSdkResume ? '可使用 force=true 通过 SDK 通道绑定' : '可在 config.json 开启 dsh.allowSdkResume 后使用 SDK 通道',
        });
      }
    }
    dshSessionId = targetId;
    if (!cwd && meta.cwd) cwd = meta.cwd;
    if (!title && meta.title) title = meta.title;
  }

  const metaForChannel = dshSessionId ? await sessionCatalog.get(dshSessionId).catch(() => null) : null;
  const channel = metaForChannel && metaForChannel.agentPreset && dsh.cfg.allowSdkResume === true ? 'sdk' : 'headless';
  const created = chatStore.createSession(title, { cwd, dshSessionId, channel });
  auditLog(`创建聊天会话 ${created.id}${dshSessionId ? `（绑定 ${dshSessionId}）` : ''}${channel === 'sdk' ? ' [sdk]' : ''}`, req);
  sendJson(res, 200, { ...created, channel });
})));

route('GET', CHAT_SESSION_RE, requireAuth(async (req, res, url, match) => {
  const limit = Number(url.searchParams.get('limit')) || 200;
  const before = url.searchParams.get('before') || '';
  const result = chatStore.getSession(match[1], { limit, before });
  if (!result) return sendJson(res, 404, { error: 'chat_session_not_found', detail: '会话不存在' });
  // 绑定的 DSH 会话信息（供 UI 判断是否可在 DSH 控制台继续 / 是否可续聊）
  const dshSessionId = result.session.dshSessionId;
  let boundDsh = null;
  if (dshSessionId) {
    const meta = await sessionCatalog.get(dshSessionId).catch(() => null);
    boundDsh = meta
      ? {
          id: meta.id,
          resumable: meta.resumable,
          agentPreset: meta.agentPreset,
          cwd: meta.cwd,
          title: meta.title,
          channel: result.session.channel === 'sdk' || meta.agentPreset ? 'sdk' : 'headless',
        }
      : { id: dshSessionId, resumable: false, agentPreset: null, cwd: result.session.cwd || null, missing: true, channel: result.session.channel || 'headless' };
  } else {
    boundDsh = { id: null, resumable: true, agentPreset: null, cwd: result.session.cwd || null, channel: result.session.channel || 'headless' };
  }
  sendJson(res, 200, { ...result, boundDsh });
}));

route('POST', CHAT_MESSAGES_RE, requireAuth(requireCsrf(async (req, res, url, match) => {
  const body = await readBody(req, 2 * 1024 * 1024);
  const sessionId = match[1];
  const chatMeta = chatStore.sessionMeta(sessionId);
  if (!chatMeta) return sendJson(res, 404, { error: 'chat_session_not_found', detail: '会话不存在' });

  const tempPatches = [];
  try {
    // 通道选择：headless（默认）/ sdk（可续聊带 agentPreset 的 Web 会话）/ auto
    let requested = body.channel === undefined || body.channel === null || body.channel === '' ? 'auto' : String(body.channel);
    if (!['headless', 'sdk', 'auto'].includes(requested)) {
      return sendJson(res, 400, { error: 'invalid_channel', detail: 'channel 只能是 headless/sdk/auto' });
    }
    const boundMeta = chatMeta.dshSessionId ? await sessionCatalog.get(chatMeta.dshSessionId).catch(() => null) : null;
    const boundPreset = boundMeta && boundMeta.agentPreset ? boundMeta.agentPreset : null;
    if (requested === 'auto') requested = boundPreset ? 'sdk' : 'headless';

    if (requested === 'sdk') {
      if (dsh.cfg.allowSdkResume !== true) {
        return sendJson(res, 400, {
          error: 'sdk_resume_disabled',
          detail: 'SDK 高级续聊未开启：请在 config.json 的 dsh 中设置 allowSdkResume=true（默认关闭）',
        });
      }
      const presets = detectPresetPatches(dsh.cfg.bin, dsh.cfg.sdkPresetPatches);
      if (presets.length === 0) {
        return sendJson(res, 400, { error: 'dsh_preset_missing', detail: '未找到 preset patch，无法通过 SDK 续聊' });
      }
      if (dsh.cfg.sdkProvidersPatch && !fs.existsSync(dsh.cfg.sdkProvidersPatch)) {
        return sendJson(res, 400, { error: 'dsh_provider_missing', detail: 'sdkProvidersPatch 文件不存在' });
      }
      let dshSessionId = chatMeta.dshSessionId || '';
      if (!dshSessionId && body.dshSessionId) dshSessionId = String(body.dshSessionId);
      if (!dshSessionId) {
        return sendJson(res, 400, { error: 'dsh_session_not_bound', detail: '聊天会话尚未绑定 DSH 会话' });
      }
      const capabilities = await dshCapabilities.get();
      let provider = null;
      let model = null;
      if (body.model !== undefined && body.model !== null && body.model !== '') {
        const resolved = dshCapabilities.resolveModel(body.model, capabilities);
        if (!resolved) {
          return sendJson(res, 400, { error: 'invalid_model', detail: 'model 不在当前 headless/sdk providers 中（provider/model）' });
        }
        provider = resolved.provider;
        model = resolved.model;
      } else if (capabilities && capabilities.ok && capabilities.defaultModel) {
        provider = capabilities.defaultModel.provider;
        model = capabilities.defaultModel.model;
      }
      if (!provider || !model) {
        return sendJson(res, 400, { error: 'dsh_provider_missing', detail: '无法确定 provider/model（请配置 dsh.patch 或在请求中指定 model）' });
      }
      const sessionMetaBound = boundMeta || (await sessionCatalog.get(dshSessionId).catch(() => null));
      const cwd = chatMeta.cwd || (sessionMetaBound && sessionMetaBound.cwd) || dsh.cfg.cwd || ROOT;
      const result = await chatService.sendSdkMessage(sessionId, body.text, {
        runner: sdkRunner,
        dshSessionId,
        provider,
        model,
        cwd,
      });
      auditLog(`聊天 SDK 续聊 session=${sessionId} dsh=${dshSessionId} provider=${provider}/${model}`, req);
      return sendJson(res, 200, result);
    }

    // headless 通道：带 agentPreset 的会话无法用 one-shot runner 续聊
    if (boundPreset) {
      return sendJson(res, 400, {
        error: 'dsh_session_not_resumable',
        detail: `该会话由 DSH Web 创建（agent preset: ${boundPreset}），headless 无法续聊；请使用 channel='sdk'（需开启 dsh.allowSdkResume）`,
        agentPreset: boundPreset,
      });
    }

    let extraPatches = [];
    if (body.model !== undefined && body.model !== null && body.model !== '') {
      const capabilities = await dshCapabilities.get();
      const resolved = dshCapabilities.resolveModel(body.model, capabilities);
      if (!capabilities.ok) {
        return sendJson(res, 400, { error: 'invalid_model', detail: '无法读取 DSH 能力配置（dump-config 失败）' });
      }
      if (!resolved) {
        return sendJson(res, 400, { error: 'invalid_model', detail: 'model 不在当前 headless providers 中（provider/model）' });
      }
      // 临时 patch：覆盖 agent-default-model（任务结束后删除）
      const tmpDir = path.join(DATA_DIR, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const patchFile = path.join(tmpDir, `chat-model-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.yml`);
      const yaml = [
        '- id: agent-default-model',
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        '  config:',
        `    provider: ${resolved.provider}`,
        `    model: ${resolved.model}`,
        '',
      ].join('\n');
      fs.writeFileSync(patchFile, yaml, { mode: 0o600 });
      tempPatches.push(patchFile);
      extraPatches = [patchFile];
      auditLog(`聊天指定模型 ${resolved.provider}/${resolved.model}`, req);
    }
    const result = chatService.sendMessage(sessionId, body.text, { extraPatches, tempPatches });
    sendJson(res, 200, { ...result, channel: 'headless' });
  } catch (e) {
    for (const file of tempPatches) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        /* ignore */
      }
    }
    const code = e.code || 'chat_failed';
    const status = CHAT_ERROR_STATUS[code] || 500;
    sendJson(res, status, { error: code, detail: String(e.detail || e.message || code) });
  }
})));;

route('DELETE', CHAT_SESSION_RE, requireAuth(requireCsrf(async (req, res, url, match) => {
  const removed = chatStore.deleteSession(match[1]);
  if (!removed) return sendJson(res, 404, { error: 'chat_session_not_found', detail: '会话不存在' });
  auditLog(`删除聊天会话 ${match[1]}`, req);
  sendJson(res, 200, { ok: true });
})));

const CHAT_ERROR_STATUS = {
  chat_session_not_found: 404,
  dsh_session_not_found: 404,
  dsh_session_not_resumable: 400,
  cwd_invalid: 400,
  invalid_model: 400,
  dsh_patch_missing: 400,
  sdk_resume_disabled: 400,
  sdk_unavailable: 503,
  dsh_session_not_bound: 400,
  dsh_session_busy_in_web: 400,
  dsh_provider_missing: 400,
  dsh_preset_missing: 400,
  dsh_sdk_timeout: 504,
  dsh_sdk_error: 500,
  invalid_channel: 400,
  chat_text_required: 400,
  chat_text_too_long: 400,
  dsh_task_disabled: 403,
  dsh_task_busy: 409,
  dsh_task_invalid: 400,
  dsh_bin_missing: 503,
  dsh_disabled: 503,
  dsh_spawn_failed: 500,
};

route('GET', '/api/system', requireAuth(async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    static: readStaticInfo(),
    config: {
      title: config.panel.title,
      sampleIntervalMs: config.sampleIntervalMs,
      thresholds: config.thresholds,
      hostname: readStaticInfo().hostname,
    },
  });
}));

route('GET', '/api/metrics/latest', requireAuth(async (req, res) => {
  const latest = collector.getLatest();
  if (!latest) return sendError(res, 503, '采集器尚未就绪');
  sendJson(res, 200, { ok: true, data: latest });
}));

route('GET', '/api/metrics/history', requireAuth(async (req, res, url) => {
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  const maxPoints = Math.min(2000, Math.max(20, Number(url.searchParams.get('points')) || 300));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return sendError(res, 400, '时间范围无效');
  }
  const result = store.query(from, to, maxPoints);
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/metrics/memory-history', requireAuth(async (req, res) => {
  // 内存环形缓冲，最近 10 分钟的秒级数据
  sendJson(res, 200, { ok: true, points: collector.getHistory() });
}));

route('GET', '/api/processes/summary', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...readProcessSummary() });
}));

/* ===== 告警（列表 / 确认 / 规则 / 状态） ===== */

route('GET', '/api/alerts', requireAuth(async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit')) || 200;
  const severity = url.searchParams.get('severity') || '';
  if (severity && !['warn', 'crit'].includes(severity)) {
    return sendJson(res, 400, { error: 'invalid_severity', detail: 'severity 只能是 warn/crit' });
  }
  const unacked = url.searchParams.get('unacked') === '1';
  const list = store.listAlerts(limit, { severity, unacked });
  sendJson(res, 200, { ok: true, alerts: list });
}));

route('POST', '/api/alerts/ack', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return sendJson(res, 400, { error: 'invalid_id', detail: 'id 必须是正整数' });
  }
  const count = store.ackAlerts([id]);
  sendJson(res, 200, { ok: true, count });
})));

route('POST', '/api/alerts/ack_all', requireAuth(requireCsrf(async (req, res) => {
  const count = store.ackAllAlerts();
  sendJson(res, 200, { ok: true, count });
})));

route('GET', '/api/alerts/rules', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...alertsEngine.describe() });
}));

route('PUT', '/api/alerts/rules', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const result = alertsEngine.update(body);
    saveConfig(config);
    auditLog(`更新告警规则 ${result.rules.length} 条 enabled=${alertsEngine.config.enabled}`, req);
    sendJson(res, 200, { ok: true, rules: result.rules });
  } catch (e) {
    sendJson(res, 400, { error: e.code || 'invalid_rules', detail: e.detail || e.message });
  }
})));

route('GET', '/api/alerts/state', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...alertsEngine.stateView() });
}));

/* ===== 通知渠道（不回显密钥） ===== */

route('GET', '/api/notify', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...notifier.describe() });
}));

route('PUT', '/api/notify', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    notifier.update(body);
    saveConfig(config);
    const view = notifier.describe();
    auditLog(`更新通知配置 webhook=${view.webhook.enabled} email=${view.email.enabled} ntfy=${view.ntfy.enabled}`, req);
    sendJson(res, 200, { ok: true, ...view });
  } catch (e) {
    sendJson(res, 400, { error: e.code || 'invalid_notify', detail: e.detail || e.message });
  }
})));

route('POST', '/api/notify/test', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const channel = String(body.channel || '');
  if (!['webhook', 'email', 'ntfy'].includes(channel)) {
    return sendJson(res, 400, { error: 'invalid_channel', detail: 'channel 只能是 webhook/email/ntfy' });
  }
  const result = await notifier.test(channel);
  auditLog(`通知渠道测试 ${channel} ok=${result.ok} detail=${result.detail}`, req);
  sendJson(res, 200, result);
})));

/* ===== 审计日志 / 会话管理 / 备份恢复 / App 更新 ===== */

route('GET', '/api/audit', requireAuth(async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit')) || 200;
  const offset = Number(url.searchParams.get('offset')) || 0;
  const q = url.searchParams.get('q') || '';
  const result = readAuditEntries({ file: path.join(DATA_DIR, 'audit.log'), limit, offset, q });
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/sessions', requireAuth(async (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const currentSid = cookies[COOKIE_NAME] || '';
  const sessions = auth.listSessions().map((item) => ({
    id: item.id,
    username: item.username,
    ip: item.ip,
    ua: item.ua,
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    current: item.sid === currentSid,
  }));
  sendJson(res, 200, { ok: true, sessions });
}));

route('POST', '/api/sessions/revoke', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const id = String(body.id || '');
  const result = auth.revokeSession(id);
  const cookies = parseCookies(req.headers.cookie);
  const currentSid = cookies[COOKIE_NAME] || '';
  const revokedSelf = result.sids.includes(currentSid);
  if (revokedSelf) {
    res.setHeader('Set-Cookie', buildSetCookie(COOKIE_NAME, '', { maxAge: 0 }));
  }
  if (result.revoked) {
    auditLog(`撤销会话 ${id.slice(0, 12)}（${result.count} 个${revokedSelf ? '，含当前会话' : ''}）`, req);
  }
  sendJson(res, 200, { ok: true, revoked: result.revoked });
})));

route('POST', '/api/backup/create', requireAuth(requireCsrf(async (req, res) => {
  try {
    const info = backupManager.create();
    auditLog(`创建备份 ${info.filename} (${info.size}B)`, req);
    sendJson(res, 200, { id: info.id, filename: info.filename, size: info.size, createdAt: info.createdAt });
  } catch (e) {
    sendJson(res, 500, { error: e.code || 'backup_failed', detail: e.detail || e.message });
  }
})));

route('GET', '/api/backup/list', requireAuth(async (req, res) => {
  sendJson(res, 200, { backups: backupManager.list(), auto: backupManager.autoView });
}));

route('PUT', '/api/backup/settings', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  if (body.auto !== undefined && typeof body.auto !== 'boolean') {
    return sendJson(res, 400, { error: 'invalid_settings', detail: 'auto 必须是布尔值' });
  }
  if (body.keep !== undefined) {
    const keep = Number(body.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 30) {
      return sendJson(res, 400, { error: 'invalid_settings', detail: 'keep 必须是 1..30 的整数' });
    }
  }
  const next = {
    ...(config.backup || {}),
    ...(body.auto !== undefined ? { auto: body.auto } : {}),
    ...(body.keep !== undefined ? { keep: Number(body.keep) } : {}),
  };
  backupManager.updateSettings(next);
  config.backup = next;
  saveConfig(config);
  auditLog(`更新备份设置 auto=${backupManager.config.auto} keep=${backupManager.config.keep}`, req);
  sendJson(res, 200, { ok: true, auto: backupManager.autoView });
})));

route('GET', '/api/backup/download', requireAuth(async (req, res, url) => {
  const id = url.searchParams.get('id') || '';
  try {
    const { stream, size, filename } = backupManager.open(id);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': size,
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
    });
    stream.on('error', () => {
      try {
        res.destroy();
      } catch (e) {
        /* ignore */
      }
    });
    stream.pipe(res);
  } catch (e) {
    sendJson(res, 404, { error: e.code || 'backup_not_found' });
  }
}));

route('POST', '/api/backup/delete', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const id = String(body.id || '');
  try {
    backupManager.delete(id);
    auditLog(`删除备份 ${id}`, req);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 404, { error: e.code || 'backup_not_found' });
  }
})));

route('POST', '/api/backup/restore', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  if (body.confirm !== 'RESTORE') {
    return sendJson(res, 400, { error: 'confirm_required', detail: 'confirm 必须为 RESTORE' });
  }
  const id = String(body.id || '');
  try {
    const result = backupManager.restore(id);
    auditLog(`恢复备份 ${id}（原文件已备份为 .bak，需重启）`, req);
    sendJson(res, 200, result);
  } catch (e) {
    const status = e.code === 'backup_not_found' ? 404 : e.code === 'invalid_backup' || e.code === 'invalid_tar' ? 400 : 500;
    sendJson(res, status, { error: e.code || 'restore_failed', detail: e.detail || e.message });
  }
})));

route('GET', '/api/app/update', async (req, res) => {
  try {
    sendJson(res, 200, await appUpdate.info());
  } catch (e) {
    sendJson(res, 200, { version: null });
  }
});

/* ===== B2 特权运维（panel-helper / root 白名单） ===== */

route('GET', '/api/host/status', requireAuth(async (req, res) => {
  const enabled = !config.helper || config.helper.enabled !== false;
  const available = enabled ? await helperClient.available() : false;
  sendJson(res, 200, { helper: available, version: available ? HELPER_VERSION : null });
}));

route('POST', '/api/host/service', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const actionCheck = helperValidate.validateServiceAction(String(body.action || ''));
  if (!actionCheck.ok) return sendInvalidArgs(res, actionCheck.error);
  const unitCheck = helperValidate.validateServiceUnit(body.unit);
  if (!unitCheck.ok) return sendInvalidArgs(res, unitCheck.error);
  const action = actionCheck.value;
  const unit = unitCheck.value;
  try {
    const result = await callHelper(`service.${action}`, { unit });
    auditLog(`特权操作 service.${action} ${unit} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 service.${action} ${unit} 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('POST', '/api/host/process/kill', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const pidCheck = helperValidate.validatePid(body.pid);
  if (!pidCheck.ok) return sendInvalidArgs(res, pidCheck.error);
  const signalCheck = helperValidate.validateSignal(body.signal);
  if (!signalCheck.ok) return sendInvalidArgs(res, signalCheck.error);
  try {
    const result = await callHelper('process.kill', { pid: pidCheck.value, signal: signalCheck.value });
    auditLog(`特权操作 process.kill pid=${pidCheck.value} signal=${signalCheck.value} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 process.kill pid=${pidCheck.value} 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('GET', '/api/host/cron', requireAuth(async (req, res) => {
  try {
    const result = await callHelper('cron.list');
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendHelperError(res, e);
  }
}));

route('POST', '/api/host/cron/write', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const linesCheck = helperValidate.validateCronLines(body.lines);
  if (!linesCheck.ok) return sendInvalidArgs(res, linesCheck.error);
  try {
    const result = await callHelper('cron.write', { lines: linesCheck.value });
    auditLog(`特权操作 cron.write ${linesCheck.value.length} 行 ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 cron.write 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('POST', '/api/host/power', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const actionCheck = helperValidate.validatePowerAction(String(body.action || ''));
  if (!actionCheck.ok) return sendInvalidArgs(res, actionCheck.error);
  const action = actionCheck.value;
  if (action !== 'cancel') {
    const expected = action.toUpperCase();
    if (body.confirm !== expected) {
      return sendJson(res, 400, { error: 'confirm_required', detail: `确认码必须为 ${expected}` });
    }
  }
  try {
    const result = await callHelper(`power.${action}`, {});
    auditLog(`特权操作 power.${action} ok${result && result.delaySeconds ? `（${result.delaySeconds}s 后执行，可用 cancel 取消）` : ''}`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 power.${action} 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('GET', '/api/host/mounts', requireAuth(async (req, res) => {
  try {
    const result = await callHelper('mount.list');
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendHelperError(res, e);
  }
}));

route('POST', '/api/host/mount', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const deviceCheck = helperValidate.validateMountDevice(body.device);
  if (!deviceCheck.ok) return sendInvalidArgs(res, deviceCheck.error);
  const pointCheck = helperValidate.validateMountPoint(body.mountPoint);
  if (!pointCheck.ok) return sendInvalidArgs(res, pointCheck.error);
  try {
    const result = await callHelper('mount.mount', { device: deviceCheck.value, mountPoint: pointCheck.value });
    auditLog(`特权操作 mount.mount ${deviceCheck.value} -> ${pointCheck.value} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 mount.mount 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('POST', '/api/host/umount', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const pointCheck = helperValidate.validateMountPoint(body.mountPoint);
  if (!pointCheck.ok) return sendInvalidArgs(res, pointCheck.error);
  try {
    const result = await callHelper('mount.umount', { mountPoint: pointCheck.value });
    auditLog(`特权操作 mount.umount ${pointCheck.value} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 mount.umount 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('GET', '/api/host/firewall', requireAuth(async (req, res) => {
  try {
    const result = await callHelper('firewall.status');
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendHelperError(res, e);
  }
}));

route('POST', '/api/host/firewall', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const actionCheck = helperValidate.validateFirewallAction(String(body.action || ''));
  if (!actionCheck.ok) return sendInvalidArgs(res, actionCheck.error);
  const action = actionCheck.value;
  if (action === 'status') return sendInvalidArgs(res, 'status 请使用 GET /api/host/firewall');
  try {
    let result;
    if (action === 'enable' || action === 'disable') {
      result = await callHelper(`firewall.${action}`, {});
    } else {
      const ruleCheck = helperValidate.validateFirewallRule({
        mode: action,
        port: body.port,
        proto: body.proto,
        profile: body.profile,
      });
      if (!ruleCheck.ok) return sendInvalidArgs(res, ruleCheck.error);
      const args = {};
      if (ruleCheck.value.port !== undefined) {
        args.port = ruleCheck.value.port;
        args.proto = ruleCheck.value.proto;
      } else {
        args.profile = ruleCheck.value.profile;
      }
      if (action === 'delete') args.ruleAction = body.ruleAction === 'deny' ? 'deny' : 'allow';
      result = await callHelper(`firewall.${action}`, args);
    }
    auditLog(`特权操作 firewall.${action} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 firewall.${action} 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

route('GET', '/api/host/packages/upgradable', requireAuth(async (req, res) => {
  try {
    const result = await callHelper('packages.upgradable');
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendHelperError(res, e);
  }
}));

route('POST', '/api/host/packages', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const action = String(body.action || '');
  if (!['update', 'upgrade'].includes(action)) {
    return sendInvalidArgs(res, "packages action 仅允许 update/upgrade");
  }
  if (action === 'upgrade' && body.confirm !== 'UPGRADE') {
    return sendJson(res, 400, { error: 'confirm_required', detail: '升级确认码必须为 UPGRADE' });
  }
  try {
    const result = await callHelper(`packages.${action}`, { confirm: body.confirm });
    auditLog(`特权操作 packages.${action} ok`, req);
    sendJson(res, 200, { ok: true, result });
  } catch (e) {
    auditLog(`特权操作 packages.${action} 失败 code=${e.code || 'helper_error'}`, req);
    sendHelperError(res, e);
  }
})));

/* ===== 进程 / 服务 / 日志 ===== */

route('GET', '/api/processes', requireAuth(async (req, res, url) => {
  const sort = url.searchParams.get('sort') || 'cpu';
  const limit = Number(url.searchParams.get('limit')) || 500;
  const filter = url.searchParams.get('filter') || '';
  const result = listProcesses({ sort, limit, filter });
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/services', requireAuth(async (req, res) => {
  const result = await listServices();
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/logs', requireAuth(async (req, res, url) => {
  const lines = Number(url.searchParams.get('lines')) || 200;
  const unit = url.searchParams.get('unit') || null;
  const out = await readLogs(lines, unit);
  sendJson(res, 200, { ok: true, lines: out });
}));

/* ===== 扩展检测 ===== */

route('GET', '/api/connections', requireAuth(async (req, res, url) => {
  const state = url.searchParams.get('state') || undefined;
  const limit = Number(url.searchParams.get('limit')) || 500;
  const result = extra.listConnections({ state, limit });
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/ports', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ports: extra.listListenPorts() });
}));

route('GET', '/api/netstats', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, stats: extra.readNetStats() });
}));

route('GET', '/api/cron', requireAuth(async (req, res) => {
  const result = await extra.listCronJobs();
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/modules', requireAuth(async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit')) || 300;
  sendJson(res, 200, { ok: true, modules: extra.listKernelModules(limit) });
}));

route('GET', '/api/packages', requireAuth(async (req, res, url) => {
  const limit = Number(url.searchParams.get('limit')) || 100;
  const result = await extra.listPackages(limit);
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/inodes', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, inodes: extra.readInodes() });
}));

route('GET', '/api/timesync', requireAuth(async (req, res) => {
  const result = await extra.readTimeSync();
  sendJson(res, 200, { ok: true, ...result });
}));

route('GET', '/api/boot', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...extra.readBootInfo(), vm: extra.readVmStats() });
}));

route('GET', '/api/disks/smart', requireAuth(async (req, res, url) => {
  const device = url.searchParams.get('device');
  const force = url.searchParams.get('force') === '1';
  try {
    if (device) {
      const data = await smart.readOneSmart(String(device), force);
      return sendJson(res, 200, { ok: true, ...data });
    }
    const result = await smart.readAllSmart(force);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJson(res, 200, { ok: false, available: false, reason: e.message, disks: [] });
  }
}));

route('GET', '/api/disks/info', requireAuth(async (req, res) => {
  const disks = extra.listDisksInfo();
  sendJson(res, 200, { ok: true, disks });
}));

route('GET', '/api/gpu', requireAuth(async (req, res) => {
  const latest = collector.getLatest();
  sendJson(res, 200, { ok: true, gpu: latest ? latest.gpu : null });
}));

route('GET', '/api/cpu/cores', requireAuth(async (req, res) => {
  const latest = collector.getLatest();
  if (!latest) return sendError(res, 503, '采集器尚未就绪');
  sendJson(res, 200, {
    ok: true,
    cores: latest.cpu.perCore,
    coreCount: latest.cpu.coreCount,
    freq: latest.cpu.freq,
    throttle: latest.cpu.throttle,
    temp: latest.cpu.temp,
  });
}));

route('GET', '/api/disks/queue', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, disks: extra.readDiskSchedulers() });
}));

route('GET', '/api/sensors', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...extra.readAllSensors() });
}));

route('GET', '/api/pci', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, devices: extra.listPciDevices() });
}));

route('GET', '/api/interfaces/stats', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, interfaces: extra.readInterfaceStats() });
}));

/* ===== Docker 管理 ===== */

route('GET', '/api/docker/status', requireAuth(async (req, res) => {
  const docker = getDockerClient();
  const probe = await docker.probe();
  let info = null;
  if (probe.reachable) {
    try {
      info = await docker.systemInfo();
    } catch (e) {
      info = null;
    }
  }
  sendJson(res, 200, { ok: true, ...probe, info });
}));

route('GET', '/api/docker/containers', requireAuth(async (req, res, url) => {
  const all = url.searchParams.get('all') !== '0';
  try {
    const docker = getDockerClient();
    const containers = await docker.listContainers(all);
    sendJson(res, 200, { ok: true, containers });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message, code: e.code, containers: [] });
  }
}));

route('GET', '/api/docker/containers/detail', requireAuth(async (req, res, url) => {
  const id = url.searchParams.get('id');
  if (!id) return sendError(res, 400, '缺少容器 id');
  try {
    const docker = getDockerClient();
    const [detail, stats] = await Promise.all([
      docker.inspectContainer(id),
      docker.containerStats(id).catch(() => null),
    ]);
    sendJson(res, 200, { ok: true, detail, stats });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}));

route('GET', '/api/docker/containers/logs', requireAuth(async (req, res, url) => {
  const id = url.searchParams.get('id');
  const tail = Number(url.searchParams.get('tail')) || 200;
  if (!id) return sendError(res, 400, '缺少容器 id');
  try {
    const docker = getDockerClient();
    const lines = await docker.containerLogs(id, tail);
    sendJson(res, 200, { ok: true, lines });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}));

route('POST', '/api/docker/containers/action', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const { id, action } = body;
  if (!id || !action) return sendError(res, 400, '缺少参数');
  try {
    const docker = getDockerClient();
    const result = await docker.containerAction(String(id), String(action));
    auditLog(`docker 容器 ${action}: ${id}`);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/docker/containers/remove', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const { id, force } = body;
  if (!id) return sendError(res, 400, '缺少容器 id');
  try {
    const docker = getDockerClient();
    await docker.removeContainer(String(id), Boolean(force));
    auditLog(`docker 删除容器: ${id} force=${Boolean(force)}`);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('GET', '/api/docker/images', requireAuth(async (req, res) => {
  try {
    const docker = getDockerClient();
    const images = await docker.listImages();
    sendJson(res, 200, { ok: true, images });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message, images: [] });
  }
}));

route('POST', '/api/docker/images/remove', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const { id, force } = body;
  if (!id) return sendError(res, 400, '缺少镜像 id');
  try {
    const docker = getDockerClient();
    await docker.removeImage(String(id), Boolean(force));
    auditLog(`docker 删除镜像: ${id}`);
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('GET', '/api/docker/networks', requireAuth(async (req, res) => {
  try {
    const docker = getDockerClient();
    const networks = await docker.listNetworks();
    sendJson(res, 200, { ok: true, networks });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message, networks: [] });
  }
}));

route('GET', '/api/docker/volumes', requireAuth(async (req, res) => {
  try {
    const docker = getDockerClient();
    const volumes = await docker.listVolumes();
    sendJson(res, 200, { ok: true, volumes });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message, volumes: [] });
  }
}));

route('GET', '/api/docker/df', requireAuth(async (req, res) => {
  try {
    const docker = getDockerClient();
    const usage = await docker.diskUsage();
    sendJson(res, 200, { ok: true, usage });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message, usage: null });
  }
}));

/* ===== Docker compose ===== */

route('GET', '/api/docker/compose', requireAuth(async (req, res) => {
  try {
    const docker = getDockerClient();
    const containers = await docker.listContainers(true);
    sendJson(res, 200, { ok: true, projects: groupComposeProjects(containers) });
  } catch (e) {
    // 无 docker / socket 不可用时优雅降级为空列表（不 500）
    sendJson(res, 200, { ok: false, available: false, error: 'docker_unavailable', projects: [] });
  }
}));

route('POST', '/api/docker/compose/action', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const project = String(body.project || '');
  const action = String(body.action || '');
  if (!['start', 'stop', 'restart'].includes(action)) {
    return sendError(res, 400, '不支持的动作（start/stop/restart）');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(project)) {
    return sendError(res, 400, '项目名非法');
  }
  let containers;
  try {
    containers = await getDockerClient().listContainers(true);
  } catch (e) {
    return sendJson(res, 503, { error: 'docker_unavailable', detail: 'Docker 不可用' });
  }
  const targets = containers.filter((c) => c.labels && c.labels['com.docker.compose.project'] === project);
  if (targets.length === 0) {
    return sendJson(res, 404, { error: 'project_not_found', detail: 'compose 项目不存在或没有容器' });
  }
  const docker = getDockerClient();
  const results = [];
  for (const container of targets) {
    try {
      await docker.containerAction(container.id, action);
      results.push({ id: container.shortId, name: container.name, ok: true });
    } catch (e) {
      results.push({ id: container.shortId, name: container.name, ok: false, error: e.message });
    }
  }
  auditLog(`compose ${action} ${project}（${targets.length} 个容器）`, req);
  sendJson(res, 200, { ok: true, project, action, results });
})));

/* ===== 性能压测 ===== */

route('GET', '/api/bench/status', requireAuth(async (req, res) => {
  sendJson(res, 200, { ok: true, ...bench.status() });
}));

route('POST', '/api/bench/start', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const kind = String(body.kind || '');
  if (!['cpu', 'memory', 'disk', 'network'].includes(kind)) {
    return sendError(res, 400, '不支持的类型（cpu / memory / disk / network）');
  }
  if (bench.current) {
    return sendError(res, 409, '已有压测任务在运行，请先中止');
  }

  auditLog(`压测开始 ${kind} ${JSON.stringify(body)}`);

  // 异步执行，立刻返回，前端轮询 /api/bench/status
  const runner = {
    cpu: () => bench.runCpu(body),
    memory: () => bench.runMemory(body),
    disk: () => bench.runDisk(body),
    network: () => bench.runNetwork(body),
  }[kind];

  runner()
    .then((result) => {
      auditLog(`压测完成 ${kind} score=${result.score}`);
      try {
        store.saveBench(kind, body, result.score || 0, result.durationMs || 0, result);
      } catch (e) {
        console.error('[bench] 结果入库失败:', e.message);
      }
    })
    .catch((e) => {
      auditLog(`压测失败 ${kind}: ${e.message}`);
      console.error('[bench]', e.message);
    });

  sendJson(res, 200, { ok: true, started: kind });
})));

route('POST', '/api/bench/abort', requireAuth(requireCsrf(async (req, res) => {
  const r = bench.abort('用户中止');
  auditLog('压测中止');
  sendJson(res, 200, { ok: r.ok, ...r });
})));

route('GET', '/api/bench/history', requireAuth(async (req, res, url) => {
  const kind = url.searchParams.get('kind') || null;
  const rows = store.listBench(kind, 50).map((r) => ({
    id: r.id,
    at: r.ts,
    kind: r.kind,
    score: r.score,
    durationMs: r.duration_ms,
    params: safeJson(r.params),
    detail: safeJson(r.detail),
  }));
  sendJson(res, 200, { ok: true, results: rows });
}));

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/* ===== 文件管理 ===== */

route('GET', '/api/files/list', requireAuth(async (req, res, url) => {
  const target = url.searchParams.get('path') || '/';
  const showHidden = url.searchParams.get('hidden') === '1';
  try {
    const result = await files.listDir(target, { showHidden });
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}));

route('GET', '/api/files/read', requireAuth(async (req, res, url) => {
  const target = url.searchParams.get('path');
  if (!target) return sendError(res, 400, '缺少 path 参数');
  try {
    const result = await files.readText(target);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}));

route('POST', '/api/files/write', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req, 16 * 1024 * 1024);
  const target = String(body.path || '');
  try {
    const result = await files.writeText(target, String(body.content ?? ''));
    auditLog(`文件写入 ${result.path} (${result.size}B)`);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/mkdir', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.makeDir(String(body.path || ''));
    auditLog(`新建目录 ${r.path}`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/touch', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.makeFile(String(body.path || ''));
    auditLog(`新建文件 ${r.path}`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/rename', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.rename(String(body.from || ''), String(body.to || ''));
    auditLog(`重命名 ${r.from} -> ${r.to}`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/delete', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const useTrash = body.trash !== false;
  try {
    // 批量（paths）或单个（path）
    if (Array.isArray(body.paths)) {
      if (body.paths.length === 0) return sendError(res, 400, 'paths 不能为空');
      if (body.paths.length > files.BATCH_LIMIT) return sendError(res, 400, `单次最多 ${files.BATCH_LIMIT} 项`);
      if (useTrash) {
        const result = await files.batchOp({ op: 'delete', paths: body.paths, trashRoot: TRASH_ROOT });
        auditLog(`批量删除 ${result.done.length} 项到回收站`, req);
        return sendJson(res, 200, { ok: true, trashed: result.done });
      }
      const removed = [];
      for (const target of body.paths) removed.push(await files.remove(String(target)));
      auditLog(`批量永久删除 ${removed.length} 项`, req);
      return sendJson(res, 200, { ok: true, removed });
    }

    const target = String(body.path || '');
    if (useTrash) {
      const entry = await files.trashPut(TRASH_ROOT, target);
      auditLog(`删除到回收站 ${entry.path}${entry.type === 'dir' ? ' (目录)' : ''}`, req);
      return sendJson(res, 200, { ok: true, path: entry.path, wasDir: entry.type === 'dir', trash: entry });
    }
    const r = await files.remove(target);
    auditLog(`永久删除 ${r.path}${r.wasDir ? ' (目录)' : ''}`, req);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

/* ===== 文件批量 / 回收站 ===== */

route('POST', '/api/files/batch', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const result = await files.batchOp({
      op: body.op,
      paths: body.paths,
      target: body.target,
      trashRoot: TRASH_ROOT,
    });
    auditLog(`批量${result.op} ${result.done.length} 项${body.target ? ` -> ${body.target}` : ''}`, req);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    if (e.code === 'conflicts') {
      return sendJson(res, 400, { error: 'conflicts', detail: e.message, conflicts: e.conflicts });
    }
    if (['invalid_op', 'invalid_paths', 'too_many_paths', 'invalid_target', 'invalid_path'].includes(e.code)) {
      return sendJson(res, 400, { error: e.code, detail: e.message });
    }
    sendError(res, 400, e.message);
  }
})));

route('GET', '/api/trash/list', requireAuth(async (req, res) => {
  try {
    const entries = await files.trashList(TRASH_ROOT);
    sendJson(res, 200, { ok: true, entries });
  } catch (e) {
    sendJson(res, 200, { ok: false, entries: [], error: e.message });
  }
}));

route('POST', '/api/trash/restore', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const result = await files.trashRestore(TRASH_ROOT, String(body.id || ''));
    auditLog(`回收站恢复 ${result.path}`, req);
    sendJson(res, 200, { ok: true, ...result });
  } catch (e) {
    const status = e.code === 'trash_not_found' ? 404 : e.code === 'target_exists' ? 409 : 400;
    sendJson(res, status, { error: e.code || 'restore_failed', detail: e.message });
  }
})));

route('POST', '/api/trash/purge', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const result = await files.trashPurge(TRASH_ROOT, { id: body.id, all: body.all === true });
    auditLog(`回收站清理 ${result.count} 项`, req);
    sendJson(res, 200, { ok: true, count: result.count });
  } catch (e) {
    const status = e.code === 'trash_not_found' ? 404 : 400;
    sendJson(res, status, { error: e.code || 'purge_failed', detail: e.message });
  }
})));

route('POST', '/api/files/chmod', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.chmod(String(body.path || ''), body.mode);
    auditLog(`修改权限 ${r.path} -> ${r.mode}`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/compress', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.compress(body.sources || [], String(body.dest || ''), body.cwd);
    auditLog(`压缩 -> ${r.path} (${files.fmtSize(r.size)})`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('POST', '/api/files/extract', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  try {
    const r = await files.extract(String(body.archive || ''), String(body.dest || ''));
    auditLog(`解压 ${r.archive} -> ${r.path}`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('GET', '/api/files/download', requireAuth(async (req, res, url) => {
  const target = url.searchParams.get('path');
  if (!target) return sendError(res, 400, '缺少 path 参数');
  try {
    const { stream, size, name } = await files.openReadStream(target);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    stream.pipe(res);
    stream.on('error', () => {
      try { res.destroy(); } catch (e) { /* ignore */ }
    });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}));

route('POST', '/api/files/upload', requireAuth(requireCsrf(async (req, res, url) => {
  const dir = url.searchParams.get('dir') || '/';
  const fileName = url.searchParams.get('name') || '';
  try {
    const r = await files.saveUpload(dir, fileName, req);
    auditLog(`上传 ${r.path} (${files.fmtSize(r.size)})`);
    sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

/* ===== 文件下载分享 ===== */

route('POST', '/api/download/share', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
  if (!rawPath || rawPath.includes('\0')) {
    return sendJson(res, 400, { error: 'invalid_path', detail: 'path 无效' });
  }
  if (!path.isAbsolute(rawPath)) {
    return sendJson(res, 400, { error: 'invalid_path', detail: '必须是绝对路径' });
  }
  const resolved = path.resolve(rawPath);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'file_not_found' });
    return sendJson(res, 400, { error: 'file_unavailable', detail: e.code || e.message });
  }
  if (!stat.isFile()) {
    return sendJson(res, 400, { error: 'not_a_regular_file', detail: '只允许普通文件' });
  }
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (e) {
    return sendJson(res, 400, { error: 'not_readable' });
  }

  let ttlMinutes;
  if (body.ttlMinutes !== undefined && body.ttlMinutes !== null) {
    ttlMinutes = Number(body.ttlMinutes);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      return sendJson(res, 400, { error: 'invalid_ttl', detail: 'ttlMinutes 必须是 1..1440 的整数' });
    }
  }
  const once = body.once === true;

  let share;
  try {
    share = shares.create({
      filePath: resolved,
      filename: path.basename(resolved),
      size: stat.size,
      ttlMinutes,
      once,
    });
  } catch (e) {
    if (e.code === 'share_limit_reached') {
      return sendJson(res, 429, { error: 'share_limit_reached', detail: '分享数量已达上限' });
    }
    return sendError(res, 500, '创建分享失败');
  }

  const url = publicShareUrl(req, share.token);
  auditLog(`分享下载 ${resolved} (${stat.size}B) 到期 ${new Date(share.expiresAt).toISOString()} once=${once}`, req);
  sendJson(res, 200, {
    token: share.token,
    url,
    qrUrl: `${url}/qr.svg`,
    filename: share.filename,
    size: share.size,
    expiresAt: share.expiresAt,
    once: share.once,
  });
})));

route('GET', '/api/download/shares', requireAuth(async (req, res) => {
  sendJson(res, 200, { shares: shares.list() });
}));

route('POST', '/api/download/revoke', requireAuth(requireCsrf(async (req, res) => {
  const body = await readBody(req);
  const token = String(body.token || '');
  const share = shares.get(token);
  const revoked = shares.revoke(token);
  if (revoked) {
    auditLog(`撤销下载分享 ${token.slice(0, 8)}… ${share ? share.path : ''}`, req);
  }
  sendJson(res, 200, { ok: true, revoked });
})));

/* ===== Web 终端 ===== */

route('POST', '/api/terminal/create', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req);
  try {
    // 可选容器终端：严格校验 cid/名称，再向 Docker 确认容器存在
    let container = null;
    if (body.container !== undefined && body.container !== null && body.container !== '') {
      const refCheck = validateContainerRef(body.container);
      if (!refCheck.ok) return sendError(res, 400, refCheck.error);
      let containers;
      try {
        containers = await getDockerClient().listContainers(true);
      } catch (e) {
        return sendJson(res, 503, { error: 'docker_unavailable', detail: 'Docker 不可用' });
      }
      const ref = refCheck.value;
      const match = containers.find(
        (c) =>
          c.id === ref ||
          c.shortId === ref ||
          c.name === ref ||
          (ref.length >= 12 && /^[0-9a-f]+$/i.test(ref) && c.id.startsWith(ref))
      );
      if (!match) return sendJson(res, 404, { error: 'container_not_found', detail: '容器不存在' });
      container = { id: match.id, name: match.name };
    }

    const s = terminals.create({
      ownerSid: session.csrf, // 用会话标识绑定所有权
      cols: body.cols,
      rows: body.rows,
      container,
    });
    auditLog(
      container
        ? `打开容器终端 ${container.name} (${container.id.slice(0, 8)})`
        : `打开终端 ${s.id.slice(0, 8)}`,
      req
    );
    sendJson(res, 200, { ok: true, ...s.info() });
  } catch (e) {
    sendError(res, 400, e.message);
  }
})));

route('GET', '/api/terminal/list', requireAuth(async (req, res, url, session) => {
  sendJson(res, 200, { ok: true, sessions: terminals.list(session.csrf) });
}));

route('POST', '/api/terminal/input', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req, 256 * 1024);
  const s = terminals.get(String(body.id || ''), session.csrf);
  if (!s) return sendError(res, 404, '会话不存在');
  const r = s.write(body.data);
  if (!r.ok) return sendError(res, 400, r.error);
  sendJson(res, 200, { ok: true });
})));

route('POST', '/api/terminal/resize', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req);
  const s = terminals.get(String(body.id || ''), session.csrf);
  if (!s) return sendError(res, 404, '会话不存在');
  const r = s.resize(body.cols, body.rows);
  sendJson(res, 200, { ok: true, ...r });
})));

route('POST', '/api/terminal/close', requireAuth(requireCsrf(async (req, res, url, session) => {
  const body = await readBody(req);
  const r = terminals.close(String(body.id || ''), session.csrf);
  auditLog(`关闭终端 ${String(body.id || '').slice(0, 8)}`);
  sendJson(res, 200, { ok: r.ok, error: r.error });
})));

/* ---------------- 请求分发 ---------------- */

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    // 非法 Host / 请求行不能变成未捕获异常拖垮进程
    return sendError(res, 400, '请求地址无效');
  }
  const pathname = url.pathname;

  // 安全响应头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    // SSE 单独处理
    if (pathname === '/api/stream' && req.method === 'GET') {
      return handleSse(req, res);
    }

    // 终端输出流
    if (pathname === '/api/terminal/stream' && req.method === 'GET') {
      return handleTerminalStream(req, res, url);
    }

    // DSH 任务事件流
    if (pathname === '/api/dsh/task/stream' && req.method === 'GET') {
      return handleDshTaskStream(req, res, url);
    }

    // 公开下载分享（免登录；只认 token，永不回退到 SPA）
    if ((pathname === '/d' || pathname.startsWith('/d/')) && (req.method === 'GET' || req.method === 'HEAD')) {
      return handlePublicShare(req, res, url);
    }

    // App 自动更新：最新 APK（免登录）
    if (pathname === '/app/latest.apk' && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleLatestApk(req, res);
    }

    // API 路由匹配（/api 与 /api/* 一律 JSON，绝不回退到 SPA HTML）
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        if (r.pattern instanceof RegExp) {
          const match = r.pattern.exec(pathname);
          if (match) return await r.handler(req, res, url, match);
          continue;
        }
        if (r.pattern === pathname) {
          return await r.handler(req, res, url);
        }
      }
      return sendError(res, 404, '接口不存在');
    }

    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    sendError(res, 405, '方法不允许');
  } catch (e) {
    console.error('[server] 请求处理异常:', e);
    if (!res.headersSent) {
      sendError(res, 500, e.message || '服务器内部错误');
    }
  }
}

const server = http.createServer(handleRequest);

/* ---------------- 定时维护 ---------------- */

setInterval(() => {
  auth.sweep();
  shares.sweep();
  // 自动备份：每天 hour 点后检查一次（可补跑当天）
  try {
    backupManager.checkAuto(new Date());
  } catch (e) {
    /* 自动备份失败不影响面板 */
  }
  // 回收站：每天清理超过保留天数的条目
  if (Date.now() - lastTrashCleanup >= 24 * 60 * 60 * 1000) {
    lastTrashCleanup = Date.now();
    files
      .trashCleanup(TRASH_ROOT, TRASH_RETENTION_DAYS)
      .then((result) => {
        if (result.count > 0) console.log(`[trash] 清理过期条目 ${result.count} 个`);
      })
      .catch(() => {});
  }
}, 5 * 60 * 1000).unref();

/* ---------------- 启动 ---------------- */

collector.start();

const PORT = Number(process.env.PANEL_PORT || config.port || 3081);
const HOST = process.env.PANEL_HOST || config.host || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  服务器控制面板已启动`);
  console.log(`  本机访问：http://127.0.0.1:${PORT}`);
  console.log(`  局域网：  http://${readStaticInfo().hostname}:${PORT}`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请修改 config.json 中的 port`);
  } else {
    console.error('服务启动失败:', e.message);
  }
  process.exit(1);
});

/* ---------------- 可选 TLS listener（默认关闭） ---------------- */

const extraServers = [];

function startTlsListener() {
  const tlsCfg = config.tls;
  if (!tlsCfg || typeof tlsCfg !== 'object') return;

  const certPath = tlsCfg.cert;
  const keyPath = tlsCfg.key;
  if (!certPath || !keyPath) {
    console.warn('[tls] config.tls 存在但缺少 cert/key，仅启用 HTTP');
    return;
  }

  let cert;
  let key;
  try {
    cert = fs.readFileSync(String(certPath));
    key = fs.readFileSync(String(keyPath));
  } catch (e) {
    // 证书缺失/不可读：只告警，不影响 HTTP 启动
    console.warn(`[tls] 证书读取失败，仅启用 HTTP: ${e.message}`);
    return;
  }

  let https;
  try {
    https = require('node:https');
  } catch (e) {
    console.warn(`[tls] 无法加载 node:https，仅启用 HTTP: ${e.message}`);
    return;
  }

  const tlsPort = Number(tlsCfg.port) || 3443;
  try {
    const secureServer = https.createServer({ cert, key }, handleRequest);
    secureServer.on('error', (e) => {
      console.warn(`[tls] HTTPS listener 异常（HTTP 不受影响）: ${e.message}`);
    });
    secureServer.listen(tlsPort, HOST, () => {
      console.log(`  HTTPS：  https://${readStaticInfo().hostname}:${tlsPort}`);
    });
    extraServers.push(secureServer);
  } catch (e) {
    console.warn(`[tls] HTTPS listener 创建失败（仅启用 HTTP）: ${e.message}`);
  }
}

startTlsListener();

/* ---------------- 优雅退出 ---------------- */

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭...`);
  collector.stop();
  terminals.closeAll();
  dsh.closeAll();
  shares.close();
  chatStore.close();
  sdkRunner.closeAll();
  for (const c of sseClients) {
    try {
      c.end();
    } catch (e) {
      /* ignore */
    }
  }
  sseClients.clear();
  for (const extra of extraServers) {
    try {
      extra.close();
    } catch (e) {
      /* ignore */
    }
  }
  extraServers.length = 0;
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
