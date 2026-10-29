#!/usr/bin/env node
/**
 * B2 panel-helper 协议 + 面板侧调用链回归测试（零依赖，不要求 root）
 *
 * 说明：本机没有 passwordless sudo，真实 root 操作无法验证。测试用「以当前用户身份启动的
 * 降权 helper」验证协议/白名单/日志/错误映射，以及面板侧路由（只调用只读 op 或非法参数，
 * 绝不触发真实 reboot/挂载/防火墙/升级）。
 *
 * 覆盖：
 *  - validate.js 白名单单测（unit/pid/signal/mount/firewall/cron）
 *  - protocol.js：HMAC 正确/错误、ts 过期/未来、nonce 重放、非法帧
 *  - helper 进程：socket/日志权限、只读 op、未知 op、参数越界、错误密钥、重放、日志脱敏
 *  - 面板路由：未登录 401 / 缺 CSRF 403、helper 可用/不可用（503）、危险操作 confirm 校验、
 *              参数校验、审计写入
 *  - install/uninstall 脚本：语法、未知参数退出 2 且不改系统、--help
 *
 * 用法：node tests/helper-test.mjs ["<测试实例密码>"] [--keep]
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hashPassword, generatePassword } = require('../lib/config.js');
const { HelperClient, HELPER_VERSION } = require('../lib/helper.js');
const validate = require('../helper/validate.js');
const protocol = require('../helper/protocol.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-helper-test-'));

const results = [];
const skipped = [];
const children = [];

function rec(group, name, ok, detail, ms) {
  results.push({ group, name, ok: Boolean(ok), detail, ms });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}${ms !== undefined ? ` (${ms}ms)` : ''}`);
}

function skip(name, detail) {
  skipped.push({ name, detail });
  console.log(`⏭️  [跳过] ${name}${detail ? ' — ' + detail : ''}`);
}

/* ---------------- HTTP ---------------- */

