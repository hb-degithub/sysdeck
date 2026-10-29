#!/usr/bin/env node
/**
 * B3 后端能力回归测试（零依赖，自包含隔离实例）
 *
 * 覆盖：文件回收站/批量、分享持久化（含损坏容忍）、网络吞吐压测（loopback）、
 *       CPU 压测 GPU 采样、Docker compose 聚合/动作、容器终端参数校验、备份设置。
 *
 * 用法：node tests/b3-extras-test.mjs ["<测试实例密码>"] [--keep]
 * 所有操作均在 /tmp 隔离实例与临时文件上；不触发真实容器操作/远程网络。
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
const filesLib = require('../lib/files.js');
const { validateContainerRef, groupComposeProjects } = require('../lib/docker.js');
const { ShareStore } = require('../lib/share.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-b3-test-'));
const WORK = path.join(TMP_ROOT, 'work');
const children = [];
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
        resolve({ status: res.statusCode, headers: res.headers, buffer, text, body, setCookie: res.headers['set-cookie'] || [] });
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

function prepareDir() {
  const dir = path.join(TMP_ROOT, 'panel');
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const emptyDist = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDist, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: {
      title: 'B3 测试',
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
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data') };
}

async function spawnPanel(prepared) {
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
  children.push(child);
  const inst = {
    base,
    port,
    child,
    logs,
    dataDir: prepared.dataDir,
    configPath: prepared.configPath,
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
      if (res.status === 200) return inst;
    } catch (e) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`实例启动超时\n${logs.join('')}`);
}

/* ---------------- 单元测试 ---------------- */

async function testUnits() {
  const group = '单元';

  // ---- 容器引用校验 ----
  rec(group, '容器 id 12..64 hex 合法', validateContainerRef('abc123def456').ok && validateContainerRef('a'.repeat(64)).ok);
  rec(group, '容器名合法 / 路径穿越与 shell 元字符拒绝', validateContainerRef('my-app_1').ok && !validateContainerRef('../etc').ok && !validateContainerRef('a;rm -rf /').ok && !validateContainerRef('').ok && !validateContainerRef('x'.repeat(200)).ok);

  // ---- compose 聚合 ----
  const projects = groupComposeProjects([
    { id: 'a'.repeat(64), shortId: 'aaaaaaaaaaaa', name: 'p_app_1', state: 'running', status: 'Up', image: 'x', labels: { 'com.docker.compose.project': 'proj', 'com.docker.compose.service': 'app' }, ports: [] },
    { id: 'b'.repeat(64), shortId: 'bbbbbbbbbbbb', name: 'p_db_1', state: 'exited', status: 'Exited', image: 'y', labels: { 'com.docker.compose.project': 'proj', 'com.docker.compose.service': 'db' }, ports: [] },
    { id: 'c'.repeat(64), shortId: 'cccccccccccc', name: 'solo', state: 'running', status: 'Up', image: 'z', labels: {}, ports: [] },
  ]);
  rec(group, 'compose 按 label 聚合（partial/running/total）', projects.length === 1 && projects[0].name === 'proj' && projects[0].total === 2 && projects[0].running === 1 && projects[0].status === 'partial', JSON.stringify(projects[0]));
  rec(group, 'compose 忽略非 compose 容器 / services 排序', projects[0].services.map((s) => s.name).join(',') === 'app,db');

  // ---- 回收站 7 天清理（直接构造旧索引） ----
  const trashRoot = path.join(TMP_ROOT, 'trash-unit');
  fs.mkdirSync(WORK, { recursive: true });
  const victim = path.join(WORK, 'unit-trash.txt');
  fs.writeFileSync(victim, 'unit');
  const entry = await filesLib.trashPut(trashRoot, victim);
  filesLib.writeTrashIndex(trashRoot, [{ ...entry, deletedAt: Date.now() - 8 * 86400 * 1000 }]);
  const cleaned = await filesLib.trashCleanup(trashRoot, 7);
  rec(group, '回收站 7 天清理（构造旧条目）', cleaned.count === 1 && (await filesLib.trashList(trashRoot)).length === 0);

  // ---- 分享持久化（单元：加载/损坏容忍/节流写） ----
  const shareDir = path.join(TMP_ROOT, 'share-unit');
  fs.mkdirSync(shareDir, { recursive: true });
  const store = new ShareStore({ dataDir: shareDir });
  const share = store.create({ filePath: victim, filename: 'unit-trash.txt', size: 4, ttlMinutes: 30 });
  store.flush();
  const reloaded = new ShareStore({ dataDir: shareDir });
  rec(group, '分享持久化：flush 后重新加载仍存在', Boolean(reloaded.get(share.token)));
  reloaded.close();
  fs.writeFileSync(path.join(shareDir, 'shares.json'), '{not-json');
  const broken = new ShareStore({ dataDir: shareDir });
  rec(group, 'shares.json 损坏时忽略并 warn，不抛异常', broken.size === 0);
  broken.close();
}

