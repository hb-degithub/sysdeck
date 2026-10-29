#!/usr/bin/env node
/**
 * 文件下载器（分享链接 + 二维码）回归测试（零依赖，Node 22+）
 *
 * 自包含：/tmp 隔离实例（独立 config / DATA_DIR / 端口），不触碰正式 systemd 实例。
 *
 * 覆盖：
 *  - 未登录 / 缺 CSRF 鉴权
 *  - 创建分享字段（32 hex token、按 Host 拼 URL、filename/size/expiresAt/once）
 *  - 免登录公开下载（中文文件名、Content-Length、attachment）
 *  - Range（206 / Content-Range / 后缀范围 / 416）
 *  - 未知 / 过期 / 撤销 / once 用尽 → 404
 *  - qr.svg（image/svg+xml、白底深色、size 参数、按 Host 变化）
 *  - 目录 / 不存在 / 相对路径 / 非法 ttl 校验
 *  - 分享列表、撤销、命中计数、审计
 *  - 重启进程后分享不残留
 *  - lib/share.js 单元行为（TTL 过期、maxShares、config 默认）
 *
 * 用法：node tests/download-test.mjs ["<测试实例密码>"] [--keep]
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
const { ShareStore, resolveShareConfig, parseRange, contentDisposition, generateQrSvg, mimeFor, SHARE_DEFAULTS } = require('../lib/share.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-download-test-'));
const FILES_DIR = path.join(TMP_ROOT, 'files');
const instances = [];
const results = [];
const skipped = [];

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
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
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

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  return {
    base,
    get csrf() {
      return csrf;
    },
    get cookie() {
      return cookie;
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
      const res = await request(base, '/api/login', {
        method: 'POST',
        body: { username: 'admin', password: PASSWORD },
      });
      for (const c of res.setCookie) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      if (res.status === 200 && res.body?.csrf) csrf = res.body.csrf;
      return res;
    },
    setCsrf(token) {
      csrf = token;
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
      title: '下载器测试',
      username: 'admin',
      passwordHash: hashPassword(PASSWORD, salt),
      passwordSalt: salt,
      mustChangePassword: false,
    },
    session: { secret: crypto.randomBytes(32).toString('hex'), ttlSeconds: 12 * 60 * 60 },
    sampleIntervalMs: 500,
  };
  for (const [key, value] of Object.entries(patch)) config[key] = value;
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

  const inst = {
    name: prepared.dir,
    base,
    port: usePort,
    dir: prepared.dir,
    dataDir: prepared.dataDir,
    child,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
      }
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

/* ---------------- 单元测试（lib/share.js） ---------------- */

