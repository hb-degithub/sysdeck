'use strict';

/**
 * App 原生聊天后端：会话/消息持久化 + 与 DshTaskManager 对接
 *
 * 存储：<DATA_DIR>/dsh-chat.json（0600、原子写、≤5MB、最多 100 会话 × 每会话 500 条）
 * 结构：{version:1, sessions:[{id,title,createdAt,updatedAt,dshSessionId,
 *        messages:[{id,role,text,ts,status,taskId?,error?}]}]}
 *
 * 设计：
 *  - 消息先落库（user=ok，assistant=running），任务结束后回填 assistant（ok/error）
 *  - 任务事件里的 sessionId 会写回会话的 dshSessionId，下一条消息用 --session-id 续聊
 *  - 进程重启时，遗留的 running 消息标记为 error（任务已随进程中断）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHAT_FILE = 'dsh-chat.json';
const MAX_SESSIONS = 100;
const MAX_MESSAGES = 500;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const SESSION_ID_RE = /^chat-[A-Za-z0-9_-]{1,60}$/;
const ROLES = new Set(['user', 'assistant', 'system']);
const STATUSES = new Set(['ok', 'error', 'running']);

function chatError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || code;
  return err;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function textPreview(text, max = 60) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 从 dsh NDJSON 事件里提取 sessionId（兼容多种字段位置） */
function pickSessionId(event) {
  if (!event || typeof event !== 'object') return null;
  const direct = event.sessionId || event.session_id;
  if (typeof direct === 'string' && direct) return direct;
  if (event.session && typeof event.session === 'object' && typeof event.session.id === 'string') return event.session.id;
  if (event.data && typeof event.data === 'object') {
    const nested = event.data.sessionId || event.data.session_id;
    if (typeof nested === 'string' && nested) return nested;
  }
  return null;
}

class ChatStore {
  /**
   * @param {{dataDir?:string, maxSessions?:number, maxMessages?:number, warn?:Function}} options
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir ? path.resolve(String(options.dataDir)) : '';
    this.file = this.dataDir ? path.join(this.dataDir, CHAT_FILE) : '';
    this.maxSessions = Math.min(1000, Math.max(1, Math.trunc(options.maxSessions) || MAX_SESSIONS));
    this.maxMessages = Math.min(5000, Math.max(1, Math.trunc(options.maxMessages) || MAX_MESSAGES));
    this.warn = typeof options.warn === 'function' ? options.warn : (msg) => console.warn(msg);
    this.sessions = [];
    this._writeTimer = null;
    if (this.file) this.load();
  }

  get size() {
    return this.sessions.length;
  }

  /** 启动加载：损坏/超限忽略并 warn，running 消息标记为中断 */
  load() {
    this.sessions = [];
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      this.warn('[chat] dsh-chat.json 无效或超过 5MB，已忽略');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.warn('[chat] dsh-chat.json 解析失败，已忽略');
      return;
    }
    const raw = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    let repaired = false;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id !== 'string' || !SESSION_ID_RE.test(item.id)) continue;
      const messages = [];
      for (const msg of Array.isArray(item.messages) ? item.messages : []) {
        if (!msg || typeof msg !== 'object') continue;
        if (!ROLES.has(msg.role) || typeof msg.text !== 'string') continue;
        let status = STATUSES.has(msg.status) ? msg.status : 'ok';
        if (status === 'running') {
          status = 'error';
          repaired = true;
        }
        messages.push({
          id: typeof msg.id === 'string' ? msg.id : newId('msg'),
          role: msg.role,
          text: msg.text.slice(0, MAX_TEXT_BYTES),
          ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(),
          status,
          ...(typeof msg.taskId === 'string' ? { taskId: msg.taskId } : {}),
          ...(typeof msg.error === 'string' ? { error: msg.error.slice(0, 2000) } : {}),
        });
      }
      this.sessions.push({
        id: item.id,
        title: typeof item.title === 'string' ? item.title.slice(0, 120) : '',
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
        dshSessionId: typeof item.dshSessionId === 'string' ? item.dshSessionId : null,
        channel: item.channel === 'sdk' ? 'sdk' : 'headless',
        cwd: typeof item.cwd === 'string' && item.cwd ? item.cwd : '',
        messages: messages.slice(-this.maxMessages),
      });
    }
    this._enforceLimits();
    if (repaired) this._markDirty();
  }

  _serialize() {
    return JSON.stringify({
      version: 1,
      sessions: this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        dshSessionId: s.dshSessionId,
        channel: s.channel || 'headless',
        cwd: s.cwd || '',
        messages: s.messages,
      })),
    });
  }

  _markDirty() {
    if (!this.file || this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, 500);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  /** 立即落盘（0600 原子写）；超过 5MB 时淘汰最旧会话/消息 */
  flush() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      let json = this._serialize();
      let guard = 0;
      while (Buffer.byteLength(json, 'utf8') > MAX_BYTES && guard < 500) {
        guard += 1;
        this._enforceLimits();
        const oldest = this._oldestSession();
        if (!oldest) break;
        if (oldest.messages.length > 1) {
          oldest.messages.shift();
        } else {
          this.sessions = this.sessions.filter((s) => s !== oldest);
        }
        json = this._serialize();
      }
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch (e) {
        /* ignore */
      }
      return true;
    } catch (e) {
      this.warn(`[chat] dsh-chat.json 写入失败: ${e.code || e.message}`);
      return false;
    }
  }

  close() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this.flush();
  }

  _enforceLimits() {
    // 每会话消息上限（保留最新）
    for (const session of this.sessions) {
      if (session.messages.length > this.maxMessages) {
        session.messages = session.messages.slice(-this.maxMessages);
      }
    }
    // 会话上限（保留 updatedAt 最新）
    if (this.sessions.length > this.maxSessions) {
      this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      this.sessions = this.sessions.slice(0, this.maxSessions);
    }
  }

  _oldestSession() {
    if (this.sessions.length === 0) return null;
    return [...this.sessions].sort((a, b) => a.updatedAt - b.updatedAt)[0];
  }

  _find(id) {
    return this.sessions.find((s) => s.id === String(id || '')) || null;
  }

  /** 会话标题：显式标题 → 首条用户消息摘要 → 新会话 */
  _titleOf(session) {
    if (session.title) return session.title;
    const firstUser = session.messages.find((m) => m.role === 'user' && m.text);
    return firstUser ? textPreview(firstUser.text, 24) : '新会话';
  }

  listSessions() {
    return [...this.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => {
        const last = session.messages[session.messages.length - 1];
        return {
          id: session.id,
          title: this._titleOf(session),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          lastText: last ? textPreview(last.text, 80) : '',
          messageCount: session.messages.length,
          dshSessionId: session.dshSessionId || null,
          channel: session.channel || 'headless',
          cwd: session.cwd || '',
        };
      });
  }

  /**
   * @param {string} [title]
   * @param {{cwd?:string, dshSessionId?:string}} [options]
   */
  createSession(title = '', options = {}) {
    const now = Date.now();
    const session = {
      id: newId('chat'),
      title: String(title || '').slice(0, 120),
      createdAt: now,
      updatedAt: now,
      dshSessionId: typeof options.dshSessionId === 'string' && options.dshSessionId ? options.dshSessionId : null,
      channel: options.channel === 'sdk' ? 'sdk' : 'headless',
      cwd: typeof options.cwd === 'string' && options.cwd ? options.cwd : '',
      messages: [],
    };
    this.sessions.push(session);
    this._enforceLimits();
    this._markDirty();
    return { id: session.id };
  }

  /** 会话元信息（不含消息）；不存在返回 null */
  sessionMeta(id) {
    const session = this._find(id);
    if (!session) return null;
    return {
      id: session.id,
      title: this._titleOf(session),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      dshSessionId: session.dshSessionId || null,
      channel: session.channel || 'headless',
      cwd: session.cwd || '',
      messageCount: session.messages.length,
    };
  }

  /**
   * 取消息（默认最近 200 条，before 为消息 id：返回该消息之前的更早消息）。
   * @returns {{session:object, messages:Array, hasMore:boolean}|null}
   */
  getSession(id, options = {}) {
    const session = this._find(id);
    if (!session) return null;
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(options.limit)) || 200));
    let list = session.messages;
    if (options.before) {
      const index = list.findIndex((m) => m.id === String(options.before));
      if (index > 0) list = list.slice(0, index);
      else if (index === 0) list = [];
    }
    const messages = list.slice(-limit);
    return {
      session: this.sessionMeta(id),
      messages,
      hasMore: list.length > messages.length,
    };
  }

  appendMessage(id, message) {
    const session = this._find(id);
    if (!session) throw chatError('chat_session_not_found', '会话不存在');
    const role = ROLES.has(message.role) ? message.role : 'user';
    const status = STATUSES.has(message.status) ? message.status : 'ok';
    const now = Date.now();
    const entry = {
      id: newId('msg'),
      role,
      text: String(message.text || '').slice(0, MAX_TEXT_BYTES),
      ts: now,
      status,
      ...(message.taskId ? { taskId: String(message.taskId) } : {}),
    };
    session.messages.push(entry);
    session.updatedAt = now;
    this._enforceLimits();
    this._markDirty();
    return entry;
  }

  updateMessage(sessionId, messageId, patch = {}) {
    const session = this._find(sessionId);
    if (!session) return null;
    const message = session.messages.find((m) => m.id === messageId);
    if (!message) return null;
    if (typeof patch.text === 'string') message.text = patch.text.slice(0, MAX_TEXT_BYTES);
    if (STATUSES.has(patch.status)) message.status = patch.status;
    if (typeof patch.taskId === 'string') message.taskId = patch.taskId;
    if (typeof patch.error === 'string') message.error = patch.error.slice(0, 2000);
    if (Number.isFinite(patch.exitCode)) message.exitCode = patch.exitCode;
    message.ts = Date.now();
    session.updatedAt = message.ts;
    this._markDirty();
    return message;
  }

  /** 切换会话通道（headless / sdk） */
  setChannel(id, channel) {
    const session = this._find(id);
    if (!session) return false;
    const value = channel === 'sdk' ? 'sdk' : 'headless';
    if (session.channel === value) return false;
    session.channel = value;
    session.updatedAt = Date.now();
    this._markDirty();
    return true;
  }

  setDshSessionId(id, dshSessionId) {
    const session = this._find(id);
    if (!session || typeof dshSessionId !== 'string' || !dshSessionId) return false;
    if (session.dshSessionId === dshSessionId) return false;
    session.dshSessionId = dshSessionId;
    session.updatedAt = Date.now();
    this._markDirty();
    return true;
  }

  deleteSession(id) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== String(id || ''));
    if (this.sessions.length === before) return false;
    this._markDirty();
    return true;
  }
}

/**
 * 聊天服务：把「发消息」翻译成 DSH headless 任务，并把结果写回会话。
 */
class ChatService {
  /**
   * @param {{store:ChatStore, dsh:object, audit?:Function, logger?:object}} options
   */
  constructor(options = {}) {
    this.store = options.store;
    this.dsh = options.dsh;
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    this.logger = options.logger || console;
  }

  /**
   * 发送消息并启动 headless 任务。
   * @param {string} sessionId
   * @param {string} text
   * @param {{extraPatches?:string[], tempPatches?:string[]}} [options]
   *   extraPatches: 本次任务额外 patch（如临时 model patch）
   *   tempPatches: 任务结束后需要删除的临时文件
   * @returns {{messageId:string, assistantMessageId:string, taskId:string}}
   */
  sendMessage(sessionId, text, options = {}) {
    const meta = this.store.sessionMeta(sessionId);
    if (!meta) throw chatError('chat_session_not_found', '会话不存在');
    const value = String(text === undefined || text === null ? '' : text).trim();
    if (!value) throw chatError('chat_text_required', 'text 不能为空');
    if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
      throw chatError('chat_text_too_long', `text 超过 ${MAX_TEXT_BYTES} 字节`);
    }
    if (!this.dsh || this.dsh.allowTask !== true) {
      throw chatError('dsh_task_disabled', '需在 config.json 开启 dsh.allowTask');
    }
    // 单并发：先检查再落库，避免被拒绝的消息留下脏记录
    if (this.dsh.current) {
      throw chatError('dsh_task_busy', '已有 DSH 任务在运行');
    }

    const userMessage = this.store.appendMessage(sessionId, { role: 'user', text: value, status: 'ok' });
    const assistantMessage = this.store.appendMessage(sessionId, { role: 'assistant', text: '', status: 'running' });

    const tempPatches = Array.isArray(options.tempPatches) ? options.tempPatches.filter(Boolean) : [];
    let started;
    try {
      started = this.dsh.startTask({
        prompt: value,
        sessionId: meta.dshSessionId || null,
        ...(meta.cwd ? { cwd: meta.cwd } : {}),
        ...(Array.isArray(options.extraPatches) && options.extraPatches.length ? { extraPatches: options.extraPatches } : {}),
      });
    } catch (e) {
      this._removeTempPatches(tempPatches);
      this.store.updateMessage(sessionId, assistantMessage.id, {
        status: 'error',
        text: String(e.detail || e.message || '任务启动失败'),
      });
      throw e;
    }

    const taskId = started.id;
    this.store.updateMessage(sessionId, assistantMessage.id, { taskId });
    this._watch(sessionId, assistantMessage.id, taskId, tempPatches);
    this.audit(`聊天消息已提交 task=${taskId} session=${sessionId}`);
    return { messageId: userMessage.id, assistantMessageId: assistantMessage.id, taskId };
  }

  /** 订阅任务事件，结束（payload=null）时回填 assistant 消息 */
  _watch(sessionId, assistantMessageId, taskId, tempPatches = [], runner = null) {
    const taskRunner = runner || this.dsh;

    const acc = {
      finals: [],
      assistantTexts: [],
      stdout: [],
      stderr: [],
      errorMessage: null,
      exitCode: undefined,
      sawDone: false,
    };

    let unsubscribe = null;
    unsubscribe = taskRunner.subscribeTask(taskId, (payload) => {
      if (payload === null) {
        this._finalize(sessionId, assistantMessageId, acc, taskId);
        this._removeTempPatches(tempPatches);
        if (typeof unsubscribe === 'function') unsubscribe();
        return;
      }
      let event;
      try {
        event = JSON.parse(payload);
      } catch (e) {
        return;
      }
      // DshTaskManager 把 NDJSON 行包成 {type:'event', line:'<json>'}；这里解包成原始事件
      if (event && event.type === 'event' && typeof event.line === 'string') {
        try {
          const inner = JSON.parse(event.line);
          if (inner && typeof inner === 'object') {
            event = { ...inner, sessionId: event.sessionId || inner.sessionId };
          }
        } catch (e) {
          /* 非 JSON 的 event 行按原样处理 */
        }
      }
      const dshSessionId = pickSessionId(event);
      if (dshSessionId) this.store.setDshSessionId(sessionId, dshSessionId);

      if (event.type === 'final' || event.type === 'done') {
        if (typeof event.text === 'string' && event.text.trim()) acc.finals.push(event.text);
      }
      // SDK 通道只推 assistant/message 事件（没有 headless 的 final 行），作为文本兜底
      if (event.type === 'assistant/message') {
        const blocks = event.data?.message?.content || event.data?.content;
        if (Array.isArray(blocks)) {
          const text = blocks
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim();
          if (text) acc.assistantTexts.push(text);
        }
      }
      if (event.type === 'done') {
        acc.sawDone = true;
        acc.exitCode = event.code === undefined ? null : event.code;
      }
      if (event.type === 'error') {
        acc.errorMessage = typeof event.message === 'string' ? event.message : 'error';
        if (event.code !== undefined && acc.exitCode === undefined) acc.exitCode = event.code;
      }
      if (event.type === 'stdout' && typeof event.line === 'string') acc.stdout.push(event.line);
      if (event.type === 'stderr' && typeof event.line === 'string') acc.stderr.push(event.line);
    });

    if (!unsubscribe) {
      // 任务在订阅前已结束（极短任务）：按失败处理，避免 running 卡死
      this.store.updateMessage(sessionId, assistantMessageId, {
        status: 'error',
        text: '任务已结束但未能捕获输出',
      });
      this._removeTempPatches(tempPatches);
    }
  }

  /** 删除临时 patch 文件（模型路由等一次性覆盖） */
  _removeTempPatches(files) {
    for (const file of Array.isArray(files) ? files : []) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * 通过 SDK 通道续聊（可续聊带 agentPreset 的 Web 会话）。
   * @param {string} sessionId 聊天会话 id
   * @param {string} text
   * @param {{runner:object, dshSessionId:string, provider:string, model:string, cwd?:string}} options
   * @returns {Promise<{messageId:string, assistantMessageId:string, taskId:string, channel:'sdk'}>}
   */
  async sendSdkMessage(sessionId, text, options = {}) {
    const meta = this.store.sessionMeta(sessionId);
    if (!meta) throw chatError('chat_session_not_found', '会话不存在');
    const value = String(text === undefined || text === null ? '' : text).trim();
    if (!value) throw chatError('chat_text_required', 'text 不能为空');
    if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
      throw chatError('chat_text_too_long', `text 超过 ${MAX_TEXT_BYTES} 字节`);
    }
    const runner = options.runner;
    if (!runner) throw chatError('sdk_unavailable', 'SDK 通道不可用');
    const dshSessionId = String(options.dshSessionId || '');
    if (!dshSessionId) throw chatError('dsh_session_not_bound', '聊天会话尚未绑定 DSH 会话');

    if (meta.dshSessionId !== dshSessionId) this.store.setDshSessionId(sessionId, dshSessionId);
    this.store.setChannel(sessionId, 'sdk');

    const userMessage = this.store.appendMessage(sessionId, { role: 'user', text: value, status: 'ok' });
    const assistantMessage = this.store.appendMessage(sessionId, { role: 'assistant', text: '', status: 'running' });

    let started;
    try {
      started = await runner.startTask({
        dshSessionId,
        text: value,
        provider: options.provider,
        model: options.model,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (e) {
      this.store.updateMessage(sessionId, assistantMessage.id, {
        status: 'error',
        text: String(e.detail || e.message || 'SDK 启动失败'),
      });
      throw e;
    }

    const taskId = started.id;
    this.store.updateMessage(sessionId, assistantMessage.id, { taskId });
    this._watch(sessionId, assistantMessage.id, taskId, [], runner);
    this.audit(`SDK 续聊已提交 task=${taskId} session=${sessionId}`);
    return { messageId: userMessage.id, assistantMessageId: assistantMessage.id, taskId, channel: 'sdk' };
  }

  _finalize(sessionId, assistantMessageId, acc, taskId) {
    const exitCode = acc.exitCode;
    const ok = !acc.errorMessage && (exitCode === 0 || exitCode === null || exitCode === undefined);
    let text = acc.finals.join('\n').trim();
    if (!text) text = acc.assistantTexts.join('\n').trim();
    if (!text && ok) text = acc.stdout.join('\n').trim();
    if (ok && !text) text = '（无输出）';
    if (!ok) {
      if (!text) text = acc.errorMessage ? `任务失败：${acc.errorMessage}` : '任务执行失败';
      else if (acc.errorMessage && !text.includes(acc.errorMessage)) text = `${text}\n${acc.errorMessage}`;
    }
    const stderrSummary = acc.stderr.join('\n').trim().slice(0, 2000);
    this.store.updateMessage(sessionId, assistantMessageId, {
      status: ok ? 'ok' : 'error',
      text,
      ...(stderrSummary ? { error: stderrSummary } : {}),
      ...(exitCode !== undefined && exitCode !== null ? { exitCode } : {}),
    });
    this.audit(`聊天任务结束 task=${taskId} status=${ok ? 'ok' : 'error'}${exitCode !== undefined ? ` code=${exitCode}` : ''}`);
    void acc.sawDone;
  }
}

module.exports = {
  ChatStore,
  ChatService,
  CHAT_FILE,
  MAX_SESSIONS,
  MAX_MESSAGES,
  MAX_BYTES,
  MAX_TEXT_BYTES,
  SESSION_ID_RE,
  pickSessionId,
};
