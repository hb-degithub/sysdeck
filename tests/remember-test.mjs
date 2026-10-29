#!/usr/bin/env node
/**
 * 「记住密码 / 30 天免登录」回归测试（零依赖，Node 22+）
 *
 * 自包含：在 /tmp 创建隔离实例（独立 config / DATA_DIR / 端口），
 * 不会接触正式 systemd 实例（3081）及其 data/。
 *
 * 覆盖：
 *  - remember=true 的 Set-Cookie 属性（HttpOnly / SameSite=Strict / Max-Age / HTTPS Secure）
 *  - 只带 panel_remember 自动登录（resumed、拿到 csrf、可调受保护接口）
 *  - 令牌轮换（旧 token 失效、新 token 有效）
 *  - 同一 DATA_DIR 重启进程后仍可自动登录（持久化）
 *  - 过期 token → 未登录 + 启动时清理落盘
 *  - 退出登录 / /api/remember/forget 撤销与幂等
 *  - remember.json 0600、≤64KB、只存 sha256 摘要、响应/日志不含明文 token
 *  - session.rememberDays / rememberMax 配置覆盖与超限淘汰最旧
 *
 * 用法：node tests/remember-test.mjs ["<测试实例密码>"] [--keep]
 * 退出码：0 全绿；1 存在失败。
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
const { REMEMBER_COOKIE } = require('../lib/auth.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-remember-test-'));

const results = [];
const skipped = [];
const instances = [];
const allLogs = [];

function rec(group, name, ok, detail, ms) {
  results.push({ group, name, ok: Boolean(ok), detail, ms });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}${ms !== undefined ? ` (${ms}ms)` : ''}`);
}

function skip(name, detail) {
  skipped.push({ name, detail });
  console.log(`⏭️  [跳过] ${name}${detail ? ' — ' + detail : ''}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
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
    req.setTimeout(opts.timeoutMs || 20000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSetCookie(header) {
  const parts = String(header).split(';').map((s) => s.trim());
  const first = parts.shift();
  const eq = first.indexOf('=');
  const cookie = {
    name: eq >= 0 ? first.slice(0, eq) : first,
    value: eq >= 0 ? first.slice(eq + 1) : '',
    attrs: {},
  };
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx < 0) cookie.attrs[part.toLowerCase()] = true;
    else cookie.attrs[part.slice(0, idx).toLowerCase()] = part.slice(idx + 1);
  }
  return cookie;
}

function findCookie(res, name) {
  for (const raw of res.setCookie) {
    const parsed = parseSetCookie(raw);
    if (parsed.name === name) return parsed;
  }
  return null;
}

function makeClient(base) {
  const jar = new Map();
  let csrf = '';
  return {
    base,
    get csrf() {
      return csrf;
    },
    setCookie(name, value) {
      if (value === undefined || value === null) jar.delete(name);
      else jar.set(name, value);
    },
    getCookie(name) {
      return jar.get(name);
    },
    cookieHeader() {
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      for (const raw of res.setCookie) {
        const c = parseSetCookie(raw);
        const maxAge = c.attrs['max-age'] !== undefined ? Number(c.attrs['max-age']) : undefined;
        if (maxAge === 0 || !c.value) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
    },
    async call(pathname, opts = {}) {
      const method = opts.method || 'GET';
      const res = await request(base, pathname, {
        ...opts,
        method,
        cookie: this.cookieHeader() || undefined,
        csrf: method === 'GET' ? undefined : opts.csrf !== undefined ? opts.csrf : csrf || undefined,
      });
      this.absorb(res);
      return res;
    },
    async login({ remember, headers } = {}) {
      const body = { username: 'admin', password: PASSWORD };
      if (remember !== undefined) body.remember = remember;
      const res = await request(base, '/api/login', { method: 'POST', body, headers: headers || {} });
      this.absorb(res);
      if (res.status === 200 && res.body && res.body.csrf) csrf = res.body.csrf;
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
      title: '记住密码测试',
      username: 'admin',
      passwordHash: hashPassword(PASSWORD, salt),
      passwordSalt: salt,
      mustChangePassword: false,
    },
    session: {
      secret: crypto.randomBytes(32).toString('hex'),
      ttlSeconds: 12 * 60 * 60,
      ...(patch.session || {}),
    },
    sampleIntervalMs: 500,
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'session' && key !== 'panel') config[key] = value;
  }
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data') };
}

async function spawnInstance(prepared, port) {
  const usePort = port || (await findFreePort());
  const base = `http://127.0.0.1:${usePort}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: prepared.configPath,
      PANEL_DATA_DIR: prepared.dataDir,
      PANEL_PORT: String(usePort),
      PANEL_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  child.on('exit', (code) => logs.push(`[exit] ${code}`));

  const inst = {
    base,
    port: usePort,
    dir: prepared.dir,
    configPath: prepared.configPath,
    dataDir: prepared.dataDir,
    child,
    logs,
    rememberFile: path.join(prepared.dataDir, 'remember.json'),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
      }
      if (child.exitCode === null) child.kill('SIGKILL');
      allLogs.push(...logs);
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

function readRememberFile(inst) {
  const text = fs.readFileSync(inst.rememberFile, 'utf8');
  return { text, json: JSON.parse(text) };
}

/* ---------------- 测试 ---------------- */

