#!/usr/bin/env node
/**
 * DSH 集成 / PWA 静态 / 可选 TLS 回归测试（零依赖，Node 22+）
 *
 * 默认（自包含）模式：在 /tmp 下创建隔离实例（独立 config/data/端口），
 * 用 fake dsh 脚本验证任务启动、参数、审计、SSE 生命周期、并发与超时，
 * 不会触碰正式 systemd 实例（3081）。
 *
 * 附着模式：设置 PANEL_BASE（可选 PANEL_PASSWORD）后只对已运行实例执行只读/鉴权检查：
 *   PANEL_BASE=http://127.0.0.1:3099 node tests/dsh-test.mjs "<密码>"
 *
 * 用法：
 *   node tests/dsh-test.mjs                # 自包含
 *   node tests/dsh-test.mjs "<密码>"       # 自包含，指定测试实例密码
 *   node tests/dsh-test.mjs "<密码>" --keep # 失败时保留 /tmp 目录便于排查
 *
 * 退出码：0 全部通过；1 存在失败。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hashPassword, generatePassword } = require('../lib/config.js');
const { extractDshToken, classifyHost, resolveDshConfig, runBounded, DshManager, parseCredentialsRefs, loadCredentialsRefs, DEFAULT_PATCH } = require('../lib/dsh.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROJECT_PUBLIC = path.join(ROOT, 'public');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const ATTACH_BASE = process.env.PANEL_BASE || '';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-dsh-test-'));
const results = [];
const skipped = [];
const instances = [];

/* ---------------- 断言记录 ---------------- */

function rec(group, name, ok, detail, ms) {
  results.push({ group, name, ok: Boolean(ok), detail, ms });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}${ms !== undefined ? ` (${ms}ms)` : ''}`);
}

function skip(name, detail) {
  skipped.push({ name, detail });
  console.log(`⏭️  [跳过] ${name}${detail ? ' — ' + detail : ''}`);
}

function eqJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ---------------- HTTP 基础工具 ---------------- */

function request(base, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const headers = { ...(opts.headers || {}) };
    let payload = null;
    if (opts.body !== undefined) {
      payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
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
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          body,
          setCookie: res.headers['set-cookie'] || [],
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 15000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 读取一条 SSE 流直到服务端关闭，收集所有 data: JSON 事件 */
function collectSse(base, pathname, cookie, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), {
      method: 'GET',
      headers: { Cookie: cookie || '', Accept: 'text/event-stream' },
    }, (res) => {
      const events = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              events.push(JSON.parse(raw));
            } catch {
              events.push({ raw });
            }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, events }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('sse timeout')));
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
    setCookieHeader(value) {
      cookie = value;
    },
    async call(pathname, opts = {}) {
      const method = opts.method || 'GET';
      const r = await request(base, pathname, {
        ...opts,
        method,
        cookie: cookie || undefined,
        csrf: method === 'GET' ? undefined : csrf || undefined,
      });
      for (const c of r.setCookie) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      return r;
    },
    async login(username = 'admin', password = PASSWORD) {
      const r = await this.call('/api/login', { method: 'POST', body: { username, password } });
      if (r.status !== 200 || !r.body || !r.body.csrf) {
        throw new Error(`登录失败 status=${r.status} body=${String(r.text).slice(0, 200)}`);
      }
      csrf = r.body.csrf;
      return r;
    },
  };
}

/* ---------------- 隔离实例 ---------------- */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function writeConfig(dir, patch) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: {
      title: '面板测试',
      username: 'admin',
      passwordHash: hashPassword(PASSWORD, salt),
      passwordSalt: salt,
      mustChangePassword: false,
    },
    session: { secret: crypto.randomBytes(32).toString('hex') },
    sampleIntervalMs: 500,
    ...patch,
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return configPath;
}

async function waitForHttp(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`实例提前退出 code=${child.exitCode}`);
    }
    try {
      const r = await request(new URL(url).origin, new URL(url).pathname, { timeoutMs: 1000 });
      if (r.status === 200) return r;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待实例启动超时: ${url}`);
}

async function startInstance(name, configPatch, options = {}) {
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = path.join(TMP_ROOT, name);
  const configPath = writeConfig(dir, configPatch);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: configPath,
      PANEL_DATA_DIR: path.join(dir, 'data'),
      PANEL_PORT: String(port),
      PANEL_HOST: '127.0.0.1',
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  child.on('exit', (code) => logs.push(`\n[exit] code=${code}\n`));

  const inst = {
    name,
    port,
    base,
    dir,
    child,
    logs,
    configPath,
    dataDir: path.join(dir, 'data'),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 4000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };

  try {
    await waitForHttp(base + '/api/app/info', 12000, child);
  } catch (e) {
    throw new Error(`${name} 启动失败: ${e.message}\n--- logs ---\n${logs.join('')}`);
  }
  await new Promise((r) => setTimeout(r, 250)); // 给 TLS 告警等启动日志一点时间
  instances.push(inst);
  return inst;
}

