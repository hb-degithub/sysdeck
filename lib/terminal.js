'use strict';

/**
 * Web 终端
 *
 * 通过 `script -qfec` 分配真实 PTY 运行交互式 shell：
 *   - 不依赖 node-pty（无需编译原生模块）
 *   - `script` 是 util-linux 自带的 PTY 分配器，Ubuntu 默认安装
 *
 * 通信方式：
 *   - 输出：SSE 推送（GET /api/terminal/stream?id=xxx）
 *   - 输入：POST /api/terminal/input
 *   - 尺寸：POST /api/terminal/resize
 *
 * 安全与资源限制：
 *   - 会话数量上限、单会话输出缓冲上限、空闲超时自动回收
 *   - 会话与创建者的 sid 绑定，其他人拿到 id 也无法操作
 *   - 只允许启动固定 shell（不接受任意命令）
 */

const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');

const LIMITS = {
  maxSessions: 6, // 同时最多 6 个终端
  maxBufferBytes: 512 * 1024, // 单会话输出缓冲上限
  idleTimeoutMs: 30 * 60 * 1000, // 30 分钟无操作自动关闭
  maxCols: 400,
  maxRows: 200,
};

/** 清理客户端发来的终端控制序列中的危险部分（保留常规 ANSI） */
function sanitizeInput(data) {
  if (typeof data !== 'string') return '';
  // 限制单次输入长度，防止粘贴巨型内容打爆
  return data.slice(0, 64 * 1024);
}

class TerminalSession {
  constructor(id, opts = {}) {
    this.id = id;
    this.ownerSid = opts.ownerSid || null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.cols = Math.min(LIMITS.maxCols, Math.max(20, opts.cols || 80));
    this.rows = Math.min(LIMITS.maxRows, Math.max(5, opts.rows || 24));
    this.buffer = []; // 最近输出（供新订阅者回放）
    this.bufferBytes = 0;
    this.listeners = new Set();
    this.closed = false;
    this.exitCode = null;
    // 可选：容器 shell（{id,name}），其余与宿主机终端一致（SSE/输入/resize/回收）
    this.container = opts.container && opts.container.id ? { id: String(opts.container.id), name: opts.container.name || null } : null;
    this.containerShell = null;

    this._spawn();
  }

  _spawn() {
    const launch = this.container ? this._containerLaunchSpec() : this._hostLaunchSpec();
    this.proc = spawn(launch.cmd, launch.args, launch.options);
    this._wireProcess();
  }