async function testLoginCookie(inst) {
  const group = '登录与 Cookie';
  const client = makeClient(inst.base);
  const now = Date.now();
  const res = await client.login({ remember: true, headers: { 'User-Agent': 'remember-test/1.0' } });
  rec(group, 'remember=true 登录成功', res.status === 200 && res.body?.ok === true, `status=${res.status}`);
  rec(group, '├ 响应含 remember.expiresAt（约 30 天后）', Number.isFinite(res.body?.remember?.expiresAt) && Math.abs(res.body.remember.expiresAt - now - 30 * 86400 * 1000) < 120000, `expiresAt=${res.body?.remember?.expiresAt}`);
  rec(group, '├ 响应体不含 token 明文', /^[0-9a-f]{64}$/.test(client.getCookie(REMEMBER_COOKIE) || '') && !res.text.includes(client.getCookie(REMEMBER_COOKIE)), 'json body 无 token');

  const rememberCookie = findCookie(res, REMEMBER_COOKIE);
  rec(group, '├ 下发 panel_remember cookie', Boolean(rememberCookie) && /^[0-9a-f]{64}$/.test(rememberCookie.value), `len=${rememberCookie?.value?.length}`);
  rec(group, '├ 属性 HttpOnly / SameSite=Strict / Path=/', Boolean(rememberCookie?.attrs.httponly) && rememberCookie?.attrs.samesite === 'Strict' && rememberCookie?.attrs.path === '/', `attrs=${JSON.stringify(rememberCookie?.attrs)}`);
  rec(group, '├ Max-Age = 30 天（2592000）', rememberCookie?.attrs['max-age'] === String(30 * 86400), `max-age=${rememberCookie?.attrs['max-age']}`);
  rec(group, '└ HTTP 下不加 Secure', !rememberCookie?.attrs.secure, `secure=${Boolean(rememberCookie?.attrs.secure)}`);
  rec(group, 'session cookie 仍然下发', Boolean(findCookie(res, 'panel_session')), `count=${res.setCookie.length}`);
  return client;
}

async function testFileStorage(inst, token) {
  const group = '持久化文件';
  rec(group, 'remember.json 已创建', fs.existsSync(inst.rememberFile), inst.rememberFile);
  const mode = fs.statSync(inst.rememberFile).mode & 0o777;
  rec(group, '文件权限 0600', mode === 0o600, `mode=${mode.toString(8)}`);
  rec(group, '文件 ≤64KB', fs.statSync(inst.rememberFile).size <= 64 * 1024, `size=${fs.statSync(inst.rememberFile).size}B`);
  const { text, json } = readRememberFile(inst);
  rec(group, '结构 {version:1, tokens:[...]}', json.version === 1 && Array.isArray(json.tokens), `tokens=${json.tokens?.length}`);
  rec(group, '只存 sha256 摘要（无明文 token）', !text.includes(token) && json.tokens.every((t) => /^[0-9a-f]{64}$/.test(t.hash)), `hashLen=${json.tokens?.[0]?.hash?.length}`);
  rec(group, '摘要与 sha256(token) 一致', json.tokens.some((t) => t.hash === sha256(token)), 'sha256 match');
  rec(group, '原子写无残留 .tmp', !fs.existsSync(inst.rememberFile + '.tmp'));
  rec(group, '条目字段完整（username/createdAt/expiresAt/ua）', json.tokens.length > 0 && json.tokens[0].username === 'admin' && Number.isFinite(json.tokens[0].createdAt) && Number.isFinite(json.tokens[0].expiresAt) && typeof json.tokens[0].ua === 'string', JSON.stringify({ username: json.tokens[0]?.username, ua: json.tokens[0]?.ua }));
}