function writeScript(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

/* ---------------- 测试：纯函数（journal 解析 / host 分类） ---------------- */

async function testPureFunctions() {
  const group = '工具函数';
  const journal = [
    '2026-10-20T17:46:26+08:00 hb dsh[215504]: dsh web: https://myhost.example.ts.net/?token=oldtokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '2026-10-22T17:42:55+08:00 hb dsh[405376]: dsh web: https://myhost.example.ts.net/?token=newtokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    '2026-10-22T17:42:54+08:00 hb dsh[405376]: dsh web: listening on 192.168.1.10 over plain HTTP',
  ].join('\n');
  const parsed = extractDshToken(journal);
  rec(group, 'journal 解析取最新时间戳 token', parsed && parsed.token === 'newtokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', parsed && parsed.token);

  const noTs = extractDshToken('dsh web: https://x/?token=aaa\ndsh web: https://x/?token=bbb');
  rec(group, '无时间戳时取最后一条 token', noTs && noTs.token === 'bbb', noTs && noTs.token);
  rec(group, '无 token 返回 null', extractDshToken('dsh web: listening only') === null);

  const cases = [
    ['192.168.1.10:3081', 'lan'],
    ['100.64.0.5:3081', 'public'],
    ['myhost.example.ts.net', 'public'],
    ['localhost:3099', 'lan'],
  ];
  const cls = cases.map(([host, want]) => [host, classifyHost(host), want]);
  rec(group, '按 Host 判定 lan/public', cls.every(([h, got, want]) => got === want), cls.map(([h, g]) => `${h}=${g}`).join(' '));

  // 配置默认值与 allowTask 严格布尔
  const cfgStrict = resolveDshConfig({ dsh: { allowTask: 'true' } });
  rec(group, 'allowTask 仅接受布尔 true（字符串 true 无效）', cfgStrict.allowTask === false);
  const cfgCustom = resolveDshConfig({ dsh: { allowTask: true, taskTimeoutMs: 1234 } });
  rec(group, 'taskTimeoutMs 覆盖生效', cfgCustom.allowTask === true && cfgCustom.taskTimeoutMs === 1234, `timeout=${cfgCustom.taskTimeoutMs}`);

  // headless 补丁与 credentials 默认值
  const cfgDefault = resolveDshConfig({});
  rec(group, 'patch 默认为空（开源通用：不默认加载本机模型路由补丁）',
    cfgDefault.patch === '' && typeof DEFAULT_PATCH === 'string' && DEFAULT_PATCH.endsWith('.example.yml'),
    `patch="${cfgDefault.patch}" example=${DEFAULT_PATCH}`);
  const cfgPatch = resolveDshConfig({ dsh: { patch: '/tmp/my-headless.patch.yml' } });
  rec(group, 'patch 可由 config.dsh.patch 显式指定', cfgPatch.patch === '/tmp/my-headless.patch.yml', cfgPatch.patch);
  rec(group, 'credentialsFile 默认 $DSH_HOME/.credentials.yaml',
    cfgDefault.credentialsFile === path.join(cfgDefault.home, '.credentials.yaml') && cfgDefault.credentialsMaxBytes === 64 * 1024,
    cfgDefault.credentialsFile);
  const cfgNoPatch = resolveDshConfig({ dsh: { patch: '', env: { OK_KEY: 'v', '9BAD': 'x', NUM: 2 } } });
  rec(group, 'patch="" 可禁用；dsh.env 过滤非法变量名并字符串化',
    cfgNoPatch.patch === '' && eqJson(cfgNoPatch.env, { OK_KEY: 'v', NUM: '2' }),
    JSON.stringify(cfgNoPatch.env));

  // credentials 最小解析（值全部是假密钥，不涉及真实凭据）
  const credSample = [
    'version: 1',
    'records:',
    '  - kind: x',
    'refs:',
    '  MY_LLM_API_KEY: "fake-quoted-ref"',
    '  URL_VALUE: https://example.invalid/path:8080',
    "  SINGLE_QUOTED: 'fake-single-ref'",
    '  EMPTY_REF:',
    '  BROKEN_LINE_WITHOUT_COLON',
    'other: top-level',
  ].join('\n');
  const parsedRefs = parseCredentialsRefs(credSample);
  rec(group, 'credentials refs 最小解析（引号/冒号/畸形行）',
    parsedRefs.MY_LLM_API_KEY === 'fake-quoted-ref'
      && parsedRefs.URL_VALUE === 'https://example.invalid/path:8080'
      && parsedRefs.SINGLE_QUOTED === 'fake-single-ref'
      && parsedRefs.EMPTY_REF === undefined
      && parsedRefs.other === undefined,
    JSON.stringify(Object.keys(parsedRefs)));
  const missingCred = loadCredentialsRefs(path.join(TMP_ROOT, 'no-such-credentials.yaml'));
  rec(group, 'credentials 缺失静默降级（不抛异常）', missingCred.missing === true && eqJson(missingCred.refs, {}));
  const oversizePath = path.join(TMP_ROOT, 'oversize-credentials.yaml');
  fs.writeFileSync(oversizePath, 'refs:\n  X: ' + 'y'.repeat(70 * 1024));
  rec(group, 'credentials >64KB 返回错误码且不加载', loadCredentialsRefs(oversizePath, 64 * 1024).error === 'size_exceeded');
  const malformedPath = path.join(TMP_ROOT, 'malformed-credentials.yaml');
  fs.writeFileSync(malformedPath, 'refs:\n  MY_LLM_API_KEY: "unterminated\n  BROKEN\n\u0000\u0001');
  const malformed = loadCredentialsRefs(malformedPath);
  rec(group, 'credentials 畸形内容不抛异常', malformed.error === null && typeof malformed.refs === 'object');

  // consoleUrlCustom 优先且原样返回
  const customMgr = new DshManager({ config: { dsh: { consoleUrlCustom: 'https://custom.example/console?token=xyz' } } });
  try {
    const out = await customMgr.consoleUrl('192.168.1.10:3081');
    rec(group, 'consoleUrlCustom 优先且原样返回', out.mode === 'custom' && out.url === 'https://custom.example/console?token=xyz', JSON.stringify(out));
  } finally {
    customMgr.closeAll();
  }

  // 有界命令执行：超时 kill 与输出字节上限
  const t0 = Date.now();
  const slow = await runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200, maxBytes: 1024 });
  rec(group, 'runBounded 超时 kill', slow.ok === false && slow.error === 'timeout' && Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  const big = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { timeoutMs: 3000, maxBytes: 1024 });
  rec(group, 'runBounded 输出字节上限', big.truncated === true && Buffer.byteLength(big.stdout) <= 1024, `bytes=${Buffer.byteLength(big.stdout)} truncated=${big.truncated}`);
}

