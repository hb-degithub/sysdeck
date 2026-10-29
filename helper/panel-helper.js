'use strict';

/**
 * panel-helper —— 最小授权 root 特权助手
 *
 * - 仅监听 Unix Socket（默认 /run/server-panel/helper.sock，目录 0750 root:hb，socket 0660 root:hb）
 * - 协议：一行一个 JSON，HMAC-SHA256 + 时间戳(±60s) + nonce 去重（见 helper/protocol.js）
 * - 只实现白名单 op，全部参数经 helper/validate.js 严格校验；非法参数一律拒绝并记日志
 * - 所有调用写日志（默认 /var/log/server-panel-helper.log，0600）
 * - 所有外部命令用 execFile / spawn 数组传参，绝不拼接 shell 字符串
 *
 * 环境变量（install-helper.sh 会写入 systemd unit；测试用它们降权/隔离运行）：
 *   PANEL_HELPER_SOCKET   socket 路径
 *   PANEL_HELPER_SECRET   密钥文件（≥32 字符）
 *   PANEL_HELPER_LOG      日志路径
 *   PANEL_HELPER_USER     cron 操作目标用户（默认 hb）
 *   PANEL_HELPER_GID      socket/目录所属组 gid（root 运行时生效）
 *   PANEL_HELPER_EXEC_TIMEOUT_MS / PANEL_HELPER_APT_TIMEOUT_MS
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const validate = require('./validate');
const protocol = require('./protocol');

const VERSION = '1.0.0';

const SOCKET_PATH = process.env.PANEL_HELPER_SOCKET || '/run/server-panel/helper.sock';
const SECRET_FILE = process.env.PANEL_HELPER_SECRET || '/etc/server-panel/helper.secret';
const LOG_FILE = process.env.PANEL_HELPER_LOG || '/var/log/server-panel-helper.log';
const PANEL_USER = process.env.PANEL_HELPER_USER || 'hb';
const GID = Number.isInteger(Number(process.env.PANEL_HELPER_GID)) ? Number(process.env.PANEL_HELPER_GID) : 0;
const EXEC_TIMEOUT_MS = Number(process.env.PANEL_HELPER_EXEC_TIMEOUT_MS) > 0 ? Number(process.env.PANEL_HELPER_EXEC_TIMEOUT_MS) : 15000;
const APT_TIMEOUT_MS = Number(process.env.PANEL_HELPER_APT_TIMEOUT_MS) > 0 ? Number(process.env.PANEL_HELPER_APT_TIMEOUT_MS) : 300000;

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_OUTPUT = 32 * 1024;

let secret = '';
const nonces = new protocol.NonceCache();

/* ---------------- 错误 ---------------- */

class OpError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || code;
  }
}

const denied = (detail) => new OpError('helper_denied', detail);
const opFailed = (detail) => new OpError('helper_error', detail);

/* ---------------- 日志 ---------------- */

function ensureLogFile() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o750 });
  } catch (e) {
    /* ignore */
  }
  try {
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', { mode: 0o600 });
    else fs.chmodSync(LOG_FILE, 0o600);
  } catch (e) {
    /* 日志不可写不应阻止 helper 启动，但会打印到 stderr */
  }
}

function logEvent(entry) {
  const record = {
    ts: new Date().toISOString(),
    version: VERSION,
    ...entry,
  };
  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch (e) {
    console.error('[helper] 写日志失败:', e.code || e.message);
  }
}

/* ---------------- 命令执行（无 shell） ---------------- */

function truncate(text, max = MAX_RESPONSE_OUTPUT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}

function runFile(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: options.timeoutMs || EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({
          code,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          errorCode: error && typeof error.code === 'string' ? error.code : null,
          killed: Boolean(error && error.killed),
        });
      }
    );
  });
}

function runWithInput(cmd, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnSafe(cmd, args, options);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: truncate(stdout), stderr: truncate(stderr) });
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      settled = true;
      reject(opFailed(`无法执行 ${path.basename(cmd)}: ${err.code || err.message}`));
    });
    child.on('close', (code) => finish(code === null ? -1 : code));
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}


