'use strict';

/**
 * DSH 会话目录 / 历史解析 / 能力探测
 *
 * 关键事实：
 *  - 会话文件 `<dsh.home>/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd` 是**多帧 zstd**
 *    （Node zlib 的 zstdDecompressSync 只能解第一帧），因此优先用系统 `zstd -dc` 全量解码；
 *    二进制缺失时回退"只读首帧 header"并标记 historyAvailable=false。
 *  - headless 一次性 runner 拒绝 adopt 带 agentPreset 的会话（DSH Web 创建的 standard/cordis 等），
 *    因此这类会话 resumable=false：可浏览历史，但不能由面板续聊。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');

const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_DECODE_BYTES = 32 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_MESSAGES = 2000;
const MAX_TEXT = 4000;

function sessionError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || code;
  return err;
}

/** 在 PATH 中查找可执行文件（仅用于探测 zstd） */
function findBinary(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {
      /* continue */
    }
  }
  return '';
}

/** 解码结果：{text, historyAvailable, decode} */
const EMPTY_DECODE = Object.freeze({ text: '', historyAvailable: false, decode: 'unavailable' });

function decodeWithZstd(file, zstdBin, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    execFile(
      zstdBin,
      ['-dc', file],
      { timeout: timeoutMs, maxBuffer: MAX_DECODE_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

/** 回退：只解第一帧（Node zlib），仅够拿 header */
function decodeFirstFrame(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return EMPTY_DECODE;
  }
  try {
    const text = zlib.zstdDecompressSync(buf, { maxOutputLength: 1024 * 1024 }).toString('utf8');
    return { text, historyAvailable: false, decode: 'header-only' };
  } catch (e) {
    const firstLine = buf.toString('utf8').split('\n')[0] || '';
    try {
      const header = JSON.parse(firstLine);
      if (header && header.type === 'session') {
        return { text: `${firstLine}\n`, historyAvailable: false, decode: 'header-only' };
      }
    } catch (err) {
      /* ignore */
    }
    return EMPTY_DECODE;
  }
}

/**
 * 全量解码会话文件（优先 zstd CLI）。
 * @returns {Promise<{text:string, historyAvailable:boolean, decode:string}>}
 */
async function decodeSessionFile(file, options = {}) {
  const zstdBin = options.zstdBin === undefined ? findBinary('zstd') : options.zstdBin;
  if (!zstdBin) return decodeFirstFrame(file);
  try {
    const text = await decodeWithZstd(file, zstdBin, options.timeoutMs || 3000);
    return { text, historyAvailable: true, decode: 'zstd-cli' };
  } catch (e) {
    return decodeFirstFrame(file);
  }
}

/** 解析 JSONL 文本为事件数组（坏行跳过；超长内容截断） */
function parseEvents(text) {
  const events = [];
  if (typeof text !== 'string' || !text) return events;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === 'object') events.push(event);
    } catch (e) {
      /* 坏行跳过 */
    }
    if (events.length >= 20000) break;
  }
  return events;
}

/** 从内容块数组中拼接文本（兼容 {type:'text',text} / string） */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function preview(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 从目录名解码 workspace（`--home-hb-~670D...--` 形式），失败回退 */
function decodeWorkspaceName(dirName) {
  const raw = String(dirName || '');
  const trimmed = raw.replace(/^--+|-+$/g, '');
  if (!trimmed) return '';
  const decoded = trimmed
    .replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/-/g, '/');
  return decoded.startsWith('/') ? decoded : `/${decoded}`;
}

/** 从事件里取 agentPreset（header 优先，其次 agent-preset/selected 等事件） */
function extractAgentPreset(header, events) {
  if (header && typeof header.agentPreset === 'string' && header.agentPreset) return header.agentPreset;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || typeof event.type !== 'string') continue;
    if (!/agent[-_/]preset|agentPreset/i.test(event.type)) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const value = data.preset || data.name || data.agentPreset || event.preset;
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/** 从事件里取最后选择的模型 */
function extractModel(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'model/selection') continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (typeof data.provider === 'string' && typeof data.model === 'string') {
      return { provider: data.provider, model: data.model };
    }
  }
  // 兜底：最后一条 assistant/message 的 source
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'assistant/message') continue;
    const source = event.data?.message?.source;
    if (source && typeof source.provider === 'string' && typeof source.model === 'string') {
      return { provider: source.provider, model: source.model };
    }
  }
  return null;
}

/** 从事件里取标题 */
function extractTitle(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'session/title') continue;
    const title = event.data && typeof event.data.title === 'string' ? event.data.title.trim() : '';
    if (title) return title;
  }
  return '';
}