/* ---------------- 测试：鉴权与只读 API ---------------- */

async function testAuthAndReadonly(inst, opts = {}) {
  const allowTaskKnown = opts.allowTaskKnown === true;
  const group = '鉴权';
  const anon = makeClient(inst.base);

  let r = await anon.call('/api/app/info');
  const info = r.body || {};
  const dshTaskEnabled = info.features?.dshTask === true;
  rec(group, '/api/app/info 免登录可访问', r.status === 200, `status=${r.status}`, undefined);
  rec(group, '├ 契约字段 app/version/name', info.app === 'server-panel' && info.version === '0.2.0' && info.name, `${info.app}@${info.version} ${info.name}`);
  rec(group, '├ features/endpoints 字段', info.features && typeof info.features.dsh === 'boolean' && info.features.pwa === true && typeof info.features.dshTask === 'boolean' && info.endpoints?.dshConsole === '/api/dsh/console-url', JSON.stringify(info.features));
  rec(group, '└ 响应为 JSON + no-store', /application\/json/.test(r.headers['content-type'] || '') && r.headers['cache-control'] === 'no-store', r.headers['content-type']);

  for (const p of ['/api/dsh/status', '/api/dsh/console-url', '/api/dsh/sessions']) {
    r = await anon.call(p);
    rec(group, `未登录 ${p} → 401`, r.status === 401, `status=${r.status}`);
  }
  r = await anon.call('/api/dsh/task', { method: 'POST', body: { prompt: 'x' } });
  rec(group, '未登录 POST /api/dsh/task → 401', r.status === 401, `status=${r.status}`);

  r = await anon.call('/api/dsh/task/stream?id=nope');
  rec(group, '未登录任务流 → 401', r.status === 401, `status=${r.status}`);

  const client = makeClient(inst.base);
  r = await client.call('/api/login', { method: 'POST', body: { username: 'admin', password: 'definitely-wrong' } });
  rec(group, '错误密码 → 401', r.status === 401, `status=${r.status}`);
  await client.login();

  r = await client.call('/api/session');
  rec(group, '登录后会话有效', r.status === 200 && r.body?.authenticated === true, `user=${r.body?.username}`);

  // 缺 CSRF：手工请求（client.call 会自动带 CSRF）
  r = await request(inst.base, '/api/dsh/task', {
    method: 'POST',
    headers: { Cookie: client.cookie },
    body: { prompt: 'x' },
  });
  rec(group, '写操作缺 CSRF → 403', r.status === 403, `status=${r.status}`);

  // 附着模式下 allowTask 可能为 true，不能在别人的实例上启动真实任务
  if (allowTaskKnown || !dshTaskEnabled) {
    r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'x' } });
    rec(group, 'allowTask=false → 403 dsh_task_disabled', r.status === 403 && r.body?.error === 'dsh_task_disabled', JSON.stringify(r.body));
  } else {
    skip('allowTask=false → 403 dsh_task_disabled', '附着实例 allowTask=true，跳过以免启动真实任务');
  }

  return { client, dshTaskEnabled };
}

async function testStatus(client, opts = {}) {
  const allowTaskKnown = opts.allowTaskKnown === true;
  const group = 'DSH 状态';
  const t0 = Date.now();
  let r = await client.call('/api/dsh/status');
  const s = r.body || {};
  rec(group, 'GET /api/dsh/status 可访问', r.status === 200, `status=${r.status}`, Date.now() - t0);
  rec(group, '├ available 为布尔且含 home', typeof s.available === 'boolean' && typeof s.home === 'string', `available=${s.available} home=${s.home}`);
  rec(group, '├ web.reachable 为布尔', typeof s.web?.reachable === 'boolean', `reachable=${s.web?.reachable} pid=${s.web?.pid} profile=${s.web?.profile} uptime=${s.web?.uptimeSec}s`);
  rec(group, '├ profile 与 uptime 类型正确', (s.web?.profile === null || typeof s.web?.profile === 'string') && (s.web?.uptimeSec === null || typeof s.web?.uptimeSec === 'number'), `profile=${s.web?.profile}`);
  rec(group, '├ tokenFound/allowTask 为布尔', typeof s.tokenFound === 'boolean' && typeof s.allowTask === 'boolean', `tokenFound=${s.tokenFound} allowTask=${s.allowTask}`);
  if (allowTaskKnown) {
    rec(group, '├ allowTask 与配置一致（false）', s.allowTask === false, `allowTask=${s.allowTask}`);
  }
  const infoRes = await client.call('/api/app/info');
  rec(group, '├ allowTask 与 app/info features.dshTask 一致', infoRes.body?.features?.dshTask === s.allowTask, `status=${s.allowTask} appInfo=${infoRes.body?.features?.dshTask}`);
  rec(group, '└ errors 为数组', Array.isArray(s.errors), JSON.stringify(s.errors));

  if (s.available && !s.web?.reachable) {
    rec(group, 'web 可达性（本机 DSH 运行中）', true, '跳过：DSH 未运行属环境差异');
  }
}