  _baseOptions() {
    return {
      cwd: os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'C.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    };
  }

  _hostLaunchSpec() {
    const shell = process.env.SHELL && /^(bash|zsh|sh)$/.test(require('node:path').basename(process.env.SHELL))
      ? process.env.SHELL
      : '/bin/bash';
    // script -qfec "<shell>" /dev/null
    //   -q 静默   -f 刷新   -e 返回子进程退出码   -c 执行的命令
    return { cmd: 'script', args: ['-qfec', `${shell} -i`, '/dev/null'], options: this._baseOptions() };
  }

  /**
   * 容器终端：先数组传参探测容器内 bash 是否存在（无 shell 拼接），
   * 再通过 script -qfec "docker exec -it <hex-id> <sh|bash>" 获得 PTY。
   * 容器 id 已在上层/此处严格校验为 12..64 位 hex，shell 只可能是 bash/sh。
   */
  _containerLaunchSpec() {
    const containerId = this.container.id;
    if (!/^[0-9a-f]{12,64}$/i.test(containerId)) throw new Error('容器 id 非法');
    let shell = 'sh';
    try {
      const probe = spawnSync('docker', ['exec', containerId, 'sh', '-c', 'command -v bash'], {
        timeout: 5000,
        encoding: 'utf8',
      });
      if (probe.status === 0 && /bash/.test(String(probe.stdout || ''))) shell = 'bash';
    } catch (e) {
      shell = 'sh';
    }
    this.containerShell = shell;
    return {
      cmd: 'script',
      args: ['-qfec', `docker exec -it ${containerId} ${shell}`, '/dev/null'],
      options: this._baseOptions(),
    };
  }

  _wireProcess() {
    this.proc.stdout.on('data', (chunk) => this._emit(chunk));
    this.proc.stderr.on('data', (chunk) => this._emit(chunk));

    this.proc.on('exit', (code) => {
      this.exitCode = code;
      this._emit(Buffer.from(`\r\n\x1b[33m[进程已退出，退出码 ${code}]\x1b[0m\r\n`));
      this.close('process-exit');
    });

    this.proc.on('error', (e) => {
      this._emit(Buffer.from(`\r\n\x1b[31m[启动失败：${e.message}]\x1b[0m\r\n`));
      this.close('spawn-error');
    });
  }

  _emit(chunk) {
    if (this.closed) return;
    const text = chunk.toString('utf8');

    this.buffer.push(text);
    this.bufferBytes += chunk.length;
    // 环形缓冲：超出上限时丢弃最旧的
    while (this.bufferBytes > LIMITS.maxBufferBytes && this.buffer.length > 1) {
      const dropped = this.buffer.shift();
      this.bufferBytes -= Buffer.byteLength(dropped, 'utf8');
    }

    for (const fn of this.listeners) {
      try {
        fn(text);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** 订阅输出；返回取消订阅函数 */
  subscribe(fn, replay = true) {
    if (replay && this.buffer.length > 0) {
      try {
        fn(this.buffer.join(''));
      } catch (e) {
        /* ignore */
      }
    }
    this.listeners.add(fn);
    this.lastActivity = Date.now();
    return () => this.listeners.delete(fn);
  }

  /** 写入用户输入 */
  write(data) {
    if (this.closed) return { ok: false, error: '会话已关闭' };
    const safe = sanitizeInput(data);
    if (!safe) return { ok: false, error: '空输入' };
    this.lastActivity = Date.now();
    try {
      this.proc.stdin.write(safe);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 调整终端尺寸（通过 stty 通知 PTY） */
  resize(cols, rows) {
    if (this.closed) return { ok: false };
    const c = Math.min(LIMITS.maxCols, Math.max(20, Number(cols) || 80));
    const r = Math.min(LIMITS.maxRows, Math.max(5, Number(rows) || 24));
    if (c === this.cols && r === this.rows) return { ok: true, cols: c, rows: r };
    this.cols = c;
    this.rows = r;
    this.lastActivity = Date.now();
    // script 不支持动态 TIOCSWINSZ，用 stty 让子 shell 感知新尺寸
    try {
      this.proc.stdin.write(`\x1b[8;${r};${c}t`);
    } catch (e) {
      /* ignore */
    }
    return { ok: true, cols: c, rows: r };
  }

  close(reason = 'user') {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    try {
      this.proc.stdin.end();
    } catch (e) {
      /* ignore */
    }
    try {
      this.proc.kill('SIGTERM');
      // 2 秒后强杀
      setTimeout(() => {
        try {
          if (!this.proc.killed) this.proc.kill('SIGKILL');
        } catch (e) {
          /* ignore */
        }
      }, 2000).unref?.();
    } catch (e) {
      /* ignore */
    }

    for (const fn of this.listeners) {
      try {
        fn(null); // null 表示结束
      } catch (e) {
        /* ignore */
      }
    }
    this.listeners.clear();
  }

  info() {
    return {
      id: this.id,
      container: this.container ? { id: this.container.id, name: this.container.name, shell: this.containerShell } : null,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      closed: this.closed,
      exitCode: this.exitCode,
      hasSubscribers: this.listeners.size > 0,
    };
  }
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();

    // 定期回收空闲会话
    this._sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of this.sessions) {
        if (s.closed) {
          this.sessions.delete(id);
          continue;
        }
        // 无订阅者且长时间无活动
        if (s.listeners.size === 0 && now - s.lastActivity > LIMITS.idleTimeoutMs) {
          s.close('idle-timeout');
          this.sessions.delete(id);
        }
      }
    }, 60000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  /** 创建会话 */
  create(opts = {}) {
    if (this.sessions.size >= LIMITS.maxSessions) {
      throw new Error(`终端数量已达上限（${LIMITS.maxSessions} 个），请先关闭其他终端`);
    }
    const id = require('node:crypto').randomBytes(12).toString('hex');
    const session = new TerminalSession(id, opts);
    this.sessions.set(id, session);
    return session;
  }

  /** 获取会话（校验所有者） */
  get(id, ownerSid) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (ownerSid && s.ownerSid && s.ownerSid !== ownerSid) return null;
    return s;
  }

  /** 关闭会话 */
  close(id, ownerSid) {
    const s = this.get(id, ownerSid);
    if (!s) return { ok: false, error: '会话不存在' };
    s.close('user');
    this.sessions.delete(id);
    return { ok: true };
  }

  /** 列出当前所有会话（管理员视图） */
  list(ownerSid) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (ownerSid && s.ownerSid && s.ownerSid !== ownerSid) continue;
      out.push(s.info());
    }
    return out;
  }

  /** 关闭全部（服务退出时） */
  closeAll() {
    for (const s of this.sessions.values()) s.close('shutdown');
    this.sessions.clear();
  }
}

module.exports = { TerminalManager, TerminalSession, LIMITS };