function spawnSafe(cmd, args, options = {}) {
  return spawn(cmd, args, {
    timeout: options.timeoutMs || EXEC_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/* ---------------- 进程树保护 ---------------- */

function readProcCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch (e) {
    return [];
  }
}

function readPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const rest = stat.slice(end + 2).split(' ');
    return Number(rest[1]) || 0;
  } catch (e) {
    return 0;
  }
}

/** 禁止结束：1 号、helper 自身、helper 祖先、面板 server.js 进程树 */
function isForbiddenPid(pid) {
  if (pid <= 1 || pid === process.pid) return true;
  let current = process.pid;
  for (let i = 0; i < 64 && current > 1; i += 1) {
    if (current === pid) return true;
    current = readPpid(current);
  }
  const argv = readProcCmdline(pid);
  if (argv.some((arg) => arg.endsWith('panel-helper.js'))) return true;
  if (argv.some((arg) => arg.endsWith('server.js')) && argv.some((arg) => /node/.test(arg))) return true;
  return false;
}

/* ---------------- /proc/mounts ---------------- */

function readMounts() {
  const mounts = [];
  let text = '';
  try {
    text = fs.readFileSync('/proc/mounts', 'utf8');
  } catch (e) {
    return mounts;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    mounts.push({
      device: parts[0],
      mountPoint: parts[1],
      fstype: parts[2],
      options: (parts[3] || '').split(',').filter(Boolean),
      managed: parts[1].startsWith('/mnt/') || parts[1].startsWith('/media/'),
    });
    if (mounts.length >= 300) break;
  }
  return mounts;
}

/* ---------------- 白名单 op 实现 ---------------- */

async function opService(action, args) {
  const actionCheck = validate.validateServiceAction(action);
  if (!actionCheck.ok) throw denied(actionCheck.error);
  const unitCheck = validate.validateServiceUnit(args.unit);
  if (!unitCheck.ok) throw denied(unitCheck.error);

  // 要求 unit 真实存在（systemctl cat 退出码为 0）
  const cat = await runFile('systemctl', ['cat', unitCheck.value]);
  if (cat.code !== 0) throw denied('unit 不存在');

  const result = await runFile('systemctl', [actionCheck.value, unitCheck.value]);
  if (actionCheck.value === 'status') {
    return { unit: unitCheck.value, output: truncate(`${result.stdout}${result.stderr}`), exitCode: result.code };
  }
  if (result.code !== 0) {
    throw opFailed(`systemctl ${actionCheck.value} 失败: ${truncate(result.stderr || result.stdout, 500)}`);
  }
  return { unit: unitCheck.value, action: actionCheck.value };
}

async function opProcessKill(args) {
  const pidCheck = validate.validatePid(args.pid);
  if (!pidCheck.ok) throw denied(pidCheck.error);
  const signalCheck = validate.validateSignal(args.signal);
  if (!signalCheck.ok) throw denied(signalCheck.error);
  const pid = pidCheck.value;
  if (isForbiddenPid(pid)) throw denied('禁止结束 1 号进程 / helper / 面板自身进程树');
  // 注意：Node 的 process.kill 只接受 'SIGTERM'/'SIGKILL' 或数字，不认 'TERM'/'KILL'
  const nodeSignal = signalCheck.value === 'KILL' ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, nodeSignal);
  } catch (e) {
    if (e.code === 'ESRCH') throw opFailed('进程不存在');
    if (e.code === 'EPERM') throw denied('无权限结束该进程');
    throw opFailed(`kill 失败: ${e.code || e.message}`);
  }
  return { pid, signal: signalCheck.value };
}

async function opCronList() {
  const result = await runFile('crontab', ['-u', PANEL_USER, '-l']);
  if (result.code !== 0) {
    const text = `${result.stderr}${result.stdout}`.toLowerCase();
    if (text.includes('no crontab')) return { user: PANEL_USER, lines: [] };
    throw opFailed(`读取 crontab 失败: ${truncate(result.stderr || result.stdout, 300)}`);
  }
  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  return { user: PANEL_USER, lines: lines.slice(0, validate.MAX_CRON_LINES + 50) };
}