function testUnits() {
  const group = '单元';
  const defaults = resolveShareConfig({});
  rec(group, '默认配置 shareTtlMinutes=60 / maxShares=100 / maxHits=0', defaults.shareTtlMinutes === SHARE_DEFAULTS.shareTtlMinutes && defaults.maxShares === SHARE_DEFAULTS.maxShares && defaults.maxHits === SHARE_DEFAULTS.maxHits, JSON.stringify(defaults));
  rec(group, '配置夹取（ttl 0→1、maxShares 0→1）', resolveShareConfig({ shareTtlMinutes: 0, maxShares: 0 }).shareTtlMinutes === 1 && resolveShareConfig({ maxShares: 0 }).maxShares === 1);

  rec(group, 'parseRange 普通/开放/后缀', JSON.stringify(parseRange('bytes=0-99', 1000)) === JSON.stringify({ start: 0, end: 99 }) && JSON.stringify(parseRange('bytes=900-', 1000)) === JSON.stringify({ start: 900, end: 999 }) && JSON.stringify(parseRange('bytes=-50', 1000)) === JSON.stringify({ start: 950, end: 999 }));
  rec(group, 'parseRange 越界/非法', parseRange('bytes=1000-', 1000)?.invalid === true && parseRange('bytes=abc', 1000)?.invalid === true && parseRange('bytes=0-1,5-6', 1000)?.invalid === true);

  const disposition = contentDisposition('中文 文件.txt');
  rec(group, 'Content-Disposition 中文 filename*', disposition.includes("filename*=UTF-8''") && decodeURIComponent(disposition.split("filename*=UTF-8''")[1]) === '中文 文件.txt', disposition);

  const svg = generateQrSvg('http://192.168.1.10:3081/d/' + 'a'.repeat(32), 320);
  rec(group, 'QR SVG 白底 + 深色模块 + 静区', svg.includes('<svg') && svg.includes('fill="#ffffff"') && (svg.match(/<rect/g) || []).length > 100 && /viewBox="0 0 \d+ \d+"/.test(svg), `rects=${(svg.match(/<rect/g) || []).length}`);
  rec(group, 'QR size 夹取 160..1024', /width="320"/.test(svg) && /width="160"/.test(generateQrSvg('x', 1)) && /width="1024"/.test(generateQrSvg('x', 9999)), 'clamp ok');

  // ShareStore 过期与上限
  const store = new ShareStore({ maxShares: 2 });
  const expired = store.create({ filePath: '/tmp/x', filename: 'x', size: 1, ttlMinutes: 1 });
  expired.expiresAt = Date.now() - 1000;
  rec(group, '过期 share 立即不可用且列表不含', store.get(expired.token) === null && !store.list().some((s) => s.token === expired.token));
  const a = store.create({ filePath: '/tmp/a', filename: 'a', size: 1, ttlMinutes: 60 });
  store.create({ filePath: '/tmp/b', filename: 'b', size: 1, ttlMinutes: 60 });
  let limitCode = '';
  try {
    store.create({ filePath: '/tmp/c', filename: 'c', size: 1, ttlMinutes: 60 });
  } catch (e) {
    limitCode = e.code;
  }
  rec(group, 'maxShares 超限拒绝', limitCode === 'share_limit_reached', limitCode);
  store.close();

  const onceStore = new ShareStore({});
  const once = onceStore.create({ filePath: '/tmp/o', filename: 'o', size: 100, ttlMinutes: 60, once: true });
  onceStore.registerHit(once.token);
  rec(group, 'once 仅命中（未完整送达）不消耗额度', onceStore.get(once.token) !== null);
  onceStore.noteDelivery(once.token, 100, 0, 49);
  rec(group, 'once 部分 Range 不消耗额度（断点续传友好）', onceStore.get(once.token) !== null);
  onceStore.noteDelivery(once.token, 100, 50, 99);
  rec(group, 'once 完整覆盖 0..size-1 后失效', onceStore.get(once.token) === null);
  const partial = onceStore.create({ filePath: '/tmp/p', filename: 'p', size: 10, ttlMinutes: 60, once: true });
  onceStore.noteDelivery(partial.token, 10, 0, 9);
  rec(group, 'once 单次完整下载即失效', onceStore.get(partial.token) === null);
  onceStore.close();
  rec(group, 'close 清空登记表', store.size === 0 && onceStore.size === 0);
  rec(group, 'MIME 映射（txt/json/bin）', mimeFor('a.txt').startsWith('text/plain') && mimeFor('a.json').startsWith('application/json') && mimeFor('a.bin') === 'application/octet-stream');
}

/* ---------------- 集成测试 ---------------- */

async function createShare(client, body, headers) {
  return client.call('/api/download/share', { method: 'POST', body, headers: headers || {} });
}