async function testConsoleUrl(client) {
  const group = '控制台 URL';
  const t0 = Date.now();
  const r = await client.call('/api/dsh/console-url');
  const body = r.body || {};
  rec(group, 'GET /api/dsh/console-url 响应', r.status === 200 || r.status === 502, `status=${r.status}`, Date.now() - t0);

  if (r.status === 502) {
    rec(group, 'journal 不可用时返回契约错误', body.error === 'dsh_console_unavailable' && typeof body.detail === 'string', JSON.stringify(body));
    skip('lan/public URL 改写', '本机 journal 中无 dsh web token');
    return;
  }

  rec(group, '├ url 含 token 参数', typeof body.url === 'string' && /[?&]token=[A-Za-z0-9._~+/=-]+/.test(body.url), body.url.replace(/token=.*/, 'token=***'));
  rec(group, '└ 默认按请求 Host 推导 lan 地址（匿名机可用）', body.mode === 'lan' && /^http:\/\/127\.0\.0\.1:3080\/\?token=/.test(body.url), `mode=${body.mode} url=${String(body.url).replace(/token=.*/, 'token=***')}`);

  // 伪造 Host 验证 tailnet 改写
  const pub = await request(client.base, '/api/dsh/console-url', {
    headers: { Host: 'myhost.example.ts.net', Cookie: client.cookie },
  });
  const pubBody = pub.body || {};
  rec(group, 'Host=*.ts.net → mode=public + https 公网 URL', pub.status === 200 && pubBody.mode === 'public' && /^https:\/\/myhost\.example\.ts\.net\/\?token=/.test(pubBody.url || ''), `mode=${pubBody.mode}`);

  const lan = await request(client.base, '/api/dsh/console-url', {
    headers: { Host: '192.168.1.10:3081', Cookie: client.cookie },
  });
  rec(group, 'Host=局域网 IP → mode=lan', lan.status === 200 && lan.body?.mode === 'lan' && /^http:\/\/192\.168\.1\.10:3080\//.test(lan.body?.url || ''), `mode=${lan.body?.mode}`);

  const tail = await request(client.base, '/api/dsh/console-url', {
    headers: { Host: '100.64.0.5:3081', Cookie: client.cookie },
  });
  rec(group, 'Host=tailnet IP → mode=public', tail.status === 200 && tail.body?.mode === 'public', `mode=${tail.body?.mode}`);
}

async function testSessions(client) {
  const group = '会话列表';
  const t0 = Date.now();
  let r = await client.call('/api/dsh/sessions?limit=5');
  const data = r.body || {};
  const list = data.sessions || [];
  rec(group, 'GET /api/dsh/sessions?limit=5', r.status === 200 && Array.isArray(list), `status=${r.status}`, Date.now() - t0);
  rec(group, '├ 契约字段 sessions/total/truncated', Array.isArray(data.sessions) && typeof data.total === 'number' && typeof data.truncated === 'boolean', `total=${data.total} 返回=${list.length} truncated=${data.truncated}`);
  rec(group, '├ limit 生效', list.length <= 5, `返回 ${list.length} 条`);
  if (list.length) {
    const s = list[0];
    rec(group, '├ 会话字段完整', typeof s.id === 'string' && s.id.startsWith('session-') && typeof s.cwd === 'string' && Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt) && Number.isFinite(s.sizeBytes), `${s.id.slice(0, 24)}… cwd=${s.cwd}`);
    const sorted = list.every((x, i) => i === 0 || list[i - 1].updatedAt >= x.updatedAt);
    rec(group, '└ 按 updatedAt 倒序', sorted);
    rec(group, 'total 与 truncated 自洽', data.truncated === data.total > list.length, `total=${data.total} len=${list.length}`);
  } else {
    skip('会话字段与排序', 'DSH_HOME/sessions 下暂无会话文件');
  }

  r = await client.call('/api/dsh/sessions?limit=999');
  rec(group, 'limit 上限被钳制到 200', r.status === 200 && (r.body?.sessions?.length || 0) <= 200, `返回 ${r.body?.sessions?.length} 条`);

  r = await client.call('/api/dsh/sessions');
  rec(group, '默认 limit=50（会话目录）', r.status === 200 && (r.body?.sessions?.length || 0) <= 50, `返回 ${r.body?.sessions?.length} 条`);
}