async function opCronWrite(args) {
  const linesCheck = validate.validateCronLines(args.lines);
  if (!linesCheck.ok) throw denied(linesCheck.error);
  const input = linesCheck.value.length ? `${linesCheck.value.join('\n')}\n` : '';
  const result = await runWithInput('crontab', ['-u', PANEL_USER, '-'], input);
  if (result.code !== 0) {
    throw opFailed(`写入 crontab 失败: ${truncate(result.stderr, 300)}`);
  }
  return { user: PANEL_USER, lines: linesCheck.value.length };
}

async function opPower(action) {
  const check = validate.validatePowerAction(action);
  if (!check.ok) throw denied(check.error);
  const args = check.value === 'reboot'
    ? ['-r', '+1']
    : check.value === 'shutdown'
      ? ['-h', '+1']
      : ['-c'];
  const result = await runFile('shutdown', args);
  if (result.code !== 0) {
    throw opFailed(`shutdown ${check.value} 失败: ${truncate(result.stderr || result.stdout, 300)}`);
  }
  return {
    action: check.value,
    delaySeconds: check.value === 'cancel' ? 0 : 60,
    output: truncate(result.stdout || result.stderr, 1000),
  };
}

async function opMountList() {
  return { mounts: readMounts() };
}

async function opMountMount(args) {
  const deviceCheck = validate.validateMountDevice(args.device);
  if (!deviceCheck.ok) throw denied(deviceCheck.error);
  const pointCheck = validate.validateMountPoint(args.mountPoint);
  if (!pointCheck.ok) throw denied(pointCheck.error);

  let stat;
  try {
    stat = fs.statSync(deviceCheck.value);
  } catch (e) {
    throw denied('设备不存在');
  }
  if (!stat.isBlockDevice()) throw denied('设备不是块设备');

  let pointStat;
  try {
    pointStat = fs.statSync(pointCheck.value);
  } catch (e) {
    throw denied('挂载点不存在');
  }
  if (!pointStat.isDirectory()) throw denied('挂载点不是目录');

  if (readMounts().some((m) => m.mountPoint === pointCheck.value)) throw denied('挂载点已被占用');

  const result = await runFile('mount', [deviceCheck.value, pointCheck.value]);
  if (result.code !== 0) throw opFailed(`mount 失败: ${truncate(result.stderr, 300)}`);
  return { device: deviceCheck.value, mountPoint: pointCheck.value };
}

async function opMountUmount(args) {
  const pointCheck = validate.validateMountPoint(args.mountPoint);
  if (!pointCheck.ok) throw denied(pointCheck.error);
  if (!readMounts().some((m) => m.mountPoint === pointCheck.value)) throw denied('挂载点当前未挂载');
  const result = await runFile('umount', [pointCheck.value]);
  if (result.code !== 0) throw opFailed(`umount 失败: ${truncate(result.stderr, 300)}`);
  return { mountPoint: pointCheck.value };
}

async function opFirewallStatus() {
  const result = await runFile('ufw', ['status', 'verbose']);
  if (result.code !== 0) throw opFailed(`ufw status 失败: ${truncate(result.stderr || result.stdout, 300)}`);
  return { output: truncate(`${result.stdout}${result.stderr}`, 20000), exitCode: result.code };
}

