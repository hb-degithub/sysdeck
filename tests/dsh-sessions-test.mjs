#!/usr/bin/env node
/**
 * DSH 会话目录 / 历史解析 / 能力探测 测试（零依赖，自包含隔离实例）
 *
 * 覆盖：
 *  - 多帧 zstd 解码（zstd CLI）与 header-only 回退
 *  - 会话元信息（preset → resumable=false、无 preset → true、cwd 缺失 → false、title/model/计数/摘要）
 *  - 消息映射（user/assistant/tool/tool-result 合并、跳过无关事件、limit 取尾部）
 *  - 目录列表（排序/limit/q/workspace/mtime 缓存命中）
 *  - dump-config 解析（plugins/defaultModel/providers；不返回 apiKeyEnv/baseURL）
 *  - API：/api/dsh/sessions、/messages、/capabilities
 *  - chat 导入：resumable 成功绑定 cwd/标题；不可续 → 400 带 agentPreset；cwd 不存在 → 400
 *
 * 用法：node tests/dsh-sessions-test.mjs ["<测试实例密码>"] [--keep]
 */

import { spawn, execFileSync } from 'node:child_process';
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
const {
  SessionCatalog,
  DshCapabilities,
  parseDumpConfig,
  extractSessionMeta,
  mapMessages,
  findBinary,
  decodeSessionFile,
  decodeWorkspaceName,
} = require('../lib/dshSessions.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PASSWORD = process.argv[2] || generatePassword(20);
const KEEP = process.argv.includes('--keep');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-dshsess-test-'));
const HAS_ZSTD = Boolean(findBinary('zstd'));
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

/* ---------------- fixture 构造 ---------------- */

const EXISTING_CWD = path.join(TMP_ROOT, 'work');
fs.mkdirSync(EXISTING_CWD, { recursive: true });
const MISSING_CWD = path.join(TMP_ROOT, 'no-such-cwd');

function eventsFor(id, { cwd, preset, title, withTools = false }) {
  const created = Date.now() - 60000;
  const lines = [];
  lines.push({ type: 'session', version: 4, id, createdAt: created, cwd, isSeeded: false, delegationDepth: 0, ...(preset ? { agentPreset: preset } : {}) });
  lines.push({ type: 'user/message', seq: 1, time: created + 1000, data: { content: [{ type: 'text', text: '第一条用户消息：你好' }], role: 'user', id: 'u1' } });
  lines.push({ type: 'model/selection', seq: 2, time: created + 1100, data: { provider: 'p1', model: 'm1' } });
  lines.push({ type: 'assistant/message', seq: 3, time: created + 2000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手回复内容' }], source: { kind: 'model', provider: 'p1', model: 'm1' } } } });
  if (withTools) {
    lines.push({ type: 'tool/call', seq: 4, time: created + 3000, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"/tmp/a.txt"}' } });
    lines.push({ type: 'tool/result', seq: 5, time: created + 3100, data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '文件内容摘要' }] } } });
  }
  lines.push({ type: 'system/message', seq: 6, time: created + 3200, data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示' }] } } });
  if (title) lines.push({ type: 'session/title', seq: 7, time: created + 3300, data: { title } });
  return lines;
}

/** 把文本切成多帧 zstd 并写入文件（模拟 DSH 真实多帧格式） */
function writeMultiFrameSession(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  if (!HAS_ZSTD) {
    // 无 zstd：退化为单帧（Node zlib 可解）以便仍能测试 header
    const zlib = require('node:zlib');
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
    return;
  }
  const splitAt = text.indexOf('\n', Math.floor(text.length / 2));
  const first = text.slice(0, splitAt + 1);
  const second = text.slice(splitAt + 1);
  const frame1 = execFileSync('zstd', ['-c', '-q'], { input: Buffer.from(first, 'utf8'), maxBuffer: 8 * 1024 * 1024 });
  const frame2 = execFileSync('zstd', ['-c', '-q'], { input: Buffer.from(second, 'utf8'), maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(file, Buffer.concat([frame1, frame2]));
}

function sessionPath(dshHome, workspaceDir, id) {
  return path.join(dshHome, 'sessions', workspaceDir, id, 'session.v4.jsonl.zstd');
}

const FIXTURE_DUMP = `# == @deepseek-ai/dsh-base
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager'
  disabled: !!js '!ctx.get(''profileContext'')'
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: zijian
    model: deepseek/deepseek-v4.1-flash
# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-headless
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      zijian:
        displayName: 自建
        apiKeyEnv: MY_LLM_API_KEY
        api: openai-responses
        baseURL: https://example.invalid/v1
        models:
          - id: deepseek/deepseek-v4.1-flash
            name: deepseek/deepseek-v4.1-flash
            contextWindow: 1048576
      chat:
        displayName: 自建chat
        api: openai-completions
        models:
          - id: global:fast
            name: global:fast
- id: disabled-plugin
  name: '@deepseek-ai/dsh-disabled-example'
  disabled: true
- id: jobs
  name: '@deepseek-ai/dsh-jobs'
`;

/* ---------------- 单元测试 ---------------- */

function testParseDumpConfig() {
  const group = 'capabilities 解析';
  const parsed = parseDumpConfig(FIXTURE_DUMP);
  rec(group, 'plugins 提取 id/name/disabled（仅字面 true 视为禁用）', parsed.plugins.length === 6 && parsed.plugins[0].id === 'timer' && parsed.plugins.find((p) => p.id === 'disabled-plugin')?.disabled === true && parsed.plugins.find((p) => p.id === 'plugin-manager')?.disabled === false, parsed.plugins.map((p) => `${p.id}${p.disabled ? '(off)' : ''}`).join(','));
  rec(group, 'defaultModel 解析', parsed.defaultModel?.provider === 'zijian' && parsed.defaultModel?.model === 'deepseek/deepseek-v4.1-flash', JSON.stringify(parsed.defaultModel));
  rec(group, 'providers 与模型列表', parsed.providers.length === 2 && parsed.providers[0].name === 'zijian' && parsed.providers[0].models.length === 1 && parsed.providers[1].models[0].id === 'global:fast', JSON.stringify(parsed.providers.map((p) => `${p.name}:${p.models.map((m) => m.id).join('|')}`)));
  rec(group, '不返回密钥名/内部地址', !JSON.stringify(parsed).includes('MY_LLM_API_KEY') && !JSON.stringify(parsed).includes('example.invalid'), 'sanitized');
  rec(group, '空输入不抛异常', parseDumpConfig('').plugins.length === 0 && parseDumpConfig(null).providers.length === 0);
}

function testExtractMeta() {
  const group = '会话元信息';
  const stat = { mtimeMs: 1793000000000, size: 1234 };
  const presetLines = eventsFor('session-preset-1', { cwd: EXISTING_CWD, preset: 'standard', title: '带预设的会话', withTools: true });
  const headerPreset = presetLines[0];
  const metaPreset = extractSessionMeta({ header: headerPreset, events: presetLines, stat, decode: 'zstd-cli', historyAvailable: true });
  rec(group, 'agentPreset 存在 → resumable=false', metaPreset.agentPreset === 'standard' && metaPreset.resumable === false, JSON.stringify({ preset: metaPreset.agentPreset, resumable: metaPreset.resumable }));
  rec(group, '├ title/model/messageCount/lastMessage', metaPreset.title === '带预设的会话' && metaPreset.model?.provider === 'p1' && metaPreset.messageCount === 2 && metaPreset.lastMessage.includes('助手回复内容'), JSON.stringify({ title: metaPreset.title, model: metaPreset.model, count: metaPreset.messageCount }));
  rec(group, '└ workspace 取自 cwd 尾段', metaPreset.workspace === path.basename(EXISTING_CWD) && metaPreset.cwd === EXISTING_CWD, metaPreset.workspace);

  const noPreset = eventsFor('session-plain-1', { cwd: EXISTING_CWD });
  const metaPlain = extractSessionMeta({ header: noPreset[0], events: noPreset, stat, decode: 'zstd-cli', historyAvailable: true });
  rec(group, '无 preset + cwd 存在 → resumable=true', metaPlain.agentPreset === null && metaPlain.resumable === true, JSON.stringify({ preset: metaPlain.agentPreset, resumable: metaPlain.resumable }));
  const missing = eventsFor('session-missing-1', { cwd: MISSING_CWD });
  const metaMissing = extractSessionMeta({ header: missing[0], events: missing, stat, decode: 'zstd-cli', historyAvailable: true });
  rec(group, 'cwd 不存在 → resumable=false', metaMissing.resumable === false, `cwd=${metaMissing.cwd}`);
  const headerOnly = extractSessionMeta({ header: noPreset[0], events: [noPreset[0]], stat, decode: 'header-only', historyAvailable: false });
  rec(group, 'historyAvailable=false 透传', headerOnly.historyAvailable === false && headerOnly.messageCount === 0, JSON.stringify({ history: headerOnly.historyAvailable, count: headerOnly.messageCount }));
}

function testMapMessages() {
  const group = '消息映射';
  const lines = eventsFor('session-tools-1', { cwd: EXISTING_CWD, withTools: true });
  const mapped = mapMessages(lines, { limit: 100 });
  rec(group, 'user/assistant/tool 映射且跳过 system', mapped.messages.map((m) => m.role).join(',') === 'user,assistant,tool', mapped.messages.map((m) => m.role).join(','));
  rec(group, 'tool 含名称与参数摘要', mapped.messages[2].tool === 'read' && mapped.messages[2].text.includes('/tmp/a.txt'), JSON.stringify(mapped.messages[2]));
  rec(group, 'tool/result 合并进同 callId 的 tool', typeof mapped.messages[2].result === 'string' && mapped.messages[2].result.includes('文件内容摘要'), mapped.messages[2].result);
  rec(group, 'assistant 带模型信息', mapped.messages[1].model === 'p1/m1', mapped.messages[1].model);

  const many = [];
  for (let i = 0; i < 300; i += 1) many.push({ type: 'user/message', time: i, data: { content: [{ type: 'text', text: `m${i}` }] } });
  const limited = mapMessages(many, { limit: 50 });
  rec(group, 'limit 取最近 N 条且保持顺序', limited.messages.length === 50 && limited.messages[49].text === 'm299' && limited.messages[0].text === 'm250' && limited.total === 300, `${limited.messages[0].text}..${limited.messages[49].text}`);
}

function testWorkspaceDecode() {
  const group = 'workspace';
  rec(group, '目录名解码（~hex → 字符）', decodeWorkspaceName('--home-user-~9879~76EE~6A21~677F--') === '/home/user/project', decodeWorkspaceName('--home-user-~9879~76EE~6A21~677F--'));
  rec(group, '普通 ASCII 目录名', decodeWorkspaceName('--home-user-project--') === '/home/user/project');
}

/* ---------------- Catalog ---------------- */

async function testCatalog(dshHome) {
  const group = '会话目录';
  const catalog = new SessionCatalog({ dshHome });
  const list = await catalog.list({ limit: 50 });
  rec(group, '多帧 zstd 全量解码成功', list.historyDecode === (HAS_ZSTD ? 'zstd-cli' : 'header-only') && list.sessions.length === 4, `decode=${list.historyDecode} sessions=${list.sessions.length}`);
  const preset = list.sessions.find((s) => s.id === 'session-preset-1');
  const plain = list.sessions.find((s) => s.id === 'session-plain-1');
  rec(group, '字段完整（cwd/title/model/resumable/historyAvailable）', Boolean(preset) && preset.resumable === false && preset.title === '带预设的会话' && preset.model?.provider === 'p1' && preset.historyAvailable === true, JSON.stringify(preset));
  rec(group, '无 preset 会话可续聊', Boolean(plain) && plain.resumable === true && plain.agentPreset === null, JSON.stringify({ resumable: plain?.resumable }));
  const sorted = list.sessions.every((s, i) => i === 0 || list.sessions[i - 1].updatedAt >= s.updatedAt);
  rec(group, '按 updatedAt 倒序', sorted);

  const capped = await catalog.list({ limit: 999 });
  rec(group, 'limit 上限 200', capped.sessions.length <= 200 && capped.sessions.length === list.sessions.length, `len=${capped.sessions.length}`);

  const search = await catalog.list({ q: '第一条用户消息' });
  rec(group, 'q 命中首条用户消息', search.sessions.length === 4, `hits=${search.sessions.length}`);
  const byTitle = await catalog.list({ q: '带预设' });
  rec(group, 'q 命中标题', byTitle.sessions.length === 1 && byTitle.sessions[0].id === 'session-preset-1');
  const workspaceFilter = await catalog.list({ workspace: path.basename(EXISTING_CWD) });
  rec(group, 'workspace 过滤', workspaceFilter.sessions.length >= 1 && workspaceFilter.sessions.every((s) => s.workspace === path.basename(EXISTING_CWD)), `hits=${workspaceFilter.sessions.length}`);

  const decodesBefore = catalog.stats.decodes;
  await catalog.list({ limit: 50 });
  rec(group, 'mtime/size 缓存命中（不重复解码）', catalog.stats.decodes === decodesBefore && catalog.stats.cacheHits > 0, `decodes=${catalog.stats.decodes} hits=${catalog.stats.cacheHits}`);

  const history = await catalog.messages('session-preset-1', { limit: 200 });
  rec(group, '历史消息映射', Boolean(history) && history.messages.length >= 2 && history.messages[0].role === 'user' && history.historyAvailable === true, `messages=${history?.messages?.length}`);
  rec(group, '不存在会话 → null', (await catalog.messages('session-nope-0')) === null);

  const headerOnlyCatalog = new SessionCatalog({ dshHome, zstdBin: '' });
  const headerOnlyList = await headerOnlyCatalog.list({ limit: 10 });
  rec(group, 'zstd 缺失 → header-only + historyAvailable=false', headerOnlyList.historyDecode === 'header-only' && headerOnlyList.sessions.every((s) => s.historyAvailable === false), `decode=${headerOnlyList.historyDecode}`);
  const headerOnlyMessages = await headerOnlyCatalog.messages('session-plain-1');
  rec(group, '└ 无 zstd 时历史为空', headerOnlyMessages.historyAvailable === false && headerOnlyMessages.messages.length === 0);
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

function writeFakeDsh(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'fake-dsh-sessions.sh');
  const dumpFile = path.join(dir, 'dump.yml');
  fs.writeFileSync(dumpFile, FIXTURE_DUMP);
  fs.writeFileSync(
    script,
    `#!/bin/sh
case "$*" in
  *--dump-config*) cat ${JSON.stringify(dumpFile)}; exit 0 ;;
  *--version*) echo "0.2.1-test"; exit 0 ;;
esac
echo '{"type":"session","sessionId":"session-panel-1"}'
echo '{"type":"final","text":"ok"}'
exit 0
`,
    { mode: 0o755 }
  );
  fs.chmodSync(script, 0o755);
  return script;
}

async function spawnPanel(prepared) {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
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

function preparePanel(name, dshHome, fakeBin) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const emptyDist = path.join(TMP_ROOT, 'dist-empty');
  fs.mkdirSync(emptyDist, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const config = {
    panel: { title: '会话目录测试', username: 'admin', passwordHash: hashPassword(PASSWORD, salt), passwordSalt: salt, mustChangePassword: false },
    session: { secret: crypto.randomBytes(32).toString('hex'), ttlSeconds: 12 * 60 * 60 },
    sampleIntervalMs: 1000,
    alerts: { enabled: false },
    backup: { auto: false, keep: 2, hour: 4 },
    appUpdate: { distDir: emptyDist },
    dsh: {
      allowTask: true,
      bin: fakeBin,
      home: dshHome,
      patch: '',
      credentialsFile: '',
      profile: 'headless',
      taskTimeoutMs: 15000,
      taskPatches: [],
      cwd: dir,
    },
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, configPath, dataDir: path.join(dir, 'data') };
}

async function testApi(inst, client) {
  const group = '会话 API';
  let res = await client.call('/api/dsh/sessions?limit=10');
  rec(group, 'GET /api/dsh/sessions 返回目录', res.status === 200 && Array.isArray(res.body.sessions) && res.body.sessions.length === 4 && typeof res.body.historyDecode === 'string', `sessions=${res.body?.sessions?.length} decode=${res.body?.historyDecode}`);
  rec(group, '├ 包含 resumable/agentPreset/title/model', res.body.sessions.some((s) => s.id === 'session-preset-1' && s.resumable === false && s.agentPreset === 'standard') && res.body.sessions.some((s) => s.id === 'session-plain-1' && s.resumable === true), 'fields ok');
  res = await client.call('/api/dsh/sessions?q=带预设');
  rec(group, 'q 过滤', res.body.sessions.length === 1 && res.body.sessions[0].id === 'session-preset-1');

  res = await client.call('/api/dsh/sessions/session-preset-1/messages?limit=200');
  rec(group, 'GET 历史消息', res.status === 200 && res.body.historyAvailable === true && res.body.messages.length >= 2 && res.body.session.id === 'session-preset-1', `messages=${res.body?.messages?.length}`);
  res = await client.call('/api/dsh/sessions/session-nope-0/messages');
  rec(group, '不存在会话 → 404', res.status === 404 && res.body.error === 'dsh_session_not_found');

  res = await client.call('/api/dsh/capabilities');
  rec(group, 'GET /api/dsh/capabilities 解析 dump-config', res.status === 200 && res.body.ok === true && res.body.profile === 'headless' && res.body.plugins.length === 6 && res.body.defaultModel?.provider === 'zijian' && res.body.providers.length === 2, JSON.stringify({ ok: res.body?.ok, plugins: res.body?.plugins?.length, providers: res.body?.providers?.length }));
  rec(group, '├ allowTask/taskPatches/historyDecode/dshVersion', res.body.allowTask === true && Array.isArray(res.body.taskPatches) && res.body.historyDecode === (HAS_ZSTD ? 'zstd-cli' : 'header-only') && /0\.2\.1/.test(res.body.dshVersion || ''), JSON.stringify({ allowTask: res.body?.allowTask, decode: res.body?.historyDecode, version: res.body?.dshVersion }));
  rec(group, '└ 不含密钥名/内部地址', !res.text.includes('MY_LLM_API_KEY') && !res.text.includes('example.invalid'), 'sanitized');

  // 导入可续聊会话
  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { dshSessionId: 'session-plain-1' } });
  rec(group, '导入 resumable=true 会话成功', res.status === 200 && typeof res.body.id === 'string', JSON.stringify(res.body));
  const imported = res.body.id;
  let detail = await client.call(`/api/dsh/chat/sessions/${imported}`);
  rec(group, '├ 绑定 cwd 与 DSH 标题', detail.body.session.cwd === EXISTING_CWD && detail.body.session.dshSessionId === 'session-plain-1' && detail.body.session.title === '普通会话', JSON.stringify({ cwd: detail.body.session.cwd, title: detail.body.session.title }));
  rec(group, '└ GET 增加 boundDsh（resumable/agentPreset/cwd）', detail.body.boundDsh?.resumable === true && detail.body.boundDsh?.agentPreset === null && detail.body.boundDsh?.cwd === EXISTING_CWD, JSON.stringify(detail.body.boundDsh));

  // 不可续聊
  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { dshSessionId: 'session-preset-1' } });
  rec(group, '导入带 agentPreset 会话 → 400 dsh_session_not_resumable', res.status === 400 && res.body.error === 'dsh_session_not_resumable' && /agent preset: standard/.test(res.body.detail || '') && res.body.agentPreset === 'standard', JSON.stringify(res.body));

  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { dshSessionId: 'session-doesnotexist' } });
  rec(group, '导入不存在会话 → 404', res.status === 404 && res.body.error === 'dsh_session_not_found');

  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { cwd: MISSING_CWD } });
  rec(group, 'cwd 不存在 → 400 cwd_invalid', res.status === 400 && res.body.error === 'cwd_invalid', JSON.stringify(res.body));
  res = await client.call('/api/dsh/chat/sessions', { method: 'POST', body: { cwd: EXISTING_CWD } });
  rec(group, 'cwd 合法 → 创建成功并保存', res.status === 200 && typeof res.body.id === 'string');
  detail = await client.call(`/api/dsh/chat/sessions/${res.body.id}`);
  rec(group, '└ 会话 cwd 已保存', detail.body.session.cwd === EXISTING_CWD);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('\n══════ DSH 会话目录 / 历史 / 能力 测试 ══════');
  console.log(`临时目录：${TMP_ROOT}   zstd=${HAS_ZSTD ? findBinary('zstd') : '缺失（header-only）'}`);

  testParseDumpConfig();
  testExtractMeta();
  testMapMessages();
  testWorkspaceDecode();

  // 构造真实 DSH home fixture（4 个会话：preset / 普通 / cwd 缺失 / 工具调用）
  const dshHome = path.join(TMP_ROOT, 'dsh-home');
  const wsA = '--tmp-work--';
  const wsB = '--tmp-missing--';
  writeMultiFrameSession(sessionPath(dshHome, wsA, 'session-preset-1'), eventsFor('session-preset-1', { cwd: EXISTING_CWD, preset: 'standard', title: '带预设的会话', withTools: true }));
  writeMultiFrameSession(sessionPath(dshHome, wsA, 'session-plain-1'), eventsFor('session-plain-1', { cwd: EXISTING_CWD, title: '普通会话' }));
  writeMultiFrameSession(sessionPath(dshHome, wsB, 'session-missing-1'), eventsFor('session-missing-1', { cwd: MISSING_CWD }));
  writeMultiFrameSession(sessionPath(dshHome, wsA, 'session-tools-1'), eventsFor('session-tools-1', { cwd: EXISTING_CWD, withTools: true }));
  // 调整 mtime，保证排序稳定（tools 最新）
  const now = Date.now();
  fs.utimesSync(sessionPath(dshHome, wsA, 'session-preset-1'), new Date(now - 30000), new Date(now - 30000));
  fs.utimesSync(sessionPath(dshHome, wsA, 'session-plain-1'), new Date(now - 20000), new Date(now - 20000));
  fs.utimesSync(sessionPath(dshHome, wsB, 'session-missing-1'), new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(sessionPath(dshHome, wsA, 'session-tools-1'), new Date(now), new Date(now));

  if (HAS_ZSTD) {
    // 验证多帧解码本身
    const decoded = await decodeSessionFile(sessionPath(dshHome, wsA, 'session-preset-1'));
    rec('解码', 'zstd -dc 解出全部多帧事件', decoded.historyAvailable === true && decoded.text.split('\n').filter(Boolean).length >= 8, `lines=${decoded.text.split('\n').filter(Boolean).length} decode=${decoded.decode}`);
  } else {
    skip('多帧解码', '未安装 zstd，已按 header-only 回退');
  }

  await testCatalog(dshHome);

  const fakeBin = writeFakeDsh(path.join(TMP_ROOT, 'fake'));
  const prepared = preparePanel('panel', dshHome, fakeBin);
  const inst = await spawnPanel(prepared);
  const client = makeClient(inst.base);
  await client.login();
  try {
    await testApi(inst, client);
  } finally {
    await inst.stop();
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