/** 首条用户消息（供搜索） */
function firstUserText(events) {
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue;
    const text = contentText(event.data?.content);
    if (text) return text;
  }
  return '';
}

/**
 * 从 header + 事件 + stat 生成会话元信息。
 * @param {{header:object, events:Array, stat:{mtimeMs:number,size:number}, decode?:string, historyAvailable?:boolean,
 *          workspaceDir?:string, cwdExists?:Function}} input
 */
function extractSessionMeta(input) {
  const { header, events, stat } = input;
  const decode = input.decode || 'header-only';
  const historyAvailable = input.historyAvailable === true;
  const cwd = typeof header?.cwd === 'string' ? header.cwd : '';
  const agentPreset = extractAgentPreset(header || {}, events || []);
  const model = extractModel(events || []);
  const title = extractTitle(events || []);

  let messageCount = 0;
  let lastAssistant = '';
  let firstUser = '';
  for (const event of events || []) {
    if (!event) continue;
    if (event.type === 'user/message') {
      messageCount += 1;
      if (!firstUser) firstUser = contentText(event.data?.content);
    } else if (event.type === 'assistant/message') {
      messageCount += 1;
      lastAssistant = contentText(event.data?.message?.content || event.data?.content);
    }
  }

  const cwdExists = typeof input.cwdExists === 'function'
    ? input.cwdExists
    : (value) => {
        try {
          return fs.statSync(value).isDirectory();
        } catch (e) {
          return false;
        }
      };
  const workspace = path.basename(cwd) || decodeWorkspaceName(input.workspaceDir || '') || '';

  return {
    id: typeof header?.id === 'string' && header.id ? header.id : path.basename(path.dirname(input.file || '')),
    cwd,
    workspace,
    createdAt: Number(header?.createdAt) || Math.round(stat?.birthtimeMs || stat?.ctimeMs || 0),
    updatedAt: Math.round(stat?.mtimeMs || 0),
    sizeBytes: Number(stat?.size) || 0,
    agentPreset: agentPreset || null,
    title: title || (firstUser ? preview(firstUser, 40) : ''),
    model,
    messageCount,
    lastMessage: preview(lastAssistant, 120),
    firstUserMessage: firstUser,
    // 无 agent preset 且 cwd 仍存在 → 面板可用 --session-id 续聊
    resumable: !agentPreset && Boolean(cwd) && cwdExists(cwd),
    historyAvailable,
    decode,
  };
}

/** 事件 → 聊天消息映射 */
function mapMessages(events, options = {}) {
  const limit = Math.min(MAX_MESSAGES, Math.max(1, Math.trunc(Number(options.limit)) || 200));
  const out = [];
  for (const event of events || []) {
    if (!event || typeof event.type !== 'string') continue;
    const ts = Number.isFinite(event.time) ? event.time : undefined;
    if (event.type === 'user/message') {
      const text = contentText(event.data?.content).slice(0, MAX_TEXT);
      if (text) out.push({ role: 'user', text, ...(ts ? { ts } : {}), ...(event.data?.id ? { id: event.data.id } : {}) });
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content || event.data?.content).slice(0, MAX_TEXT);
      const source = event.data?.message?.source;
      out.push({
        role: 'assistant',
        text,
        ...(ts ? { ts } : {}),
        ...(source && source.provider ? { model: `${source.provider}/${source.model || ''}`.replace(/\/$/, '') } : {}),
      });
    } else if (event.type === 'tool/call') {
      const name = typeof event.data?.name === 'string' ? event.data.name : 'tool';
      const args = typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments || {});
      out.push({
        role: 'tool',
        tool: name,
        text: preview(args, 120),
        callId: event.data?.callId || null,
        ...(ts ? { ts } : {}),
      });
    } else if (event.type === 'tool/result') {
      const callId = event.data?.toolCallId || event.data?.message?.toolCallId || null;
      const text = preview(contentText(event.data?.message?.content || event.data?.content), 120);
      // 并入上一条同 callId 的 tool 消息（没有则单独成条）
      let merged = false;
      if (callId) {
        for (let i = out.length - 1; i >= 0; i -= 1) {
          if (out[i].role === 'tool' && out[i].callId === callId) {
            out[i].result = text;
            merged = true;
            break;
          }
        }
      }
      if (!merged && text) out.push({ role: 'tool', tool: 'result', text, ...(ts ? { ts } : {}) });
    }
    if (out.length > MAX_MESSAGES * 2) break;
  }
  const messages = out.slice(-limit);
  return { messages, total: out.length };
}

/* ---------------- 能力探测（dump-config 解析） ---------------- */

function unquote(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  return text;
}

/**
 * 解析 `dsh --profile headless --dump-config` 输出（简单行扫描，不引 YAML 依赖）。
 * 提取：plugins[{id,name,disabled}]、defaultModel{provider,model}、providers[{name,displayName,api,models:[{id,name}]}]
 */
function parseDumpConfig(text) {
  const lines = String(text || '').split('\n');
  const plugins = [];
  const providers = new Map();
  let defaultModel = null;
  let currentPlugin = null;
  const blocks = new Map(); // id -> lines

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^- id:\s*(.+)$/.exec(line);
    if (match) {
      currentPlugin = { id: unquote(match[1]), name: '', disabled: false };
      plugins.push(currentPlugin);
      blocks.set(currentPlugin.id, []);
      continue;
    }
    if (/^# ==/.test(line)) {
      currentPlugin = null;
      continue;
    }
    if (!currentPlugin) continue;
    const nameMatch = /^ {2}name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      currentPlugin.name = unquote(nameMatch[1]);
      continue;
    }
    const disabledMatch = /^ {2}disabled:\s*(.+)$/.exec(line);
    if (disabledMatch) {
      currentPlugin.disabled = unquote(disabledMatch[1]) === 'true';
      continue;
    }
    if (/^ {2}config:/.test(line)) {
      blocks.get(currentPlugin.id).push(line);
      // 收集 config 子块（缩进 > 2），直到下一个 plugin / 注释
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (/^- id:/.test(next) || /^# ==/.test(next) || /^ {0,2}[A-Za-z]/.test(next)) break;
        blocks.get(currentPlugin.id).push(next);
        j += 1;
      }
      i = j - 1;
    }
  }

  // 默认模型
  const defaultLines = blocks.get('agent-default-model') || [];
  let provider = '';
  let model = '';
  for (const line of defaultLines) {
    const p = /^ {4}provider:\s*(.+)$/.exec(line);
    if (p) provider = unquote(p[1]);
    const m = /^ {4}model:\s*(.+)$/.exec(line);
    if (m) model = unquote(m[1]);
  }
  if (provider && model) defaultModel = { provider, model };

  // llm-pi-ai providers
  const llmLines = blocks.get('llm-pi-ai') || [];
  let currentProvider = null;
  let currentModel = null;
  for (const line of llmLines) {
    if (/^ {4}providers:\s*$/.test(line)) continue;
    const providerMatch = /^ {6}([A-Za-z0-9_.:@-]+):\s*$/.exec(line);
    if (providerMatch) {
      const name = providerMatch[1];
      currentProvider = { name, displayName: '', api: '', models: [] };
      providers.set(name, currentProvider);
      currentModel = null;
      continue;
    }
    if (!currentProvider) continue;
    const field = /^ {8}(displayName|api|apiKeyEnv|baseURL):\s*(.*)$/.exec(line);
    if (field) {
      if (field[1] === 'displayName') currentProvider.displayName = unquote(field[2]);
      else if (field[1] === 'api') currentProvider.api = unquote(field[2]);
      // apiKeyEnv / baseURL 不返回（避免泄露部署细节/密钥名）
      continue;
    }
    const modelStart = /^ {10}- id:\s*(.+)$/.exec(line);
    if (modelStart) {
      currentModel = { id: unquote(modelStart[1]), name: '' };
      currentProvider.models.push(currentModel);
      continue;
    }
    const modelName = /^ {12}name:\s*(.+)$/.exec(line);
    if (modelName && currentModel) currentModel.name = unquote(modelName[1]);
  }

  return {
    plugins,
    defaultModel,
    providers: [...providers.values()],
  };
}

/**
 * 能力/插件探测（60s 缓存）。
 */
class DshCapabilities {
  /**
   * @param {{dshBin:string, profile?:string, patches?:string[], allowTask?:boolean,
   *          taskPatches?:string[], cacheMs?:number, runBounded?:Function, zstdBin?:string, logger?:object}} options
   */
  constructor(options = {}) {
    this.dshBin = options.dshBin;
    this.profile = options.profile || 'headless';
    this.patches = Array.isArray(options.patches) ? options.patches.filter(Boolean) : [];
    this.allowTask = options.allowTask === true;
    this.taskPatches = Array.isArray(options.taskPatches) ? options.taskPatches.filter(Boolean) : [];
    this.cacheMs = Number(options.cacheMs) > 0 ? Number(options.cacheMs) : 60000;
    this.runBounded = typeof options.runBounded === 'function' ? options.runBounded : require('./dsh').runBounded;
    this.zstdBin = options.zstdBin === undefined ? findBinary('zstd') : options.zstdBin;
    this.logger = options.logger || console;
    this.cache = null;
    this.versionCache = null;
  }

  get historyDecode() {
    return this.zstdBin ? 'zstd-cli' : 'header-only';
  }

  /** 实际传给 headless 的 patch 列表（只保留存在的文件） */
  effectivePatches() {
    return [...new Set([...this.patches, ...this.taskPatches].filter(Boolean))].filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch (e) {
        return false;
      }
    });
  }

  async dshVersion() {
    if (this.versionCache) return this.versionCache;
    const result = await this.runBounded(this.dshBin, ['--version'], { timeoutMs: 3000, maxBytes: 16 * 1024 });
    this.versionCache = result.ok ? String(result.stdout || result.stderr || '').trim().split('\n')[0] : null;
    return this.versionCache;
  }

  /** @returns {{ok:boolean, profile?:string, plugins?:Array, defaultModel?:object|null, providers?:Array, allowTask?:boolean, taskPatches?:string[], historyDecode?:string, dshVersion?:string|null, error?:string}} */
  async get(options = {}) {
    const force = options.force === true;
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < this.cacheMs) return this.cache.value;
    if (!this.dshBin) {
      const value = { ok: false, error: 'dsh_bin_missing', historyDecode: this.historyDecode, allowTask: this.allowTask, taskPatches: this.taskPatches };
      this.cache = { at: now, value };
      return value;
    }
    const args = ['--profile', this.profile];
    for (const patch of this.effectivePatches()) args.push('--patch', patch);
    args.push('--dump-config');
    const result = await this.runBounded(this.dshBin, args, { timeoutMs: 3000, maxBytes: 2 * 1024 * 1024 });
    if (!result.ok || !String(result.stdout || '').trim()) {
      const value = {
        ok: false,
        error: result.error === 'timeout' ? 'dump_config_timeout' : 'dump_config_failed',
        detail: String(result.stderr || '').slice(0, 300) || undefined,
        profile: this.profile,
        allowTask: this.allowTask,
        taskPatches: this.taskPatches,
        historyDecode: this.historyDecode,
      };
      this.cache = { at: now, value };
      return value;
    }
    const parsed = parseDumpConfig(result.stdout);
    const value = {
      ok: true,
      profile: this.profile,
      plugins: parsed.plugins,
      defaultModel: parsed.defaultModel,
      providers: parsed.providers,
      allowTask: this.allowTask,
      taskPatches: this.taskPatches,
      historyDecode: this.historyDecode,
      dshVersion: await this.dshVersion(),
    };
    this.cache = { at: now, value };
    return value;
  }

  /** 校验 "provider/model" 是否在当前能力内；返回 {provider, model} 或 null */
  resolveModel(spec, capabilities) {
    const value = String(spec || '').trim();
    if (!value || !value.includes('/')) return null;
    const index = value.indexOf('/');
    const providerName = value.slice(0, index);
    const modelId = value.slice(index + 1);
    const caps = capabilities || this.cache?.value || null;
    const providers = Array.isArray(caps?.providers) ? caps.providers : [];
    const provider = providers.find((item) => item.name === providerName);
    if (!provider) return null;
    const model = provider.models.find((item) => item.id === modelId);
    if (!model) return null;
    return { provider: providerName, model: modelId };
  }
}

/* ---------------- 会话目录 ---------------- */

class SessionCatalog {
  /**
   * @param {{dshHome:string, zstdBin?:string, logger?:object}} options
   */
  constructor(options = {}) {
    this.dshHome = options.dshHome;
    this.zstdBin = options.zstdBin === undefined ? findBinary('zstd') : options.zstdBin;
    this.logger = options.logger || console;
    this.cache = new Map(); // file -> {mtimeMs,size,meta}
    this.stats = { decodes: 0, cacheHits: 0 };
  }

  get historyDecode() {
    return this.zstdBin ? 'zstd-cli' : 'header-only';
  }

  _sessionFiles() {
    const root = path.join(this.dshHome, 'sessions');
    const files = [];
    let workspaces = [];
    try {
      workspaces = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      return files;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(root, workspace.name);
      let sessions = [];
      try {
        sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      for (const session of sessions) {
        if (!session.isDirectory() || !session.name.startsWith('session-')) continue;
        const file = path.join(workspaceDir, session.name, SESSION_FILE);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch (e) {
          continue;
        }
        if (!stat.isFile()) continue;
        files.push({ file, stat, workspaceDir: workspace.name });
      }
    }
    return files;
  }

  async _metaFor(entry, options = {}) {
    const cached = this.cache.get(entry.file);
    if (cached && cached.mtimeMs === entry.stat.mtimeMs && cached.size === entry.stat.size && options.force !== true) {
      this.stats.cacheHits += 1;
      return cached.meta;
    }
    const decoded = await decodeSessionFile(entry.file, { zstdBin: this.zstdBin });
    this.stats.decodes += 1;
    const events = parseEvents(decoded.text);
    const header = events.find((event) => event && event.type === 'session') || null;
    if (!header) {
      const meta = null;
      this.cache.set(entry.file, { mtimeMs: entry.stat.mtimeMs, size: entry.stat.size, meta });
      return meta;
    }
    const meta = extractSessionMeta({
      header,
      events,
      stat: entry.stat,
      decode: decoded.decode,
      historyAvailable: decoded.historyAvailable,
      workspaceDir: entry.workspaceDir,
      file: entry.file,
    });
    this.cache.set(entry.file, { mtimeMs: entry.stat.mtimeMs, size: entry.stat.size, meta });
    return meta;
  }

  /**
   * 会话目录列表。
   * @param {{limit?:number, q?:string, workspace?:string, force?:boolean}} options
   */
  async list(options = {}) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(options.limit)) || DEFAULT_LIMIT));
    const q = String(options.q || '').trim().toLowerCase();
    const workspaceFilter = String(options.workspace || '').trim().toLowerCase();
    const entries = this._sessionFiles();
    // 无搜索条件时只解码最新的 2×limit 个（首次列表更快），total 用文件数表示
    const filteredMode = Boolean(q || workspaceFilter) || options.force === true;
    const candidates = filteredMode
      ? entries
      : [...entries].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, Math.min(entries.length, limit * 2));
    const metas = [];
    for (const entry of candidates) {
      const meta = await this._metaFor(entry, options);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    let filtered = metas;
    if (workspaceFilter) {
      filtered = filtered.filter((meta) => String(meta.workspace || '').toLowerCase() === workspaceFilter || String(meta.cwd || '').toLowerCase().includes(workspaceFilter));
    }
    if (q) {
      filtered = filtered.filter((meta) =>
        `${meta.title || ''} ${meta.cwd || ''} ${meta.firstUserMessage || ''} ${meta.id}`.toLowerCase().includes(q)
      );
    }
    const page = filtered.slice(0, limit);
    const total = filteredMode ? filtered.length : entries.length;
    return {
      sessions: page.map((meta) => ({
        id: meta.id,
        cwd: meta.cwd,
        workspace: meta.workspace,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        sizeBytes: meta.sizeBytes,
        agentPreset: meta.agentPreset,
        title: meta.title,
        model: meta.model,
        messageCount: meta.messageCount,
        lastMessage: meta.lastMessage,
        resumable: meta.resumable,
        historyAvailable: meta.historyAvailable,
      })),
      total,
      truncated: total > page.length,
      historyDecode: this.historyDecode,
    };
  }

  /** 按 id 找会话元信息（不存在返回 null） */
  async get(id) {
    const target = String(id || '');
    if (!/^session-[A-Za-z0-9_-]{1,80}$/.test(target)) return null;
    for (const entry of this._sessionFiles()) {
      if (path.basename(path.dirname(entry.file)) !== target) continue;
      return this._metaFor(entry);
    }
    return null;
  }

  /**
   * 读取会话历史消息。
   * @returns {Promise<{session:object, messages:Array, historyAvailable:boolean, total:number}|null>}
   */
  async messages(id, options = {}) {
    const target = String(id || '');
    if (!/^session-[A-Za-z0-9_-]{1,80}$/.test(target)) return null;
    for (const entry of this._sessionFiles()) {
      if (path.basename(path.dirname(entry.file)) !== target) continue;
      const meta = await this._metaFor(entry);
      if (!meta) return null;
      if (!this.zstdBin) {
        return { session: meta, messages: [], historyAvailable: false, total: 0 };
      }
      const decoded = await decodeSessionFile(entry.file, { zstdBin: this.zstdBin });
      if (!decoded.historyAvailable) {
        return { session: meta, messages: [], historyAvailable: false, total: 0 };
      }
      const events = parseEvents(decoded.text);
      const mapped = mapMessages(events, { limit: options.limit });
      return { session: meta, messages: mapped.messages, historyAvailable: true, total: mapped.total };
    }
    return null;
  }
}

module.exports = {
  SessionCatalog,
  DshCapabilities,
  decodeSessionFile,
  decodeFirstFrame,
  parseEvents,
  parseDumpConfig,
  extractSessionMeta,
  mapMessages,
  contentText,
  decodeWorkspaceName,
  extractAgentPreset,
  findBinary,
  SESSION_FILE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