/* ---------------- 测试：静态 / PWA / /api 回退 ---------------- */

async function testStatic(inst) {
  const group = '静态与 PWA';

  let r = await request(inst.base, '/api/definitely-not-a-route');
  rec(group, '未知 /api/* → JSON 404（不回落 HTML）', r.status === 404 && /application\/json/.test(r.headers['content-type'] || '') && typeof r.body === 'object', `status=${r.status} type=${r.headers['content-type']}`);

  r = await request(inst.base, '/api');
  rec(group, '/api → JSON 404', r.status === 404 && /application\/json/.test(r.headers['content-type'] || ''), `status=${r.status}`);

  r = await request(inst.base, '/some/spa/route');
  rec(group, '未知页面 → SPA 回退 index.html', r.status === 200 && /text\/html/.test(r.headers['content-type'] || '') && r.text.includes('<html'), `status=${r.status}`);

  const swPath = path.join(PROJECT_PUBLIC, 'sw.js');
  if (fs.existsSync(swPath)) {
    r = await request(inst.base, '/sw.js');
    rec(group, '/sw.js → no-cache + Service-Worker-Allowed:/', r.status === 200 && r.headers['cache-control'] === 'no-cache' && r.headers['service-worker-allowed'] === '/', `cache-control=${r.headers['cache-control']} allowed=${r.headers['service-worker-allowed']}`);
  } else {
    skip('/sw.js 响应头', 'public/sw.js 尚未由前端创建');
  }

  const manifestPath = path.join(PROJECT_PUBLIC, 'manifest.webmanifest');
  if (fs.existsSync(manifestPath)) {
    r = await request(inst.base, '/manifest.webmanifest');
    rec(group, '/manifest.webmanifest → application/manifest+json + no-cache', r.status === 200 && /application\/manifest\+json/.test(r.headers['content-type'] || '') && r.headers['cache-control'] === 'no-cache', `type=${r.headers['content-type']}`);
  } else {
    skip('/manifest.webmanifest MIME', 'public/manifest.webmanifest 尚未由前端创建');
  }

  r = await request(inst.base, '/app.js');
  rec(group, '既有静态资源 MIME 未回归', r.status === 200 && /javascript/.test(r.headers['content-type'] || ''), `type=${r.headers['content-type']}`);
}

/* ---------------- 测试：TLS 证书错误仅告警 ---------------- */

function testTlsWarn(inst) {
  const group = '可选 TLS';
  const joined = inst.logs.join('');
  rec(group, '证书不可读时仅告警不崩溃', /\[tls\]/.test(joined), (joined.split('\n').find((l) => l.includes('[tls]')) || '').trim());
  rec(group, 'HTTP listener 不受 TLS 影响', inst.child.exitCode === null, `pid=${inst.child.pid}`);
}

/** TLS 正常路径：配置有效自签证书时额外 HTTPS listener 的路由与 HTTP 一致（需 openssl，缺失则跳过） */
async function testTlsPositive() {
  const group = '可选 TLS';
  const probe = spawnSync('openssl', ['version'], { timeout: 5000 });
  if (probe.error || probe.status !== 0) {
    skip('TLS 正常证书路径', '未找到 openssl，跳过自签证书验证');
    return;
  }

  const dir = path.join(TMP_ROOT, 'tls-live');
  fs.mkdirSync(dir, { recursive: true });
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
  ], { timeout: 20000 });
  if (gen.status !== 0) {
    skip('TLS 正常证书路径', 'openssl 生成自签证书失败');
    return;
  }

  const tlsPort = await findFreePort();
  await startInstance('tls-live', {
    dsh: { allowTask: false },
    tls: { cert, key, port: tlsPort },
  });

  const httpsGet = (pathname) => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: tlsPort, path: pathname, rejectUnauthorized: false }, (res) => {
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
        resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body });
      });
    }).on('error', reject);
  });

  try {
    const info = await httpsGet('/api/app/info');
    rec(group, '配置有效 tls 时额外 HTTPS listener 可用', info.status === 200 && /application\/json/.test(info.type) && info.body?.app === 'server-panel', `https://127.0.0.1:${tlsPort}`);
    const miss = await httpsGet('/api/definitely-not-a-route');
    rec(group, 'HTTPS 路由与 HTTP 一致（未知 api JSON 404）', miss.status === 404 && /application\/json/.test(miss.type), `status=${miss.status}`);
  } catch (e) {
    rec(group, '配置有效 tls 时额外 HTTPS listener 可用', false, e.message);
  }
}

/* ---------------- 测试：任务 + SSE + 审计 ---------------- */

function normalFakeScript(dir, argsName = 'task-args.txt') {
  const argsFile = path.join(dir, argsName);
  return writeScript(path.join(dir, argsName.replace(/\.txt$/, '') + '.sh'), `#!/bin/sh
OUT=${JSON.stringify(argsFile)}
{
  echo "ARGS:"
  for a in "$@"; do echo "ARG:$a"; done
  echo "ENV_DSH_HOME=$DSH_HOME"
  echo "ENV_HOME=$HOME"
  for name in MY_LLM_API_KEY FAKE_PANEL_REF PANEL_EXTRA; do
    value=$(printenv "$name" 2>/dev/null || true)
    echo "ENV_$name=$value"
  done
} > "$OUT"
echo '{"type":"session","sessionId":"session-fake-1"}'
echo 'plain stdout line'
echo 'fake stderr line' >&2
sleep 0.7
echo '{"type":"result","sessionId":"session-fake-1","ok":true}'
exit 0
`);
}

