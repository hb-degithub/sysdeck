#!/usr/bin/env node
/**
 * 告警引擎 + 规则 + 通知渠道回归测试（零依赖，Node 22+）
 *
 * 自包含：/tmp 隔离实例（独立 config / DATA_DIR / 端口）+ 进程内假 webhook / SMTP / ntfy 服务，
 * 不触碰正式 systemd 实例。
 *
 * 覆盖：
 *  - 引擎：10s 评估节流、duration 未满不触发、触发写 alerts(severity)、冷却去重、恢复滞回（3 周期）、
 *          告警/恢复通知、状态视图、metric 取值映射、规则严格校验
 *  - 接口：alerts 列表过滤、ack/ack_all、rules GET/PUT（越界拒绝、持久化）、state
 *  - 通知：GET 不回显密钥、PUT 空串保持/null 清空、webhook 三种格式识别 + 通用 JSON、
 *          ntfy POST、SMTP 明文发送（AUTH LOGIN/中文主题 base64）、连接失败只记录、未配置跳过
 *  - 原 api-test 92/92 另行回归
 *
 * 用法：node tests/alerts-test.mjs ["<测试实例密码>"] [--keep]
 */

import { spawn } from 'node:child_process';
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
const { AlertEngine, normalizeRules, metricValue, DEFAULT_ALERT_RULES } = require('../lib/alerts.js');
const { Notifier } = require('../lib/notify.js');
const { DatabaseSync } = require('node:sqlite');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-alerts-test-'));

const results = [];
const skipped = [];
const instances = [];

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

/* ---------------- 隔离实例 ---------------- */

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

function prepareDir(name, patch = {}) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: {
      title: '告警测试',
      username: 'admin',
      passwordHash: hashPassword(PASSWORD, salt),
      passwordSalt: salt,
      mustChangePassword: false,
    },
    session: { secret: crypto.randomBytes(32).toString('hex'), ttlSeconds: 12 * 60 * 60 },
    sampleIntervalMs: 1000,
  };
  for (const [key, value] of Object.entries(patch)) config[key] = value;
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data') };
}

async function spawnInstance(prepared) {
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: prepared.configPath,
      PANEL_DATA_DIR: prepared.dataDir,
      PANEL_PORT: String(port),
      PANEL_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  const inst = {
    base,
    port,
    dir: prepared.dir,
    configPath: prepared.configPath,
    dataDir: prepared.dataDir,
    child,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 80));
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`实例退出 code=${child.exitCode}\n${logs.join('')}`);
    try {
      const res = await request(base, '/api/app/info', { timeoutMs: 800 });
      if (res.status === 200) {
        instances.push(inst);
        return inst;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`实例启动超时\n${logs.join('')}`);
}

/* ---------------- 假服务 ---------------- */