async function testAutoLogin(inst, token1) {
  const group = '自动登录与轮换';
  const auto = makeClient(inst.base);
  auto.setCookie(REMEMBER_COOKIE, token1);
  const res = await auto.call('/api/session');
  rec(group, '仅 remember cookie → authenticated:true', res.status === 200 && res.body?.authenticated === true, `status=${res.status}`);
  rec(group, '├ resumed:true + username + csrf', res.body?.resumed === true && res.body?.username === 'admin' && typeof res.body?.csrf === 'string', `resumed=${res.body?.resumed}`);
  rec(group, '├ 响应含 remember.expiresAt', Number.isFinite(res.body?.remember?.expiresAt), `expiresAt=${res.body?.remember?.expiresAt}`);
  const newSession = findCookie(res, 'panel_session');
  const rotated = findCookie(res, REMEMBER_COOKIE);
  rec(group, '├ 同时下发新 session cookie', Boolean(newSession?.value), `count=${res.setCookie.length}`);
  rec(group, '└ 下发轮换后的新 remember token', Boolean(rotated) && /^[0-9a-f]{64}$/.test(rotated.value) && rotated.value !== token1, `rotated=${rotated?.value !== token1}`);

  const csrf = auto.csrf;
  const sys = await auto.call('/api/system', { csrf });
  rec(group, '自动登录后 csrf 可调受保护接口', sys.status === 200 && sys.body?.ok === true, `status=${sys.status}`);

  // 旧 token 立即失效
  const replay = makeClient(inst.base);
  replay.setCookie(REMEMBER_COOKIE, token1);
  const replayRes = await replay.call('/api/session');
  rec(group, '旧 token 重放 → authenticated:false', replayRes.status === 200 && replayRes.body?.authenticated === false, JSON.stringify(replayRes.body));
  const cleared = findCookie(replayRes, REMEMBER_COOKIE);
  rec(group, '旧 token 被清 cookie（Max-Age=0）', Boolean(cleared) && cleared.attrs['max-age'] === '0', `max-age=${cleared?.attrs['max-age']}`);

  return { auto, token2: rotated.value };
}

async function testLogout(inst, auto, token2) {
  const group = '退出登录';
  const res = await auto.call('/api/logout', { method: 'POST' });
  rec(group, 'logout 返回 200', res.status === 200 && res.body?.ok === true, `status=${res.status}`);
  const sessionClear = findCookie(res, 'panel_session');
  const rememberClear = findCookie(res, REMEMBER_COOKIE);
  rec(group, '清 session 与 remember 两个 cookie', sessionClear?.attrs['max-age'] === '0' && rememberClear?.attrs['max-age'] === '0', `rememberRevoked=${res.body?.rememberRevoked}`);
  rec(group, '被撤销的 token 之后无效', Boolean(res.body?.rememberRevoked === true), `rememberRevoked=${res.body?.rememberRevoked}`);

  const after = makeClient(inst.base);
  after.setCookie(REMEMBER_COOKIE, token2);
  const afterRes = await after.call('/api/session');
  rec(group, 'logout 后 remember 不能再自动登录', afterRes.body?.authenticated === false, JSON.stringify(afterRes.body));
}

async function testForget(inst) {
  const group = 'remember/forget';
  const client = makeClient(inst.base);
  await client.login({ remember: true });
  const token = client.getCookie(REMEMBER_COOKIE);
  const first = await client.call('/api/remember/forget', { method: 'POST' });
  rec(group, 'forget 无需登录/CSRF 即可调用', first.status === 200 && first.body?.ok === true, `status=${first.status}`);
  rec(group, '首次撤销 revoked:true 并清 cookie', first.body?.revoked === true && findCookie(first, REMEMBER_COOKIE)?.attrs['max-age'] === '0', `revoked=${first.body?.revoked}`);
  const probe = makeClient(inst.base);
  probe.setCookie(REMEMBER_COOKIE, token);
  rec(group, '撤销后 token 失效', (await probe.call('/api/session')).body?.authenticated === false);

  const again = await client.call('/api/remember/forget', { method: 'POST' });
  rec(group, '重复调用幂等（仍 200）', again.status === 200 && again.body?.ok === true, `revoked=${again.body?.revoked}`);

  const bogus = makeClient(inst.base);
  bogus.setCookie(REMEMBER_COOKIE, 'not-a-valid-token');
  const bogusRes = await bogus.call('/api/session');
  rec(group, '非法 token → 未登录并清 cookie', bogusRes.status === 200 && bogusRes.body?.authenticated === false && findCookie(bogusRes, REMEMBER_COOKIE)?.attrs['max-age'] === '0');
}