function slowFakeScript(dir) {
  return writeScript(path.join(dir, 'fake-dsh-slow.sh'), `#!/bin/sh
echo '{"type":"session","sessionId":"session-slow-1"}'
echo slow-start
exec sleep 8
`);
}

async function testTaskFlow(inst, ctx) {
  const group = '任务与 SSE';
  const client = makeClient(inst.base);
  await client.login();

  let r = await client.call('/api/app/info');
  rec(group, 'allowTask=true 时 features.dshTask=true', r.body?.features?.dshTask === true, JSON.stringify(r.body?.features));

  r = await request(inst.base, '/api/dsh/task', {
    method: 'POST',
    headers: { Cookie: client.cookie },
    body: { prompt: 'x' },
  });
  rec(group, '缺 CSRF → 403', r.status === 403, `status=${r.status}`);

  r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: '   ' } });
  rec(group, '空 prompt → 400 dsh_task_invalid', r.status === 400 && r.body?.error === 'dsh_task_invalid', JSON.stringify(r.body));

  r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'hi', sessionId: 'not-a-session' } });
  rec(group, '非法 sessionId → 400', r.status === 400 && r.body?.error === 'dsh_task_invalid', JSON.stringify(r.body));

  r = await client.call('/api/dsh/task/stream?id=task-does-not-exist');
  rec(group, '未知任务 id → 404', r.status === 404, `status=${r.status}`);

  // 注入探针：prompt 里的 shell 元字符必须被当作单个 argv 参数
  const marker = path.join(TMP_ROOT, `pwned-${Date.now()}`);
  const payload = `hello; touch ${marker} && echo injected $(id)`;
  const t0 = Date.now();
  r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: payload, sessionId: 'session-abcdef-1234' } });
  rec(group, 'POST /api/dsh/task 返回 id', r.status === 200 && /^task-/.test(r.body?.id || ''), `id=${r.body?.id}`, Date.now() - t0);
  const id = r.body?.id;
  if (!id) {
    rec(group, '后续 SSE 测试', false, '任务未启动，无法继续');
    return;
  }

  const sse = await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(id)}`, client.cookie, 12000);
  const types = sse.events.map((e) => e.type);
  rec(group, 'SSE 任务流可读取并结束', sse.status === 200 && /text\/event-stream/.test(sse.headers['content-type'] || ''), `status=${sse.status} 事件数=${sse.events.length}`, Date.now() - t0);
  rec(group, '├ 首事件为 start', types[0] === 'start', types.slice(0, 4).join(','));
  rec(group, '├ NDJSON 解析为 event', sse.events.some((e) => e.type === 'event' && String(e.line).includes('session-fake-1')), sse.events.find((e) => e.type === 'event')?.line);
  rec(group, '├ 普通 stdout 行透传', sse.events.some((e) => e.type === 'stdout' && e.line === 'plain stdout line'));
  rec(group, '├ stderr 行透传', sse.events.some((e) => e.type === 'stderr' && e.line.includes('fake stderr line')));
  rec(group, '└ 结束事件 done code=0', sse.events.some((e) => e.type === 'done' && e.code === 0), JSON.stringify(sse.events.filter((e) => e.type === 'done')));

  // 参数 / 环境变量注入校验
  let argsText = '';
  try {
    argsText = fs.readFileSync(path.join(inst.dir, 'task-args.txt'), 'utf8');
  } catch {
    argsText = '';
  }
  rec(group, 'argv 以数组传递（--profile/--json/--session-id）', argsText.includes('ARG:--profile') && argsText.includes('ARG:headless') && argsText.includes('ARG:--json') && argsText.includes('ARG:--session-id') && argsText.includes('ARG:session-abcdef-1234'), argsText.split('\n').slice(0, 6).join(' | '));
  rec(group, 'prompt 作为单个 argv（无 shell 注入）', argsText.includes(`ARG:${payload}`) && !fs.existsSync(marker), `markerExists=${fs.existsSync(marker)}`);
  rec(group, 'env 显式注入 DSH_HOME', argsText.includes(`ENV_DSH_HOME=${inst.dshHome}`), argsText.split('\n').find((l) => l.startsWith('ENV_DSH_HOME')) || '');
  rec(group, 'env 显式注入 HOME（当前用户家目录）', argsText.includes(`ENV_HOME=${process.env.HOME}`), argsText.split('\n').find((l) => l.startsWith('ENV_HOME')) || '');

  // 模型路由补丁：--patch 存在、指向真实文件、位于 prompt 之前
  const patchIdx = argsText.indexOf('ARG:--patch');
  const promptIdx = argsText.indexOf(`ARG:${payload}`);
  rec(group, 'spawn 带 --patch 且指向存在的文件',
    patchIdx >= 0 && argsText.includes(`ARG:${ctx.patchPath}`) && fs.existsSync(ctx.patchPath) && patchIdx < promptIdx,
    `patch=${ctx.patchPath} beforePrompt=${patchIdx >= 0 && patchIdx < promptIdx}`);

  // credentials refs 注入 + dsh.env 覆盖优先级
  rec(group, 'credentials refs 注入 env（值来自 fake 文件）', argsText.includes(`ENV_MY_LLM_API_KEY=${ctx.refValue}`), argsText.split('\n').find((l) => l.startsWith('ENV_MY_LLM_API_KEY')) ? 'ENV_MY_LLM_API_KEY=<set>' : 'missing');
  rec(group, 'dsh.env 覆盖同名 refs', argsText.includes(`ENV_FAKE_PANEL_REF=${ctx.overrideValue}`) && !argsText.includes(`ENV_FAKE_PANEL_REF=${ctx.refValue}`), `override=${ctx.overrideValue}`);
  rec(group, 'dsh.env 额外变量注入', argsText.includes(`ENV_PANEL_EXTRA=${ctx.extraValue}`));

  // 完成后回放
  const replay = await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(id)}`, client.cookie, 8000);
  rec(group, '完成后再次订阅可回放', replay.status === 200 && replay.events.length === sse.events.length && eqJson(replay.events, sse.events), `回放 ${replay.events.length} 条`);

  // 审计
  let audit = '';
  try {
    audit = fs.readFileSync(path.join(inst.dataDir, 'audit.log'), 'utf8');
  } catch {
    audit = '';
  }
  const auditLine = audit.split('\n').find((l) => l.includes('dsh.task')) || '';
  rec(group, '审计写入 data/audit.log（含 prompt 前 200 字符）', auditLine.includes('dsh.task') && auditLine.includes('hello; touch'), auditLine.slice(0, 140));

  // 安全：refs 的值不得出现在服务日志 / 审计 / SSE / 任何接口响应里
  const statusRes = await client.call('/api/dsh/status');
  const infoRes = await client.call('/api/app/info');
  const haystacks = {
    服务日志: inst.logs.join(''),
    审计日志: audit,
    SSE事件: JSON.stringify(sse.events),
    status响应: JSON.stringify(statusRes.body),
    会话响应: JSON.stringify((await client.call('/api/dsh/sessions?limit=2')).body),
    appInfo响应: JSON.stringify(infoRes.body),
  };
  const secrets = [ctx.refValue, ctx.overrideValue, ctx.extraValue];
  const leaked = Object.entries(haystacks)
    .filter(([, text]) => secrets.some((secret) => text.includes(secret)))
    .map(([name]) => name);
  rec(group, '日志/接口/审计中不出现密钥值（仅允许键名）', leaked.length === 0, leaked.length ? `泄漏于: ${leaked.join(',')}` : '未发现');
}

