'use strict';

/**
 * DSH SDK 高级续聊（`dsh --profile sdk`）
 *
 * 背景：headless one-shot runner 拒绝 adopt 带 agentPreset 的会话（DSH Web 创建的 standard/cordis 等），
 * 而 SDK 是 Host 级运行时（JSON-RPC over stdio），可以通过 --patch 挂上 preset 定义后续聊这类会话。
 *
 * 协议（已实测）：
 *   initialize {cwd,provider,model} → {serverInfo}
 *   session/resume {sessionId} → {}
 *   session/prompt {sessionId,contentBlocks:[{type:'text',text}]} → {messageId}
 *   session/wait {sessionId} → {}
 *   通知：method=session.event params={sessionId,event:{type,seq,time,data}}
 *         method=session.status params={sessionId,status:'running'|'idle'}
 * 需要 patch：providers patch（默认复用 dsh.patch）+ 临时 registry（agent-preset-registry）+ preset patch 列表。
 *
 * 事件会被标准化为与 DshTaskManager 相同形态，从而复用 /api/dsh/task/stream（sdk- 前缀 id）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadCredentialsRefs } = require('./dsh');

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const TASK_BUFFER_BYTES = 256 * 1024;
const TASK_KEEP_MS = 30 * 60 * 1000;
const TASK_MAX_RETAINED = 20;
const PRESET_NAMES = ['cordis', 'standard', 'ptc', 'minimal'];

const REGISTRY_TEMPLATE = `- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
`;

function sdkError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail || code;
  return err;
}

/** 把 SDK 错误信息映射成可读错误码 */
function mapSdkError(message) {
  const text = String(message || '');
  if (/already owned by an active write handle/i.test(text)) {
    return { code: 'dsh_session_busy_in_web', detail: '该会话正在 DSH Web 中打开，请先在 Web 端关闭该会话后重试' };
  }
  if (/no adapter registered for provider/i.test(text)) {
    return { code: 'dsh_provider_missing', detail: 'SDK 运行时没有该 provider（请配置 dsh.patch / sdkProvidersPatch）' };
  }
  if (/agent preset .* not (?:found|defined|registered)|preset .* is not defined|unknown preset/i.test(text)) {
    return { code: 'dsh_preset_missing', detail: 'SDK 运行时缺少该 agent preset 定义（请检查 preset patch）' };
  }
  return { code: 'dsh_sdk_error', detail: text || 'SDK 执行失败' };
}

/** 从 dsh bin 路径推导 runtime 根目录（<runtime>/node_modules/.bin/dsh） */
function candidatesForRuntime(dshBin) {
  const out = [];
  let current = path.resolve(String(dshBin || ''));
  for (let i = 0; i < 6; i += 1) {
    current = path.dirname(current);
    if (current === path.dirname(current)) break;
    out.push(current);
  }
  return out;
}

/**
 * 自动探测 preset patch（<runtime>/node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml）。
 * @returns {Array<{name:string,path:string}>}
 */
function detectPresetPatches(dshBin, extra = []) {
  const explicit = (Array.isArray(extra) ? extra : []).filter(Boolean);
  if (explicit.length > 0) {
    return explicit
      .map((file) => ({ name: path.basename(file).replace(/\.patch\.yml$/, '').replace(/\.yml$/, ''), path: file }))
      .filter((item) => fs.existsSync(item.path));
  }
  for (const root of candidatesForRuntime(dshBin)) {
    const dir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.patch.yml'));
    } catch (e) {
      continue;
    }
    if (names.length === 0) continue;
    return PRESET_NAMES.filter((name) => names.includes(`${name}.patch.yml`))
      .map((name) => ({ name, path: path.join(dir, `${name}.patch.yml`) }))
      .concat(
        names
          .filter((file) => !PRESET_NAMES.includes(file.replace(/\.patch\.yml$/, '')))
          .map((file) => ({ name: file.replace(/\.patch\.yml$/, ''), path: path.join(dir, file) }))
      );
  }
  return [];
}

/** 写临时 registry patch（0600），返回路径 */
function writeRegistryPatch() {
  const file = path.join(os.tmpdir(), `dsh-sdk-registry-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.yml`);
  fs.writeFileSync(file, REGISTRY_TEMPLATE, { mode: 0o600 });
  return file;
}