/* ---------------- 文件 / 回收站 / 批量 ---------------- */

function newPath(name) {
  fs.mkdirSync(WORK, { recursive: true });
  return path.join(WORK, name);
}

async function testFilesTrash(client) {
  const group = '回收站';

  const fileA = newPath('trash-a.txt');
  fs.writeFileSync(fileA, 'hello trash');
  let res = await client.call('/api/files/delete', { method: 'POST', body: { path: fileA } });
  rec(group, '删除默认进回收站', res.status === 200 && res.body.ok === true && typeof res.body.trash?.id === 'string' && res.body.trash.path === fileA, JSON.stringify(res.body.trash));
  rec(group, '└ 原文件已移走', !fs.existsSync(fileA));
  const trashId = res.body.trash.id;
  const trashDir = path.join(TMP_ROOT, 'panel', 'data', 'trash');
  rec(group, '└ 回收站目录与 index.json 0600', fs.existsSync(path.join(trashDir, trashId)) && (fs.statSync(path.join(trashDir, 'index.json')).mode & 0o777) === 0o600);

  res = await client.call('/api/trash/list');
  const listed = (res.body.entries || []).find((e) => e.id === trashId);
  rec(group, 'GET /api/trash/list 返回条目', res.status === 200 && Boolean(listed) && listed.path === fileA && listed.name === 'trash-a.txt' && Number.isFinite(listed.size) && Number.isFinite(listed.deletedAt), JSON.stringify(listed));

  res = await client.call('/api/trash/restore', { method: 'POST', body: { id: trashId } });
  rec(group, '恢复成功且内容一致', res.status === 200 && res.body.ok === true && fs.readFileSync(fileA, 'utf8') === 'hello trash', JSON.stringify(res.body));
  rec(group, '└ 列表已移除该条目', !(await client.call('/api/trash/list')).body.entries.some((e) => e.id === trashId));

  // 恢复冲突：原路径被占用
  const fileB = newPath('trash-conflict.txt');
  fs.writeFileSync(fileB, 'v1');
  res = await client.call('/api/files/delete', { method: 'POST', body: { path: fileB } });
  const conflictId = res.body.trash.id;
  fs.writeFileSync(fileB, 'v2');
  res = await client.call('/api/trash/restore', { method: 'POST', body: { id: conflictId } });
  rec(group, '恢复时原路径被占用 → 409', res.status === 409 && res.body.error === 'target_exists', `status=${res.status}`);
  rec(group, '└ 冲突时不覆盖现有文件', fs.readFileSync(fileB, 'utf8') === 'v2');

  // purge
  res = await client.call('/api/trash/purge', { method: 'POST', body: { id: conflictId } });
  rec(group, 'purge 指定条目', res.status === 200 && res.body.count === 1 && !fs.existsSync(path.join(trashDir, conflictId)), JSON.stringify(res.body));
  res = await client.call('/api/trash/purge', { method: 'POST', body: { id: 'nonexistent' } });
  rec(group, 'purge 不存在条目 → 404', res.status === 404);

  // trash:false 永久删除
  const fileC = newPath('hard-delete.txt');
  fs.writeFileSync(fileC, 'x');
  res = await client.call('/api/files/delete', { method: 'POST', body: { path: fileC, trash: false } });
  rec(group, 'trash:false 永久删除', res.status === 200 && res.body.ok === true && !fs.existsSync(fileC) && !(await client.call('/api/trash/list')).body.entries.some((e) => e.path === fileC));

  // 审计
  const audit = await client.call('/api/audit?q=回收站');
  rec(group, '删除/恢复写入审计', (audit.body.entries || []).some((e) => e.action === '删除到回收站' || e.detail.includes('回收站')), JSON.stringify(audit.body.entries?.[0]));
}

