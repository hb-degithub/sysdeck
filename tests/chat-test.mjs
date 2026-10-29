#!/usr/bin/env node
/**
 * App 原生聊天 API 测试（零依赖，自包含隔离实例 + fake dsh）
 *
 * 覆盖：会话增删查、消息追加与持久化、fake dsh → assistant 落库（ok/error + stderr 摘要）、
 *      续聊传 --session-id、allowTask=false 403、并发 409、CSRF/401、存储 0600/损坏容忍/上限。
 *
 * 用法：node tests/chat-test.mjs ["<测试实例密码>"] [--keep]
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
const { ChatStore, MAX_SESSIONS, MAX_MESSAGES } = require('../lib/chat.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-chat-test-'));
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
    async call(pathname, opts = {}) {
      const method = opts.method || 'GET';
      const res = await request(base, pathname, {
        ...opts,
        method,
        cookie: cookie || undefined,
        csrf: method === 'GET' ? undefined : csrf || undefined,
      });
      for (const c of res.setCookie || []) {
        if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
      }
      return res;
    },
    async login() {
      const res = await request(base, '/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
      for (const c of res.setCookie || []) {
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

function writeFakeDsh(dirName, argsLogName) {
  const dir = path.join(TMP_ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const argsLog = path.join(dir, argsLogName);
  fs.writeFileSync(argsLog, '');
  const script = path.join(dir, 'fake-dsh-chat.sh');
  const dumpFile = path.join(dir, 'dump.yml');
  fs.writeFileSync(
    dumpFile,
    [
      '# fixture dump',
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: zijian',
      '    model: deepseek/deepseek-v4.1-flash',
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      zijian:',
      '        displayName: 自建',
      '        api: openai-responses',
      '        models:',
      '          - id: deepseek/deepseek-v4.1-flash',
      '            name: deepseek/deepseek-v4.1-flash',
      '      chat:',
      '        displayName: 自建chat',
      '        api: openai-completions',
      '        models:',
      '          - id: global:fast',
      '            name: global:fast',
      '- id: jobs',
      "  name: '@deepseek-ai/dsh-jobs'",
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    script,
    `#!/bin/sh
case "$*" in
  *--dump-config*) cat ${JSON.stringify(dumpFile)}; exit 0 ;;
  *--version*) echo "0.2.1-test"; exit 0 ;;
esac
OUT=${JSON.stringify(argsLog)}
{
  echo "CALL"
  prev=""
  for a in "$@"; do
    echo "ARG:$a"
    if [ "$prev" = "--patch" ]; then
      echo "PATCHPATH:$a"
      echo "PATCHBODY_BEGIN"
      cat "$a" 2>/dev/null
      echo "PATCHBODY_END"
    fi
    prev="$a"
  done
} >> "$OUT"
case "$*" in
  *PROMPT_ERROR*)
    echo '{"type":"session","sessionId":"session-fake-chat-err"}'
    echo 'boom stderr line' >&2
    exit 1
    ;;
  *PROMPT_SLOW*)
    echo '{"type":"session","sessionId":"session-fake-chat-slow"}'
    sleep 3
    echo '{"type":"final","text":"slow done"}'
    exit 0
    ;;
  *)
    echo '{"type":"session","sessionId":"session-fake-chat-1"}'
    echo '{"type":"text","text":"partial output"}'
    echo '{"type":"final","text":"你好，我是 fake 助手。"}'
    exit 0
    ;;
esac
`,
    { mode: 0o755 }
  );
  fs.chmodSync(script, 0o755);
  return { dir, script, argsLog };
}

function preparePanel(name, options = {}) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const emptyDist = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDist, { recursive: true });
  const fake = options.fake;
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: {
      title: '聊天测试',
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
    dsh: {
      allowTask: options.allowTask !== false,
      bin: fake.script,
      home: path.join(fake.dir, 'dsh-home'),
      patch: '',
      credentialsFile: '',
      profile: 'headless',
      taskTimeoutMs: 20000,
      cwd: fake.dir,
    },
  };
  fs.mkdirSync(config.dsh.home, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data'), fake };
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
    chatFile: path.join(prepared.dataDir, 'dsh-chat.json'),
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

async function waitAssistant(client, sessionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await client.call(`/api/dsh/chat/sessions/${sessionId}`);
    const messages = res.body?.messages || [];
    const assistant = [...messages].reverse().find((m) => m.role === 'assistant');
    last = assistant;
    if (assistant && assistant.status !== 'running') return assistant;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

/* ---------------- 单元：ChatStore 上限 ---------------- */

