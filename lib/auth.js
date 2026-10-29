'use strict';

/**
 * 鉴权：用户名 + 密码，scrypt 加盐哈希，HMAC 签名会话 Cookie。
 * 特性：
 *  - 登录失败计数与锁定（防暴力破解）
 *  - CSRF Token
 *  - 会话过期
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyPassword, hashPassword } = require('./config');

const COOKIE_NAME = 'panel_session';
const CSRF_HEADER = 'x-csrf-token';
const REMEMBER_COOKIE = 'panel_remember';
const REMEMBER_FILE = 'remember.json';
const REMEMBER_MAX_BYTES = 64 * 1024;
const DEFAULT_REMEMBER_DAYS = 30;
const DEFAULT_REMEMBER_MAX = 50;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function userAgentOf(req) {
  const ua = req && req.headers ? req.headers['user-agent'] : '';
  return typeof ua === 'string' ? ua.slice(0, 200) : '';
}

class Auth {
  constructor(config, saveConfig, options = {}) {
    this.config = config;
    this.saveConfig = saveConfig;
    this.sessions = new Map(); // sid -> { username, csrf, expiresAt }
    this.failures = new Map(); // ip -> { count, lockedUntil }
    this.maxFailures = 5;
    this.lockMs = 5 * 60 * 1000;
    // 会话上限：TTL 内反复登录不应无限增长，超出时淘汰最旧的会话
    this.maxSessions = 500;
    this.maxFailureRecords = 1000;

    // 「记住密码」令牌：服务端只存 sha256 摘要，磁盘明文不可逆
    const dataDir = options.dataDir
      ? path.resolve(String(options.dataDir))
      : path.resolve(__dirname, '..', 'data');
    this.remember = new RememberStore(path.join(dataDir, REMEMBER_FILE), {
      days: config.session?.rememberDays,
      max: config.session?.rememberMax,
      warn: options.warn,
    });
    this.remember.load();
  }

  /**
   * 生成新会话
   * @param {string} username
   * @param {{ip?:string, ua?:string}} [meta] 会话元数据（用于会话管理页）
   */
  createSession(username, meta = {}) {
    const sid = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + (this.config.session.ttlSeconds || 43200) * 1000;
    const ip = typeof meta.ip === 'string' ? meta.ip.slice(0, 64) : '';
    const ua = typeof meta.ua === 'string' ? meta.ua.slice(0, 200) : '';

    // 达到上限时先清理过期会话，仍超限则淘汰最旧的
    if (this.sessions.size >= this.maxSessions) {
      this.sweep();
      while (this.sessions.size >= this.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) break;
        this.sessions.delete(oldest); // Map 保持插入顺序，首个即最旧
      }
    }

    this.sessions.set(sid, { username, csrf, expiresAt, createdAt: now, lastSeenAt: now, ip, ua });
    // username 必须一并返回：调用方（/api/login）依赖它回填前端状态
    return { sid, csrf, username, expiresAt, createdAt: now, lastSeenAt: now, ip, ua };
  }

  /** 校验会话；返回会话或 null（lastSeenAt 节流 30s 更新） */
  getSession(sid) {
    if (!sid) return null;
    const s = this.sessions.get(sid);
    if (!s) return null;
    const now = Date.now();
    if (now > s.expiresAt) {
      this.sessions.delete(sid);
      return null;
    }
    if (!s.lastSeenAt || now - s.lastSeenAt > 30 * 1000) s.lastSeenAt = now;
    return s;
  }

  destroySession(sid) {
    if (sid) this.sessions.delete(sid);
  }

  /** 会话列表（含 id 前缀，供管理接口；不返回 sid 全文/csrf） */
  listSessions() {
    this.sweep();
    return [...this.sessions.entries()]
      .map(([sid, s]) => ({
        sid,
        id: sid.slice(0, 12),
        username: s.username,
        ip: s.ip || '',
        ua: s.ua || '',
        createdAt: s.createdAt || s.lastSeenAt || 0,
        lastSeenAt: s.lastSeenAt || 0,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * 按会话 id 前缀撤销（支持一次匹配多个；返回 {revoked:boolean, count, sids}）
   */
  revokeSession(idPrefix) {
    const prefix = String(idPrefix || '');
    if (!/^[0-9a-f]{6,64}$/.test(prefix)) return { revoked: false, count: 0, sids: [] };
    const sids = [];
    for (const sid of this.sessions.keys()) {
      if (sid.startsWith(prefix)) sids.push(sid);
    }
    for (const sid of sids) this.sessions.delete(sid);
    return { revoked: sids.length > 0, count: sids.length, sids };
  }

  /** 清理过期会话与失效的失败计数记录 */
  sweep() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(sid);
    }
    // 失败计数：锁定已过期且计数归零的记录可以丢弃
    for (const [ip, rec] of this.failures) {
      if (rec.lockedUntil && rec.lockedUntil <= now && rec.count === 0) {
        this.failures.delete(ip);
      }
    }
    // 防御：失败记录表本身也不应无限增长（例如大量伪造源 IP）
    if (this.failures.size > this.maxFailureRecords) {
      const excess = this.failures.size - this.maxFailureRecords;
      let i = 0;
      for (const ip of this.failures.keys()) {
        if (i++ >= excess) break;
        this.failures.delete(ip);
      }
    }
    // 「记住密码」：清理过期令牌，仅在内容变化时落盘（节流）
    this.remember.sweep(now);
  }

  /**
   * 尝试登录
   * @returns {{ok:boolean, error?:string, session?:object}}
   */
  /**
   * 尝试登录
   * @param {string} username
   * @param {string} password
   * @param {string} ip
   * @param {{ua?:string}} [meta] 会话元数据（UA 用于会话管理页）
   * @returns {{ok:boolean, error?:string, session?:object}}
   */
  login(username, password, ip, meta = {}) {
    const lock = this.failures.get(ip);
    if (lock && lock.lockedUntil > Date.now()) {
      const remain = Math.ceil((lock.lockedUntil - Date.now()) / 1000);
      return { ok: false, error: `尝试次数过多，请 ${remain} 秒后再试` };
    }

    const cfg = this.config.panel;
    const userOk = username === cfg.username;
    const passOk = verifyPassword(password, cfg.passwordHash);

    // 用户名错误时也做一次哈希，避免时序侧信道
    if (!userOk) {
      try {
        crypto.scryptSync(password || '', 'timing-equalizer', 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      } catch (e) {
        /* ignore */
      }
    }

    if (!userOk || !passOk) {
      const rec = this.failures.get(ip) || { count: 0, lockedUntil: 0 };
      rec.count += 1;
      if (rec.count >= this.maxFailures) {
        rec.lockedUntil = Date.now() + this.lockMs;
        rec.count = 0;
      }
      this.failures.set(ip, rec);
      return { ok: false, error: '用户名或密码错误' };
    }

    this.failures.delete(ip);
    const session = this.createSession(username, { ip, ua: meta.ua });
    return { ok: true, session };
  }

  /** 修改密码 */
  changePassword(currentPassword, newPassword) {
    const cfg = this.config.panel;
    if (!verifyPassword(currentPassword, cfg.passwordHash)) {
      return { ok: false, error: '当前密码不正确' };
    }
    if (!newPassword || newPassword.length < 8) {
      return { ok: false, error: '新密码至少 8 位' };
    }
    if (newPassword.length > 200) {
      return { ok: false, error: '新密码过长' };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    cfg.passwordSalt = salt;
    cfg.passwordHash = hashPassword(newPassword, salt);
    cfg.mustChangePassword = false;
    this.saveConfig(this.config);
    return { ok: true };
  }

  /** 修改用户名 */
  changeUsername(currentPassword, newUsername) {
    const cfg = this.config.panel;
    if (!verifyPassword(currentPassword, cfg.passwordHash)) {
      return { ok: false, error: '密码不正确' };
    }
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(newUsername || '')) {
      return { ok: false, error: '用户名只能包含字母、数字、下划线、点、连字符，长度 2-32' };
    }
    cfg.username = newUsername;
    this.saveConfig(this.config);
    return { ok: true };
  }

  /**
   * 签发「记住密码」令牌（明文只返回给调用方用于 Set-Cookie，服务端仅存摘要）
   * @returns {{token:string, expiresAt:number}|null} days<=0 时禁用，返回 null
   */
  issueRemember(username, req) {
    const issued = this.remember.issue(username, { ua: userAgentOf(req) });
    return issued ? { token: issued.token, expiresAt: issued.expiresAt } : null;
  }

  /**
   * 用 remember token 自动登录：校验 → 轮换令牌（旧 token 立即作废）→ 创建新会话。
   * token 无效/过期返回 null。
   * @returns {{session:object, remember:{token:string, expiresAt:number}}|null}
   */
  resumeRemember(token, req) {
    const rotated = this.remember.rotate(token, { ua: userAgentOf(req) });
    if (!rotated) return null;
    const ip = req && req.socket ? String(req.socket.remoteAddress || '') : '';
    const session = this.createSession(rotated.username, { ip, ua: userAgentOf(req) });
    return {
      session,
      remember: { token: rotated.token, expiresAt: rotated.expiresAt },
    };
  }

  /** 撤销指定 remember token（不存在也算成功，幂等） */
  revokeRemember(token) {
    return this.remember.revoke(token);
  }

  /** 校验 CSRF */
  static csrfValid(session, token) {
    if (!session || !token) return false;
    const a = Buffer.from(session.csrf);
    const b = Buffer.from(String(token));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

/* ---------------- 「记住密码」令牌持久化 ---------------- */

/**
 * remember token 存储：
 *  - 明文 token 只存在于客户端 Cookie，服务端仅保存 sha256 摘要
 *  - 磁盘文件 0600、原子写（tmp + rename）、上限 64KB
 *  - 过期清理、上限淘汰最旧（createdAt）
 */
class RememberStore {
  constructor(file, options = {}) {
    this.file = file;
    const days = Number(options.days);
    const max = Number(options.max);
    this.days = Number.isFinite(days)
      ? Math.min(365, Math.max(0, Math.trunc(days)))
      : DEFAULT_REMEMBER_DAYS;
    this.max = Number.isFinite(max)
      ? Math.min(1000, Math.max(1, Math.trunc(max)))
      : DEFAULT_REMEMBER_MAX;
    this.tokens = [];
    this.warn = typeof options.warn === 'function' ? options.warn : (msg) => console.warn(msg);
  }

  get enabled() {
    return this.days > 0;
  }

  /** 启动时加载；清理过期/非法条目，仅在内容变化时落盘 */
  load() {
    this.tokens = [];
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      return; // 文件不存在：首次使用，不主动创建
    }
    if (!stat.isFile()) {
      this.warn('[auth] remember.json 不是普通文件，忽略');
      return;
    }
    // 启动时若权限过宽（例如历史文件 0644），收紧到 0600
    if ((stat.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(this.file, 0o600);
      } catch (e) {
        /* 非致命：写入时还会再 chmod */
      }
    }
    // 防御：超过上限的文件不解析（避免异常文件占内存）
    if (stat.size > REMEMBER_MAX_BYTES) {
      this.warn('[auth] remember.json 超过 64KB，忽略');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.warn('[auth] remember.json 解析失败，忽略');
      return;
    }
    const raw = parsed && Array.isArray(parsed.tokens) ? parsed.tokens : [];
    const now = Date.now();
    const valid = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const hash = typeof item.hash === 'string' ? item.hash.toLowerCase() : '';
      if (!/^[0-9a-f]{64}$/.test(hash)) continue;
      const username = typeof item.username === 'string' ? item.username.slice(0, 128) : '';
      if (!username) continue;
      const createdAt = Number(item.createdAt);
      const expiresAt = Number(item.expiresAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) continue;
      if (expiresAt <= now) continue; // 过期清理
      valid.push({
        hash,
        username,
        createdAt,
        expiresAt,
        ua: typeof item.ua === 'string' ? item.ua.slice(0, 200) : '',
      });
    }
    const trimmed = this._enforceMax(valid);
    const changed = trimmed.length !== raw.length;
    this.tokens = trimmed;
    if (changed) this._save();
  }

  /**
   * 签发新令牌。
   * @returns {{token:string, expiresAt:number}|null} 禁用时返回 null
   */
  issue(username, options = {}) {
    if (!this.enabled) return null;
    this._pruneExpired();
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const entry = {
      hash: sha256Hex(token),
      username: String(username || '').slice(0, 128),
      createdAt: now,
      expiresAt: now + this.days * 86400 * 1000,
      ua: typeof options.ua === 'string' ? options.ua.slice(0, 200) : '',
    };
    this.tokens.push(entry);
    this.tokens = this._enforceMax(this.tokens);
    this._save();
    return { token, expiresAt: entry.expiresAt };
  }

  /** 校验 token；有效返回条目，否则 null（不区分不存在/过期） */
  verify(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = sha256Hex(token);
    const entry = this.tokens.find((t) => t.hash === hash);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  /** 轮换：旧 token 立即作废并签发新 token（保留原过期时间，不延长免登录窗口） */
  rotate(token, options = {}) {
    const entry = this.verify(token);
    if (!entry) return null;
    const newToken = crypto.randomBytes(32).toString('hex');
    const updated = {
      hash: sha256Hex(newToken),
      username: entry.username,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      ua: typeof options.ua === 'string' ? options.ua.slice(0, 200) : entry.ua,
    };
    this.tokens = this.tokens.filter((t) => t !== entry);
    this.tokens.push(updated);
    this._save();
    return { token: newToken, expiresAt: updated.expiresAt, username: updated.username };
  }

  /** 撤销 token；返回是否真的删除了条目（幂等：重复撤销返回 false） */
  revoke(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const hash = sha256Hex(token);
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.hash !== hash);
    if (this.tokens.length === before) return false;
    this._save();
    return true;
  }

  /** 清理过期/超限条目；仅内容变化时落盘（由 Auth.sweep 定时调用） */
  sweep(now = Date.now()) {
    const before = this.tokens.length;
    this.tokens = this._enforceMax(this.tokens.filter((t) => t.expiresAt > now));
    if (this.tokens.length !== before) this._save();
  }

  _pruneExpired() {
    const now = Date.now();
    this.tokens = this.tokens.filter((t) => t.expiresAt > now);
  }

  _enforceMax(tokens) {
    if (tokens.length <= this.max) return tokens.slice();
    return tokens.slice().sort((a, b) => a.createdAt - b.createdAt).slice(tokens.length - this.max);
  }

  _save() {
    try {
      let tokens = this.tokens;
      let json = JSON.stringify({ version: 1, tokens });
      while (Buffer.byteLength(json, 'utf8') > REMEMBER_MAX_BYTES && tokens.length > 1) {
        tokens = tokens.slice(1);
        json = JSON.stringify({ version: 1, tokens });
      }
      this.tokens = tokens;
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch (e) {
        /* 非致命 */
      }
    } catch (e) {
      this.warn(`[auth] remember.json 写入失败: ${e.code || e.message}`);
    }
  }
}

/* ---------------- Cookie 工具 ---------------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  }
  return out;
}

function buildSetCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push('SameSite=Strict');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  Auth,
  RememberStore,
  COOKIE_NAME,
  CSRF_HEADER,
  REMEMBER_COOKIE,
  REMEMBER_FILE,
  DEFAULT_REMEMBER_DAYS,
  DEFAULT_REMEMBER_MAX,
  parseCookies,
  buildSetCookie,
};
