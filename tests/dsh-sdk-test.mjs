#!/usr/bin/env node
/**
 * SDK 高级续聊（dsh --profile sdk）后端测试（零依赖，自包含 fake SDK 子进程）
 *
 * 覆盖：
 *  - /api/dsh/sdk/status（allowSdkResume / preset 探测 / providers patch）
 *  - force 绑定带 agentPreset 的 Web 会话（channel=sdk），boundDsh 字段
 *  - 正常续聊：JSON-RPC initialize/resume/prompt/wait → SSE start/event/done，assistant 文本落库
 *  - 错误映射：already owned → dsh_session_busy_in_web；no adapter → dsh_provider_missing；
 *              preset missing → dsh_preset_missing；超时 → error timeout 并 kill
 *  - 参数与清理：--profile sdk、providers patch、preset patches、临时 registry 文件任务后删除
 *  - allowSdkResume=false：status 不可用、sdk 通道 400 sdk_resume_disabled；headless 仍可用
 *  - 并发：SDK 任务运行中再提交 → 409 dsh_task_busy
 *
 * 用法：node tests/dsh-sdk-test.mjs ["<测试实例密码>"] [--keep]
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
const { detectPresetPatches, writeRegistryPatch } = require('../lib/dshSdk.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-sdk-test-'));
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

/* ---------------- fixture ---------------- */

const EXISTING_CWD = path.join(TMP_ROOT, 'work');
fs.mkdirSync(EXISTING_CWD, { recursive: true });

function writePresetFixtures() {
  const dir = path.join(TMP_ROOT, 'presets');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['cordis', 'standard', 'ptc', 'minimal']) {
    fs.writeFileSync(path.join(dir, `${name}.patch.yml`), `# fake preset ${name}\n`, { mode: 0o600 });
  }
  return ['cordis', 'standard', 'ptc', 'minimal'].map((name) => path.join(dir, `${name}.patch.yml`));
}

function writeProvidersPatch() {
  const file = path.join(TMP_ROOT, 'providers.patch.yml');
  fs.writeFileSync(file, '# fake providers patch\n', { mode: 0o600 });
  return file;
}