async function testBusyAndTimeout(inst) {
  const group = '并发与超时';
  const client = makeClient(inst.base);
  await client.login();

  let r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'slow task one' } });
  rec(group, '慢任务启动成功', r.status === 200 && /^task-/.test(r.body?.id || ''), `id=${r.body?.id}`);
  const id = r.body?.id;

  r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'slow task two' } });
  rec(group, '并发提交 → 409 dsh_task_busy', r.status === 409 && r.body?.error === 'dsh_task_busy', JSON.stringify(r.body));

  const t0 = Date.now();
  const sse = id ? await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(id)}`, client.cookie, 10000) : { events: [] };
  const errEvent = sse.events.find((e) => e.type === 'error');
  rec(group, '超时任务发送 error: timeout', Boolean(errEvent) && errEvent.message === 'timeout', JSON.stringify(errEvent));
  rec(group, '超时在 taskTimeoutMs 附近触发（<5s）', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

  r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'after timeout' } });
  rec(group, '超时清理后可再次提交（非 409）', r.status !== 409, `status=${r.status}`);
}

/** 降级：credentials 不可读 + patch 缺失时不应崩溃，任务仍应能启动并完成 */
async function testDegradedCredentials(inst) {
  const group = '任务降级';
  const client = makeClient(inst.base);
  await client.login();

  let r = await client.call('/api/dsh/task', { method: 'POST', body: { prompt: 'degraded run' } });
  rec(group, 'credentials 不可读 + patch 缺失时任务仍能启动', r.status === 200 && /^task-/.test(r.body?.id || ''), `status=${r.status}`);
  const id = r.body?.id;
  if (!id) return;

  const sse = await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(id)}`, client.cookie, 12000);
  rec(group, '降级任务完成 done code=0（无异常）', sse.events.some((e) => e.type === 'done' && e.code === 0), JSON.stringify(sse.events.filter((e) => e.type === 'done' || e.type === 'error')));

  const logs = inst.logs.join('');
  rec(group, '降级仅告警（[dsh] 前缀）且不含任何密钥值', /\[dsh\]/.test(logs) && !logs.includes('fake-ref-value'), (logs.split('\n').find((l) => l.includes('[dsh]')) || '').trim());

  let argsText = '';
  try {
    argsText = fs.readFileSync(path.join(inst.dir, 'degraded-args.txt'), 'utf8');
  } catch {
    argsText = '';
  }
  rec(group, 'patch 文件不存在时不加 --patch', !argsText.includes('ARG:--patch'), argsText.split('\n').slice(0, 4).join(' | '));
  rec(group, 'refs 不可用仍注入 DSH_HOME/HOME', argsText.includes(`ENV_DSH_HOME=${inst.dshHome}`) && argsText.includes(`ENV_HOME=${process.env.HOME}`));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ DSH 集成 / PWA / TLS 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);
  await testPureFunctions();

  if (ATTACH_BASE) {
    console.log(`\n附着模式：${ATTACH_BASE}`);
    const password = process.env.PANEL_PASSWORD || process.argv[2];
    if (!password) {
      throw new Error('附着模式需要提供密码：node tests/dsh-test.mjs "<密码>" 或 PANEL_PASSWORD=...');
    }
    const inst = { base: ATTACH_BASE, logs: [], child: { exitCode: null }, dir: TMP_ROOT, dataDir: '' };
    const { client } = await testAuthAndReadonly(inst, { allowTaskKnown: false });
    await testStatus(client, { allowTaskKnown: false });
    await testConsoleUrl(client);
    await testSessions(client);
    await testStatic(inst);
    skip('任务/SSE/审计', '附着模式不启动任务（需自包含模式）');
    skip('并发与超时', '附着模式跳过');
    skip('可选 TLS', '附着模式跳过');
    finish();
    return;
  }

  const mainPort = await findFreePort(); // TLS 端口（故意指向缺失证书）
  const mainInst = await startInstance('main', {
    dsh: { allowTask: false },
    tls: {
      cert: path.join(TMP_ROOT, 'main', 'missing-cert.pem'),
      key: path.join(TMP_ROOT, 'main', 'missing-key.pem'),
      port: mainPort,
    },
  });

  const { client } = await testAuthAndReadonly(mainInst, { allowTaskKnown: true });
  await testStatus(client, { allowTaskKnown: true });
  await testConsoleUrl(client);
  await testSessions(client);
  await testStatic(mainInst);
  testTlsWarn(mainInst);
  await testTlsPositive();

  // 任务实例：正常完成的 fake dsh（含模型 patch 与 credentials refs 注入）
  const taskDir = path.join(TMP_ROOT, 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  const normalScript = normalFakeScript(taskDir);
  const mockHome = path.join(taskDir, 'dsh-home');
  fs.mkdirSync(mockHome, { recursive: true });

  const fakePatch = path.join(taskDir, 'dsh-headless.patch.yml');
  fs.writeFileSync(fakePatch, '- id: llm-fake\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers: {}\n');
  const fakeCredFile = path.join(taskDir, 'credentials.yaml');
  const ctx = {
    patchPath: fakePatch,
    refValue: 'fake-ref-value-zijian-9f3a2b',
    refValueUnused: 'fake-ref-unused-777',
    overrideValue: 'fake-env-override-333',
    extraValue: 'fake-env-extra-444',
  };
  fs.writeFileSync(fakeCredFile, [
    'version: 1',
    'records: []',
    'refs:',
    `  MY_LLM_API_KEY: ${ctx.refValue}`,
    `  FAKE_PANEL_REF: ${ctx.refValue}`,
    `  UNUSED_REF: ${ctx.refValueUnused}`,
    '',
  ].join('\n'), { mode: 0o600 });

  const taskInst = await startInstance('task', {
    dsh: {
      allowTask: true,
      bin: normalScript,
      home: mockHome,
      profile: 'headless',
      taskTimeoutMs: 20000,
      cwd: taskDir,
      patch: fakePatch,
      credentialsFile: fakeCredFile,
      env: {
        FAKE_PANEL_REF: ctx.overrideValue,
        PANEL_EXTRA: ctx.extraValue,
      },
    },
  });
  taskInst.dshHome = mockHome;
  await testTaskFlow(taskInst, ctx);

  // 降级实例：credentials 不可读（目录）+ patch 文件缺失 → 任务仍能启动并完成
  const degradedDir = path.join(TMP_ROOT, 'task-degraded');
  fs.mkdirSync(degradedDir, { recursive: true });
  const degradedScript = normalFakeScript(degradedDir, 'degraded-args.txt');
  const degradedHome = path.join(degradedDir, 'dsh-home');
  fs.mkdirSync(degradedHome, { recursive: true });
  const badCredPath = path.join(degradedDir, 'credentials-is-a-directory');
  fs.mkdirSync(badCredPath, { recursive: true });
  const degradedInst = await startInstance('task-degraded', {
    dsh: {
      allowTask: true,
      bin: degradedScript,
      home: degradedHome,
      profile: 'headless',
      taskTimeoutMs: 20000,
      cwd: degradedDir,
      patch: path.join(degradedDir, 'missing-headless.patch.yml'),
      credentialsFile: badCredPath,
    },
  });
  degradedInst.dshHome = degradedHome;
  await testDegradedCredentials(degradedInst);

  // 慢任务实例：并发 busy + 超时
  const slowDir = path.join(TMP_ROOT, 'slow');
  fs.mkdirSync(slowDir, { recursive: true });
  const slowScript = slowFakeScript(slowDir);
  const slowHome = path.join(slowDir, 'dsh-home');
  fs.mkdirSync(slowHome, { recursive: true });
  const slowInst = await startInstance('slow', {
    dsh: {
      allowTask: true,
      bin: slowScript,
      home: slowHome,
      profile: 'headless',
      taskTimeoutMs: 1200,
      cwd: slowDir,
    },
  });
  await testBusyAndTimeout(slowInst);

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