async function opFirewallRule(action, args) {
  const spec = validate.validateFirewallRule({
    mode: action,
    port: args.port,
    proto: args.proto,
    profile: args.profile,
  });
  if (!spec.ok) throw denied(spec.error);

  let argv;
  if (action === 'delete') {
    const ruleAction = String(args.ruleAction || 'allow');
    if (!['allow', 'deny'].includes(ruleAction)) throw denied('delete 需指定 ruleAction=allow|deny');
    const specValue = spec.value.profile || `${spec.value.port}${spec.value.proto && spec.value.proto !== 'any' ? `/${spec.value.proto}` : ''}`;
    argv = ['delete', ruleAction, specValue];
  } else {
    if (spec.value.profile) {
      const apps = await runFile('ufw', ['app', 'list']);
      if (apps.code !== 0) throw opFailed('无法读取 ufw app list');
      const known = apps.stdout.split('\n').some((line) => line.trim().startsWith(spec.value.profile));
      if (!known) throw denied('ufw app profile 不存在');
      argv = [action, spec.value.profile];
    } else {
      const specValue = `${spec.value.port}${spec.value.proto && spec.value.proto !== 'any' ? `/${spec.value.proto}` : ''}`;
      argv = [action, specValue];
    }
  }

  const result = await runFile('ufw', argv);
  if (result.code !== 0) throw opFailed(`ufw ${action} 失败: ${truncate(result.stderr || result.stdout, 300)}`);
  return { action, rule: argv.slice(1).join(' '), output: truncate(result.stdout, 1000) };
}

async function opFirewallEnable(action) {
  const result = await runFile('ufw', action === 'enable' ? ['--force', 'enable'] : ['disable']);
  if (result.code !== 0) throw opFailed(`ufw ${action} 失败: ${truncate(result.stderr || result.stdout, 300)}`);
  return { action, output: truncate(`${result.stdout}${result.stderr}`, 1000) };
}

async function opPackagesUpgradable() {
  const result = await runFile('apt-get', ['-s', 'upgrade'], { timeoutMs: APT_TIMEOUT_MS });
  const packages = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^Inst\s+(\S+)(?:\s+\[([^\]]+)\])?(?:\s+\(([^)]+)\))?/.exec(line);
    if (match) packages.push({ name: match[1], current: match[2] || null, candidate: match[3] || null });
  }
  if (result.code !== 0 && packages.length === 0) {
    throw opFailed(`apt-get -s upgrade 失败: ${truncate(result.stderr, 300)}`);
  }
  return { packages: packages.slice(0, 500), count: packages.length };
}

async function opPackages(action, args) {
  if (action === 'update') {
    const result = await runFile('apt-get', ['update'], { timeoutMs: APT_TIMEOUT_MS });
    if (result.code !== 0) throw opFailed(`apt-get update 失败: ${truncate(result.stderr || result.stdout, 500)}`);
    return { action, output: truncate(result.stdout, 4000) };
  }
  if (action === 'upgrade') {
    if (args.confirm !== 'UPGRADE') throw denied('升级需要 confirm=UPGRADE');
    const result = await runFile('apt-get', ['-y', 'upgrade'], { timeoutMs: APT_TIMEOUT_MS });
    if (result.code !== 0) throw opFailed(`apt-get upgrade 失败: ${truncate(result.stderr || result.stdout, 800)}`);
    return { action, output: truncate(result.stdout, 6000) };
  }
  throw denied('packages action 非法');
}

/* ---------------- 分发 ---------------- */

const HANDLERS = {
  'service.status': (args) => opService('status', args),
  'service.start': (args) => opService('start', args),
  'service.stop': (args) => opService('stop', args),
  'service.restart': (args) => opService('restart', args),
  'service.enable': (args) => opService('enable', args),
  'service.disable': (args) => opService('disable', args),
  'process.kill': (args) => opProcessKill(args),
  'cron.list': () => opCronList(),
  'cron.write': (args) => opCronWrite(args),
  'power.reboot': () => opPower('reboot'),
  'power.shutdown': () => opPower('shutdown'),
  'power.cancel': () => opPower('cancel'),
  'mount.list': () => opMountList(),
  'mount.mount': (args) => opMountMount(args),
  'mount.umount': (args) => opMountUmount(args),
  'firewall.status': () => opFirewallStatus(),
  'firewall.allow': (args) => opFirewallRule('allow', args),
  'firewall.deny': (args) => opFirewallRule('deny', args),
  'firewall.delete': (args) => opFirewallRule('delete', args),
  'firewall.enable': () => opFirewallEnable('enable'),
  'firewall.disable': () => opFirewallEnable('disable'),
  'packages.upgradable': () => opPackagesUpgradable(),
  'packages.update': (args) => opPackages('update', args),
  'packages.upgrade': (args) => opPackages('upgrade', args),
};