function request(base, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const headers = { ...(opts.headers || {}) };
    let payload = null;
    if (opts.body !== undefined) {
      payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.csrf) headers['X-CSRF-Token'] = opts.csrf;
    const req = http.request(url, { method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, body, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 30000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  return {
    base,
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
    async call(pathname, opts = {}) {
      const method = opts.method || 'GET';
      const res = await request(base, pathname, {
        ...opts,
        method,
        cookie: cookie || undefined,
        csrf: method === 'GET' ? undefined : csrf || undefined,
      });
      for (const c of res.setCookie) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      return res;
    },
    async login() {
      const res = await request(base, '/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
      for (const c of res.setCookie) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      if (res.status === 200 && res.body?.csrf) csrf = res.body.csrf;
      return res;
    },
  };
}

/* ---------------- 临时目录 / helper ---------------- */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function writeSecret(file) {
  fs.writeFileSync(file, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return file;
}

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch (e) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时: ${label}`);
}

async function startHelper(dirName) {
  const dir = path.join(TMP_ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, 'helper.sock');
  const secretFile = writeSecret(path.join(dir, 'helper.secret'));
  const logFile = path.join(dir, 'helper.log');
  const child = spawn(process.execPath, [path.join(ROOT, 'helper', 'panel-helper.js')], {
    env: {
      ...process.env,
      PANEL_HELPER_SOCKET: socketPath,
      PANEL_HELPER_SECRET: secretFile,
      PANEL_HELPER_LOG: logFile,
      PANEL_HELPER_USER: process.env.USER || 'hb',
      PANEL_HELPER_GID: String(process.getgid ? process.getgid() : 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  children.push(child);
  const client = new HelperClient({ socketPath, secretFile, timeoutMs: 5000 });
  try {
    await waitFor(() => client.available(), 8000, 'helper socket');
  } catch (e) {
    throw new Error(`helper 启动失败: ${e.message}\n${logs.join('')}`);
  }
  return {
    dir,
    socketPath,
    secretFile,
    logFile,
    client,
    logs,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 4000;
      while (child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 80));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** 直接对 socket 发送任意帧，返回响应 JSON */
function rawRequest(socketPath, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request timeout'));
    }, timeoutMs);
    const finish = (err, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, index)));
      } catch (e) {
        finish(new Error('bad response json'));
      }
    });
    socket.once('error', (err) => finish(err));
  });
}

/* ---------------- 隔离面板实例 ---------------- */

function preparePanelDir(helper, extra = {}) {
  const dir = path.join(TMP_ROOT, 'panel');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const emptyDist = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDist, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: {
      title: 'helper 测试',
      username: 'admin',
      passwordHash: hashPassword(PASSWORD, salt),
      passwordSalt: salt,
      mustChangePassword: false,
    },
    session: { secret: crypto.randomBytes(32).toString('hex'), ttlSeconds: 12 * 60 * 60 },
    sampleIntervalMs: 1000,
    alerts: { enabled: false },
    backup: { auto: false, keep: 2, hour: 4 },
    appUpdate: { distDir: emptyDist },
    helper: { socketPath: helper.socketPath, secretFile: helper.secretFile, timeoutMs: 3000 },
    ...extra,
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data') };
}

async function spawnPanel(prepared) {
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PANEL_CONFIG: prepared.configPath,
      PANEL_DATA_DIR: prepared.dataDir,
      PANEL_PORT: String(port),
      PANEL_HOST: '127.0.0.1',
    },
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  children.push(child);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`面板实例退出 code=${child.exitCode}\n${logs.join('')}`);
    try {
      const res = await request(base, '/api/app/info', { timeoutMs: 800 });
      if (res.status === 200) {
        return { base, port, child, logs, dataDir: prepared.dataDir, configPath: prepared.configPath, async stop() {
          if (child.exitCode !== null) return;
          child.kill('SIGTERM');
          const end = Date.now() + 4000;
          while (child.exitCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 80));
          if (child.exitCode === null) child.kill('SIGKILL');
        } };
      }
    } catch (e) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`面板实例启动超时\n${logs.join('')}`);
}

/* ---------------- 单元：validate ---------------- */

function testValidateUnit() {
  const group = '白名单校验';
  const cases = [
    ['service unit 合法', validate.validateServiceUnit('nginx.service').ok && validate.validateServiceUnit('a@b.timer').ok],
    ['service unit 拒绝路径/后缀', !validate.validateServiceUnit('../x.service').ok && !validate.validateServiceUnit('foo.sh').ok && !validate.validateServiceUnit('a/b.service').ok && !validate.validateServiceUnit('x.service extra').ok],
    ['service action 白名单', validate.validateServiceAction('restart').ok && !validate.validateServiceAction('mask').ok],
    ['pid >1 整数', validate.validatePid(2).ok && validate.validatePid(65535).ok && !validate.validatePid(1).ok && !validate.validatePid(0).ok && !validate.validatePid(-3).ok && !validate.validatePid(1.5).ok && !validate.validatePid('x').ok],
    ['signal 仅 TERM/KILL', validate.validateSignal('TERM').ok && validate.validateSignal('kill').value === 'KILL' && !validate.validateSignal('HUP').ok && !validate.validateSignal('9').ok],
    ['mount 设备必须在 /dev', validate.validateMountDevice('/dev/sda1').ok && validate.validateMountDevice('/dev/disk/by-uuid/x').ok && !validate.validateMountDevice('/etc/passwd').ok && !validate.validateMountDevice('/dev/../etc').ok],
    ['mount 点必须在 /mnt|/media', validate.validateMountPoint('/mnt/data').ok && validate.validateMountPoint('/media/usb').ok && !validate.validateMountPoint('/etc').ok && !validate.validateMountPoint('/mnt/../etc').ok && !validate.validateMountPoint('relative').ok && !validate.validateMountPoint('/mnt').ok],
    ['firewall 端口范围', validate.validateFirewallPort(1).ok && validate.validateFirewallPort(65535).ok && !validate.validateFirewallPort(0).ok && !validate.validateFirewallPort(65536).ok && !validate.validateFirewallPort('80;rm').ok],
    ['firewall proto', validate.validateFirewallProto('tcp').ok && validate.validateFirewallProto('any').ok && !validate.validateFirewallProto('icmp').ok],
    ['firewall profile 字符白名单', validate.validateFirewallProfile('Nginx Full').ok && !validate.validateFirewallProfile('bad;rm -rf').ok],
    ['firewall 规则 port/profile 二选一', validate.validateFirewallRule({ mode: 'allow', port: 22, proto: 'tcp' }).ok && validate.validateFirewallRule({ mode: 'deny', profile: 'OpenSSH' }).ok && !validate.validateFirewallRule({ mode: 'allow' }).ok && !validate.validateFirewallRule({ mode: 'allow', port: 22, profile: 'x' }).ok && !validate.validateFirewallRule({ mode: 'nuke', port: 22 }).ok],
    ['cron 行数/长度/字符集', validate.validateCronLines(['0 4 * * * /bin/true']).ok && validate.validateCronLines([]).ok && !validate.validateCronLines(Array(101).fill('* * * * * true')).ok && !validate.validateCronLines([`${'a'.repeat(501)}`]).ok && !validate.validateCronLines(['bad\u0000line']).ok && !validate.validateCronLines(['中文注释']).ok],
    ['power action 白名单', validate.validatePowerAction('reboot').ok && validate.validatePowerAction('shutdown').ok && validate.validatePowerAction('cancel').ok && !validate.validatePowerAction('halt').ok],
  ];
  for (const [name, ok] of cases) rec(group, name, ok);
}

/* ---------------- 单元：protocol ---------------- */

function testProtocolUnit() {
  const group = '协议单元';
  const secret = crypto.randomBytes(32).toString('hex');
  const request = protocol.buildRequest(secret, 'mount.list', {});
  const verified = protocol.verifyRequest(secret, request);
  rec(group, 'HMAC 正确的请求通过', verified.ok === true && verified.value.op === 'mount.list');
  rec(group, '错误密钥被拒绝', protocol.verifyRequest(crypto.randomBytes(32).toString('hex'), request).error === 'hmac_mismatch');
  const expired = protocol.buildRequest(secret, 'mount.list', {}, { now: Date.now() - 120000 });
  rec(group, 'ts 超过 ±60s 被拒绝', protocol.verifyRequest(secret, expired).error === 'ts_out_of_window');
  const future = protocol.buildRequest(secret, 'mount.list', {}, { now: Date.now() + 120000 });
  rec(group, '未来时间戳被拒绝', protocol.verifyRequest(secret, future).error === 'ts_out_of_window');
  const tampered = { ...request, args: { evil: true } };
  rec(group, '篡改 args 后 HMAC 失效', protocol.verifyRequest(secret, tampered).error === 'hmac_mismatch');
  rec(group, '非法 nonce 被拒绝', protocol.verifyRequest(secret, { ...request, nonce: 'xx' }).error === 'nonce_invalid');

  const cache = new protocol.NonceCache(60000);
  rec(group, 'nonce 首次通过、重放拒绝', cache.check('a'.repeat(32), 1000) === true && cache.check('a'.repeat(32), 1001) === false);
  rec(group, 'nonce 过期后可再次使用', cache.check('a'.repeat(32), 1000 + 60001) === true);
}

/* ---------------- helper 进程（降权） ---------------- */

async function testHelperProcess(helper) {
  const group = 'helper 进程';
  const socketMode = fs.statSync(helper.socketPath).mode & 0o777;
  const logMode = fs.statSync(helper.logFile).mode & 0o777;
  rec(group, 'socket 权限 0660', socketMode === 0o660, socketMode.toString(8));
  rec(group, '日志文件权限 0600', logMode === 0o600, logMode.toString(8));

  const mounts = await helper.client.call('mount.list');
  rec(group, '只读 op mount.list 可用', Array.isArray(mounts.mounts) && mounts.mounts.length > 0, `${mounts.mounts.length} 条挂载`);

  const deniedCases = [
    ['未知 op', () => helper.client.call('service.nuke', {})],
    ['service unit 路径穿越', () => helper.client.call('service.start', { unit: '../evil.service' })],
    ['process.kill pid=1', () => helper.client.call('process.kill', { pid: 1, signal: 'TERM' })],
    ['process.kill 非法 signal', () => helper.client.call('process.kill', { pid: 2, signal: 'HUP' })],
    ['process.kill 非整数 pid', () => helper.client.call('process.kill', { pid: '2;rm', signal: 'TERM' })],
    ['mount.mount 设备不在 /dev', () => helper.client.call('mount.mount', { device: '/etc/passwd', mountPoint: '/mnt/x' })],
    ['mount.umount 挂载点越界', () => helper.client.call('mount.umount', { mountPoint: '/etc' })],
    ['firewall 端口越界', () => helper.client.call('firewall.allow', { port: 70000, proto: 'tcp' })],
    ['firewall profile 注入', () => helper.client.call('firewall.allow', { profile: 'bad;rm -rf /' })],
    ['cron.write 超 100 行', () => helper.client.call('cron.write', { lines: Array(101).fill('* * * * * true') })],
    ['cron.write 控制字符', () => helper.client.call('cron.write', { lines: ['bad\u0000line'] })],
    ['packages.upgrade 缺 confirm', () => helper.client.call('packages.upgrade', {})],
  ];
  for (const [name, fn] of deniedCases) {
    let code = '';
    try {
      await fn();
    } catch (e) {
      code = e.code;
    }
    rec(group, `拒绝：${name}`, code === 'helper_denied', code);
  }

  // 真实 kill：spawn 一个 sleep 子进程，分别用 TERM / KILL 结束（回归 ERR_UNKNOWN_SIGNAL）
  const waitGone = async (pid, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const spawnSleeper = () => spawn('sleep', ['600'], { stdio: 'ignore' });

  const sleeperTerm = spawnSleeper();
  children.push(sleeperTerm);
  await new Promise((r) => setTimeout(r, 150));
  let killResult = null;
  let killCode = '';
  try {
    killResult = await helper.client.call('process.kill', { pid: sleeperTerm.pid, signal: 'TERM' });
  } catch (e) {
    killCode = `${e.code}:${e.detail}`;
  }
  rec(group, 'TERM 真实结束进程（不出现 ERR_UNKNOWN_SIGNAL）', Boolean(killResult) && killResult.pid === sleeperTerm.pid && killResult.signal === 'TERM', killCode || JSON.stringify(killResult));
  rec(group, '└ 目标进程已退出', await waitGone(sleeperTerm.pid), `pid=${sleeperTerm.pid}`);

  const sleeperKill = spawnSleeper();
  children.push(sleeperKill);
  await new Promise((r) => setTimeout(r, 150));
  let kill9 = null;
  let kill9Code = '';
  try {
    kill9 = await helper.client.call('process.kill', { pid: sleeperKill.pid, signal: 'KILL' });
  } catch (e) {
    kill9Code = `${e.code}:${e.detail}`;
  }
  rec(group, 'KILL 真实结束进程', Boolean(kill9) && kill9.signal === 'KILL', kill9Code || JSON.stringify(kill9));
  rec(group, '└ 目标进程已退出', await waitGone(sleeperKill.pid), `pid=${sleeperKill.pid}`);

  let goneCode = '';
  try {
    await helper.client.call('process.kill', { pid: sleeperKill.pid, signal: 'TERM' });
  } catch (e) {
    goneCode = e.code;
  }
  rec(group, '结束已退出进程 → helper_error（进程不存在）', goneCode === 'helper_error', goneCode);

  // 错误密钥
  const wrongSecret = path.join(helper.dir, 'wrong.secret');
  writeSecret(wrongSecret);
  const wrongClient = new HelperClient({ socketPath: helper.socketPath, secretFile: wrongSecret, timeoutMs: 3000 });
  let wrongCode = '';
  try {
    await wrongClient.call('mount.list');
  } catch (e) {
    wrongCode = e.code;
  }
  rec(group, '错误密钥 → helper_denied', wrongCode === 'helper_denied', wrongCode);

  // 过期时间戳（直接发帧）
  const secret = fs.readFileSync(helper.secretFile, 'utf8').trim();
  const expired = protocol.buildRequest(secret, 'mount.list', {}, { now: Date.now() - 120000 });
  const expiredResp = await rawRequest(helper.socketPath, expired);
  rec(group, '过期时间戳帧被拒绝', expiredResp.ok === false && expiredResp.error.code === 'helper_denied' && expiredResp.error.detail === 'ts_out_of_window', expiredResp.error?.detail);

  // nonce 重放
  const replayReq = protocol.buildRequest(secret, 'mount.list', {});
  const first = await rawRequest(helper.socketPath, replayReq);
  const second = await rawRequest(helper.socketPath, replayReq);
  rec(group, 'nonce 重放被拒绝', first.ok === true && second.ok === false && second.error.detail === 'nonce_replay', JSON.stringify(second.error));

  // 非法 JSON
  const badJson = await rawRequest(helper.socketPath, { evil: true });
  rec(group, '非法协议帧被拒绝', badJson.ok === false && badJson.error.code === 'helper_denied' && ['op_invalid', 'hmac_mismatch'].includes(badJson.error.detail), JSON.stringify(badJson.error));

  // 日志：包含 op/拒绝，但不含密钥与 hmac
  const logText = fs.readFileSync(helper.logFile, 'utf8');
  rec(group, 'helper 日志记录 op 与拒绝原因', logText.includes('mount.list') && logText.includes('helper_denied') && logText.includes('nonce_replay'));
  rec(group, 'helper 日志不含密钥 / hmac', !logText.includes(secret) && !logText.includes(replayReq.hmac), 'no secret');

  // 连接失败与超时
  const missing = new HelperClient({ socketPath: path.join(TMP_ROOT, 'no-such.sock'), secretFile: helper.secretFile, timeoutMs: 1000 });
  let missingCode = '';
  try {
    await missing.call('mount.list');
  } catch (e) {
    missingCode = e.code;
  }
  rec(group, 'socket 不存在 → helper_unavailable', missingCode === 'helper_unavailable', missingCode);

  const stallPath = path.join(TMP_ROOT, 'stall.sock');
  const stallServer = net.createServer((socket) => {
    socket.on('data', () => {});
  });
  await new Promise((resolve) => stallServer.listen(stallPath, resolve));
  try {
    const stallClient = new HelperClient({ socketPath: stallPath, secretFile: helper.secretFile, timeoutMs: 400 });
    const started = Date.now();
    let stallCode = '';
    try {
      await stallClient.call('mount.list');
    } catch (e) {
      stallCode = e.code;
    }
    rec(group, '无响应 → helper_timeout（约 400ms）', stallCode === 'helper_timeout' && Date.now() - started < 3000, `${Date.now() - started}ms`);
  } finally {
    await new Promise((resolve) => stallServer.close(resolve));
    try {
      fs.unlinkSync(stallPath);
    } catch (e) {
      /* ignore */
    }
  }
}

/* ---------------- 面板侧路由 ---------------- */

function detectServiceUnit() {
  try {
    const output = execFileSync('systemctl', ['list-units', '--type=service', '--no-legend', '--no-pager'], { timeout: 5000, encoding: 'utf8' });
    const first = output.split('\n').map((line) => line.trim().split(/\s+/)[0]).find((unit) => unit && unit.endsWith('.service'));
    if (first) return first;
  } catch (e) {
    /* fallback */
  }
  return 'systemd-journald.service';
}

async function testPanelRoutes(helper, panel, client) {
  const group = '面板路由';
  const unit = detectServiceUnit();

  let res = await request(panel.base, '/api/host/status');
  rec(group, '未登录 /api/host/status → 401', res.status === 401, `status=${res.status}`);
  res = await request(panel.base, '/api/host/service', { method: 'POST', body: { unit, action: 'status' } });
  rec(group, '未登录/无 CSRF 动作 → 401', res.status === 401, `status=${res.status}`);

  res = await client.call('/api/host/status');
  rec(group, 'helper 可用时 status 返回 {helper:true,version}', res.status === 200 && res.body.helper === true && res.body.version === HELPER_VERSION, JSON.stringify(res.body));

  res = await client.call('/api/host/mounts');
  rec(group, 'GET /api/host/mounts 经 helper 返回挂载列表', res.status === 200 && res.body.ok === true && Array.isArray(res.body.mounts) && res.body.mounts.length > 0, `count=${res.body?.mounts?.length}`);

  res = await request(panel.base, '/api/host/service', { method: 'POST', headers: { Cookie: client.cookie }, body: { unit: 'systemd-journald.service', action: 'status' } });
  rec(group, 'POST 缺 CSRF → 403', res.status === 403, `status=${res.status}`);

  res = await client.call('/api/host/service', { method: 'POST', body: { unit: '../evil.service', action: 'status' } });
  rec(group, '非法 unit → 400 invalid_args（不触达 helper）', res.status === 400 && res.body.error === 'invalid_args', JSON.stringify(res.body));
  res = await client.call('/api/host/service', { method: 'POST', body: { unit, action: 'nuke' } });
  rec(group, '非法 service action → 400', res.status === 400 && res.body.error === 'invalid_args');

  res = await client.call('/api/host/service', { method: 'POST', body: { unit, action: 'status' } });
  rec(group, 'service.status（只读）经 helper 成功', res.status === 200 && res.body.ok === true && res.body.result?.unit === unit, `status=${res.status}`);
  const auditRes = await client.call('/api/audit?q=特权操作');
  rec(group, '动作写入面板审计', auditRes.body.entries.some((e) => e.action === '特权操作' && e.detail.includes('service.status')), JSON.stringify(auditRes.body.entries[0]));

  // 危险操作：只验证参数/confirm 校验，绝不真正执行
  res = await client.call('/api/host/power', { method: 'POST', body: { action: 'reboot' } });
  rec(group, 'power.reboot 缺 confirm → 400', res.status === 400 && res.body.error === 'confirm_required', JSON.stringify(res.body));
  res = await client.call('/api/host/power', { method: 'POST', body: { action: 'shutdown', confirm: 'WRONG' } });
  rec(group, 'power.shutdown 错误 confirm → 400', res.status === 400 && res.body.error === 'confirm_required');
  res = await client.call('/api/host/process/kill', { method: 'POST', body: { pid: 1, signal: 'TERM' } });
  rec(group, 'process.kill pid=1 → 400', res.status === 400 && res.body.error === 'invalid_args');
  res = await client.call('/api/host/process/kill', { method: 'POST', body: { pid: 1234, signal: 'HUP' } });
  rec(group, 'process.kill 非法 signal → 400', res.status === 400);

  // 面板链路真实结束一个测试进程（回归 502 ERR_UNKNOWN_SIGNAL）
  const panelSleeper = spawn('sleep', ['600'], { stdio: 'ignore' });
  children.push(panelSleeper);
  await new Promise((r) => setTimeout(r, 150));
  res = await client.call('/api/host/process/kill', { method: 'POST', body: { pid: panelSleeper.pid, signal: 'TERM' } });
  rec(group, '面板 POST /api/host/process/kill 真实结束进程 → 200', res.status === 200 && res.body.ok === true && res.body.result?.signal === 'TERM', `status=${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
  rec(group, '└ 目标进程已退出', await (async () => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try {
        process.kill(panelSleeper.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })(), `pid=${panelSleeper.pid}`);
  res = await client.call('/api/host/firewall', { method: 'POST', body: { action: 'allow', port: 70000 } });
  rec(group, 'firewall 端口越界 → 400', res.status === 400 && res.body.error === 'invalid_args');
  res = await client.call('/api/host/firewall', { method: 'POST', body: { action: 'allow', port: 80, proto: 'tcp' } });
  rec(group, 'firewall 合法参数在非 root helper 下被 helper 拒绝（不实际改防火墙）', res.status === 400 || res.status === 502, `status=${res.status}`);
  res = await client.call('/api/host/packages', { method: 'POST', body: { action: 'upgrade' } });
  rec(group, 'packages.upgrade 缺 confirm → 400', res.status === 400 && res.body.error === 'confirm_required');
  res = await client.call('/api/host/cron/write', { method: 'POST', body: { lines: Array(101).fill('* * * * * true') } });
  rec(group, 'cron.write 超 100 行 → 400', res.status === 400 && res.body.error === 'invalid_args');
  res = await client.call('/api/host/cron/write', { method: 'POST', body: { lines: ['bad\u0000line'] } });
  rec(group, 'cron.write 控制字符 → 400', res.status === 400);
  res = await client.call('/api/host/mount', { method: 'POST', body: { device: '/etc/passwd', mountPoint: '/mnt/x' } });
  rec(group, 'mount 非法设备 → 400', res.status === 400 && res.body.error === 'invalid_args');
  res = await client.call('/api/host/cron');
  rec(group, 'GET /api/host/cron（crontab 可用性相关）', res.status === 200 || res.status === 502, `status=${res.status}`);
  res = await client.call('/api/host/firewall');
  rec(group, 'GET /api/host/firewall（非 root 下可能 502）', [200, 502, 503].includes(res.status), `status=${res.status}`);
  res = await client.call('/api/host/packages/upgradable');
  rec(group, 'GET /api/host/packages/upgradable', [200, 502, 503].includes(res.status), `status=${res.status}`);

  // helper 日志中不应出现真实的 reboot/shutdown/upgrade 执行记录
  const helperLog = fs.readFileSync(helper.logFile, 'utf8');
  const dangerousOps = new Set(['power.reboot', 'power.shutdown', 'packages.upgrade', 'service.start', 'service.stop', 'service.restart', 'cron.write', 'mount.mount', 'mount.umount']);
  let dangerousOk = [];
  for (const line of helperLog.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (entry.result === 'ok' && dangerousOps.has(entry.op)) dangerousOk.push(entry.op);
  }
  rec(group, '危险动作从未成功执行（仅拒绝/失败）', dangerousOk.length === 0, dangerousOk.length ? dangerousOk.join(',') : 'no successful dangerous op');

  return { unit };
}

async function testHelperUnavailable(helper, panel, client) {
  const group = 'helper 不可用';
  await helper.stop();
  let res = await client.call('/api/host/status');
  rec(group, 'helper 停止后 status → {helper:false}', res.status === 200 && res.body.helper === false && res.body.version === null, JSON.stringify(res.body));
  for (const [label, method, pathname, body] of [
    ['mounts', 'GET', '/api/host/mounts', undefined],
    ['cron', 'GET', '/api/host/cron', undefined],
    ['service', 'POST', '/api/host/service', { unit: 'systemd-journald.service', action: 'status' }],
    ['process/kill', 'POST', '/api/host/process/kill', { pid: 1234, signal: 'TERM' }],
  ]) {
    res = await client.call(pathname, { method, body });
    rec(group, `${label} → 503 helper_unavailable`, res.status === 503 && res.body.error === 'helper_unavailable' && String(res.body.detail).includes('panel-helper'), `status=${res.status}`);
  }
  void panel;
}

/* ---------------- 安装脚本参数安全 ---------------- */

function testInstallScripts() {
  const group = '安装脚本';
  const install = path.join(ROOT, 'scripts', 'install-helper.sh');
  const uninstall = path.join(ROOT, 'scripts', 'uninstall-helper.sh');
  const syntax = spawnSync('bash', ['-n', install]);
  const syntax2 = spawnSync('bash', ['-n', uninstall]);
  rec(group, 'install/uninstall 脚本语法正确', syntax.status === 0 && syntax2.status === 0, 'bash -n');

  const bad = spawnSync('bash', [install, '--bogus'], { encoding: 'utf8' });
  rec(group, '未知参数 → 退出码 2 且不执行安装', bad.status === 2 && /未知参数/.test(bad.stderr + bad.stdout), `exit=${bad.status}`);
  const tooMany = spawnSync('bash', [install, '--uninstall', '--bogus'], { encoding: 'utf8' });
  rec(group, '参数过多 → 退出码 2', tooMany.status === 2, `exit=${tooMany.status}`);
  const help = spawnSync('bash', [install, '--help'], { encoding: 'utf8' });
  rec(group, '--help 正常输出用法', help.status === 0 && /用法/.test(help.stdout), 'usage');
  const badUninstall = spawnSync('bash', [uninstall, '--bogus'], { encoding: 'utf8' });
  rec(group, 'uninstall 未知参数 → 退出码 2', badUninstall.status === 2, `exit=${badUninstall.status}`);
  const nonRoot = spawnSync('bash', [install], { encoding: 'utf8' });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    skip('非 root 安装被拒绝', '当前测试以 root 运行');
  } else {
    rec(group, '非 root 执行安装 → 拒绝且退出非 0', nonRoot.status !== 0 && /root/.test(nonRoot.stderr + nonRoot.stdout), `exit=${nonRoot.status}`);
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ panel-helper 协议 + 面板调用链 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  testValidateUnit();
  testProtocolUnit();
  testInstallScripts();

  const helper = await startHelper('helper');
  try {
    await testHelperProcess(helper);

    const prepared = preparePanelDir(helper);
    const panel = await spawnPanel(prepared);
    const client = makeClient(panel.base);
    await client.login();
    await testPanelRoutes(helper, panel, client);
    await testHelperUnavailable(helper, panel, client);
    await panel.stop();
  } finally {
    await helper.stop().catch(() => {});
  }

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────');
  console.log(`结果：${passed}/${results.length} 通过 · ${failed.length} 失败 · ${skipped.length} 跳过`);
  if (failed.length) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ [${f.group}] ${f.name} — ${f.detail ?? ''}`);
  }
  if (failed.length || KEEP) {
    console.log(`\n临时目录保留：${TMP_ROOT}`);
  } else {
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }
  process.exitCode = failed.length ? 1 : 0;
}

process.on('SIGINT', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
  }
  process.exit(130);
});
process.on('SIGTERM', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch (e) {
      /* ignore */
    }
  }
  process.exit(143);
});

try {
  await main();
} catch (e) {
  console.error('\n💥 测试执行异常:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        /* ignore */
      }
    }
  }
}