/** 统一的事件文本提取（assistant/message 的 content text） */
function eventText(event) {
  const content = event?.data?.message?.content || event?.data?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/* ---------------- SDK 客户端 ---------------- */

class SdkSessionClient {
  /**
   * @param {{dshBin:string, profile?:string, providersPatch?:string, presetPatches?:Array<{name:string,path:string}>,
   *          cwd:string, home:string, homeDir?:string, credentialsFile?:string, env?:object,
   *          timeoutMs?:number, logger?:object, onEvent?:Function, onStderr?:Function}} options
   */
  constructor(options = {}) {
    this.dshBin = options.dshBin;
    this.profile = options.profile || 'sdk';
    this.providersPatch = options.providersPatch || '';
    this.presetPatches = Array.isArray(options.presetPatches) ? options.presetPatches : [];
    this.cwd = options.cwd || process.cwd();
    this.home = options.home;
    this.homeDir = options.homeDir || os.homedir();
    this.credentialsFile = options.credentialsFile || '';
    this.extraEnv = options.env && typeof options.env === 'object' ? options.env : {};
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.logger = options.logger || console;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.onStderr = typeof options.onStderr === 'function' ? options.onStderr : () => {};

    this.child = null;
    this.registryFile = null;
    this.pending = new Map(); // id -> {resolve,reject,timer,method}
    this.nextId = 1;
    this.buffer = '';
    this.stderrTail = [];
    this.closed = false;
    this.status = null;
    this.sessionId = null;
  }

  get args() {
    const args = ['--profile', this.profile];
    if (this.providersPatch) args.push('--patch', this.providersPatch);
    args.push('--patch', this.registryFile);
    for (const preset of this.presetPatches) args.push('--patch', preset.path);
    return args;
  }

  /** 启动子进程（不含 RPC 调用） */
  start() {
    if (this.child) return;
    if (!this.dshBin) throw sdkError('sdk_unavailable', '未配置 dsh.bin');
    this.registryFile = writeRegistryPatch();
    const credential = this.credentialsFile
      ? loadCredentialsRefs(this.credentialsFile, 64 * 1024)
      : { refs: {} };
    const env = {
      ...process.env,
      ...(this.home ? { DSH_HOME: this.home } : {}),
      HOME: this.homeDir,
      ...credential.refs,
      ...this.extraEnv,
    };
    try {
      this.child = spawn(this.dshBin, this.args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this._cleanupRegistry();
      throw sdkError('sdk_unavailable', e.message);
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      if (this.stderrTail.join('').length > 8000) this.stderrTail.splice(0, this.stderrTail.length - 20);
      this.onStderr(text);
    });
    this.child.on('error', (err) => this._failAll(sdkError('sdk_unavailable', err.message)));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        const detail = this.stderrTail.join('').trim().slice(0, 500);
        this._failAll(mapSdkError(detail) ? sdkError(mapSdkError(detail).code, mapSdkError(detail).detail) : sdkError('dsh_sdk_error', `SDK 进程退出 code=${code}`));
      }
      void signal;
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.buffer = '';
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (frame.id !== undefined && frame.id !== null && (frame.result !== undefined || frame.error !== undefined)) {
        const waiter = this.pending.get(frame.id);
        if (!waiter) continue;
        this.pending.delete(frame.id);
        clearTimeout(waiter.timer);
        if (frame.error) {
          const mapped = mapSdkError(frame.error.message);
          waiter.reject(sdkError(mapped.code, mapped.detail));
        } else {
          waiter.resolve(frame.result || {});
        }
        continue;
      }
      if (typeof frame.method !== 'string') continue;
      const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
      if (params.sessionId) this.sessionId = params.sessionId;
      if (frame.method === 'session.event' && params.event) {
        this.onEvent(params.event);
      } else if (frame.method === 'session.status') {
        this.status = params.status || null;
        this.onEvent({ type: 'session/status', data: { status: params.status } });
      }
    }
  }

  _failAll(err) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  _cleanupRegistry() {
    if (!this.registryFile) return;
    try {
      fs.unlinkSync(this.registryFile);
    } catch (e) {
      /* ignore */
    }
    this.registryFile = null;
  }

  /** 发送 RPC 请求并等待响应 */
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child) throw sdkError('sdk_unavailable', 'SDK 进程未启动');
    if (this.closed) return Promise.reject(sdkError('dsh_sdk_error', 'SDK 进程已退出'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(sdkError('dsh_sdk_timeout', `SDK ${method} 超时`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(sdkError('dsh_sdk_error', 'SDK 写入失败'));
      }
    });
  }

  initialize({ cwd, provider, model }) {
    return this.request('initialize', { cwd: cwd || this.cwd, provider, model });
  }

  resume(sessionId) {
    return this.request('session/resume', { sessionId });
  }

  prompt(sessionId, text) {
    return this.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] });
  }

  wait(sessionId, timeoutMs) {
    return this.request('session/wait', { sessionId }, timeoutMs);
  }

  shutdown() {
    if (!this.child || this.closed) {
      this._cleanupRegistry();
      return Promise.resolve();
    }
    return this.request('shutdown', {}, 3000).catch(() => {}).then(() => this.close());
  }

  close() {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch (e) {
        /* ignore */
      }
      try {
        this.child.kill('SIGTERM');
      } catch (e) {
        /* ignore */
      }
      const child = this.child;
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch (e) {
          /* ignore */
        }
      }, 2000).unref?.();
      this.child = null;
    }
    this.closed = true;
    this._cleanupRegistry();
  }
}