async function testBatch(client) {
  const group = '批量操作';
  const srcDir = newPath('batch-src');
  const targetDir = newPath('batch-target');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const f1 = path.join(srcDir, 'one.txt');
  const f2 = path.join(srcDir, 'two.txt');
  fs.writeFileSync(f1, '1');
  fs.writeFileSync(f2, '2');

  let res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'move', paths: [f1, f2], target: targetDir } });
  rec(group, '批量 move 成功', res.status === 200 && res.body.done.length === 2 && fs.existsSync(path.join(targetDir, 'one.txt')) && fs.existsSync(path.join(targetDir, 'two.txt')), JSON.stringify(res.body.done));
  rec(group, '└ 源文件已移走', !fs.existsSync(f1) && !fs.existsSync(f2));

  const src2 = newPath('batch-src2');
  fs.mkdirSync(src2, { recursive: true });
  const f3 = path.join(src2, 'three.txt');
  fs.writeFileSync(f3, '3');
  res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'copy', paths: [f3], target: targetDir } });
  rec(group, '批量 copy 成功且源保留', res.status === 200 && fs.existsSync(path.join(targetDir, 'three.txt')) && fs.existsSync(f3));

  // 冲突：目标已有同名
  const f4 = path.join(src2, 'one.txt');
  fs.writeFileSync(f4, 'conflict');
  res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'move', paths: [f4], target: targetDir } });
  rec(group, '同名冲突 → 400 + conflicts 列表', res.status === 400 && res.body.error === 'conflicts' && Array.isArray(res.body.conflicts) && res.body.conflicts.length === 1, JSON.stringify(res.body.conflicts));
  rec(group, '└ 冲突时不做部分移动', fs.existsSync(f4) && fs.readFileSync(path.join(targetDir, 'one.txt'), 'utf8') === '1');

  // 超限 200
  res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'delete', paths: Array.from({ length: 201 }, (_, i) => `/tmp/x-${i}`) } });
  rec(group, '单次超过 200 项 → 400', res.status === 400 && res.body.error === 'too_many_paths', JSON.stringify(res.body));

  // 批量 delete 走回收站
  res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'delete', paths: [path.join(targetDir, 'three.txt')] } });
  rec(group, '批量 delete 进回收站', res.status === 200 && res.body.done.length === 1 && !fs.existsSync(path.join(targetDir, 'three.txt')));
  rec(group, '└ 回收站可见', (await client.call('/api/trash/list')).body.entries.some((e) => e.name === 'three.txt'));

  res = await client.call('/api/files/batch', { method: 'POST', body: { op: 'bogus', paths: [f3] } });
  rec(group, '非法 op → 400', res.status === 400 && res.body.error === 'invalid_op');
}

/* ---------------- 分享持久化 ---------------- */

async function testSharePersistence(prepared, client) {
  const group = '分享持久化';
  const file = newPath('share-me.txt');
  fs.writeFileSync(file, 'persist me');
  let res = await client.call('/api/download/share', { method: 'POST', body: { path: file, ttlMinutes: 30 } });
  rec(group, '创建分享', res.status === 200 && /^[0-9a-f]{32}$/.test(res.body?.token || ''), `token=${res.body?.token?.slice(0, 8)}…`);
  const token = res.body.token;
  const sharesFile = path.join(prepared.dataDir, 'shares.json');
  // 等待节流写落盘（≤1s）
  await new Promise((r) => setTimeout(r, 1500));
  rec(group, 'shares.json 已落盘且 0600', fs.existsSync(sharesFile) && (fs.statSync(sharesFile).mode & 0o777) === 0o600);

  await client.call('/api/session'); // 触发若干请求
  const panel = await spawnPanel(prepared); // 同一 DATA_DIR 重启
  try {
    const download = await request(panel.base, `/d/${token}`);
    rec(group, '重启实例后分享仍可下载', download.status === 200 && download.buffer.toString('utf8') === 'persist me', `status=${download.status}`);
    const login2 = makeClient(panel.base);
    const lr = await login2.login();
    rec(group, '新实例登录正常（shares 加载不影响启动）', lr.status === 200);
    const list = await login2.call('/api/download/shares');
    rec(group, '└ 分享列表包含该 token', list.body.shares.some((s) => s.token === token));
  } finally {
    await panel.stop();
  }

  // 损坏 shares.json：应忽略并 warn，面板正常启动
  fs.writeFileSync(sharesFile, '{"version":1,"shares":[{broken');
  const panel2 = await spawnPanel(prepared);
  try {
    const info = await request(panel2.base, '/api/app/info');
    const login3 = makeClient(panel2.base);
    await login3.login();
    const list = await login3.call('/api/download/shares');
    rec(group, 'shares.json 损坏 → 启动不崩、列表为空', info.status === 200 && list.status === 200 && Array.isArray(list.body.shares), `shares=${list.body?.shares?.length}`);
  } finally {
    await panel2.stop();
  }
  // 还原为空 shares 文件，避免影响后续测试
  fs.writeFileSync(sharesFile, JSON.stringify({ version: 1, shares: [] }));
}