async function testRememberFalse(inst) {
  const group = 'remember=false';
  const client = makeClient(inst.base);
  const res = await client.login({ remember: false });
  rec(group, 'remember=false 不下发 remember cookie', res.status === 200 && !findCookie(res, REMEMBER_COOKIE) && res.body?.remember === undefined, `count=${res.setCookie.length}`);
  const plain = await request(inst.base, '/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  rec(group, '不传 remember 也不下发', !findCookie(plain, REMEMBER_COOKIE));
}

async function testSecureFlag(inst) {
  const group = 'HTTPS Secure';
  const client = makeClient(inst.base);
  const res = await client.login({ remember: true, headers: { 'X-Forwarded-Proto': 'https' } });
  const cookie = findCookie(res, REMEMBER_COOKIE);
  rec(group, 'x-forwarded-proto=https → cookie 带 Secure', Boolean(cookie?.attrs.secure), `attrs=${JSON.stringify(cookie?.attrs)}`);
  const multi = makeClient(inst.base);
  const res2 = await multi.login({ remember: true, headers: { 'X-Forwarded-Proto': 'https, http' } });
  rec(group, '多值 X-Forwarded-Proto 首值 https 生效', Boolean(findCookie(res2, REMEMBER_COOKIE)?.attrs.secure));
}

async function testPersistence(prepared, token) {
  const group = '重启持久化';
  const port = await findFreePort();
  const inst = await spawnInstance(prepared, port);
  const client = makeClient(inst.base);
  client.setCookie(REMEMBER_COOKIE, token);
  const res = await client.call('/api/session');
  rec(group, '同一 DATA_DIR 重启后可自动登录', res.status === 200 && res.body?.authenticated === true && res.body?.resumed === true, `resumed=${res.body?.resumed}`);
  const rotated = findCookie(res, REMEMBER_COOKIE);
  rec(group, '重启后自动登录同样轮换 token', Boolean(rotated) && rotated.value !== token, `rotated=${rotated?.value !== token}`);
  rec(group, '记住密码不依赖内存会话', findCookie(res, 'panel_session')?.value?.length > 0);
  return { inst, token: rotated?.value };
}

async function testExpiry(prepared, token) {
  const group = '过期清理';
  // 先在磁盘上把该 token 改成已过期
  const rememberPath = path.join(prepared.dataDir, 'remember.json');
  const data = JSON.parse(fs.readFileSync(rememberPath, 'utf8'));
  const hash = sha256(token);
  let found = false;
  for (const entry of data.tokens) {
    if (entry.hash === hash) {
      entry.expiresAt = Date.now() - 1000;
      found = true;
    }
  }
  rec(group, '构造过期条目成功', found, `tokens=${data.tokens.length}`);
  fs.writeFileSync(rememberPath, JSON.stringify(data), { mode: 0o600 });

  const port = await findFreePort();
  const inst = await spawnInstance(prepared, port);
  const client = makeClient(inst.base);
  client.setCookie(REMEMBER_COOKIE, token);
  const res = await client.call('/api/session');
  rec(group, '过期 token → authenticated:false', res.status === 200 && res.body?.authenticated === false, JSON.stringify(res.body));
  const after = JSON.parse(fs.readFileSync(rememberPath, 'utf8'));
  rec(group, '启动加载时清除过期条目并落盘', !after.tokens.some((t) => t.hash === hash), `剩余 ${after.tokens.length} 条`);
  rec(group, '清理后文件仍为 0600', (fs.statSync(rememberPath).mode & 0o777) === 0o600);
  return inst;
}

async function testMaxAndDays() {
  const group = '上限与配置';
  const prepared = prepareDir('override', { session: { rememberDays: 2, rememberMax: 3 } });
  const now = Date.now();
  const tokens = [];
  const entries = [];
  for (let i = 0; i < 6; i++) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.push(token);
    entries.push({
      hash: sha256(token),
      username: 'admin',
      createdAt: now - (6 - i) * 86400 * 1000,
      expiresAt: now + 10 * 86400 * 1000,
      ua: `crafted-${i}`,
    });
  }
  fs.writeFileSync(path.join(prepared.dataDir, 'remember.json'), JSON.stringify({ version: 1, tokens: entries }), { mode: 0o600 });

  const inst = await spawnInstance(prepared);
  const data = JSON.parse(fs.readFileSync(path.join(prepared.dataDir, 'remember.json'), 'utf8'));
  rec(group, '启动加载时超限淘汰最旧（6 → 3）', data.tokens.length === 3 && entries.slice(3).every((e) => data.tokens.some((t) => t.hash === e.hash)), `剩余 ${data.tokens.length} 条`);
  rec(group, '被淘汰的最旧 token 无效', (await (() => {
    const c = makeClient(inst.base);
    c.setCookie(REMEMBER_COOKIE, tokens[0]);
    return c.call('/api/session');
  })()).body?.authenticated === false);

  const keep = makeClient(inst.base);
  keep.setCookie(REMEMBER_COOKIE, tokens[5]);
  const resumed = await keep.call('/api/session');
  rec(group, '保留下来的较新 token 可自动登录', resumed.body?.authenticated === true, `resumed=${resumed.body?.resumed}`);

  const shortDays = makeClient(inst.base);
  const res = await shortDays.login({ remember: true });
  const cookie = findCookie(res, REMEMBER_COOKIE);
  rec(group, 'rememberDays=2 覆盖生效（Max-Age 172800）', cookie?.attrs['max-age'] === String(2 * 86400), `max-age=${cookie?.attrs['max-age']}`);
  const data2 = JSON.parse(fs.readFileSync(path.join(prepared.dataDir, 'remember.json'), 'utf8'));
  rec(group, '新增 token 后仍不超过上限 3', data2.tokens.length === 3, `剩余 ${data2.tokens.length} 条`);
  return inst;
}