function testStoreLimits() {
  const group = '存储上限';
  const dir = path.join(TMP_ROOT, 'store-limits');
  fs.mkdirSync(dir, { recursive: true });
  const store = new ChatStore({ dataDir: dir, maxSessions: 3, maxMessages: 5 });
  for (let i = 0; i < 5; i += 1) store.createSession(`会话${i}`);
  rec(group, '会话上限（maxSessions=3）', store.listSessions().length === 3, `sessions=${store.listSessions().length}`);
  const id = store.listSessions()[0].id;
  for (let i = 0; i < 8; i += 1) {
    store.appendMessage(id, { role: 'user', text: `消息${i}`, status: 'ok' });
  }
  const page = store.getSession(id, { limit: 500 });
  rec(group, '每会话消息上限（maxMessages=5）', page.messages.length === 5 && page.messages[page.messages.length - 1].text === '消息7', `messages=${page.messages.length}`);
  store.flush();
  const reloaded = new ChatStore({ dataDir: dir, maxSessions: 3, maxMessages: 5 });
  rec(group, 'flush 后可重新加载', reloaded.listSessions().length === 3 && reloaded.getSession(id, { limit: 10 }).messages.length === 5);
  reloaded.close();
  rec(group, '默认上限常量 100 / 500', MAX_SESSIONS === 100 && MAX_MESSAGES === 500);
}

/* ---------------- 主流程 ---------------- */