async function testAuth(inst, client) {
  const group = '鉴权';
  const anon = await request(inst.base, '/api/download/share', { method: 'POST', body: { path: path.join(FILES_DIR, 'a.txt') } });
  rec(group, '未登录创建分享 → 401', anon.status === 401, `status=${anon.status}`);

  const noCsrf = await request(inst.base, '/api/download/share', {
    method: 'POST',
    headers: { Cookie: client.cookie || '' },
    body: { path: path.join(FILES_DIR, 'a.txt') },
  });
  rec(group, '缺 CSRF → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  const sharesAnon = await request(inst.base, '/api/download/shares');
  rec(group, '未登录列表 → 401', sharesAnon.status === 401, `status=${sharesAnon.status}`);
  const revokeAnon = await request(inst.base, '/api/download/revoke', { method: 'POST', body: { token: 'x' } });
  rec(group, '未登录撤销 → 401', revokeAnon.status === 401, `status=${revokeAnon.status}`);
}

async function testCreate(inst, client, sample) {
  const group = '创建分享';
  const t0 = Date.now();
  const res = await createShare(client, { path: sample.path });
  const body = res.body || {};
  rec(group, '创建中文文件名分享', res.status === 200, `status=${res.status}`, Date.now() - t0);
  rec(group, '├ token 为 32 hex', /^[0-9a-f]{32}$/.test(body.token || ''), `token=${body.token?.slice(0, 8)}…`);
  rec(group, '├ url 按请求 Host 拼绝对地址', body.url === `${inst.base}/d/${body.token}`, body.url);
  rec(group, '├ qrUrl = url + /qr.svg', body.qrUrl === `${body.url}/qr.svg`, body.qrUrl);
  rec(group, '├ filename / size 正确', body.filename === sample.filename && body.size === sample.size, `${body.filename} ${body.size}B`);
  rec(group, '├ expiresAt ≈ 60 分钟后', Math.abs(body.expiresAt - (Date.now() + 60 * 60000)) < 120000, `expiresAt=${body.expiresAt}`);
  rec(group, '└ once=false', body.once === false);

  const hostRes = await createShare(client, { path: sample.path }, { Host: '192.168.1.10:3081' });
  rec(group, '显式 Host 生效（局域网地址）', hostRes.body?.url === `http://192.168.1.10:3081/d/${hostRes.body?.token}`, hostRes.body?.url);
  const httpsRes = await createShare(client, { path: sample.path }, { Host: '192.168.1.10:3081', 'X-Forwarded-Proto': 'https' });
  rec(group, 'HTTPS（X-Forwarded-Proto）用 https 前缀', httpsRes.body?.url?.startsWith('https://192.168.1.10:3081/d/'), httpsRes.body?.url);
  const tailRes = await createShare(client, { path: sample.path }, { Host: 'myhost.example.ts.net' });
  rec(group, 'tailscale 域名 Host 生效', tailRes.body?.url?.startsWith('http://myhost.example.ts.net/d/'), tailRes.body?.url);

  // ttl 覆盖
  const ttlRes = await createShare(client, { path: sample.path, ttlMinutes: 5 });
  rec(group, 'ttlMinutes=5 覆盖生效', Math.abs(ttlRes.body?.expiresAt - (Date.now() + 5 * 60000)) < 120000, `expiresAt=${ttlRes.body?.expiresAt}`);
  return { ...body, hostUrl: hostRes.body.url };
}

async function testPublicDownload(inst, created, sample) {
  const group = '公开下载';
  const pathOnly = new URL(created.url).pathname;
  const res = await request(inst.base, pathOnly); // 无任何 cookie
  rec(group, '免登录下载 200（无 cookie）', res.status === 200, `status=${res.status}`);
  rec(group, '├ Content-Length 正确', res.headers['content-length'] === String(sample.size), `len=${res.headers['content-length']}`);
  rec(group, '├ Content-Type 按扩展名', String(res.headers['content-type']).startsWith('text/plain'), res.headers['content-type']);
  const disposition = String(res.headers['content-disposition'] || '');
  const encoded = disposition.split("filename*=UTF-8''")[1] || '';
  rec(group, '├ attachment 中文文件名正确', disposition.startsWith('attachment') && decodeURIComponent(encoded) === sample.filename, disposition);
  rec(group, '├ 内容与源文件一致', res.buffer.equals(sample.buffer), `bytes=${res.buffer.length}`);
  rec(group, '└ no-store 缓存头', res.headers['cache-control'] === 'no-store');

  const head = await request(inst.base, pathOnly, { method: 'HEAD' });
  rec(group, 'HEAD 只回头（200 + Content-Length，不消耗次数）', head.status === 200 && head.headers['content-length'] === String(sample.size) && head.buffer.length === 0, `body=${head.buffer.length}`);

  // 非法 Host 在上游 URL 解析阶段即被拒绝（400），不会进入文件流，属安全行为
  const weirdHost = await request(inst.base, pathOnly, { headers: { Host: 'bad host with spaces' } });
  rec(group, '非法 Host 被安全拒绝（400，不泄露文件）', weirdHost.status === 400 && weirdHost.buffer.length < 200, `status=${weirdHost.status}`);
}

async function testRange(inst, createdBig, bigBuffer) {
  const group = 'Range';
  const pathOnly = new URL(createdBig.url).pathname;
  const size = bigBuffer.length;

  let res = await request(inst.base, pathOnly, { headers: { Range: 'bytes=0-99' } });
  rec(group, 'Range bytes=0-99 → 206', res.status === 206 && res.buffer.length === 100 && res.buffer.equals(bigBuffer.subarray(0, 100)), `status=${res.status} len=${res.buffer.length}`);
  rec(group, '├ Content-Range 正确', res.headers['content-range'] === `bytes 0-99/${size}`, res.headers['content-range']);
  rec(group, '└ Content-Length = 100', res.headers['content-length'] === '100', res.headers['content-length']);

  res = await request(inst.base, pathOnly, { headers: { Range: 'bytes=-50' } });
  rec(group, '后缀 Range bytes=-50 → 206 最后 50 字节', res.status === 206 && res.buffer.equals(bigBuffer.subarray(size - 50)), `status=${res.status} len=${res.buffer.length}`);

  res = await request(inst.base, pathOnly, { headers: { Range: `bytes=900000-` } });
  rec(group, '越界 Range → 416 + Content-Range */size', res.status === 416 && res.headers['content-range'] === `bytes */${size}`, `status=${res.status} cr=${res.headers['content-range']}`);

  res = await request(inst.base, pathOnly, { headers: { Range: 'bytes=0-1,5-6' } });
  rec(group, '多段 Range（不支持）→ 416', res.status === 416, `status=${res.status}`);
}

async function testListAndHits(inst, client, createdBig) {
  const group = '列表与计数';
  let res = await client.call('/api/download/shares');
  const list = res.body?.shares || [];
  rec(group, 'GET shares 返回数组', res.status === 200 && Array.isArray(list), `count=${list.length}`);
  rec(group, '├ 按 createdAt 倒序', list.every((s, i) => i === 0 || list[i - 1].createdAt >= s.createdAt));
  const item = list.find((s) => s.token === createdBig.token);
  rec(group, '├ 字段完整', Boolean(item) && item.path.endsWith('big.bin') && item.filename === 'big.bin' && Number.isFinite(item.size) && Number.isFinite(item.expiresAt) && typeof item.hits === 'number' && item.once === false, JSON.stringify({ filename: item?.filename, hits: item?.hits }));
  rec(group, '└ 不包含文件内容字段', item && Object.keys(item).every((k) => ['token', 'path', 'filename', 'size', 'createdAt', 'expiresAt', 'hits', 'once'].includes(k)), Object.keys(item || {}).join(','));

  const hitsBefore = item?.hits ?? 0;
  await request(inst.base, new URL(createdBig.url).pathname);
  await request(inst.base, new URL(createdBig.url).pathname);
  res = await client.call('/api/download/shares');
  const after = (res.body?.shares || []).find((s) => s.token === createdBig.token);
  rec(group, '两次下载后 hits 递增 2（Range 命中同样计数）', after?.hits === hitsBefore + 2, `hits ${hitsBefore} → ${after?.hits}`);
}

async function testRevokeAndOnce(inst, client, sample) {
  const group = '撤销与一次性';
  const revokeTarget = await createShare(client, { path: sample.path });
  const token = revokeTarget.body.token;
  let res = await client.call('/api/download/revoke', { method: 'POST', body: { token } });
  rec(group, '撤销成功 revoked:true', res.status === 200 && res.body?.revoked === true, JSON.stringify(res.body));
  rec(group, '撤销后公开下载 404', (await request(inst.base, `/d/${token}`)).status === 404);
  rec(group, '撤销后二维码 404', (await request(inst.base, `/d/${token}/qr.svg`)).status === 404);
  res = await client.call('/api/download/revoke', { method: 'POST', body: { token } });
  rec(group, '重复撤销 revoked:false（不报错）', res.status === 200 && res.body?.revoked === false, JSON.stringify(res.body));
  const list = (await client.call('/api/download/shares')).body.shares;
  rec(group, '撤销后列表不再出现', !list.some((s) => s.token === token));

  const onceShare = await createShare(client, { path: sample.path, once: true });
  const onceToken = onceShare.body.token;
  rec(group, 'once=true 创建成功', onceShare.status === 200 && onceShare.body.once === true);
  const first = await request(inst.base, `/d/${onceToken}`);
  rec(group, 'once 首次下载 200', first.status === 200 && first.buffer.length > 0, `status=${first.status}`);
  const second = await request(inst.base, `/d/${onceToken}`);
  rec(group, 'once 第二次 404', second.status === 404, `status=${second.status}`);
  const afterOnce = (await client.call('/api/download/shares')).body.shares;
  rec(group, 'once 用尽后列表移除', !afterOnce.some((s) => s.token === onceToken));
}

async function testQr(inst, client, sample) {
  const group = '二维码';
  const created = await createShare(client, { path: sample.path });
  const token = created.body.token;
  let res = await request(inst.base, `/d/${token}/qr.svg`); // 免登录
  const svg = res.text;
  rec(group, 'qr.svg 免登录 200 + image/svg+xml', res.status === 200 && String(res.headers['content-type']).startsWith('image/svg+xml'), `status=${res.status} type=${res.headers['content-type']}`);
  rec(group, '├ 含 <svg 与白底深色', svg.includes('<svg') && svg.includes('fill="#ffffff"') && svg.includes('fill="#000000"'), 'svg ok');
  const rects = (svg.match(/<rect/g) || []).length;
  rec(group, '└ 模块数 > 0（rect 数 > 100）', rects > 100, `rects=${rects}`);

  const custom = await request(inst.base, `/d/${token}/qr.svg?size=200`);
  rec(group, 'size=200 生效', /width="200"/.test(custom.text) && custom.text.includes('height="200"'), 'width 200');
  const clampedHigh = await request(inst.base, `/d/${token}/qr.svg?size=9999`);
  rec(group, 'size 上限夹取 1024', /width="1024"/.test(clampedHigh.text));
  const clampedLow = await request(inst.base, `/d/${token}/qr.svg?size=10`);
  rec(group, 'size 下限夹取 160', /width="160"/.test(clampedLow.text));

  // 不同 Host → 二维码内容不同（证明二维码用当前 Host 拼的绝对地址）
  const hostA = await request(inst.base, `/d/${token}/qr.svg`, { headers: { Host: '192.168.1.10:3081' } });
  const hostB = await request(inst.base, `/d/${token}/qr.svg`, { headers: { Host: 'myhost.example.ts.net' } });
  rec(group, '二维码内容随请求 Host 变化', hostA.status === 200 && hostB.status === 200 && hostA.text !== hostB.text, `A=${hostA.text.length}B B=${hostB.text.length}B`);

  const unknownQr = await request(inst.base, `/d/${'0'.repeat(32)}/qr.svg`);
  rec(group, '未知 token 二维码 → 404 文本', unknownQr.status === 404 && String(unknownQr.headers['content-type']).startsWith('text/plain'), `status=${unknownQr.status}`);
}

async function testValidation(inst, client, sample) {
  const group = '参数校验';
  const dirPath = path.join(FILES_DIR, 'subdir');
  fs.mkdirSync(dirPath, { recursive: true });
  let res = await createShare(client, { path: dirPath });
  rec(group, '目录 → 400 not_a_regular_file', res.status === 400 && res.body?.error === 'not_a_regular_file', JSON.stringify(res.body));

  res = await createShare(client, { path: path.join(FILES_DIR, 'no-such-file.txt') });
  rec(group, '不存在 → 404 file_not_found', res.status === 404 && res.body?.error === 'file_not_found', JSON.stringify(res.body));

  res = await createShare(client, { path: 'relative/file.txt' });
  rec(group, '相对路径 → 400 invalid_path', res.status === 400 && res.body?.error === 'invalid_path', JSON.stringify(res.body));

  for (const ttl of [0, 1441, 'abc', 1.5]) {
    res = await createShare(client, { path: sample.path, ttlMinutes: ttl });
    rec(group, `非法 ttlMinutes=${JSON.stringify(ttl)} → 400`, res.status === 400 && res.body?.error === 'invalid_ttl', `status=${res.status}`);
  }

  res = await createShare(client, { path: `${sample.path}\0` });
  rec(group, '含 NUL 的 path → 400', res.status === 400, `status=${res.status}`);

  const unknown = await request(inst.base, `/d/${crypto.randomBytes(16).toString('hex')}`);
  rec(group, '未知 token → 404 简短文本', unknown.status === 404 && String(unknown.headers['content-type']).startsWith('text/plain') && unknown.text.includes('无效'), `status=${unknown.status}`);
  const malformed = await request(inst.base, '/d/not-a-token');
  rec(group, '格式错误 token → 404', malformed.status === 404, `status=${malformed.status}`);
}

async function testAudit(inst, sample) {
  const group = '审计';
  const auditPath = path.join(inst.dataDir, 'audit.log');
  const text = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  rec(group, '创建分享写审计（路径 + 到期时间）', text.includes('分享下载') && text.includes(sample.path) && /到期 \d{4}-\d{2}-\d{2}T/.test(text), (text.split('\n').find((l) => l.includes('分享下载')) || '').slice(0, 120));
  rec(group, '撤销分享写审计', text.includes('撤销下载分享'), (text.split('\n').find((l) => l.includes('撤销下载分享')) || '').slice(0, 100));
  rec(group, '审计中不含完整下载 token', !text.includes(sample.token), 'no full token');
  const logText = inst.logs.join('');
  rec(group, '服务日志不含下载 token', !logText.includes(sample.token));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ 文件下载器（分享链接 + 二维码）测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);
  testUnits();

  fs.mkdirSync(FILES_DIR, { recursive: true });
  const chineseName = '中文 文件.txt';
  const chineseContent = '你好，世界！\n第二行：下载测试\n';
  const chineseBuffer = Buffer.from(chineseContent, 'utf8');
  const chinesePath = path.join(FILES_DIR, chineseName);
  fs.writeFileSync(chinesePath, chineseBuffer);

  const bigBuffer = crypto.randomBytes(200000);
  const bigPath = path.join(FILES_DIR, 'big.bin');
  fs.writeFileSync(bigPath, bigBuffer);

  const emptyPath = path.join(FILES_DIR, 'empty.txt');
  fs.writeFileSync(emptyPath, '');

  const jsonPath = path.join(FILES_DIR, 'data.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ hello: '世界' }));

  const prepared = prepareDir('main');
  const inst = await spawnInstance(prepared);
  const client = makeClient(inst.base);
  await client.login();

  await testAuth(inst, client);

  const sample = { path: chinesePath, filename: chineseName, size: chineseBuffer.length, buffer: chineseBuffer };
  const created = await testCreate(inst, client, sample);
  await testPublicDownload(inst, created, sample);

  const bigShare = (await createShare(client, { path: bigPath })).body;
  rec('公开下载', '大文件（200KB）分享创建成功', /^[0-9a-f]{32}$/.test(bigShare.token), `size=${bigShare.size}`);
  await testRange(inst, bigShare, bigBuffer);
  await testListAndHits(inst, client, bigShare);

  await testRevokeAndOnce(inst, client, sample);
  await testQr(inst, client, sample);
  await testValidation(inst, client, sample);

  // 空文件 / JSON MIME
  const emptyShare = (await createShare(client, { path: emptyPath })).body;
  const emptyRes = await request(inst.base, `/d/${emptyShare.token}`);
  rec('MIME', '空文件下载 200 + Content-Length 0', emptyRes.status === 200 && emptyRes.headers['content-length'] === '0' && emptyRes.buffer.length === 0, `status=${emptyRes.status}`);
  const jsonShare = (await createShare(client, { path: jsonPath })).body;
  const jsonRes = await request(inst.base, `/d/${jsonShare.token}`);
  rec('MIME', '.json → application/json', String(jsonRes.headers['content-type']).startsWith('application/json'), jsonRes.headers['content-type']);

  await testAudit(inst, { ...sample, token: created.token });

  // B3：分享持久化到 data/shares.json，重启后仍可下载
  const oldToken = created.token;
  await inst.stop();
  const port = await findFreePort();
  const restarted = await spawnInstance(prepared, port);
  const afterRestart = await request(restarted.base, `/d/${oldToken}`);
  rec('生命周期', '进程重启后分享仍可下载（持久化）', afterRestart.status === 200 && afterRestart.buffer.equals(sample.buffer), `status=${afterRestart.status}`);
  const sharesFile = path.join(prepared.dataDir, 'shares.json');
  rec('生命周期', '└ data/shares.json 已落盘 0600', fs.existsSync(sharesFile) && (fs.statSync(sharesFile).mode & 0o777) === 0o600);
  await restarted.stop();

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