const ALLOWED_OPS = new Set(Object.keys(HANDLERS));

async function dispatch(op, args) {
  if (!ALLOWED_OPS.has(op)) throw denied('未知 op');
  const handler = HANDLERS[op];
  return handler(args || {});
}

/* ---------------- Socket 服务 ---------------- */

function reply(socket, payload) {
  try {
    socket.end(`${JSON.stringify(payload)}\n`);
  } catch (e) {
    /* ignore */
  }
}

async function handleLine(socket, line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (e) {
    logEvent({ op: '-', result: 'denied', detail: 'invalid_json' });
    return reply(socket, { ok: false, error: { code: 'helper_denied', detail: 'invalid_json' } });
  }

  const verdict = protocol.verifyRequest(secret, request);
  if (!verdict.ok) {
    logEvent({
      op: typeof request.op === 'string' ? request.op.slice(0, 64) : '-',
      result: 'denied',
      detail: verdict.error,
    });
    return reply(socket, { ok: false, error: { code: 'helper_denied', detail: verdict.error } });
  }

  if (!nonces.check(request.nonce)) {
    logEvent({ op: verdict.value.op, result: 'denied', detail: 'nonce_replay' });
    return reply(socket, { ok: false, error: { code: 'helper_denied', detail: 'nonce_replay' } });
  }

  const { op, args } = verdict.value;
  const startedAt = Date.now();
  try {
    const result = await dispatch(op, args);
    logEvent({ op, args: truncate(JSON.stringify(args || {}), 400), result: 'ok', ms: Date.now() - startedAt });
    reply(socket, { ok: true, result });
  } catch (e) {
    const code = e instanceof OpError ? e.code : 'helper_error';
    const detail = e instanceof OpError ? e.detail : 'helper 内部错误';
    logEvent({
      op,
      args: truncate(JSON.stringify(args || {}), 400),
      result: 'error',
      code,
      detail: truncate(detail, 500),
      ms: Date.now() - startedAt,
    });
    reply(socket, { ok: false, error: { code, detail: truncate(detail, 500) } });
  }
}

function startServer() {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > protocol.MAX_FRAME_BYTES) {
        logEvent({ op: '-', result: 'denied', detail: 'frame_too_large' });
        try {
          socket.destroy();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(socket, line).catch(() => {});
      }
    });
  });

  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      fs.chownSync(path.dirname(SOCKET_PATH), 0, GID);
      fs.chmodSync(path.dirname(SOCKET_PATH), 0o750);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (e) {
    /* ignore */
  }

  server.listen(SOCKET_PATH, () => {
    try {
      fs.chmodSync(SOCKET_PATH, 0o660);
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        fs.chownSync(SOCKET_PATH, 0, GID);
      }
    } catch (e) {
      /* ignore */
    }
    console.log(`[helper] v${VERSION} listening on ${SOCKET_PATH} (user=${PANEL_USER} gid=${GID})`);
    logEvent({ op: 'helper.start', result: 'ok', socket: SOCKET_PATH, version: VERSION });
  });

  server.on('error', (err) => {
    console.error('[helper] socket 错误:', err.code || err.message);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`[helper] 收到 ${signal}，退出`);
    try {
      server.close();
    } catch (e) {
      /* ignore */
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function main() {
  ensureLogFile();
  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (e) {
    console.error(`[helper] 无法读取密钥文件 ${SECRET_FILE}: ${e.code || e.message}`);
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error('[helper] 密钥长度不足 32 字符，拒绝启动');
    process.exit(1);
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    console.warn('[helper] 警告：当前不是 root，特权操作（服务/电源/防火墙/挂载/升级）将失败，仅适合测试');
  }
  startServer();
}

main();
