'use strict';

/**
 * panel-helper 协议：单行 JSON + HMAC-SHA256 + 时间戳 + nonce 防重放
 *
 * 请求：{ nonce, ts, hmac, op, args }
 *   - nonce: 16..64 位 hex（客户端每次随机）
 *   - ts: 毫秒时间戳，允许 ±60s 偏差
 *   - hmac: HMAC_SHA256(secret, op + "\n" + JSON.stringify(args) + "\n" + ts + "\n" + nonce)
 *
 * 响应：{ ok:true, result } 或 { ok:false, error:{code,detail} }
 */

const crypto = require('node:crypto');

const MAX_FRAME_BYTES = 256 * 1024;
const TS_WINDOW_MS = 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;

function canonicalString(op, args, ts, nonce) {
  return `${op}\n${JSON.stringify(args || {})}\n${ts}\n${nonce}`;
}

function sign(secret, op, args, ts, nonce) {
  return crypto.createHmac('sha256', String(secret)).update(canonicalString(op, args, ts, nonce), 'utf8').digest('hex');
}

/**
 * 生成一个已签名请求（客户端用）。
 * @param {string} secret
 * @param {string} op
 * @param {object} args
 * @param {{now?:number, nonce?:string}} [options]
 */
function buildRequest(secret, op, args, options = {}) {
  const ts = typeof options.now === 'number' ? options.now : Date.now();
  const nonce = options.nonce || crypto.randomBytes(16).toString('hex');
  return { nonce, ts, hmac: sign(secret, op, args, ts, nonce), op, args: args || {} };
}

function verifyHmac(secret, req) {
  const expected = Buffer.from(sign(secret, req.op, req.args, req.ts, req.nonce), 'hex');
  let actual;
  try {
    actual = Buffer.from(String(req.hmac), 'hex');
  } catch (e) {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * 校验请求签名与时间戳（nonce 去重由 NonceCache 负责）。
 * @returns {{ok:true, value:{op:string,args:object}}|{ok:false, error:string}}
 */
function verifyRequest(secret, req, options = {}) {
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : TS_WINDOW_MS;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  if (!req || typeof req !== 'object') return { ok: false, error: 'request_shape_invalid' };
  if (typeof req.op !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(req.op)) return { ok: false, error: 'op_invalid' };
  if (typeof req.nonce !== 'string' || !/^[0-9a-f]{16,64}$/i.test(req.nonce)) return { ok: false, error: 'nonce_invalid' };
  if (!Number.isInteger(req.ts)) return { ok: false, error: 'ts_invalid' };
  if (Math.abs(now - req.ts) > windowMs) return { ok: false, error: 'ts_out_of_window' };
  if (typeof req.hmac !== 'string' || !/^[0-9a-f]{64}$/i.test(req.hmac)) return { ok: false, error: 'hmac_invalid' };
  if (req.args !== undefined && (req.args === null || typeof req.args !== 'object' || Array.isArray(req.args))) {
    return { ok: false, error: 'args_invalid' };
  }
  if (!verifyHmac(secret, req)) return { ok: false, error: 'hmac_mismatch' };
  return { ok: true, value: { op: req.op, args: req.args || {} } };
}

/** nonce 内存去重（5 分钟 TTL） */
class NonceCache {
  constructor(ttlMs = NONCE_TTL_MS) {
    this.ttlMs = ttlMs;
    this.seen = new Map(); // nonce -> expiresAt
    this.lastSweep = 0;
  }

  /** 首次出现返回 true 并记录；重复返回 false */
  check(nonce, now = Date.now()) {
    this.sweep(now);
    const expiresAt = this.seen.get(nonce);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  sweep(now = Date.now()) {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(nonce);
    }
  }

  get size() {
    return this.seen.size;
  }
}

module.exports = {
  canonicalString,
  sign,
  buildRequest,
  verifyRequest,
  verifyHmac,
  NonceCache,
  MAX_FRAME_BYTES,
  TS_WINDOW_MS,
  NONCE_TTL_MS,
};