function startFakeHttp() {
  return new Promise((resolve) => {
    const captured = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        captured,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startFakeSmtp() {
  return new Promise((resolve) => {
    const state = { commands: [], messages: [], authUser: null, authPass: null };
    const server = net.createServer((socket) => {
      let buffer = '';
      let inData = false;
      let data = '';
      let authStep = 0;
      socket.write('220 fake ESMTP ready\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === '.') {
              inData = false;
              state.messages.push(data);
              data = '';
              socket.write('250 OK queued\r\n');
            } else {
              data += line + '\r\n';
            }
            continue;
          }
          state.commands.push(line);
          const upper = line.toUpperCase();
          if (authStep === 1) {
            state.authUser = line;
            authStep = 2;
            socket.write('334 UGFzc3dvcmQ6\r\n');
            continue;
          }
          if (authStep === 2) {
            state.authPass = line;
            authStep = 0;
            socket.write('235 Authentication successful\r\n');
            continue;
          }
          if (upper.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (upper === 'AUTH LOGIN') { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
          else if (upper.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
          else if (upper.startsWith('RCPT TO')) socket.write('250 OK\r\n');
          else if (upper === 'DATA') { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (upper === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
          else socket.write('250 OK\r\n');
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/* ---------------- 单元：引擎 ---------------- */

function snap(cpuPercent, extra = {}) {
  return {
    cpu: { percent: cpuPercent, coreCount: 8, temp: 50 },
    memory: { usedPercent: 40, swapPercent: 0 },
    load: { load1: 0.5 },
    filesystems: [{ mountPoint: '/', usedPercent: 30 }],
    network: { interfaces: [{ name: 'eth0', rxBytesPerSec: 1024 * 1024, txBytesPerSec: 512 * 1024 }] },
    sensors: { cpuTemp: 50, gpuTemp: 40 },
    ...extra,
  };
}

function makeEngineHarness(overrides = {}) {
  const state = { alerts: [], events: [], audits: [] };
  const config = {
    enabled: true,
    cooldownMinutes: 10,
    notifyOnRecover: true,
    rules: [{ id: 'cpu', metric: 'cpuPercent', op: '>', value: 90, durationSec: 10, severity: 'crit', enabled: true }],
    ...overrides,
  };
  const store = {
    addAlert: (...args) => state.alerts.push(args),
  };
  const notifier = {
    sendAlert: (event) => {
      state.events.push(event);
      return Promise.resolve();
    },
  };
  const engine = new AlertEngine({
    config,
    store,
    notifier,
    audit: (message) => state.audits.push(message),
    evalIntervalMs: 10000,
  });
  return { engine, config, state };
}

function testEngineUnit() {
  const group = '引擎单元';
  rec(group, '默认规则 5 条且 metric/severity 符合契约', DEFAULT_ALERT_RULES.length === 5 && DEFAULT_ALERT_RULES.every((r) => ['cpu-high', 'mem-high', 'disk-high', 'cpu-temp-high', 'load-per-core-high'].includes(r.id)), DEFAULT_ALERT_RULES.map((r) => r.id).join(','));

  const { engine, state } = makeEngineHarness();
  // 10s 节流：t=0 首评（记录 conditionSince），t=5s 被节流
  engine.evaluate(snap(95), 0);
  rec(group, '首次评估记录 lastEvalAt 且未触发（duration 未满）', engine.lastEvalAt === 0 && state.alerts.length === 0, `lastEvalAt=${engine.lastEvalAt}`);
  engine.evaluate(snap(95), 5000);
  rec(group, '10s 节流内不重复评估', engine.lastEvalAt === 0, `lastEvalAt=${engine.lastEvalAt}`);
  engine.evaluate(snap(95), 10000);
  rec(group, '连续 durationSec 满足后触发', state.alerts.length === 1, JSON.stringify(state.alerts[0]));
  const [metric, value, threshold, message, severity] = state.alerts[0] || [];
  rec(group, '触发写入 severity/message', metric === 'cpuPercent' && value === 95 && threshold === 90 && severity === 'crit' && message.includes('CPU 使用率'), message);
  rec(group, '触发发送告警通知 + 审计', state.events.some((e) => e.type === 'alert' && e.severity === 'crit' && e.metricLabel === 'CPU 使用率') && state.audits.some((a) => a.includes('告警触发')), state.events[0]?.type);
  rec(group, 'stateView firing 含 since/value', engine.stateView().firing.length === 1 && engine.stateView().firing[0].since === 10000, JSON.stringify(engine.stateView().firing));

  // 恢复滞回：连续 3 个评估周期不满足
  engine.evaluate(snap(50), 20000);
  rec(group, '不满足 1 个周期仍保持 firing', engine.stateView().firing.length === 1);
  engine.evaluate(snap(50), 30000);
  rec(group, '不满足 2 个周期仍保持 firing', engine.stateView().firing.length === 1);
  engine.evaluate(snap(50), 40000);
  rec(group, '连续 3 个周期不满足 → 恢复', engine.stateView().firing.length === 0);
  rec(group, '恢复发送通知 + 审计', state.events.some((e) => e.type === 'recover') && state.audits.some((a) => a.includes('告警恢复')), state.audits.join(' | '));

  // 冷却：恢复后 10 分钟内不再触发
  engine.evaluate(snap(95), 50000);
  engine.evaluate(snap(95), 60000);
  rec(group, '冷却期内不重复触发', state.alerts.length === 1, `alerts=${state.alerts.length}`);
  engine.evaluate(snap(95), 700000); // 冷却已过（lastFired 10000 + 600000 = 610000 < 700000）
  engine.evaluate(snap(95), 710000);
  rec(group, '冷却结束后可再次触发', state.alerts.length === 2, `alerts=${state.alerts.length}`);

  // disabled 规则 / disabled 引擎
  const h2 = makeEngineHarness({ rules: [{ id: 'off', metric: 'cpuPercent', op: '>', value: 1, durationSec: 5, severity: 'warn', enabled: false }] });
  h2.engine.evaluate(snap(99), 0);
  h2.engine.evaluate(snap(99), 10000);
  rec(group, 'enabled=false 的规则不触发', h2.state.alerts.length === 0);
  const h3 = makeEngineHarness({ enabled: false });
  h3.engine.evaluate(snap(99), 0);
  h3.engine.evaluate(snap(99), 20000);
  rec(group, '引擎 enabled=false 时完全不评估', h3.engine.lastEvalAt === null && h3.state.alerts.length === 0);

  // notifyOnRecover=false
  const h4 = makeEngineHarness({ notifyOnRecover: false });
  h4.engine.evaluate(snap(95), 0);
  h4.engine.evaluate(snap(95), 10000);
  h4.engine.evaluate(snap(50), 20000);
  h4.engine.evaluate(snap(50), 30000);
  h4.engine.evaluate(snap(50), 40000);
  rec(group, 'notifyOnRecover=false 时不发恢复通知', h4.state.events.filter((e) => e.type === 'recover').length === 0, `events=${h4.state.events.length}`);
}

function testMetricMapping() {
  const group = '指标映射';
  const snapshot = snap(55, {
    memory: { usedPercent: 60, swapPercent: 10 },
    filesystems: [{ mountPoint: '/', usedPercent: 70 }, { mountPoint: '/data', usedPercent: 85 }],
    load: { load1: 4 },
    network: { interfaces: [{ rxBytesPerSec: 1024 * 100, txBytesPerSec: 1024 * 50 }, { rxBytesPerSec: 1024 * 20, txBytesPerSec: 1024 * 10 }] },
    sensors: { cpuTemp: 65, gpuTemp: 55 },
  });
  rec(group, 'cpuPercent/memPercent/swapPercent', metricValue(snapshot, 'cpuPercent') === 55 && metricValue(snapshot, 'memPercent') === 60 && metricValue(snapshot, 'swapPercent') === 10);
  rec(group, 'diskPercent 取文件系统最大值', metricValue(snapshot, 'diskPercent') === 85);
  rec(group, 'cpuTempC/gpuTempC', metricValue(snapshot, 'cpuTempC') === 65 && metricValue(snapshot, 'gpuTempC') === 55);
  rec(group, 'load1/loadPerCore', metricValue(snapshot, 'load1') === 4 && metricValue(snapshot, 'loadPerCore') === 0.5);
  rec(group, 'netRxKBs/netTxKBs 汇总换算 KB/s', metricValue(snapshot, 'netRxKBs') === 120 && metricValue(snapshot, 'netTxKBs') === 60);
  rec(group, '未知 metric / 缺失数据 → null', metricValue(snapshot, 'nope') === null && metricValue({}, 'cpuTempC') === null);
}

function testRuleValidation() {
  const group = '规则校验';
  const h = makeEngineHarness();
  const bad = [
    [{ metric: 'nope', op: '>', value: 1, durationSec: 10, severity: 'warn' }, 'metric'],
    [{ metric: 'cpuPercent', op: '!=', value: 1, durationSec: 10, severity: 'warn' }, 'op'],
    [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 10, severity: 'fatal' }, 'severity'],
    [{ metric: 'cpuPercent', op: '>', value: 'x', durationSec: 10, severity: 'warn' }, 'value'],
    [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 4, severity: 'warn' }, 'duration'],
    [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 3601, severity: 'warn' }, 'duration'],
    [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 10, severity: 'warn', id: 'bad id!' }, 'id'],
  ];
  for (const [rule, label] of bad) {
    let code = '';
    try {
      normalizeRules([rule], { strict: true });
    } catch (e) {
      code = e.code;
    }
    rec(group, `非法 ${label} 被拒绝`, code === 'invalid_rules', code);
  }
  const tooMany = Array.from({ length: 31 }, (_, i) => ({ id: `r${i}`, metric: 'cpuPercent', op: '>', value: 90, durationSec: 60, severity: 'warn' }));
  let tooManyCode = '';
  try {
    normalizeRules(tooMany, { strict: true });
  } catch (e) {
    tooManyCode = e.code;
  }
  rec(group, '超过 30 条被拒绝', tooManyCode === 'invalid_rules');
  let dupCode = '';
  try {
    normalizeRules([
      { id: 'x', metric: 'cpuPercent', op: '>', value: 90, durationSec: 60, severity: 'warn' },
      { id: 'x', metric: 'memPercent', op: '>', value: 90, durationSec: 60, severity: 'warn' },
    ], { strict: true });
  } catch (e) {
    dupCode = e.code;
  }
  rec(group, '重复 id 被拒绝', dupCode === 'invalid_rules');

  const validRule = { id: 'v1', metric: 'memPercent', op: '>=', value: 80, durationSec: 5, severity: 'warn', enabled: false };
  const out = h.engine.update({ rules: [validRule], cooldownMinutes: 5, notifyOnRecover: false });
  rec(group, '合法更新生效并返回 rules', out.rules.length === 1 && out.rules[0].id === 'v1' && h.engine.describe().cooldownMinutes === 5 && h.engine.describe().notifyOnRecover === false);
  let cooldownCode = '';
  try {
    h.engine.update({ cooldownMinutes: 0 });
  } catch (e) {
    cooldownCode = e.code;
  }
  rec(group, 'cooldownMinutes 越界被拒绝', cooldownCode === 'invalid_rules');
  let enabledCode = '';
  try {
    h.engine.update({ enabled: 'yes' });
  } catch (e) {
    enabledCode = e.code;
  }
  rec(group, 'enabled 非布尔被拒绝', enabledCode === 'invalid_rules');
}

/* ---------------- 单元：通知 ---------------- */

async function testNotifyUnit(fakeHttp) {
  const group = '通知单元';
  // webhook 三种格式识别 + 通用 JSON
  const cases = [
    ['wecom', 'qyapi.weixin.qq.com', (p) => p.msgtype === 'text' && typeof p.text?.content === 'string'],
    ['dingtalk', 'oapi.dingtalk.com', (p) => p.msgtype === 'text' && typeof p.text?.content === 'string'],
    ['feishu', 'open.feishu.cn', (p) => p.msg_type === 'text' && typeof p.content?.text === 'string'],
    ['generic', 'example.invalid/hook', (p) => p.source === 'server-panel' && typeof p.text === 'string' && p.metric === 'cpuPercent'],
  ];
  for (const [label, marker, check] of cases) {
    fakeHttp.captured.length = 0;
    const notifier = new Notifier({
      config: { webhook: { enabled: true, type: 'auto', url: `http://127.0.0.1:${fakeHttp.port}/hook/${marker}` } },
    });
    await notifier.sendAlert({ type: 'alert', severity: 'crit', metric: 'cpuPercent', metricLabel: 'CPU 使用率', value: 95, threshold: 90, durationSec: 60 });
    await notifier.flush();
    const captured = fakeHttp.captured[0];
    let payload = {};
    try {
      payload = JSON.parse(captured?.body || '{}');
    } catch {
      payload = {};
    }
    rec(group, `webhook ${label} 格式识别`, Boolean(captured) && check(payload), captured?.body?.slice(0, 80));
  }

  // ntfy
  fakeHttp.captured.length = 0;
  const ntfy = new Notifier({ config: { ntfy: { enabled: true, url: `http://127.0.0.1:${fakeHttp.port}`, topic: 'test-topic' } } });
  await ntfy.sendAlert({ type: 'alert', severity: 'crit', metric: 'memPercent', metricLabel: '内存使用率', value: 95, threshold: 90 });
  await ntfy.flush();
  const ntfyReq = fakeHttp.captured[0];
  rec(group, 'ntfy POST 到 /topic 且正文含告警', Boolean(ntfyReq) && ntfyReq.url === '/test-topic' && ntfyReq.body.includes('内存使用率'), `${ntfyReq?.url}`);

  // 未配置时跳过发送
  const idle = new Notifier({});
  await idle.sendAlert({ type: 'alert', metric: 'cpuPercent', metricLabel: 'CPU 使用率', value: 99, threshold: 90 });
  await idle.flush();
  rec(group, '未启用任何渠道时静默跳过', idle.lastSentAt === null && idle.lastError === null);
  rec(group, '未配置 email/ntfy 的 test 返回 not_configured', (await idle.test('email')).detail === 'not_configured' && (await idle.test('ntfy')).detail === 'not_configured');

  // 密钥不回显
  const secretUrl = 'https://hooks.example.invalid/SECRET-HOOK-KEY-123';
  const secretNotifier = new Notifier({ config: { webhook: { enabled: true, url: secretUrl }, email: { enabled: true, host: 'smtp.example.invalid', port: 587, user: 'secret-user', pass: 'secret-pass-999', from: 'a@b.c', to: 'd@e.f' } } });
  const view = JSON.stringify(secretNotifier.describe());
  rec(group, 'describe() 不回显 webhook url / email 账号密码', !view.includes('SECRET-HOOK-KEY-123') && !view.includes('secret-pass-999') && !view.includes('secret-user') && secretNotifier.describe().webhook.urlSet === true && secretNotifier.describe().email.userSet === true && secretNotifier.describe().email.toSet === true, view.slice(0, 160));
}

async function testSmtpUnit(fakeSmtp, fakeHttp) {
  const group = 'SMTP 单元';
  const closedPort = await findFreePort(); // 拿一个当前没人监听的端口
  const notifier = new Notifier({
    config: {
      email: {
        enabled: true,
        host: '127.0.0.1',
        port: fakeSmtp.port,
        secure: false,
        user: 'mailuser@example.com',
        pass: 'mailpass-123',
        from: 'panel@example.com',
        to: 'ops@example.com',
      },
    },
  });
  const result = await notifier.test('email');
  rec(group, 'SMTP 明文投递成功（AUTH LOGIN）', result.ok === true && result.detail === 'ok' && typeof result.elapsedMs === 'number', JSON.stringify(result));
  const commands = fakeSmtp.state.commands.join('\n');
  rec(group, '├ EHLO / MAIL FROM / RCPT TO', /EHLO localhost/i.test(commands) && commands.includes('MAIL FROM:<panel@example.com>') && commands.includes('RCPT TO:<ops@example.com>'), commands.split('\n').slice(0, 5).join(' | '));
  rec(group, '├ AUTH LOGIN 使用 base64 凭据', commands.includes(Buffer.from('mailuser@example.com').toString('base64')) && commands.includes(Buffer.from('mailpass-123').toString('base64')));
  const message = fakeSmtp.state.messages[0] || '';
  rec(group, '└ 邮件正文 base64 且主题 UTF-8 编码', message.includes('Subject: =?UTF-8?B?') && /Content-Transfer-Encoding: base64/.test(message), message.split('\r\n').find((l) => l.startsWith('Subject')) || '');

  const failNotifier = new Notifier({
    config: { email: { enabled: true, host: '127.0.0.1', port: closedPort, from: 'a@b.c', to: 'd@e.f' } },
    timeoutMs: 2000,
  });
  const failResult = await failNotifier.test('email');
  rec(group, 'SMTP 连接失败返回错误码且不抛异常', failResult.ok === false && /^[A-Z_]+$|smtp_/.test(failResult.detail) && !failResult.detail.includes('a@b.c'), JSON.stringify(failResult));
  await failNotifier.sendAlert({ type: 'alert', metric: 'cpuPercent', metricLabel: 'CPU 使用率', value: 99, threshold: 90 });
  await failNotifier.flush();
  rec(group, '发送失败只记录 lastError（不含敏感信息）', typeof failNotifier.lastError === 'string' && failNotifier.lastError.length < 64 && !failNotifier.lastError.includes('127.0.0.1'), failNotifier.lastError);

  // 仅 email 关闭 → 静默跳过
  const disabled = new Notifier({ config: { email: { enabled: false, host: '127.0.0.1', port: fakeSmtp.port, from: 'a@b.c', to: 'd@e.f' } } });
  const before = fakeSmtp.state.commands.length;
  await disabled.sendAlert({ type: 'alert', metric: 'cpuPercent', metricLabel: 'CPU 使用率', value: 99, threshold: 90 });
  await disabled.flush();
  rec(group, 'email disabled 时不连接 SMTP', fakeSmtp.state.commands.length === before);
  void fakeHttp;
}

/* ---------------- 集成：接口与持久化 ---------------- */

async function testRulesApi(inst, client) {
  const group = '规则接口';
  const res = await client.call('/api/alerts/rules');
  const body = res.body || {};
  rec(group, 'GET /api/alerts/rules 返回默认配置', res.status === 200 && body.enabled === true && body.cooldownMinutes === 10 && body.notifyOnRecover === true && Array.isArray(body.rules) && body.rules.length === 5, `enabled=${body.enabled} rules=${body.rules?.length}`);
  rec(group, '默认规则字段完整', body.rules.every((r) => typeof r.id === 'string' && typeof r.metric === 'string' && typeof r.op === 'string' && Number.isFinite(r.value) && Number.isFinite(r.durationSec) && ['warn', 'crit'].includes(r.severity) && typeof r.enabled === 'boolean'), JSON.stringify(body.rules?.[0]));

  const invalidCases = [
    ['metric', { rules: [{ metric: 'nope', op: '>', value: 1, durationSec: 10, severity: 'warn' }] }],
    ['op', { rules: [{ metric: 'cpuPercent', op: '<>', value: 1, durationSec: 10, severity: 'warn' }] }],
    ['severity', { rules: [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 10, severity: 'x' }] }],
    ['duration', { rules: [{ metric: 'cpuPercent', op: '>', value: 1, durationSec: 4, severity: 'warn' }] }],
    ['cooldown', { cooldownMinutes: 0 }],
    ['rules 非数组', { rules: 'nope' }],
    ['31 条规则', { rules: Array.from({ length: 31 }, (_, i) => ({ id: `r${i}`, metric: 'cpuPercent', op: '>', value: 90, durationSec: 60, severity: 'warn' })) }],
  ];
  for (const [label, payload] of invalidCases) {
    const out = await client.call('/api/alerts/rules', { method: 'PUT', body: payload });
    rec(group, `PUT 非法 ${label} → 400`, out.status === 400 && out.body?.error === 'invalid_rules', `status=${out.status} ${JSON.stringify(out.body).slice(0, 80)}`);
  }

  // 先清空规则，避免真实环境触发默认告警干扰测试
  let out = await client.call('/api/alerts/rules', { method: 'PUT', body: { rules: [] } });
  rec(group, 'PUT 空规则数组被接受', out.status === 200 && Array.isArray(out.body?.rules) && out.body.rules.length === 0, `status=${out.status}`);

  const custom = { id: 'custom-cpu', metric: 'cpuPercent', op: '>=', value: 85, durationSec: 30, severity: 'crit', enabled: false };
  out = await client.call('/api/alerts/rules', { method: 'PUT', body: { rules: [custom], cooldownMinutes: 7, notifyOnRecover: false } });
  rec(group, 'PUT 合法规则生效', out.status === 200 && out.body.rules.length === 1 && out.body.rules[0].id === 'custom-cpu', JSON.stringify(out.body.rules));
  const got = await client.call('/api/alerts/rules');
  rec(group, '├ GET 反映新规则与开关', got.body.rules.length === 1 && got.body.cooldownMinutes === 7 && got.body.notifyOnRecover === false);
  const saved = JSON.parse(fs.readFileSync(inst.configPath, 'utf8'));
  rec(group, '└ 规则持久化到 config.json', saved.alerts?.rules?.length === 1 && saved.alerts.rules[0].id === 'custom-cpu' && saved.alerts.cooldownMinutes === 7);
}

function seedAlerts(inst) {
  const db = new DatabaseSync(path.join(inst.dataDir, 'metrics.db'));
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const insert = db.prepare('INSERT INTO alerts (ts, metric, value, threshold, message, severity, acknowledged) VALUES (?,?,?,?,?,?,?)');
    const now = Date.now();
    insert.run(now - 3000, 'cpuPercent', 95.5, 90, 'CPU 使用率告警', 'crit', 0);
    insert.run(now - 2000, 'memPercent', 92.1, 90, '内存使用率告警', 'warn', 0);
    insert.run(now - 1000, 'diskPercent', 91, 90, '磁盘使用率告警（已确认）', 'crit', 1);
    return { now };
  } finally {
    db.close();
  }
}

async function testAlertsApi(inst, client) {
  const group = '告警列表';
  seedAlerts(inst);

  let res = await client.call('/api/alerts?limit=10');
  rec(group, 'GET /api/alerts 返回列表与 severity', res.status === 200 && Array.isArray(res.body?.alerts) && res.body.alerts.length >= 3 && res.body.alerts.every((a) => ['warn', 'crit'].includes(a.severity)), `count=${res.body?.alerts?.length}`);
  rec(group, '└ 字段完整', res.body.alerts.every((a) => Number.isFinite(a.id) && Number.isFinite(a.ts) && typeof a.metric === 'string' && Number.isFinite(a.value) && Number.isFinite(a.threshold) && typeof a.message === 'string' && typeof a.acknowledged === 'number'));

  res = await client.call('/api/alerts?severity=crit&unacked=1');
  rec(group, 'severity + unacked 过滤', res.body.alerts.length === 1 && res.body.alerts[0].severity === 'crit' && res.body.alerts[0].acknowledged === 0, `count=${res.body.alerts.length}`);
  res = await client.call('/api/alerts?severity=bogus');
  rec(group, '非法 severity → 400', res.status === 400, `status=${res.status}`);

  const target = (await client.call('/api/alerts?unacked=1')).body.alerts[0];
  res = await client.call('/api/alerts/ack', { method: 'POST', body: { id: target.id } });
  rec(group, 'ack 单条返回 count=1', res.status === 200 && res.body.ok === true && res.body.count === 1, JSON.stringify(res.body));
  res = await client.call('/api/alerts/ack', { method: 'POST', body: { id: target.id } });
  rec(group, '重复 ack count=0', res.body.count === 0);
  res = await client.call('/api/alerts/ack_all', { method: 'POST' });
  rec(group, 'ack_all 返回更新数量', res.status === 200 && res.body.ok === true && res.body.count >= 1, JSON.stringify(res.body));
  res = await client.call('/api/alerts?unacked=1');
  rec(group, 'ack_all 后无未确认告警', res.body.alerts.length === 0);
  res = await client.call('/api/alerts/ack', { method: 'POST', body: { id: 'x' } });
  rec(group, '非法 id → 400', res.status === 400);

  res = await client.call('/api/alerts/state');
  rec(group, 'GET /api/alerts/state 结构正确', res.status === 200 && Array.isArray(res.body?.firing) && (res.body.lastEvalAt === null || Number.isFinite(res.body.lastEvalAt)), `firing=${res.body?.firing?.length} lastEvalAt=${res.body?.lastEvalAt}`);
}

async function testNotifyApi(inst, client, fakeHttp, fakeSmtp) {
  const group = '通知接口';
  let res = await client.call('/api/notify');
  rec(group, 'GET /api/notify 默认关闭且不回显密钥', res.status === 200 && res.body.webhook.enabled === false && res.body.webhook.urlSet === false && res.body.email.userSet === false && res.body.email.toSet === false, JSON.stringify(res.body).slice(0, 120));

  // 配置带密钥的渠道，验证不回显
  res = await client.call('/api/notify', {
    method: 'PUT',
    body: {
      webhook: { enabled: true, url: 'https://hooks.example.invalid/SECRET-HOOK-KEY-123' },
      email: { enabled: true, host: 'smtp.example.invalid', port: 587, user: 'secret-user', pass: 'secret-pass-999', from: 'a@b.c', to: 'd@e.f' },
      ntfy: { enabled: true, url: 'https://ntfy.example.invalid', topic: 'panel-topic' },
    },
  });
  rec(group, 'PUT /api/notify 保存配置（返回不含密钥）', res.status === 200 && res.body.webhook.urlSet === true && res.body.email.userSet === true && !JSON.stringify(res.body).includes('SECRET-HOOK-KEY-123') && !JSON.stringify(res.body).includes('secret-pass-999'), JSON.stringify(res.body).slice(0, 140));
  res = await client.call('/api/notify');
  rec(group, '└ GET 仍不返回 url/pass/user', !JSON.stringify(res.body).includes('SECRET-HOOK-KEY-123') && !res.body.webhook.url && !res.body.email.pass && !res.body.email.user, JSON.stringify(res.body).slice(0, 160));

  // 空串=保持，null=清空
  res = await client.call('/api/notify', { method: 'PUT', body: { webhook: { url: '' }, email: { pass: '' } } });
  rec(group, '空字符串=保持原值', res.body.webhook.urlSet === true && res.body.email.userSet === true, `urlSet=${res.body.webhook.urlSet}`);
  res = await client.call('/api/notify', { method: 'PUT', body: { webhook: { enabled: false, url: null }, email: { pass: null } } });
  rec(group, 'null=清空字段（url 清空需同时关闭 webhook）', res.status === 200 && res.body.webhook.urlSet === false && res.body.email.userSet === true, `urlSet=${res.body.webhook?.urlSet} userSet=${res.body.email?.userSet}`);

  // 非法配置
  res = await client.call('/api/notify', { method: 'PUT', body: { webhook: { enabled: true, url: 'not-a-url' } } });
  rec(group, '非法 webhook url → 400', res.status === 400 && res.body.error === 'invalid_notify', JSON.stringify(res.body));
  res = await client.call('/api/notify', { method: 'PUT', body: { ntfy: { enabled: true, topic: 'bad topic!' } } });
  rec(group, '非法 ntfy topic → 400', res.status === 400);

  // webhook test 走本地假服务
  res = await client.call('/api/notify', {
    method: 'PUT',
    body: { webhook: { enabled: true, url: `http://127.0.0.1:${fakeHttp.port}/hook/real` }, email: { enabled: false }, ntfy: { enabled: false } },
  });
  rec(group, '配置本地 webhook 成功', res.status === 200);
  fakeHttp.captured.length = 0;
  res = await client.call('/api/notify/test', { method: 'POST', body: { channel: 'webhook' } });
  rec(group, 'POST /api/notify/test webhook → ok', res.status === 200 && res.body.ok === true && typeof res.body.elapsedMs === 'number', JSON.stringify(res.body));
  rec(group, '└ 假 webhook 收到 JSON 通知', fakeHttp.captured.length === 1 && fakeHttp.captured[0].body.includes('测试通知'), fakeHttp.captured[0]?.body?.slice(0, 100));

  // ntfy test
  await client.call('/api/notify', { method: 'PUT', body: { ntfy: { enabled: true, url: `http://127.0.0.1:${fakeHttp.port}`, topic: 'panel-test' } } });
  fakeHttp.captured.length = 0;
  res = await client.call('/api/notify/test', { method: 'POST', body: { channel: 'ntfy' } });
  rec(group, 'POST /api/notify/test ntfy → ok', res.body.ok === true && fakeHttp.captured[0]?.url === '/panel-test', JSON.stringify(res.body));

  // email test（本地假 SMTP）
  await client.call('/api/notify', {
    method: 'PUT',
    body: { email: { enabled: true, host: '127.0.0.1', port: fakeSmtp.port, secure: false, user: 'u@example.com', pass: 'p-123', from: 'panel@example.com', to: 'ops@example.com' } },
  });
  res = await client.call('/api/notify/test', { method: 'POST', body: { channel: 'email' } });
  rec(group, 'POST /api/notify/test email → ok', res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
  rec(group, '└ 假 SMTP 收到 MAIL/RCPT', fakeSmtp.state.commands.some((c) => c.startsWith('MAIL FROM:<panel@example.com>')));
  res = await client.call('/api/notify/test', { method: 'POST', body: { channel: 'bogus' } });
  rec(group, '非法 channel → 400', res.status === 400);

  // SMTP 连接失败只记录
  const closedPort = await findFreePort();
  await client.call('/api/notify', { method: 'PUT', body: { email: { enabled: true, host: '127.0.0.1', port: closedPort } } });
  res = await client.call('/api/notify/test', { method: 'POST', body: { channel: 'email' } });
  rec(group, 'SMTP 失败时 test 返回 ok:false + 错误码', res.status === 200 && res.body.ok === false && typeof res.body.detail === 'string' && !res.body.detail.includes('127.0.0.1'), JSON.stringify(res.body));
  const notifyView = await client.call('/api/notify');
  rec(group, '└ GET /api/notify lastError 为脱敏错误码', typeof notifyView.body.lastError === 'string' && notifyView.body.lastError.length < 64 && !notifyView.body.lastError.includes('127.0.0.1'), notifyView.body.lastError);

  // 日志/审计不含密钥
  const logs = inst.logs.join('');
  const auditPath = path.join(inst.dataDir, 'audit.log');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  rec(group, '服务日志与审计不含通知密钥', !logs.includes('secret-pass-999') && !logs.includes('SECRET-HOOK-KEY-123') && !audit.includes('secret-pass-999') && !audit.includes('SECRET-HOOK-KEY-123'));
  rec(group, 'config.json 中保存了 notify 配置', fs.existsSync(inst.configPath) && JSON.parse(fs.readFileSync(inst.configPath, 'utf8')).notify?.email?.host === '127.0.0.1');
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ 告警引擎 + 规则 + 通知渠道 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  testEngineUnit();
  testMetricMapping();
  testRuleValidation();

  const fakeHttp = await startFakeHttp();
  const fakeSmtp = await startFakeSmtp();
  try {
    await testNotifyUnit(fakeHttp);
    await testSmtpUnit(fakeSmtp, fakeHttp);

    const prepared = prepareDir('main');
    const inst = await spawnInstance(prepared);
    const client = makeClient(inst.base);
    await client.login();

    await testRulesApi(inst, client);
    await testAlertsApi(inst, client);
    await testNotifyApi(inst, client, fakeHttp, fakeSmtp);
    await inst.stop();
  } finally {
    await fakeHttp.close();
    await fakeSmtp.close();
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
    } catch {
      /* ignore */
    }
  }
  process.exitCode = failed.length ? 1 : 0;
}

async function cleanupInstances() {
  await Promise.all(instances.map((i) => i.stop().catch(() => {})));
}

process.on('SIGINT', async () => {
  await cleanupInstances();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanupInstances();
  process.exit(143);
});

try {
  await main();
} catch (e) {
  console.error('\n💥 测试执行异常:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  await cleanupInstances();
}