/* ---------------- SDK 任务注册表（供 SSE 复用） ---------------- */

class SdkTaskRunner {
  /**
   * @param {{resolveClientOptions:Function, audit?:Function, logger?:object, timeoutMs?:number}} options
   */
  constructor(options = {}) {
    this.resolveClientOptions = options.resolveClientOptions;
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    this.logger = options.logger || console;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.tasks = new Map();
    this.current = null;
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  getTask(id) {
    return this.tasks.get(String(id || '')) || null;
  }

  subscribeTask(id, listener) {
    const task = this.getTask(id);
    if (!task) return null;
    for (const payload of task.buffer.slice()) {
      try {
        listener(payload);
      } catch (e) {
        return () => {};
      }
    }
    if (task.finished) {
      try {
        listener(null);
      } catch (e) {
        /* ignore */
      }
      return () => {};
    }
    task.subscribers.add(listener);
    return () => {
      task.subscribers.delete(listener);
    };
  }

  _emit(task, event) {
    const payload = JSON.stringify(event);
    task.buffer.push(payload);
    task.bufferBytes += Buffer.byteLength(payload, 'utf8') + 1;
    while (task.bufferBytes > TASK_BUFFER_BYTES && task.buffer.length > 1) {
      const dropped = task.buffer.shift();
      task.bufferBytes -= Buffer.byteLength(dropped, 'utf8') + 1;
    }
    for (const listener of task.subscribers) {
      try {
        listener(payload);
      } catch (e) {
        task.subscribers.delete(listener);
      }
    }
  }

  _finish(task, kind, extra = {}) {
    if (task.finished) return;
    task.finished = true;
    task.endedAt = Date.now();
    if (this.current === task) this.current = null;
    if (task.client) task.client.close();
    if (task.timer) clearTimeout(task.timer);
    const event = kind === 'error'
      ? { type: 'error', ...(extra.message ? { message: extra.message } : {}), ...(extra.code ? { code: extra.code } : {}) }
      : { type: 'done', code: extra.code === undefined ? 0 : extra.code, ...(task.sessionId ? { sessionId: task.sessionId } : {}) };
    this._emit(task, event);
    for (const listener of task.subscribers) {
      try {
        listener(null);
      } catch (e) {
        /* ignore */
      }
    }
    task.subscribers.clear();
    this._prune();
  }

  _prune() {
    if (this.tasks.size <= TASK_MAX_RETAINED) return;
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= TASK_MAX_RETAINED) break;
      if (task === this.current) continue;
      if (task.finished) this.tasks.delete(id);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task === this.current) continue;
      if (task.finished && task.endedAt && now - task.endedAt > TASK_KEEP_MS) this.tasks.delete(id);
    }
    this._prune();
  }

  /**
   * 启动一次 SDK 续聊：init → resume → prompt（同步阶段，失败可映射成 HTTP 错误），
   * 然后异步 wait + 事件转发；返回任务 id（sdk- 前缀）。
   * @param {{dshSessionId:string, text:string, cwd?:string, provider:string, model:string}} input
   * @returns {Promise<{id:string}>}
   */
  async startTask(input = {}) {
    if (this.current) throw sdkError('dsh_task_busy', '已有 SDK 任务在运行');
    const sessionId = String(input.dshSessionId || '');
    if (!/^session-[A-Za-z0-9._-]{1,200}$/.test(sessionId)) throw sdkError('dsh_task_invalid', 'dshSessionId 格式无效');
    if (!input.provider || !input.model) throw sdkError('dsh_provider_missing', '缺少 provider/model');
    const text = String(input.text || '');
    if (!text.trim()) throw sdkError('dsh_task_invalid', 'text 不能为空');

    const options = await this.resolveClientOptions({ cwd: input.cwd });
    if (!options || !options.dshBin) throw sdkError('sdk_unavailable', 'SDK 不可用（缺少 dsh.bin）');
    if (!options.presetPatches || options.presetPatches.length === 0) {
      throw sdkError('dsh_preset_missing', '未找到 preset patch，无法续聊带 preset 的会话');
    }

    const id = `sdk-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const task = {
      id,
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      finished: false,
      buffer: [],
      bufferBytes: 0,
      subscribers: new Set(),
      client: null,
      timer: null,
      exitCode: null,
    };

    const client = new SdkSessionClient({
      ...options,
      cwd: input.cwd || options.cwd,
      timeoutMs: this.timeoutMs,
      onEvent: (event) => {
        if (event.type === 'session/status') {
          this._emit(task, { type: 'event', line: JSON.stringify(event) });
          return;
        }
        this._emit(task, { type: 'event', line: JSON.stringify(event) });
      },
      onStderr: (chunk) => {
        const line = String(chunk).replace(/\r$/, '').trim();
        if (line) this._emit(task, { type: 'stderr', line: line.slice(0, 4000) });
      },
    });
    task.client = client;
    this.current = task;
    this.tasks.set(id, task);
    this._emit(task, { type: 'start', sessionId });

    try {
      client.start();
      await client.initialize({ cwd: input.cwd || options.cwd, provider: input.provider, model: input.model });
      await client.resume(sessionId);
      const promptResult = await client.prompt(sessionId, text);
      if (promptResult?.messageId) task.promptMessageId = promptResult.messageId;
    } catch (e) {
      const mapped = mapSdkError(e.detail || e.message);
      const code = e.code && e.code.startsWith('dsh_') ? e.code : mapped.code;
      client.close();
      this.tasks.delete(id);
      this.current = null;
      throw sdkError(code, mapped.detail || e.detail || e.message);
    }

    // 异步等待 turn 结束
    const timeoutMs = this.timeoutMs;
    task.timer = setTimeout(() => {
      if (task.finished) return;
      this._emit(task, { type: 'stderr', line: `[sdk] 超时 ${Math.round(timeoutMs / 1000)}s，正在终止` });
      this._finish(task, 'error', { message: 'timeout', code: 'dsh_sdk_timeout' });
    }, timeoutMs);
    if (task.timer.unref) task.timer.unref();

    client
      .wait(sessionId, timeoutMs)
      .then(() => {
        task.exitCode = 0;
        this._finish(task, 'done', { code: 0 });
      })
      .catch((e) => {
        this._finish(task, 'error', { message: e.detail || e.message || 'sdk_failed', code: e.code || 'dsh_sdk_error' });
      });

    this.audit(`sdk 续聊 task=${id} session=${sessionId}`);
    return { id };
  }

  closeAll() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const task of this.tasks.values()) {
      if (task.client) task.client.close();
      if (task.timer) clearTimeout(task.timer);
    }
    this.tasks.clear();
    this.current = null;
  }
}

module.exports = {
  SdkSessionClient,
  SdkTaskRunner,
  detectPresetPatches,
  writeRegistryPatch,
  mapSdkError,
  eventText,
  sdkError,
  PRESET_NAMES,
  DEFAULT_TIMEOUT_MS,
};
