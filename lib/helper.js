'use strict';

/**
 * 面板侧 panel-helper 客户端
 *
 * - 通过 Unix Socket 调用 root helper，HMAC-SHA256 + 时间戳 + nonce（协议见 helper/protocol.js）
 * - 单次请求超时（默认 10s），错误统一为 HelperError：
 *     helper_unavailable / helper_denied / helper_timeout / helper_error
 * - 密钥只从文件读取（缓存 mtime/size），不写入日志/响应
 */

const net = require('node:net');
const fs = require('node:fs');
const protocol = require('../helper/protocol');

const HELPER_VERSION = '1.0.0';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

class HelperError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'HelperError';
    this.code = code || 'helper_error';
    this.detail = detail || this.code;
  }
}

class HelperClient {
  /**
   * @param {{socketPath?:string, secretFile?:string, timeoutMs?:number}} options
   */
  constructor(options = {}) {
    this.socketPath = options.socketPath || '/run/server-panel/helper.sock';
    this.secretFile = options.secretFile || '/etc/server-panel/helper.secret';
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this._secretCache = null;
  }

  /** 读取密钥（缓存）；失败归为 helper_unavailable */
  readSecret() {
    let stat;
    try {
      stat = fs.statSync(this.secretFile);
    } catch (e) {
      throw new HelperError('helper_unavailable', 'helper 密钥不可读');
    }
    if (this._secretCache && this._secretCache.mtimeMs === stat.mtimeMs && this._secretCache.size === stat.size) {
      return this._secretCache.value;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.secretFile, 'utf8').trim();
    } catch (e) {
      throw new HelperError('helper_unavailable', 'helper 密钥不可读');
    }
    if (raw.length < 32) throw new HelperError('helper_unavailable', 'helper 密钥无效');
    this._secretCache = { mtimeMs: stat.mtimeMs, size: stat.size, value: raw };
    return raw;
  }

  /** 仅探测 socket 是否可连接（不发送请求） */
  available() {
    if (!fs.existsSync(this.socketPath)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const socket = net.connect(this.socketPath);
      const timer = setTimeout(() => finish(false), Math.min(2000, this.timeoutMs));
      if (timer.unref) timer.unref();
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch (e) {
          /* ignore */
        }
        resolve(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }

  /**
   * 调用 helper op。
   * @param {string} op
   * @param {object} [args]
   * @param {{timeoutMs?:number}} [options]
   */
  call(op, args = {}, options = {}) {
    let secret;
    let request;
    try {
      secret = this.readSecret();
      request = protocol.buildRequest(secret, op, args || {});
    } catch (e) {
      return Promise.reject(e);
    }
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      let socket;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (socket) socket.destroy();
        } catch (e) {
          /* ignore */
        }
        fn(value);
      };

      const timer = setTimeout(() => {
        finish(reject, new HelperError('helper_timeout', 'helper 响应超时'));
      }, timeoutMs);
      if (timer.unref) timer.unref();

      try {
        socket = net.connect(this.socketPath);
      } catch (e) {
        finish(reject, new HelperError('helper_unavailable', '无法连接 helper'));
        return;
      }

      socket.setEncoding('utf8');
      socket.once('connect', () => {
        try {
          socket.write(`${JSON.stringify(request)}\n`);
        } catch (e) {
          finish(reject, new HelperError('helper_error', '发送请求失败'));
        }
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
          finish(reject, new HelperError('helper_error', 'helper 响应过大'));
          return;
        }
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        let response;
        try {
          response = JSON.parse(line);
        } catch (e) {
          finish(reject, new HelperError('helper_error', 'helper 响应不是合法 JSON'));
          return;
        }
        if (!response || typeof response !== 'object') {
          finish(reject, new HelperError('helper_error', 'helper 响应结构非法'));
          return;
        }
        if (response.ok === true) {
          finish(resolve, response.result);
          return;
        }
        const code = response.error && typeof response.error.code === 'string' ? response.error.code : 'helper_error';
        const detail = response.error && typeof response.error.detail === 'string' ? response.error.detail : 'helper 调用失败';
        finish(reject, new HelperError(code, detail));
      });
      socket.once('error', (err) => {
        const code = err && err.code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES' || code === 'ENOTSOCK') {
          finish(reject, new HelperError('helper_unavailable', '需要安装/启动 panel-helper'));
        } else {
          finish(reject, new HelperError('helper_error', 'helper 连接异常'));
        }
      });
      socket.once('end', () => {
        if (!settled) finish(reject, new HelperError('helper_error', 'helper 提前关闭连接'));
      });
    });
  }
}

module.exports = { HelperClient, HelperError, HELPER_VERSION, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS };
