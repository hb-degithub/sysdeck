#!/usr/bin/env node
/**
 * 审计日志 / 会话管理 / 备份恢复 / App 更新端点 回归测试（零依赖，Node 22+）
 *
 * 自包含：/tmp 隔离实例（独立 config / DATA_DIR / 端口 / dist 目录），不触碰正式实例。
 *
 * 覆盖：
 *  - /api/audit：解析/倒序/分页/关键字过滤/坏行跳过/不泄露敏感内容
 *  - /api/sessions：字段/current/revoke 他人/revoke 自己（清 cookie + 原 sid 失效）
 *  - 备份：create/list/download（gzip+tar 内含 config.json+metrics.db）、restore（错误 confirm、
 *          恶意 tar 路径拒绝、正常恢复内容一致 + .bak）、delete、自动备份保留策略
 *  - App 更新：/api/app/update 版本/大小/sha256、/app/latest.apk 下载与 Range、dist 为空 → version:null
 *
 * 用法：node tests/backup-test.mjs ["<测试实例密码>"] [--keep]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { hashPassword, generatePassword } = require('../lib/config.js');
const { BackupManager, createTarBuffer } = require('../lib/backup.js');
const { AppUpdateManager, scanLatestApk } = require('../lib/appUpdate.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-backup-test-'));
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

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
        resolve({ status: res.statusCode, headers: res.headers, buffer, text, body, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 30000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function makeClient(base, ua = 'backup-test/1.0') {
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
        headers: { 'User-Agent': ua, ...(opts.headers || {}) },
        cookie: cookie || undefined,
        csrf: method === 'GET' ? undefined : csrf || undefined,
      });
      for (const c of res.setCookie) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      return res;
    },
    async login() {
      const res = await request(base, '/api/login', { method: 'POST', headers: { 'User-Agent': ua }, body: { username: 'admin', password: PASSWORD } });
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
      title: '备份测试',
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

/* ---------------- 测试用 tar 解析（独立实现，验证下载内容） ---------------- */

function parseTarForTest(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim();
    const size = parseInt(sizeText, 8);
    if (!Number.isFinite(size)) throw new Error('bad tar size');
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    entries.push({ name, size, data });
    offset = offset + 512 + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

/* ---------------- 审计 ---------------- */

async function testAudit(inst, client) {
  const group = '审计日志';
  const auditPath = path.join(inst.dataDir, 'audit.log');
  // 追加可控测试行（含坏行），真实服务器也会写入自己的审计
  const lines = [
    '2026-10-28T00:00:00.000Z 10.0.0.1 alpha 第一条审计 detail one',
    '2026-10-28T00:00:01.000Z 10.0.0.2 beta 第二条审计 detail two',
    'this-is-a-bad-line without timestamp',
    '2026-10-28T00:00:02.000Z 10.0.0.3 分享下载 /tmp/sample.bin',
    // 历史无 IP 占位行（旧 auditLog(msg) 写法），必须把消息首词还原为 action
    '2026-10-28T00:00:03.000Z 更新告警规则 5 条 enabled=true',
    '2026-10-28T00:00:04.000Z 撤销会话 993038dde4e1（1 个，含当前会话）',
  ];
  fs.appendFileSync(auditPath, lines.join('\n') + '\n');

  let res = await client.call('/api/audit?limit=2');
  rec(group, 'GET /api/audit 返回分页结构', res.status === 200 && Array.isArray(res.body?.entries) && Number.isFinite(res.body.total) && typeof res.body.truncated === 'boolean', `entries=${res.body?.entries?.length} total=${res.body?.total}`);
  rec(group, '├ 条目字段 ts/ip/action/detail', res.body.entries.every((e) => typeof e.ts === 'string' && typeof e.ip === 'string' && typeof e.action === 'string' && typeof e.detail === 'string'), JSON.stringify(res.body.entries[0]));
  rec(group, '├ 最新在前', res.body.entries.length === 2 && res.body.entries[0].ts >= res.body.entries[1].ts);
  rec(group, '├ 坏行被跳过', !res.body.entries.some((e) => e.action === 'this-is-a-bad-line'), 'bad line skipped');
  rec(group, '└ 分页 truncated=true', res.body.truncated === true);

  res = await client.call('/api/audit?q=detail%20two');
  rec(group, 'q 关键字过滤', res.body.entries.length === 1 && res.body.entries[0].action === 'beta' && res.body.entries[0].detail.includes('detail two'), JSON.stringify(res.body.entries[0]));

  res = await client.call('/api/audit?q=更新告警规则');
  const legacyRule = res.body.entries.find((e) => e.ts.endsWith('00:00:03.000Z'));
  rec(group, '历史无 IP 行：ip 记为 -，action/detail 正确', Boolean(legacyRule) && legacyRule.ip === '-' && legacyRule.action === '更新告警规则' && legacyRule.detail.startsWith('5 条'), JSON.stringify(legacyRule));

  res = await client.call('/api/audit?q=撤销会话');
  const legacyRevoke = res.body.entries.find((e) => e.ts.endsWith('00:00:04.000Z'));
  rec(group, '历史无 IP 行（中文 action）不再错位', Boolean(legacyRevoke) && legacyRevoke.ip === '-' && legacyRevoke.action === '撤销会话' && legacyRevoke.detail.includes('含当前会话'), JSON.stringify(legacyRevoke));

  res = await client.call('/api/audit?q=alpha');
  rec(group, '带 IP 行解析保持正确', res.body.entries.length === 1 && res.body.entries[0].ip === '10.0.0.1' && res.body.entries[0].action === 'alpha', JSON.stringify(res.body.entries[0]));

  // 真实带 req 的审计（PUT rules）应记录真实 IP，且字段不错位
  const putRules = await client.call('/api/alerts/rules', { method: 'PUT', body: { enabled: true } });
  rec(group, '服务端审计可写入', putRules.status === 200);
  res = await client.call('/api/audit?q=更新告警规则');
  const liveRule = res.body.entries.find((e) => e.action === '更新告警规则' && !/^2026-10-28T00:00:0/.test(e.ts));
  rec(group, '新审计行带真实 IP 且字段不再错位', Boolean(liveRule) && liveRule.ip !== '-' && liveRule.ip.length > 0 && liveRule.detail.includes('enabled='), JSON.stringify(liveRule));

  res = await client.call('/api/audit?limit=1&offset=1');
  rec(group, 'offset 分页有效', res.status === 200 && res.body.entries.length === 1, `ts=${res.body.entries[0]?.ts}`);

  res = await client.call('/api/audit?limit=500');
  rec(group, '响应不含敏感配置内容', !res.text.includes('passwordHash') && !res.text.includes(PASSWORD), 'no secrets');
  rec(group, '未登录 → 401', (await request(inst.base, '/api/audit')).status === 401);
}

/* ---------------- 会话管理 ---------------- */

async function testSessions(inst, client) {
  const group = '会话管理';
  const second = makeClient(inst.base, 'backup-test/second-UA');
  await second.login();

  let res = await client.call('/api/sessions');
  const sessions = res.body?.sessions || [];
  rec(group, 'GET /api/sessions 返回列表', res.status === 200 && sessions.length >= 2, `count=${sessions.length}`);
  rec(group, '├ 字段完整且 id 为 12 位', sessions.every((s) => /^[0-9a-f]{12}$/.test(s.id) && typeof s.username === 'string' && typeof s.ip === 'string' && typeof s.ua === 'string' && Number.isFinite(s.createdAt) && Number.isFinite(s.lastSeenAt) && typeof s.current === 'boolean'));
  rec(group, '└ 恰有一个 current', sessions.filter((s) => s.current).length === 1);
  const other = sessions.find((s) => !s.current);
  rec(group, '第二会话 UA 已记录', sessions.some((s) => s.ua.includes('second-UA')), sessions.map((s) => s.ua).join(' | '));

  res = await client.call('/api/sessions/revoke', { method: 'POST', body: { id: other.id } });
  rec(group, '踢出其他会话', res.status === 200 && res.body.revoked === true, JSON.stringify(res.body));
  rec(group, '└ 被踢会话立即失效', (await second.call('/api/session')).body.authenticated === false, 'authenticated=false');
  res = await client.call('/api/sessions');
  rec(group, '列表不再包含被踢会话', !res.body.sessions.some((s) => s.id === other.id));

  const self = res.body.sessions.find((s) => s.current);
  res = await client.call('/api/sessions/revoke', { method: 'POST', body: { id: self.id } });
  const cleared = (res.setCookie || []).some((c) => c.startsWith('panel_session=') && c.includes('Max-Age=0'));
  rec(group, '踢自己成功并清 session cookie', res.status === 200 && res.body.revoked === true && cleared, JSON.stringify(res.body));
  rec(group, '└ 原会话立即失效', (await client.call('/api/system')).status === 401, '401');
}

/* ---------------- 备份 ---------------- */

function makeApk(name, content) {
  const distDir = path.join(TMP_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const file = path.join(distDir, name);
  fs.writeFileSync(file, content);
  return file;
}

async function testBackup(inst, client) {
  const group = '备份';
  const backupsDir = path.join(inst.dataDir, 'backups');
  const created = await client.call('/api/backup/create', { method: 'POST' });
  rec(group, 'POST /api/backup/create 成功', created.status === 200 && /^server-panel-backup-\d{8}-\d{6}\.tar\.gz$/.test(created.body?.filename || '') && created.body.size > 0 && Number.isFinite(created.body.createdAt), JSON.stringify({ filename: created.body?.filename, size: created.body?.size }));
  const filename = created.body.filename;
  const id = created.body.id;
  rec(group, '└ 文件落盘且为 gzip/0600', fs.existsSync(path.join(backupsDir, filename)) && fs.readFileSync(path.join(backupsDir, filename)).subarray(0, 2).toString('hex') === '1f8b' && (fs.statSync(path.join(backupsDir, filename)).mode & 0o777) === 0o600);

  let res = await client.call('/api/backup/list');
  rec(group, 'GET /api/backup/list 含新备份与 auto 配置', res.status === 200 && res.body.backups.some((b) => b.id === id) && res.body.auto && res.body.auto.enabled === false && res.body.auto.keep === 2, JSON.stringify(res.body.auto));

  res = await client.call(`/api/backup/download?id=${encodeURIComponent(id)}`);
  rec(group, 'download 返回 gzip 附件', res.status === 200 && res.headers['content-type'] === 'application/gzip' && String(res.headers['content-disposition']).includes(filename) && Number(res.headers['content-length']) === created.body.size, `len=${res.headers['content-length']}`);
  const tarBuffer = zlib.gunzipSync(res.buffer);
  const entries = parseTarForTest(tarBuffer);
  const names = entries.map((e) => e.name);
  rec(group, '├ tar 内含 config.json 与 data/metrics.db', names.includes('config.json') && names.includes('data/metrics.db'), names.join(','));
  const configEntry = entries.find((e) => e.name === 'config.json');
  const configJson = JSON.parse(configEntry.data.toString('utf8'));
  rec(group, '└ config.json 内容有效', configJson.panel?.username === 'admin' && typeof configJson.panel?.passwordHash === 'string');

  // 恶意 tar：路径穿越 / 绝对路径
  const evilTar = zlib.gzipSync(createTarBuffer([
    { name: 'config.json', data: Buffer.from('{"panel":{}}') },
    { name: '../evil.txt', data: Buffer.from('pwned') },
  ]));
  const evilId = 'server-panel-backup-20260101-000000.tar.gz';
  fs.writeFileSync(path.join(backupsDir, evilId), evilTar, { mode: 0o600 });
  res = await client.call('/api/backup/restore', { method: 'POST', body: { id: evilId, confirm: 'RESTORE' } });
  rec(group, '恶意 tar（.. 路径）被拒绝', res.status === 400 && String(res.body?.error).includes('invalid'), JSON.stringify(res.body));
  rec(group, '└ 未写出穿越文件', !fs.existsSync(path.join(inst.dir, 'evil.txt')) && !fs.existsSync('/tmp/evil.txt'));

  const absTar = zlib.gzipSync(createTarBuffer([{ name: 'config.json', data: Buffer.from('{}') }, { name: '/etc/passwd', data: Buffer.from('x') }]));
  const absId = 'server-panel-backup-20260101-000001.tar.gz';
  fs.writeFileSync(path.join(backupsDir, absId), absTar, { mode: 0o600 });
  res = await client.call('/api/backup/restore', { method: 'POST', body: { id: absId, confirm: 'RESTORE' } });
  rec(group, '恶意 tar（绝对路径）被拒绝', res.status === 400, JSON.stringify(res.body));

  // 错误 confirm
  res = await client.call('/api/backup/restore', { method: 'POST', body: { id, confirm: 'nope' } });
  rec(group, 'restore 错误 confirm → 400', res.status === 400 && res.body.error === 'confirm_required', JSON.stringify(res.body));

  // 正常恢复：先改文件，再恢复，校验内容回到备份时
  const modifiedConfig = Buffer.from(JSON.stringify({ marker: 'MODIFIED-AFTER-BACKUP' }, null, 2));
  fs.writeFileSync(inst.configPath, modifiedConfig);
  fs.appendFileSync(path.join(inst.dataDir, 'audit.log'), 'BEFORE-RESTORE-MARKER\n');
  res = await client.call('/api/backup/restore', { method: 'POST', body: { id, confirm: 'RESTORE' } });
  rec(group, '正常恢复返回 restartRequired', res.status === 200 && res.body.ok === true && res.body.restartRequired === true, JSON.stringify(res.body));
  const restoredConfig = fs.readFileSync(inst.configPath);
  rec(group, '├ config.json 内容恢复一致', restoredConfig.equals(configEntry.data), `${restoredConfig.length}B`);
  rec(group, '├ 原文件已备份为 .bak', fs.existsSync(`${inst.configPath}.bak`) && fs.readFileSync(`${inst.configPath}.bak`).equals(modifiedConfig));
  const restoredAudit = fs.readFileSync(path.join(inst.dataDir, 'audit.log'), 'utf8');
  rec(group, '└ audit.log 恢复到备份时内容', !restoredAudit.includes('BEFORE-RESTORE-MARKER'));

  // 恢复后服务仍可用（内存中的会话仍在）
  rec(group, '恢复后接口仍可访问', (await client.call('/api/app/info')).status === 200);

  // 删除
  const second = await client.call('/api/backup/create', { method: 'POST' });
  res = await client.call('/api/backup/delete', { method: 'POST', body: { id: second.body.id } });
  rec(group, '删除备份成功', res.status === 200 && res.body.ok === true && !fs.existsSync(path.join(backupsDir, second.body.id)));
  res = await client.call('/api/backup/delete', { method: 'POST', body: { id: second.body.id } });
  rec(group, '删除不存在备份 → 404', res.status === 404);
  res = await client.call('/api/backup/download?id=../../etc/passwd');
  rec(group, '非法备份 id 下载 → 404', res.status === 404);
  return { id };
}

/* ---------------- 自动备份（单元） ---------------- */

function testAutoBackup() {
  const group = '自动备份';
  const dir = path.join(TMP_ROOT, 'auto');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ panel: { username: 'admin' } }), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'audit.log'), 'line\n');
  const manager = new BackupManager({ configPath, dataDir, backupConfig: { auto: true, keep: 2, hour: new Date().getHours() } });
  const first = manager.checkAuto(new Date());
  rec(group, '当天到点自动备份一次', first.ran === true && manager.list().length === 1, `ran=${first.ran}`);
  const again = manager.checkAuto(new Date());
  rec(group, '同一天不重复', again.ran === false && manager.list().length === 1);
  // 再创建 3 份，保留最近 2 份
  manager.create();
  manager.create();
  manager.create();
  const pruned = manager.pruneToKeep(2);
  rec(group, 'keep 保留策略（只留最近 2 份）', manager.list().length === 2 && pruned >= 2, `removed=${pruned}`);

  const off = new BackupManager({ configPath, dataDir, backupConfig: { auto: false } });
  rec(group, 'auto=false 不自动备份', off.checkAuto(new Date()).ran === false);
  const early = new BackupManager({ configPath, dataDir, backupConfig: { auto: true, hour: 23 } });
  const fakeNow = new Date();
  fakeNow.setHours(0, 0, 0, 0);
  rec(group, '未到 hour 不备份', early.checkAuto(fakeNow).ran === false);
}

/* ---------------- App 更新 ---------------- */

async function testAppUpdate(inst) {
  const group = 'App 更新';
  const distDir = path.join(TMP_ROOT, 'dist');
  const oldApk = fs.readFileSync(path.join(distDir, 'server-panel-app-1.0.0.apk'));
  const newApk = fs.readFileSync(path.join(distDir, 'server-panel-app-1.1.0.apk'));

  let res = await request(inst.base, '/api/app/update'); // 免登录
  rec(group, '/api/app/update 免登录且返回最新版本', res.status === 200 && res.body.version === '1.1.0', JSON.stringify(res.body));
  rec(group, '├ size 与最新 APK 一致', res.body.size === newApk.length, `${res.body.size}/${newApk.length}`);
  rec(group, '├ sha256 正确', res.body.sha256 === sha256(newApk), res.body.sha256);
  rec(group, '└ downloadUrl 固定', res.body.downloadUrl === '/app/latest.apk' && res.body.notes === '');

  res = await request(inst.base, '/app/latest.apk');
  rec(group, '/app/latest.apk 免登录下载最新 APK', res.status === 200 && res.buffer.equals(newApk), `len=${res.buffer.length}`);
  rec(group, '├ content-type / attachment', String(res.headers['content-type']).includes('android.package-archive') && String(res.headers['content-disposition']).includes('server-panel-app-1.1.0.apk'), res.headers['content-disposition']);
  rec(group, '└ no-cache', res.headers['cache-control'] === 'no-cache');

  const head = await request(inst.base, '/app/latest.apk', { method: 'HEAD' });
  rec(group, 'HEAD 返回大小且无正文', head.status === 200 && Number(head.headers['content-length']) === newApk.length && head.buffer.length === 0);

  const range = await request(inst.base, '/app/latest.apk', { headers: { Range: 'bytes=0-99' } });
  rec(group, 'Range 支持（206 + Content-Range）', range.status === 206 && range.buffer.equals(newApk.subarray(0, 100)) && range.headers['content-range'] === `bytes 0-99/${newApk.length}`);

  // 版本比较单元
  const manager = new AppUpdateManager({ distDir });
  const latest = manager.latest();
  rec(group, '版本号比较（1.1.0 > 1.0.0）', latest?.version === '1.1.0' && oldApk.length < newApk.length);

  // dist 为空 / 不存在
  const emptyDir = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  rec(group, '空 dist → scanLatestApk null', scanLatestApk(emptyDir) === null);
  rec(group, '不存在的 dist → version:null', (await new AppUpdateManager({ distDir: path.join(TMP_ROOT, 'no-such-dist') }).info()).version === null);

  // 真正把实例的 dist 挪走，验证端点降级
  const movedDir = path.join(TMP_ROOT, 'dist-moved');
  fs.renameSync(distDir, movedDir);
  try {
    res = await request(inst.base, '/api/app/update');
    rec(group, 'dist 不存在时 200 {version:null}', res.status === 200 && res.body.version === null, JSON.stringify(res.body));
    res = await request(inst.base, '/app/latest.apk');
    rec(group, '无 APK 时下载 404', res.status === 404, `status=${res.status}`);
  } finally {
    fs.renameSync(movedDir, distDir);
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ 审计 / 会话 / 备份恢复 / App 更新 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  const distDir = path.join(TMP_ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'server-panel-app-1.0.0.apk'), Buffer.concat([Buffer.from('APK-1.0.0'), crypto.randomBytes(2048)]));
  fs.writeFileSync(path.join(distDir, 'server-panel-app-1.1.0.apk'), Buffer.concat([Buffer.from('APK-1.1.0'), crypto.randomBytes(8192)]));
  fs.writeFileSync(path.join(distDir, 'not-an-apk.txt'), 'ignore');

  const prepared = prepareDir('main', {
    backup: { auto: false, keep: 2, hour: 4 },
    appUpdate: { distDir },
  });
  const inst = await spawnInstance(prepared);
  let client = makeClient(inst.base);
  await client.login();

  await testAudit(inst, client);
  await testSessions(inst, client);
  // 踢自己后重新登录
  client = makeClient(inst.base);
  await client.login();

  const backupInfo = await testBackup(inst, client);
  testAutoBackup();
  await testAppUpdate(inst);

  // 删除恶意/测试备份，避免留下
  for (const name of ['server-panel-backup-20260101-000000.tar.gz', 'server-panel-backup-20260101-000001.tar.gz']) {
    try {
      fs.unlinkSync(path.join(inst.dataDir, 'backups', name));
    } catch (e) {
      /* ignore */
    }
  }
  void backupInfo;

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