async function testApi(inst, client) {
  const group = '会话 API';

  let res = await request(inst.base, '/api/dsh/chat/sessions');
  rec(group, '未登录 GET sessions → 401', res.status === 401, `status=${res.status}`);
  res = await request(inst.base, '/api/dsh/chat/sessions', { method: 'POST', headers: { Cookie: client.cookie }, body: {} });
  rec(group, '缺 CSRF 创建会话 → 403', res.status === 403, `status=${res.status}`);

  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { title: '测试会话' } });
  rec(group, '创建会话返回 id', res.status === 200 && /^chat-[A-Za-z0-9_-]+$/.test(res.body?.id || ''), JSON.stringify(res.body));
  const sessionId = res.body.id;

  res = await client.call('/api/dsh/chat/sessions');
  const listed = (res.body.sessions || []).find((s) => s.id === sessionId);
  rec(group, '列表含新会话与字段', res.status === 200 && Boolean(listed) && listed.title === '测试会话' && listed.messageCount === 0 && listed.dshSessionId === null, JSON.stringify(listed));

  res = await client.call(`/api/dsh/chat/sessions/${sessionId}`);
  rec(group, 'GET 单会话（空消息）', res.status === 200 && res.body.session.id === sessionId && res.body.messages.length === 0 && res.body.hasMore === false, JSON.stringify(res.body.session));

  res = await client.call(`/api/dsh/chat/sessions/${sessionId}`, { method: 'POST', body: {} });
  rec(group, '未知路由（POST 到 session 本身）→ 404', res.status === 404, `status=${res.status}`);

  rec(group, '未知会话 GET → 404', (await client.call('/api/dsh/chat/sessions/chat-doesnotexist')).status === 404);
  rec(group, '未知会话发消息 → 404', (await client.call('/api/dsh/chat/sessions/chat-doesnotexist/messages', { method: 'POST', body: { text: 'x' } })).status === 404);

  res = await client.call(`/api/dsh/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '   ' } });
  rec(group, '空文本 → 400 chat_text_required', res.status === 400 && res.body.error === 'chat_text_required', JSON.stringify(res.body));

  return sessionId;
}

async function testMessageFlow(inst, client, sessionId) {
  const group = '消息与任务';
  const t0 = Date.now();
  let res = await client.call(`/api/dsh/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '你好，介绍一下自己' } });
  rec(group, '发消息返回 messageId/taskId', res.status === 200 && typeof res.body.messageId === 'string' && typeof res.body.taskId === 'string' && typeof res.body.assistantMessageId === 'string', JSON.stringify(res.body));
  const taskId = res.body.taskId;

  const assistant = await waitAssistant(client, sessionId);
  rec(group, 'assistant 消息落库为 ok', assistant?.status === 'ok', JSON.stringify(assistant));
  rec(group, '├ text 取 final 文本', typeof assistant?.text === 'string' && assistant.text.includes('你好，我是 fake 助手。'), assistant?.text);
  rec(group, '└ 关联 taskId', assistant?.taskId === taskId);

  res = await client.call(`/api/dsh/chat/sessions/${sessionId}`);
  const messages = res.body.messages || [];
  rec(group, '会话消息顺序 user → assistant', messages.length === 2 && messages[0].role === 'user' && messages[1].role === 'assistant', messages.map((m) => m.role).join(','));
  rec(group, '深连接：dshSessionId 已回填', res.body.session.dshSessionId === 'session-fake-chat-1', res.body.session.dshSessionId);

  // 续聊：第二条消息应带 --session-id
  fs.writeFileSync(inst.argsLog, '');
  res = await client.call(`/api/dsh/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { text: '继续聊' } });
  rec(group, '续聊发消息成功', res.status === 200, `status=${res.status}`);
  await waitAssistant(client, sessionId);
  const argsText = fs.readFileSync(inst.argsLog, 'utf8');
  rec(group, '续聊传 --session-id', argsText.includes('ARG:--session-id') && argsText.includes('ARG:session-fake-chat-1'), argsText.split('\n').filter((l) => l.startsWith('ARG:--session-id') || l.startsWith('ARG:session-')).join(' '));
  rec(group, '续聊 prompt 作为单独 argv', argsText.includes('ARG:继续聊'));

  // 指定模型：写临时 patch（任务结束后删除）
  fs.writeFileSync(inst.argsLog, '');
  res = await client.call(`/api/dsh/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: { text: '用指定模型回复', model: 'zijian/deepseek/deepseek-v4.1-flash' },
  });
  rec(group, '指定合法 model 发消息成功', res.status === 200 && typeof res.body.taskId === 'string', JSON.stringify(res.body));
  await waitAssistant(client, sessionId, res.body.assistantMessageId);
  // 等待 fake dsh 记录 --patch（脚本在启动阶段写入）
  let modelArgs = '';
  for (let i = 0; i < 50; i += 1) {
    modelArgs = fs.existsSync(inst.argsLog) ? fs.readFileSync(inst.argsLog, 'utf8') : '';
    if (modelArgs.includes('PATCHBODY_END')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const patchLine = modelArgs.split('\n').find((line) => line.startsWith('PATCHPATH:')) || '';
  const patchPath = patchLine.slice('PATCHPATH:'.length).trim();
  rec(group, '├ 传给 fake dsh 的 --patch 指向临时文件', Boolean(patchPath) && modelArgs.includes('ARG:--patch'), patchPath);
  rec(group, '├ 临时 patch 内容为 agent-default-model 覆盖', modelArgs.includes('provider: zijian') && modelArgs.includes('model: deepseek/deepseek-v4.1-flash'), 'patch body ok');
  // 任务结束后临时文件应被清掉
  let patchDeleted = false;
  for (let i = 0; i < 50; i += 1) {
    if (patchPath && !fs.existsSync(patchPath)) {
      patchDeleted = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  rec(group, '└ 任务结束后临时 patch 已删除', Boolean(patchPath) && patchDeleted, patchPath);

  res = await client.call(`/api/dsh/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { text: 'x', model: 'nope/whatever' } });
  rec(group, '非法 model → 400 invalid_model', res.status === 400 && res.body.error === 'invalid_model', JSON.stringify(res.body));
  res = await client.call(`/api/dsh/chat/sessions/${sessionId}`);
  const msgCountAfterInvalid = (res.body.messages || []).length;
  rec(group, '└ 非法 model 不产生消息', msgCountAfterInvalid >= 6 && (res.body.messages || []).filter((m) => m.text === 'x').length === 0, `messages=${msgCountAfterInvalid}`);

  // 出错任务
  const errSession = (await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { title: '错误会话' } })).body.id;
  res = await client.call(`/api/dsh/chat/sessions/${errSession}/messages`, { method: 'POST', body: { text: 'PROMPT_ERROR 触发失败' } });
  rec(group, '启动会失败的任务（返回 taskId）', res.status === 200 && typeof res.body.taskId === 'string', JSON.stringify(res.body));
  const errAssistant = await waitAssistant(client, errSession);
  rec(group, '失败任务 → assistant status=error', errAssistant?.status === 'error', JSON.stringify(errAssistant));
  rec(group, '└ 写入 stderr 摘要', typeof errAssistant?.error === 'string' && errAssistant.error.includes('boom stderr line'), errAssistant?.error);
  rec(group, '└ 文本非空（便于客户端展示）', typeof errAssistant?.text === 'string' && errAssistant.text.length > 0, errAssistant?.text);

  // 并发 409
  const slowSession = (await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { title: '慢任务' } })).body.id;
  res = await client.call(`/api/dsh/chat/sessions/${slowSession}/messages`, { method: 'POST', body: { text: 'PROMPT_SLOW 慢任务' } });
  rec(group, '慢任务启动', res.status === 200, JSON.stringify(res.body));
  res = await client.call(`/api/dsh/chat/sessions/${slowSession}/messages`, { method: 'POST', body: { text: '并发第二条' } });
  rec(group, '并发提交 → 409 dsh_task_busy', res.status === 409 && res.body.error === 'dsh_task_busy', JSON.stringify(res.body));
  const slowAssistant = await waitAssistant(client, slowSession);
  rec(group, '慢任务完成后 assistant ok', slowAssistant?.status === 'ok', JSON.stringify(slowAssistant));

  // 删除会话
  res = await client.call(`/api/dsh/chat/sessions/${slowSession}`, { method: 'DELETE' });
  rec(group, '删除会话 → ok', res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
  rec(group, '└ 删除后 GET → 404', (await client.call(`/api/dsh/chat/sessions/${slowSession}`)).status === 404);

  void t0;
  return { errSession };
}

async function testAllowTaskDisabled() {
  const group = 'allowTask=false';
  const fake = writeFakeDsh('fake-disabled', 'args-disabled.log');
  const prepared = preparePanel('panel-disabled', { fake, allowTask: false });
  const inst = await spawnPanel(prepared);
  try {
    const client = makeClient(inst.base);
    await client.login();
    const created = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: {} });
    rec(group, 'allowTask=false 仍可创建会话', created.status === 200 && typeof created.body.id === 'string');
    const res = await client.call(`/api/dsh/chat/sessions/${created.body.id}/messages`, { method: 'POST', body: { text: 'hi' } });
    rec(group, '发消息 → 403 dsh_task_disabled', res.status === 403 && res.body.error === 'dsh_task_disabled', JSON.stringify(res.body));
    const detail = await client.call(`/api/dsh/chat/sessions/${created.body.id}`);
    rec(group, '└ 不产生消息（拒绝发生在落库前）', (detail.body.messages || []).length === 0, `messages=${detail.body.messages?.length}`);
  } finally {
    await inst.stop();
  }
}

async function testPersistence(prepared, mainInst) {
  const group = '持久化';
  await new Promise((r) => setTimeout(r, 800)); // 等待节流写盘
  rec(group, 'dsh-chat.json 已落盘 0600', fs.existsSync(mainInst.chatFile) && (fs.statSync(mainInst.chatFile).mode & 0o777) === 0o600);
  const before = JSON.parse(fs.readFileSync(mainInst.chatFile, 'utf8'));
  rec(group, '文件结构 version/sessions', before.version === 1 && Array.isArray(before.sessions) && before.sessions.length > 0, `sessions=${before.sessions.length}`);

  await mainInst.stop();
  const restarted = await spawnPanel(prepared);
  try {
    const client = makeClient(restarted.base);
    await client.login();
    const list = await client.call('/api/dsh/chat/sessions');
    rec(group, '重启后会话仍在', list.status === 200 && list.body.sessions.length > 0, `sessions=${list.body.sessions.length}`);
    const target = list.body.sessions.find((s) => s.title === '测试会话');
    rec(group, '├ 标题/消息数保留', Boolean(target) && target.messageCount >= 4, JSON.stringify({ title: target?.title, count: target?.messageCount }));
    const detail = await client.call(`/api/dsh/chat/sessions/${target.id}`);
    const assistants = (detail.body.messages || []).filter((m) => m.role === 'assistant');
    rec(group, '├ assistant 状态与文本保留', assistants.length >= 2 && assistants.every((m) => ['ok', 'error'].includes(m.status)) && assistants.some((m) => m.text.includes('fake 助手')), assistants.map((m) => m.status).join(','));
    rec(group, '└ dshSessionId 保留（可续聊）', detail.body.session.dshSessionId === 'session-fake-chat-1', detail.body.session.dshSessionId);
  } finally {
    await restarted.stop();
  }

  // 损坏文件：启动不崩、会话为空
  fs.writeFileSync(mainInst.chatFile, '{"version":1,"sessions":[BROKEN');
  const broken = await spawnPanel(prepared);
  try {
    const info = await request(broken.base, '/api/app/info');
    const client = makeClient(broken.base);
    const login = await client.login();
    const list = await client.call('/api/dsh/chat/sessions');
    rec(group, 'dsh-chat.json 损坏 → 启动不崩、列表为空', info.status === 200 && login.status === 200 && list.status === 200 && Array.isArray(list.body.sessions) && list.body.sessions.length === 0, `sessions=${list.body.sessions?.length}`);
  } finally {
    await broken.stop();
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ App 原生聊天 API 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}`);

  testStoreLimits();

  const fake = writeFakeDsh('fake-chat', 'args.log');
  const prepared = preparePanel('panel-chat', { fake });
  const inst = await spawnPanel(prepared);
  const client = makeClient(inst.base);
  await client.login();
  inst.argsLog = fake.argsLog;

  const sessionId = await testApi(inst, client);
  await testMessageFlow(inst, client, sessionId);
  await testAllowTaskDisabled();
  await testPersistence(prepared, inst);

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
