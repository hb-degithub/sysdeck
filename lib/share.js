'use strict';

/**
 * 文件分享 / 下载器
 *
 * 能力：
 *  - 把服务器上的普通文件登记成「短 token + 限时」下载链接（可选一次性）
 *  - 公开下载端点只认 token，不暴露任意路径枚举
 *  - 生成白底深色二维码 SVG（扫码即可下载）
 *
 * 安全与资源约束：
 *  - token = 16 字节随机（32 hex），仅在内存登记；进程退出即全部失效
 *  - 仅允许普通文件；目录/设备/套接字一律拒绝
 *  - 下载流式输出，支持单段 Range，不把文件读进内存
 *  - 过期/撤销/用尽后与不存在的 token 响应一致
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const qrcode = require('./vendor/qrcode');

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** 代码内默认值，不写入用户 config.json */
const SHARE_DEFAULTS = Object.freeze({
  shareTtlMinutes: 60,
  maxShares: 100,
  // 每个分享的默认下载次数上限；0 = 不限次数（once=true 时强制为 1）
  maxHits: 0,
});

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** 合并并夹取 config.download */
function resolveShareConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  return {
    shareTtlMinutes: clampInt(raw.shareTtlMinutes, 1, 1440, SHARE_DEFAULTS.shareTtlMinutes),
    maxShares: clampInt(raw.maxShares, 1, 10000, SHARE_DEFAULTS.maxShares),
    maxHits: clampInt(raw.maxHits, 0, 10000, SHARE_DEFAULTS.maxHits),
    // 持久化目录（为空则不落盘，便于单测/纯内存使用）
    dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : '',
  };
}

/* ---------------- MIME / 文件名 ---------------- */

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.xz': 'application/x-xz',
  '.bz2': 'application/x-bzip2',
  '.7z': 'application/x-7z-compressed',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
};