async function testNoLeak(instancesList, tokens) {
  const group = '安全不泄漏';
  const haystacks = {
    服务日志: allLogs.join('') + instancesList.map((i) => i.logs.join('')).join(''),
    响应集合: '',
  };
  // 收集接口响应（登录/session/forget 等）由上面的断言覆盖，这里补充数据文件检查
  const jsonAll = instancesList
    .map((i) => {
      try {
        return fs.readFileSync(i.rememberFile, 'utf8');
      } catch {
        return '';
      }
    })
    .join('');
  const leakedLogs = tokens.filter((t) => t && haystacks.服务日志.includes(t));
  rec(group, '服务日志中无 token 明文', leakedLogs.length === 0, leakedLogs.length ? `泄漏 ${leakedLogs.length} 个` : '未发现');
  const leakedFile = tokens.filter((t) => t && jsonAll.includes(t));
  rec(group, 'remember.json 中无 token 明文（仅摘要）', leakedFile.length === 0, leakedFile.length ? `泄漏 ${leakedFile.length} 个` : '未发现');
  const auditPath = path.join(TMP_ROOT, 'main', 'data', 'audit.log');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  rec(group, '审计日志中无 token 明文', tokens.filter((t) => t && audit.includes(t)).length === 0);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ 记住密码 / 30 天免登录 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  const mainPrepared = prepareDir('main');
  const inst = await spawnInstance(mainPrepared);

  const client = await testLoginCookie(inst);
  const token1 = client.getCookie(REMEMBER_COOKIE);
  await testFileStorage(inst, token1);

  const { auto, token2 } = await testAutoLogin(inst, token1);
  await testLogout(inst, auto, token2);
  await testForget(inst);
  await testRememberFalse(inst);
  await testSecureFlag(inst);

  // 重启持久化：重新登录拿新 token 后重启进程
  const fresh = makeClient(inst.base);
  await fresh.login({ remember: true });
  const persistToken = fresh.getCookie(REMEMBER_COOKIE);
  await inst.stop();
  const { inst: restarted, token: rotatedAfterRestart } = await testPersistence(mainPrepared, persistToken);
  await restarted.stop();

  const expiredInst = await testExpiry(mainPrepared, rotatedAfterRestart);
  await expiredInst.stop();

  const overrideInst = await testMaxAndDays();
  await overrideInst.stop();

  await testNoLeak([inst, restarted, expiredInst, overrideInst], [token1, token2, persistToken, rotatedAfterRestart]);
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