/** 构造带 agentPreset 的 DSH 会话（多帧 zstd，若环境有 zstd） */
function writePresetSession(dshHome, id, cwd, preset) {
  const dir = path.join(dshHome, 'sessions', '--tmp-work--', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const lines = [
    { type: 'session', version: 4, id, createdAt: Date.now() - 100000, cwd, agentPreset: preset },
    { type: 'user/message', seq: 1, time: Date.now() - 90000, data: { content: [{ type: 'text', text: '你好' }], role: 'user' } },
    { type: 'assistant/message', seq: 2, time: Date.now() - 89000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好，我是 Web 会话' }] } } },
  ];
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  const zstd = (() => {
    for (const dirName of String(process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(dirName, 'zstd');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (e) {
        /* continue */
      }
    }
    return '';
  })();
  if (zstd) {
    const { execFileSync } = require('node:child_process');
    const half = Math.floor(text.length / 2);
    const splitAt = text.indexOf('\n', half) + 1;
    const frame1 = execFileSync(zstd, ['-c', '-q'], { input: Buffer.from(text.slice(0, splitAt)), maxBuffer: 8 * 1024 * 1024 });
    const frame2 = execFileSync(zstd, ['-c', '-q'], { input: Buffer.from(text.slice(splitAt)), maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(file, Buffer.concat([frame1, frame2]));
  } else {
    const zlib = require('node:zlib');
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  }
}

/** 写 fake dsh：同时支持 headless（NDJSON）与 sdk（JSON-RPC over stdio） */
function writeFakeDsh() {
  const dir = path.join(TMP_ROOT, 'fake');
  fs.mkdirSync(dir, { recursive: true });
  const argsLog = path.join(dir, 'args.log');
  const modeFile = path.join(dir, 'mode.txt');
  fs.writeFileSync(modeFile, 'normal');
  fs.writeFileSync(argsLog, '');
  const dumpFile = path.join(dir, 'dump.yml');
  fs.writeFileSync(
    dumpFile,
    [
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: p1',
      '    model: m1',
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      p1:',
      '        displayName: fake',
      '        api: openai-completions',
      '        models:',
      '          - id: m1',
      '            name: m1',
      '',
    ].join('\n')
  );
  const script = path.join(dir, 'fake-dsh.js');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const argv = process.argv.slice(2);
const ARGS_LOG = ${JSON.stringify(argsLog)};
const MODE_FILE = ${JSON.stringify(modeFile)};
const DUMP = ${JSON.stringify(dumpFile)};
const profile = argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : '';
const mode = (() => { try { return fs.readFileSync(MODE_FILE, 'utf8').trim(); } catch (e) { return 'normal'; } })();
const patches = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--patch' && argv[i + 1]) patches.push(argv[i + 1]);
}
fs.appendFileSync(ARGS_LOG, JSON.stringify({ profile, mode, patches, registryExistsAtStart: patches.filter((p) => p.includes('dsh-sdk-registry')).map((p) => fs.existsSync(p)) }) + '\\n');
if (argv.includes('--dump-config')) { process.stdout.write(fs.readFileSync(DUMP, 'utf8')); process.exit(0); }
if (argv.includes('--version')) { process.stdout.write('0.2.1-test\\n'); process.exit(0); }
if (profile === 'headless') {
  process.stdout.write('{"type":"session","sessionId":"session-fake-headless"}\\n');
  process.stdout.write('{"type":"final","text":"headless ok"}\\n');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, obj)) + '\\n');
const notify = (method, params) => send({ method, params });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  if (req.method === 'initialize') {
    if (mode === 'provider-missing') {
      send({ id: req.id, error: { code: -32603, message: 'no adapter registered for provider "nope"' } });
      return;
    }
    send({ id: req.id, result: { serverInfo: { name: 'fake-sdk', version: '0.0.1' } } });
    return;
  }
  if (req.method === 'session/resume') {
    if (mode === 'busy') {
      send({ id: req.id, error: { code: -32603, message: 'session "' + req.params.sessionId + '" is already owned by an active write handle' } });
      return;
    }
    if (mode === 'preset-missing') {
      send({ id: req.id, error: { code: -32603, message: 'agent preset "cordis" is not defined in registry' } });
      return;
    }
    send({ id: req.id, result: {} });
    return;
  }
  if (req.method === 'session/prompt') {
    const sid = req.params.sessionId;
    send({ id: req.id, result: { messageId: 'msg-fake-1' } });
    if (mode === 'hang') return; // 不结束，等超时 kill
    notify('session.status', { sessionId: sid, status: 'running' });
    notify('session.event', { sessionId: sid, event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } } });
    notify('session.event', { sessionId: sid, event: { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: req.params.contentBlocks[0].text }], role: 'user' } } });
    notify('session.event', { sessionId: sid, event: { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: 'SDK 收到。' }], source: { provider: 'p1', model: 'm1' } } } } });
    notify('session.event', { sessionId: sid, event: { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } } });
    notify('session.status', { sessionId: sid, status: 'idle' });
    return;
  }
  if (req.method === 'session/wait') {
    if (mode === 'hang') return;
    setTimeout(() => send({ id: req.id, result: {} }), 50);
    return;
  }
  if (req.method === 'shutdown') {
    send({ id: req.id, result: {} });
    setTimeout(() => process.exit(0), 20);
    return;
  }
});
`,
    { mode: 0o755 }
  );
  fs.chmodSync(script, 0o755);
  return { script, argsLog, modeFile };
}

function setMode(fake, mode) {
  fs.writeFileSync(fake.modeFile, mode);
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

function collectSse(base, pathname, cookie, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { headers: { Cookie: cookie || '', Accept: 'text/event-stream' } }, (res) => {
      const events = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              events.push(JSON.parse(raw));
            } catch (e) {
              events.push({ raw });
            }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events }));
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

async function findFreePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function preparePanel(name, options = {}) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const emptyDist = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDist, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: { title: 'SDK 测试', username: 'admin', passwordHash: hashPassword(PASSWORD, salt), passwordSalt: salt, mustChangePassword: false },
    session: { secret: crypto.randomBytes(32).toString('hex'), ttlSeconds: 12 * 60 * 60 },
    sampleIntervalMs: 1000,
    alerts: { enabled: false },
    backup: { auto: false, keep: 2, hour: 4 },
    appUpdate: { distDir: emptyDist },
    dsh: {
      allowTask: true,
      allowSdkResume: options.allowSdkResume !== false,
      bin: options.fake.script,
      home: options.dshHome,
      patch: options.providersPatch,
      credentialsFile: '',
      profile: 'headless',
      sdkProfile: 'sdk',
      sdkPresetPatches: options.presetPatches,
      sdkProvidersPatch: options.providersPatch,
      sdkTimeoutMs: options.sdkTimeoutMs || 15000,
      taskTimeoutMs: 15000,
      cwd: dir,
      env: { FAKE_SDK_LOG: options.fake.argsLog, FAKE_SDK_MODE_FILE: options.fake.modeFile },
    },
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
      if (res.status === 200) return inst;
    } catch (e) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`实例启动超时\n${logs.join('')}`);
}

async function waitAssistant(client, sessionId, messageId = null, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await client.call(`/api/dsh/chat/sessions/${sessionId}`);
    const assistants = (res.body?.messages || []).filter((m) => m.role === 'assistant');
    const assistant = messageId ? assistants.find((m) => m.id === messageId) : assistants[assistants.length - 1];
    last = assistant;
    if (assistant && assistant.status !== 'running') return assistant;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}

function lastArgs(fake) {
  const lines = fs.readFileSync(fake.argsLog, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return null;
  }
}

/* ---------------- 测试 ---------------- */

function testPresetDetection(presetPatches) {
  const group = 'preset 探测';
  const fakeBin = path.join(TMP_ROOT, 'fake', 'fake-dsh.js');
  const detected = detectPresetPatches(fakeBin, presetPatches);
  rec(group, '显式 sdkPresetPatches 生效', detected.length === 4 && detected.every((item) => fs.existsSync(item.path)), detected.map((item) => item.name).join(','));
  rec(group, '名称去 .patch.yml 后缀', detected.map((item) => item.name).join(',') === 'cordis,standard,ptc,minimal', detected.map((item) => item.name).join(','));
  const missing = detectPresetPatches(fakeBin, ['/nonexistent/x.patch.yml']);
  rec(group, '显式路径不存在 → 空（不报错）', missing.length === 0);
  const auto = detectPresetPatches(path.join(ROOT, 'server.js'), []);
  rec(group, '无 preset 环境 → 空数组', Array.isArray(auto) && auto.length === 0, `auto=${auto.length}`);
  const registry = writeRegistryPatch();
  const body = fs.readFileSync(registry, 'utf8');
  rec(group, '临时 registry 内容含 agent-preset-registry', body.includes('agent-preset-registry') && body.includes("default: standard"), 'registry ok');
  fs.unlinkSync(registry);
}

async function testEnabled(inst, fake, presetSessionId) {
  const group = 'SDK 续聊';
  const client = makeClient(inst.base);
  await client.login();

  let res = await client.call('/api/dsh/sdk/status');
  rec(group, 'GET /api/dsh/sdk/status available=true', res.status === 200 && res.body.available === true && res.body.allowSdkResume === true && res.body.presets.length === 4 && res.body.providersPatchExists === true, JSON.stringify({ available: res.body?.available, presets: res.body?.presets, reason: res.body?.reason }));
  rec(group, '├ profile/providersPatch 字段', res.body.profile === 'sdk' && typeof res.body.providersPatch === 'string', JSON.stringify({ profile: res.body?.profile }));

  // force 绑定带 preset 的 Web 会话
  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { dshSessionId: presetSessionId, force: true } });
  rec(group, 'force=true 可绑定带 agentPreset 的会话', res.status === 200 && typeof res.body.id === 'string' && res.body.channel === 'sdk', JSON.stringify(res.body));
  const chatId = res.body.id;
  let detail = await client.call(`/api/dsh/chat/sessions/${chatId}`);
  rec(group, '├ 聊天会话 channel=sdk', detail.body.session.channel === 'sdk', detail.body.session.channel);
  rec(group, '└ boundDsh 含 agentPreset/channel（resumable 仍为 false）', detail.body.boundDsh.agentPreset === 'cordis' && detail.body.boundDsh.channel === 'sdk' && detail.body.boundDsh.resumable === false, JSON.stringify(detail.body.boundDsh));

  // 正常续聊
  setMode(fake, 'normal');
  fs.writeFileSync(fake.argsLog, '');
  res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: '继续聊两句' } });
  rec(group, 'POST 消息（auto → sdk）返回 sdk- 任务', res.status === 200 && /^sdk-/.test(res.body.taskId || '') && res.body.channel === 'sdk', JSON.stringify(res.body));
  const taskId = res.body.taskId;
  const sse = await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(taskId)}`, client.cookie, 15000);
  const types = sse.events.map((e) => e.type);
  rec(group, 'SSE 复用任务流（start/event/done）', sse.status === 200 && types[0] === 'start' && types.includes('event') && types.includes('done'), types.join(','));
  rec(group, '├ assistant/message 事件转发', sse.events.some((e) => e.type === 'event' && String(e.line).includes('assistant/message')), 'event ok');
  rec(group, '└ done code=0', sse.events.some((e) => e.type === 'done' && e.code === 0));

  const assistant = await waitAssistant(client, chatId, res.body.assistantMessageId);
  rec(group, 'assistant 消息落库 ok + 文本', assistant?.status === 'ok' && assistant.text.includes('SDK 收到。'), JSON.stringify(assistant));
  const args = lastArgs(fake);
  rec(group, '参数：--profile sdk + providers patch + preset patch', Boolean(args) && args.profile === 'sdk' && args.patches.some((p) => p.endsWith('providers.patch.yml')) && args.patches.some((p) => p.endsWith('cordis.patch.yml')), JSON.stringify(args?.patches));
  const registryPath = (args?.patches || []).find((p) => p.includes('dsh-sdk-registry'));
  rec(group, '临时 registry 启动时存在', Boolean(registryPath) && args.registryExistsAtStart?.[0] === true, registryPath || 'missing');
  for (let i = 0; i < 50 && registryPath && fs.existsSync(registryPath); i += 1) await new Promise((r) => setTimeout(r, 100));
  rec(group, '└ 任务结束后 registry 临时文件已删除', Boolean(registryPath) && !fs.existsSync(registryPath), registryPath);

  // 错误映射
  const cases = [
    ['busy', 'dsh_session_busy_in_web', /DSH Web/],
    ['provider-missing', 'dsh_provider_missing', /provider/],
    ['preset-missing', 'dsh_preset_missing', /preset/],
  ];
  for (const [mode, code, detailPattern] of cases) {
    setMode(fake, mode);
    res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: `mode ${mode}` } });
    rec(group, `错误映射 ${mode} → 400 ${code}`, res.status === 400 && res.body.error === code && detailPattern.test(res.body.detail || ''), JSON.stringify(res.body));
  }
  const afterErrors = await client.call(`/api/dsh/chat/sessions/${chatId}`);
  rec(group, '错误任务留下 error assistant（可读）', (afterErrors.body.messages || []).some((m) => m.role === 'assistant' && m.status === 'error'), 'error recorded');

  // 超时 → error timeout + kill
  setMode(fake, 'hang');
  res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: '触发超时' } });
  rec(group, '超时任务启动成功', res.status === 200 && /^sdk-/.test(res.body.taskId || ''), JSON.stringify(res.body));
  const t0 = Date.now();
  const sseTimeout = await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(res.body.taskId)}`, client.cookie, 15000);
  const errEvent = sseTimeout.events.find((e) => e.type === 'error');
  rec(group, '超时 → SSE error timeout（≤15s）', Boolean(errEvent) && (errEvent.message === 'timeout' || errEvent.code === 'dsh_sdk_timeout') && Date.now() - t0 < 15000, JSON.stringify(errEvent));

  // 并发 409
  setMode(fake, 'hang');
  res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: '并发一' } });
  rec(group, '并发任务一启动', res.status === 200);
  const concurrent = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: '并发二' } });
  rec(group, 'SDK 并发 → 409 dsh_task_busy', concurrent.status === 409 && concurrent.body.error === 'dsh_task_busy', JSON.stringify(concurrent.body));
  // 等第一个超时清理
  await collectSse(inst.base, `/api/dsh/task/stream?id=${encodeURIComponent(res.body.taskId)}`, client.cookie, 20000);
  setMode(fake, 'normal');
}

async function testDisabled(fake, dshHome) {
  const group = 'allowSdkResume=false';
  const prepared = preparePanel('panel-disabled', { fake, dshHome, presetPatches: writePresetFixtures(), providersPatch: writeProvidersPatch(), allowSdkResume: false });
  const inst = await spawnPanel(prepared);
  try {
    const client = makeClient(inst.base);
    await client.login();
    let res = await client.call('/api/dsh/sdk/status');
    rec(group, 'status available=false 且给出原因', res.status === 200 && res.body.available === false && res.body.allowSdkResume === false && /allowSdkResume/.test(res.body.reason || ''), JSON.stringify({ available: res.body?.available, reason: res.body?.reason }));

    // force 绑定被拒绝
    const presetSessionId = 'session-sdk-preset-1';
    res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { dshSessionId: presetSessionId, force: true } });
    rec(group, 'force 绑定 → 400 sdk_resume_disabled', res.status === 400 && res.body.error === 'sdk_resume_disabled', JSON.stringify(res.body));

    // 普通聊天（headless）仍可用
    res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { title: 'headless 会话' } });
    const chatId = res.body.id;
    res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: 'hi' } });
    rec(group, 'headless 会话仍可发送', res.status === 200 && res.body.channel === 'headless', JSON.stringify(res.body));
    const assistant = await waitAssistant(client, chatId, res.body.assistantMessageId);
    rec(group, '└ headless assistant ok', assistant?.status === 'ok' && assistant.text.includes('headless ok'), JSON.stringify(assistant));
    res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: 'x', channel: 'sdk' } });
    rec(group, '显式 sdk 通道 → 400 sdk_resume_disabled', res.status === 400 && res.body.error === 'sdk_resume_disabled');
    res = await client.call(`/api/dsh/chat/sessions/${chatId}/messages`, { method: 'POST', body: { text: 'x', channel: 'bogus' } });
    rec(group, '非法 channel → 400 invalid_channel', res.status === 400 && res.body.error === 'invalid_channel');
  } finally {
    await inst.stop();
  }
}

async function main() {
  console.log('\n══════ SDK 高级续聊（dsh --profile sdk）测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  const presetPatches = writePresetFixtures();
  const providersPatch = writeProvidersPatch();
  testPresetDetection(presetPatches);

  const dshHome = path.join(TMP_ROOT, 'dsh-home');
  writePresetSession(dshHome, 'session-sdk-preset-1', EXISTING_CWD, 'cordis');

  const fake = writeFakeDsh();
  const prepared = preparePanel('panel', { fake, dshHome, presetPatches, providersPatch, sdkTimeoutMs: 1500 });
  const inst = await spawnPanel(prepared);
  try {
    await testEnabled(inst, fake, 'session-sdk-preset-1');
  } finally {
    await inst.stop();
  }
  await testDisabled(fake, dshHome);

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