function mimeFor(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** RFC 5987 编码（filename*） */
function rfc5987Encode(text) {
  return encodeURIComponent(String(text)).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** ASCII 回退文件名（用于老客户端的 filename=） */
function asciiFilename(filename) {
  return String(filename || 'download')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150) || 'download';
}

/** Content-Disposition: attachment，中文名正确 */
function contentDisposition(filename) {
  return `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

/* ---------------- Range ---------------- */

/**
 * 解析单段 Range。
 * @returns {null | {invalid:true} | {start:number, end:number}}
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { invalid: true };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { invalid: true };
  if (!Number.isFinite(size) || size <= 0) return { invalid: true };

  if (rawStart === '') {
    // 后缀范围：bytes=-N（最后 N 字节）
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  let end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

/* ---------------- 分享登记表 ---------------- */

const SHARES_FILE = 'shares.json';
const MAX_SHARES_BYTES = 256 * 1024;

class ShareStore {
  constructor(config = {}) {
    const cfg = resolveShareConfig(config);
    this.shareTtlMinutes = cfg.shareTtlMinutes;
    this.maxShares = cfg.maxShares;
    this.maxHits = cfg.maxHits;
    this.shares = new Map(); // token -> share
    // 持久化：<dataDir>/shares.json（0600、原子写、≤256KB、变更节流 ≤1s）
    this.file = cfg.dataDir ? path.join(cfg.dataDir, SHARES_FILE) : '';
    this.warn = typeof config.warn === 'function' ? config.warn : (msg) => console.warn(msg);
    this._writeTimer = null;
    if (this.file) this.load();
  }

  /** 启动加载：清理过期/非法条目；shares.json 损坏时忽略并 warn */
  load() {
    this.shares.clear();
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      return;
    }
    if (!stat.isFile() || stat.size > MAX_SHARES_BYTES) {
      this.warn('[share] shares.json 无效或超过 256KB，已忽略');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      this.warn('[share] shares.json 解析失败，已忽略');
      return;
    }
    const raw = Array.isArray(parsed?.shares) ? parsed.shares : Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.token !== 'string' || !TOKEN_RE.test(item.token)) continue;
      if (typeof item.path !== 'string' || !item.path.startsWith('/')) continue;
      if (!Number.isFinite(item.createdAt) || !Number.isFinite(item.expiresAt)) continue;
      if (item.expiresAt <= now) continue; // 启动清理过期
      const once = item.once === true;
      const maxHits = Number.isFinite(item.maxHits) ? Math.max(0, Math.trunc(item.maxHits)) : once ? 1 : this.maxHits;
      const hits = Number.isFinite(item.hits) ? Math.max(0, Math.trunc(item.hits)) : 0;
      const completed = Number.isFinite(item.completed) ? Math.max(0, Math.trunc(item.completed)) : 0;
      if (maxHits > 0 && completed >= maxHits) continue;
      const coverage = Array.isArray(item.coverage)
        ? item.coverage
            .filter((seg) => Array.isArray(seg) && Number.isFinite(seg[0]) && Number.isFinite(seg[1]) && seg[0] <= seg[1])
            .map((seg) => [Math.max(0, Math.trunc(seg[0])), Math.trunc(seg[1])])
        : [];
      this.shares.set(item.token, {
        token: item.token,
        path: item.path,
        filename: typeof item.filename === 'string' ? item.filename : path.basename(item.path),
        size: Number(item.size) || 0,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        hits,
        completed,
        coverage,
        once,
        maxHits,
      });
    }
    this._enforceMax();
    if (raw.length !== this.shares.size) this._markDirty();
  }

  _enforceMax() {
    if (this.shares.size <= this.maxShares) return;
    const sorted = [...this.shares.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const share of sorted.slice(0, this.shares.size - this.maxShares)) this.shares.delete(share.token);
  }

  _serialize() {
    return JSON.stringify({
      version: 1,
      shares: [...this.shares.values()].map((share) => ({
        token: share.token,
        path: share.path,
        filename: share.filename,
        size: share.size,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        hits: share.hits,
        completed: share.completed || 0,
        coverage: Array.isArray(share.coverage) ? share.coverage : [],
        once: share.once,
        maxHits: share.maxHits,
      })),
    });
  }

  /** 变更节流写（≤1s），避免下载命中高频写盘 */
  _markDirty() {
    if (!this.file || this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, 1000);
    if (this._writeTimer.unref) this._writeTimer.unref();
  }

  /** 立即落盘（原子写 0600）；超过 256KB 时淘汰最旧条目 */
  flush() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      let json = this._serialize();
      let guard = 0;
      while (Buffer.byteLength(json, 'utf8') > MAX_SHARES_BYTES && this.shares.size > 1 && guard < 1000) {
        guard += 1;
        const oldest = [...this.shares.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) break;
        this.shares.delete(oldest.token);
        json = this._serialize();
      }
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, json, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      try {
        fs.chmodSync(this.file, 0o600);
      } catch (e) {
        /* ignore */
      }
      return true;
    } catch (e) {
      this.warn('[share] shares.json 写入失败: ' + (e.code || e.message));
      return false;
    }
  }

  get size() {
    return this.shares.size;
  }

  /**
   * 登记一个分享。
   * @param {{filePath:string, filename:string, size:number, ttlMinutes?:number, once?:boolean}} input
   * @returns {object} share（含 token）
   * @throws {Error & {code:'share_limit_reached'}}
   */
  create(input) {
    this.sweep();
    if (this.shares.size >= this.maxShares) {
      const err = new Error('分享数量已达上限');
      err.code = 'share_limit_reached';
      throw err;
    }
    const now = Date.now();
    const ttlMinutes = clampInt(input.ttlMinutes, 1, 1440, this.shareTtlMinutes);
    const once = input.once === true;
    const token = crypto.randomBytes(16).toString('hex');
    const share = {
      token,
      path: input.filePath,
      filename: input.filename,
      size: Number(input.size) || 0,
      createdAt: now,
      expiresAt: now + ttlMinutes * 60 * 1000,
      hits: 0,
      completed: 0,
      coverage: [],
      once,
      maxHits: once ? 1 : this.maxHits,
    };
    this.shares.set(token, share);
    this._markDirty();
    return share;
  }

  /** 取有效分享；不存在/过期/次数用尽一律 null */
  get(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const share = this.shares.get(token);
    if (!share) return null;
    if (share.expiresAt <= Date.now()) {
      this.shares.delete(token);
      this._markDirty();
      return null;
    }
    if (share.maxHits > 0 && share.completed >= share.maxHits) {
      this.shares.delete(token);
      this._markDirty();
      return null;
    }
    return share;
  }

  /** 命中计数（内存） */
  registerHit(token) {
    const share = this.shares.get(token);
    if (!share) return null;
    share.hits += 1;
    this._markDirty();
    return share;
  }

  /**
   * 记录一次「已送达的字节区间」。
   * 只有整个文件（0..size-1）被完整送达才算一次完整下载；
   * 这样 range 分段/断点续传（Android DownloadManager 常见）不会在第一个分段后就消耗掉一次性额度。
   */
  noteDelivery(token, size, start, end) {
    const share = this.shares.get(token);
    if (!share) return;
    const total = Math.max(0, Number(size) || 0);
    const from = Math.max(0, Number(start) || 0);
    const to = Math.min(total - 1, Number.isFinite(end) ? Number(end) : total - 1);

    if (total === 0) {
      share.completed = (share.completed || 0) + 1;
    } else if (from >= 0 && to >= from) {
      const cov = Array.isArray(share.coverage) ? share.coverage : [];
      cov.push([from, to]);
      cov.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const seg of cov) {
        const last = merged[merged.length - 1];
        if (last && seg[0] <= last[1] + 1) last[1] = Math.max(last[1], seg[1]);
        else merged.push([seg[0], seg[1]]);
      }
      share.coverage = merged;
      if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= total - 1) {
        share.completed = (share.completed || 0) + 1;
        share.coverage = [];
      }
    }
    if (share.maxHits > 0 && share.completed >= share.maxHits) {
      this.shares.delete(token);
    }
    this._markDirty();
  }

  /** 兼容旧调用：仅当已完整下载次数达到上限时消耗分享 */
  consumeIfExhausted(token) {
    const share = this.shares.get(token);
    if (!share) return;
    if (share.maxHits > 0 && share.completed >= share.maxHits) {
      this.shares.delete(token);
      this._markDirty();
    }
  }

  /** 供管理接口展示（按 createdAt 倒序） */
  list() {
    this.sweep();
    return [...this.shares.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        token: s.token,
        path: s.path,
        filename: s.filename,
        size: s.size,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        hits: s.hits,
        once: s.once,
      }));
  }

  revoke(token) {
    const removed = this.shares.delete(String(token || ''));
    if (removed) this._markDirty();
    return removed;
  }

  /** 清理过期/用尽记录，返回清理数量 */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [token, share] of this.shares) {
      if (share.expiresAt <= now || (share.maxHits > 0 && share.hits >= share.maxHits)) {
        this.shares.delete(token);
        removed += 1;
      }
    }
    if (removed > 0) this._markDirty();
    return removed;
  }

  /** 进程关闭时先落盘再清空 */
  close() {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    this.flush();
    this.shares.clear();
  }
}

/* ---------------- 二维码 SVG ---------------- */

const QR_MARGIN_MODULES = 4; // 静区（quiet zone），保证深色背景下可扫
const QR_MIN_SIZE = 160;
const QR_MAX_SIZE = 1024;
const QR_DEFAULT_SIZE = 320;

function clampQrSize(size) {
  return clampInt(size, QR_MIN_SIZE, QR_MAX_SIZE, QR_DEFAULT_SIZE);
}

/**
 * 生成二维码 SVG 字符串：白底 + 深色模块 + 4 模块静区。
 * @param {string} text 二维码内容（通常是绝对下载地址）
 * @param {number|string} [size] 像素宽度，160..1024，默认 320
 */
function generateQrSvg(text, size) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();

  const modules = qr.getModuleCount();
  const total = modules + QR_MARGIN_MODULES * 2;
  const width = clampQrSize(size);
  const rects = [];
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      rects.push(`<rect x="${col + QR_MARGIN_MODULES}" y="${row + QR_MARGIN_MODULES}" width="1" height="1"/>`);
    }
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="下载二维码">`
    + `<rect width="${total}" height="${total}" fill="#ffffff"/>`
    + `<g fill="#000000">${rects.join('')}</g>`
    + '</svg>\n';
}

module.exports = {
  SHARE_DEFAULTS,
  SHARES_FILE,
  MAX_SHARES_BYTES,
  ShareStore,
  resolveShareConfig,
  mimeFor,
  contentDisposition,
  rfc5987Encode,
  asciiFilename,
  parseRange,
  generateQrSvg,
  clampQrSize,
  QR_MIN_SIZE,
  QR_MAX_SIZE,
  QR_DEFAULT_SIZE,
  TOKEN_RE,
};