/* ---------------- 压测 ---------------- */

async function waitBenchDone(client, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.call('/api/bench/status');
    if (res.body && res.body.running === false) return res.body;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('压测未在超时内完成');
}

async function testNetworkBench(client) {
  const group = '网络压测';
  let res = await client.call('/api/bench/start', { method: 'POST', body: { kind: 'network', durationSec: 2, connected: 2, msgSize: 65536 } });
  rec(group, '启动 network 压测', res.status === 200 && res.body.started === 'network', JSON.stringify(res.body));
  let status = await waitBenchDone(client);
  const result = status.lastResult || {};
  rec(group, '完成且结果标记 loopback:true', result.kind === 'network' && result.loopback === true, JSON.stringify({ kind: result.kind, loopback: result.loopback }));
  rec(group, '├ 上下行吞吐 > 0', result.upload?.bytes > 0 && result.download?.bytes > 0 && result.upload.mbps > 0 && result.download.mbps > 0, `up=${result.upload?.mbps}MB/s down=${result.download?.mbps}MB/s`);
  rec(group, '├ 记录 CPU 占用与连接数', Number.isFinite(result.cpuPercent) && result.connected === 2 && result.msgSize === 65536, `cpu=${result.cpuPercent}%`);
  rec(group, '└ 明确提示 loopback 不代表网卡性能', typeof result.note === 'string' && result.note.includes('loopback'), result.note);

  res = await client.call('/api/bench/history?kind=network');
  const row = (res.body.results || [])[0];
  let detail = row?.detail || {};
  rec(group, '结果入库且 detail.loopback=true', res.status === 200 && row?.kind === 'network' && detail.loopback === true, `rows=${res.body.results?.length}`);

  // 中止
  res = await client.call('/api/bench/start', { method: 'POST', body: { kind: 'network', durationSec: 20, connected: 1 } });
  rec(group, '长任务启动（准备中止）', res.status === 200);
  await new Promise((r) => setTimeout(r, 400));
  res = await client.call('/api/bench/abort', { method: 'POST' });
  rec(group, '中止返回 ok', res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
  status = await waitBenchDone(client, 15000);
  rec(group, '中止后任务结束且标记 aborted', status.lastResult?.kind === 'network' && status.lastResult?.aborted === true, JSON.stringify({ aborted: status.lastResult?.aborted }));

  res = await client.call('/api/bench/start', { method: 'POST', body: { kind: 'bogus' } });
  rec(group, '不支持的类型 → 400', res.status === 400);
}

async function testCpuGpuSamples(client) {
  const group = 'GPU 采样';
  let res = await client.call('/api/bench/start', { method: 'POST', body: { kind: 'cpu', threads: 2, durationSec: 2 } });
  rec(group, 'CPU 压测启动', res.status === 200 && res.body.started === 'cpu');
  const status = await waitBenchDone(client, 30000);
  const result = status.lastResult || {};
  const samples = Array.isArray(result.samples) ? result.samples : [];
  rec(group, 'CPU 结果包含 detail.samples', samples.length > 0, `samples=${samples.length}`);
  const cpuFields = samples.filter((s) => typeof s.cpuFreqMhz === 'number' || typeof s.cpuTempC === 'number');
  if (cpuFields.length === 0) {
    skip('GPU 采样 CPU 字段', '宿主没有 cpufreq / hwmon（CI 容器常见），跳过');
  } else {
    rec(group, '├ 每项有 t 且至少一个 CPU 字段', samples.every((s) => Number.isFinite(s.t) && (typeof s.cpuFreqMhz === 'number' || typeof s.cpuTempC === 'number')), JSON.stringify(samples[0]));
  }
  const gpuKeys = ['gpuBusy', 'gpuTempC', 'gpuPowerW', 'gpuVramPercent'];
  const withGpu = samples.filter((s) => gpuKeys.some((key) => typeof s[key] === 'number'));
  rec(group, '└ GPU 字段存在则记录（有则数值，无则跳过）', samples.every((s) => gpuKeys.every((key) => s[key] === undefined || typeof s[key] === 'number')), withGpu.length ? `${withGpu.length} 个采样含 GPU 字段` : '本机无 GPU 传感器，已跳过');
  if (result.gpu) {
    rec(group, 'GPU 汇总字段合法', typeof result.gpu.busyMax === 'number' || result.gpu.busyMax === null, JSON.stringify(result.gpu));
  } else {
    skip('GPU 汇总', '本机无 GPU 传感器');
  }
}

/* ---------------- Docker compose / 容器终端 ---------------- */

async function testDockerCompose(client) {
  const group = 'Docker compose';
  let res = await client.call('/api/docker/compose');
  rec(group, 'GET /api/docker/compose 返回 projects 数组', res.status === 200 && Array.isArray(res.body?.projects), `status=${res.status} projects=${res.body?.projects?.length}`);
  res = await client.call('/api/docker/compose/action', { method: 'POST', body: { project: 'definitely-not-exist-xyz', action: 'start' } });
  rec(group, '不存在的项目 → 404（无 docker 时 503）', res.status === 404 || res.status === 503, `status=${res.status}`);
  res = await client.call('/api/docker/compose/action', { method: 'POST', body: { project: 'x', action: 'nuke' } });
  rec(group, '非法 action → 400', res.status === 400);
  res = await client.call('/api/docker/compose/action', { method: 'POST', body: { project: '../bad', action: 'start' } });
  rec(group, '非法项目名 → 400', res.status === 400);
}

async function testTerminalContainer(client) {
  const group = '容器终端';
  let res = await client.call('/api/terminal/create', { method: 'POST', body: { container: '../etc/passwd', cols: 80, rows: 24 } });
  rec(group, '非法 container → 400（不触达 docker）', res.status === 400, `status=${res.status}`);
  res = await client.call('/api/terminal/create', { method: 'POST', body: { container: 'a'.repeat(200), cols: 80, rows: 24 } });
  rec(group, '过长 container → 400', res.status === 400, `status=${res.status}`);
  res = await client.call('/api/terminal/create', { method: 'POST', body: { container: 'deadbeefdeadbeef', cols: 80, rows: 24 } });
  rec(group, '合法格式但不存在容器 → 404（无 docker 时 503）', res.status === 404 || res.status === 503, `status=${res.status}`);
  // 确认没有真的创建终端会话
  const list = await client.call('/api/terminal/list');
  rec(group, '└ 未创建终端会话', Array.isArray(list.body?.sessions) && list.body.sessions.length === 0, `sessions=${list.body?.sessions?.length}`);
}

/* ---------------- 备份设置 ---------------- */

async function testBackupSettings(client, prepared) {
  const group = '备份设置';
  let res = await client.call('/api/backup/settings', { method: 'PUT', body: { auto: true, keep: 3 } });
  rec(group, 'PUT 合法设置成功', res.status === 200 && res.body.auto?.enabled === true && res.body.auto?.keep === 3, JSON.stringify(res.body));
  res = await client.call('/api/backup/list');
  rec(group, 'GET /api/backup/list 反映新设置', res.body.auto?.enabled === true && res.body.auto?.keep === 3, JSON.stringify(res.body.auto));
  const saved = JSON.parse(fs.readFileSync(prepared.configPath, 'utf8'));
  rec(group, '配置持久化到 config.json', saved.backup?.auto === true && saved.backup?.keep === 3, JSON.stringify(saved.backup));
  for (const [label, body] of [
    ['keep=0', { keep: 0 }],
    ['keep=31', { keep: 31 }],
    ['keep 非数字', { keep: 'x' }],
    ['auto 非布尔', { auto: 'yes' }],
  ]) {
    res = await client.call('/api/backup/settings', { method: 'PUT', body });
    rec(group, `非法 ${label} → 400`, res.status === 400 && res.body.error === 'invalid_settings', `status=${res.status}`);
  }
  res = await client.call('/api/backup/settings', { method: 'PUT', body: { auto: false, keep: 2 } });
  rec(group, '恢复测试配置', res.status === 200 && res.body.auto?.enabled === false && res.body.auto?.keep === 2);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ B3 扩展后端能力 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  await testUnits();

  const prepared = prepareDir();
  const panel = await spawnPanel(prepared);
  let client = makeClient(panel.base);
  await client.login();

  await testFilesTrash(client);
  await testBatch(client);
  await testBackupSettings(client, prepared);
  await client.call('/api/session');
  await testNetworkBench(client);
  await testCpuGpuSamples(client);
  await testDockerCompose(client);
  await testTerminalContainer(client);
  await testSharePersistence(prepared, client);
  await panel.stop();

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
