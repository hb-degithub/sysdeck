'use strict';

/**
 * 通知渠道（零依赖）
 *
 *  - webhook：自动识别企业微信 / 钉钉 / 飞书 URL 格式，否则通用 JSON
 *  - email：node:net / node:tls 手写最小 SMTP 客户端
 *      · 465 端口或 secure=true → 隐式 TLS
 *      · 587 端口且服务器支持 STARTTLS → 升级 TLS
 *      · 25 端口 → 明文
 *      · AUTH LOGIN；整体 8s 超时
 *  - ntfy：HTTP POST（正文即消息）
 *
 * 安全：
 *  - 任何日志 / 接口 / lastError 都不得包含 URL（可能含 key）、用户名、密码
 *  - 发送失败只记录错误码，不阻塞采集
 *  - 串行队列发送，天然限流
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { URL } = require('node:url');

const TIMEOUT_MS = 8000;
const WEBHOOK_TYPES = ['auto', 'generic', 'wecom', 'dingtalk', 'feishu'];

const NOTIFY_DEFAULTS = Object.freeze({
  webhook: { enabled: false, type: 'auto', url: '' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '' },
  ntfy: { enabled: false, url: 'https://ntfy.sh', topic: '' },
});

function defaultNotifyConfig() {
  return JSON.parse(JSON.stringify(NOTIFY_DEFAULTS));
}

function clampPort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return 587;
  return Math.trunc(n);
}

/** 把配置补齐为完整结构（不校验） */
function normalizeNotifyConfig(raw) {
  const cfg = defaultNotifyConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const group of ['webhook', 'email', 'ntfy']) {
    if (src[group] && typeof src[group] === 'object') Object.assign(cfg[group], src[group]);
  }
  cfg.webhook.enabled = cfg.webhook.enabled === true;
  cfg.webhook.type = WEBHOOK_TYPES.includes(String(cfg.webhook.type)) ? String(cfg.webhook.type) : 'auto';
  cfg.webhook.url = String(cfg.webhook.url || '');
  cfg.email.enabled = cfg.email.enabled === true;
  cfg.email.host = String(cfg.email.host || '');
  cfg.email.port = clampPort(cfg.email.port);
  cfg.email.secure = cfg.email.secure === true;
  cfg.email.user = String(cfg.email.user || '');
  cfg.email.pass = String(cfg.email.pass || '');
  cfg.email.from = String(cfg.email.from || '');
  cfg.email.to = String(cfg.email.to || '');
  cfg.ntfy.enabled = cfg.ntfy.enabled === true;
  cfg.ntfy.url = String(cfg.ntfy.url || 'https://ntfy.sh');
  cfg.ntfy.topic = String(cfg.ntfy.topic || '');
  return cfg;
}

/** 错误只保留错误码，绝不带 URL / 账号 / 密码 */
function sanitizeError(err) {
  if (!err) return 'unknown_error';
  if (typeof err.smtpCode === 'number') return `smtp_${err.smtpCode}`;
  if (typeof err.statusCode === 'number') return `http_${err.statusCode}`;
  const code = err.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  return 'request_failed';
}

function notifyError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  return err;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/* ---------------- HTTP POST（8s 超时） ---------------- */

function httpPost(urlString, body, headers, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(notifyError('invalid_url'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const req = mod.request(
      {
        method: 'POST',
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.length,
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode });
          } else {
            const err = notifyError('http_error');
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    const timer = setTimeout(() => {
      req.destroy(notifyError('timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('close', () => clearTimeout(timer));
    req.end(payload);
  });
}

/* ---------------- 最小 SMTP 客户端 ---------------- */

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.waiters = [];
    this.error = null;
    this.closed = false;
    this._onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      this._drain();
    };
    socket.on('data', this._onData);
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => {
      this.closed = true;
      this._fail(notifyError('smtp_closed'));
    });
    this._drain();
  }

  _fail(err) {
    this.error = err;
    if (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter.reject(err);
    }
  }

  _drain() {
    if (!this.waiters.length) return;
    while (this.waiters.length) {
      const lines = this.buffer.split("\r\n");
      let endIdx = -1;
      let code = null;
      let responseLines = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === "" && i === lines.length - 1) break; // 尾部不完整
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) continue;
        if (match[2] === " ") {
          endIdx = i;
          code = Number(match[1]);
          responseLines = lines.slice(0, i + 1);
          break;
        }
      }
      if (endIdx < 0) return;
      this.buffer = lines.slice(endIdx + 1).join("\r\n");
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.resolve({ code, text: responseLines.map((l) => l.slice(4)).join("\n"), lines: responseLines });
      }
    }
  }

  _readResponse() {
    return new Promise((resolve, reject) => {
      if (this.error) {
        reject(this.error);
        return;
      }
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(notifyError('smtp_timeout'));
      }, this.timeoutMs);
      if (timer.unref) timer.unref();
      const wrapResolve = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      const wrapReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      waiter.resolve = wrapResolve;
      waiter.reject = wrapReject;
      this._drain();
    });
  }

  async command(line) {
    this.socket.write(`${line}\r\n`);
    return this._readResponse();
  }

  async upgradeToTls(options) {
    this.socket.removeListener('data', this._onData);
    this.socket.removeListener('error', this._fail);
    this.socket.removeListener('close', this._fail);
    this.buffer = '';
    const secureSocket = tls.connect({ socket: this.socket, ...options });
    await new Promise((resolve, reject) => {
      secureSocket.once('secureConnect', resolve);
      secureSocket.once('error', reject);
    });
    this.socket = secureSocket;
    secureSocket.on('data', this._onData);
    secureSocket.on('error', (err) => this._fail(err));
    secureSocket.on('close', () => {
      this.closed = true;
      this._fail(notifyError('smtp_closed'));
    });
  }

  close() {
    try {
      this.socket.end();
      this.socket.destroy();
    } catch (e) {
      /* ignore */
    }
  }
}

function connectSmtp(cfg, timeoutMs) {
  const useImplicitTls = cfg.secure === true || Number(cfg.port) === 465;
  const host = cfg.host;
  const port = cfg.port;
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => {
      try {
        if (socket) socket.destroy();
      } catch (e) {
        /* ignore */
      }
      reject(notifyError('smtp_timeout'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onConnect = () => {
      clearTimeout(timer);
      resolve(new SmtpSession(socket, timeoutMs));
    };
    const onError = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    if (useImplicitTls) {
      const opts = { host, port, rejectUnauthorized: true };
      if (!net.isIP(host)) opts.servername = host;
      socket = tls.connect(opts, onConnect);
      socket.once('error', onError);
    } else {
      socket = net.connect({ host, port }, onConnect);
      socket.once('error', onError);
    }
  });
}

const B64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

function buildMailMessage(cfg, subject, body) {
  const recipients = String(cfg.to || '')
    .split(/[,;\s]+/)
    .filter(Boolean);
  const headers = [
    `From: ${cfg.from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: =?UTF-8?B?${B64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const bodyB64 = B64(body).replace(/(.{76})/g, '$1\r\n');
  return { recipients, data: `${headers.join('\r\n')}\r\n\r\n${bodyB64}\r\n` };
}

async function sendMail(cfg, subject, body, timeoutMs = TIMEOUT_MS) {
  let session = null;
  let timer = null;
  const overall = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(notifyError("smtp_timeout")), timeoutMs);
    if (timer.unref) timer.unref();
  });

  const run = async () => {
    session = await connectSmtp(cfg, timeoutMs);
    const expect = (response, expected) => {
      if (response.code !== expected) {
        const err = notifyError("smtp_unexpected");
        err.smtpCode = response.code;
        throw err;
      }
    };
    expect(await session._readResponse(), 220); // greeting
    let ehlo = await session.command("EHLO localhost");
    if (ehlo.code !== 250) {
      const err = notifyError("smtp_ehlo");
      err.smtpCode = ehlo.code;
      throw err;
    }
    const startTlsAllowed = Number(cfg.port) !== 465 && cfg.secure !== true;
    if (startTlsAllowed && /\bSTARTTLS\b/i.test(ehlo.text)) {
      const start = await session.command("STARTTLS");
      if (start.code !== 220) {
        const err = notifyError("smtp_starttls");
        err.smtpCode = start.code;
        throw err;
      }
      const opts = { rejectUnauthorized: true };
      if (!net.isIP(cfg.host)) opts.servername = cfg.host;
      await session.upgradeToTls(opts);
      ehlo = await session.command("EHLO localhost");
      if (ehlo.code !== 250) {
        const err = notifyError("smtp_ehlo");
        err.smtpCode = ehlo.code;
        throw err;
      }
    }

    if (cfg.user || cfg.pass) {
      let auth = await session.command("AUTH LOGIN");
      if (auth.code !== 334) {
        const err = notifyError("smtp_auth");
        err.smtpCode = auth.code;
        throw err;
      }
      auth = await session.command(B64(cfg.user));
      if (auth.code !== 334) {
        const err = notifyError("smtp_auth");
        err.smtpCode = auth.code;
        throw err;
      }
      auth = await session.command(B64(cfg.pass));
      if (auth.code !== 235) {
        const err = notifyError("smtp_auth");
        err.smtpCode = auth.code;
        throw err;
      }
    }

    const { recipients, data } = buildMailMessage(cfg, subject, body);
    expect(await session.command(`MAIL FROM:<${cfg.from}>`), 250);
    for (const rcpt of recipients) {
      expect(await session.command(`RCPT TO:<${rcpt}>`), 250);
    }
    expect(await session.command("DATA"), 354);
    await session.command(`${data}.`);
    try {
      await session.command("QUIT");
    } catch (e) {
      /* QUIT 失败不影响已投递结果 */
    }
  };

  try {
    await Promise.race([run(), overall]);
  } finally {
    if (timer) clearTimeout(timer);
    if (session) session.close();
  }
}

/* ---------------- 通知器 ---------------- */

class Notifier {
  /**
   * @param {{config?:object, logger?:object, timeoutMs?:number}} options
   *   config 传引用（config.notify），update 后就地修改，便于上层 saveConfig
   */
  constructor(options = {}) {
    this.config = normalizeNotifyConfig(options.config || {});
    // 就地同步回原对象，保证 PUT 后 config.json 持久化的是新值
    this.configRef = options.config && typeof options.config === 'object' ? options.config : null;
    if (this.configRef) {
      this.configRef.webhook = this.config.webhook;
      this.configRef.email = this.config.email;
      this.configRef.ntfy = this.config.ntfy;
    }
    this.logger = options.logger || console;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TIMEOUT_MS;
    this.lastSentAt = null;
    this.lastError = null;
    this.queue = Promise.resolve();
  }

  /** 对外展示：绝不回显 webhook.url / email.pass / email.user */
  describe() {
    return {
      webhook: {
        enabled: this.config.webhook.enabled,
        type: this.config.webhook.type,
        urlSet: Boolean(this.config.webhook.url),
      },
      email: {
        enabled: this.config.email.enabled,
        host: this.config.email.host,
        port: this.config.email.port,
        secure: this.config.email.secure,
        userSet: Boolean(this.config.email.user),
        toSet: Boolean(this.config.email.to),
        fromSet: Boolean(this.config.email.from),
      },
      ntfy: {
        enabled: this.config.ntfy.enabled,
        url: this.config.ntfy.url,
        topic: this.config.ntfy.topic,
      },
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
    };
  }

  /**
   * 更新配置。空字符串 = 保持原值；null = 清空该字段。
   * @returns {{ok:true}}
   */
  update(payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    // 先在副本上应用并校验，失败时不污染现有配置
    const next = JSON.parse(JSON.stringify(this.config));

    const applyString = (target, key, incoming) => {
      if (incoming === undefined) return;
      if (incoming === null) {
        target[key] = "";
        return;
      }
      if (incoming === "") return; // 空串=保持
      target[key] = String(incoming);
    };
    const applyBool = (target, key, incoming) => {
      if (incoming === undefined) return;
      if (incoming === null) {
        target[key] = false;
        return;
      }
      if (typeof incoming !== "boolean") throw notifyError("invalid_notify", key + " 必须是布尔值");
      target[key] = incoming;
    };
    const applyPort = (target, key, incoming) => {
      if (incoming === undefined) return;
      if (incoming === null) {
        target[key] = 587;
        return;
      }
      const n = Number(incoming);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw notifyError("invalid_notify", "email.port 必须是 1..65535");
      target[key] = n;
    };

    if (body.webhook !== undefined) {
      if (body.webhook === null || typeof body.webhook !== "object") throw notifyError("invalid_notify", "webhook 必须是对象");
      const w = body.webhook;
      applyBool(next.webhook, "enabled", w.enabled);
      if (w.type !== undefined) {
        if (w.type === null) next.webhook.type = "auto";
        else if (!WEBHOOK_TYPES.includes(String(w.type))) throw notifyError("invalid_notify", "webhook.type 无效");
        else next.webhook.type = String(w.type);
      }
      applyString(next.webhook, "url", w.url);
    }
    if (body.email !== undefined) {
      if (body.email === null || typeof body.email !== "object") throw notifyError("invalid_notify", "email 必须是对象");
      const e = body.email;
      applyBool(next.email, "enabled", e.enabled);
      applyBool(next.email, "secure", e.secure);
      applyString(next.email, "host", e.host);
      applyString(next.email, "user", e.user);
      applyString(next.email, "pass", e.pass);
      applyString(next.email, "from", e.from);
      applyString(next.email, "to", e.to);
      applyPort(next.email, "port", e.port);
    }
    if (body.ntfy !== undefined) {
      if (body.ntfy === null || typeof body.ntfy !== "object") throw notifyError("invalid_notify", "ntfy 必须是对象");
      const n = body.ntfy;
      applyBool(next.ntfy, "enabled", n.enabled);
      applyString(next.ntfy, "url", n.url);
      applyString(next.ntfy, "topic", n.topic);
    }

    this._validate(next);
    this.config.webhook = next.webhook;
    this.config.email = next.email;
    this.config.ntfy = next.ntfy;
    if (this.configRef) {
      this.configRef.webhook = next.webhook;
      this.configRef.email = next.email;
      this.configRef.ntfy = next.ntfy;
    }
    return { ok: true };
  }

  _validate(cfg = this.config) {
    if (cfg.webhook.enabled) {
      if (!cfg.webhook.url || !isHttpUrl(cfg.webhook.url)) {
        throw notifyError("invalid_notify", "webhook 启用时必须提供合法 http(s) url");
      }
    }
    if (cfg.email.enabled) {
      if (!cfg.email.host) throw notifyError("invalid_notify", "email 启用时必须提供 host");
      if (!cfg.email.from) throw notifyError("invalid_notify", "email 启用时必须提供 from");
      if (!cfg.email.to) throw notifyError("invalid_notify", "email 启用时必须提供 to");
      if (!/^[^\s@]+@[^\s@]+$/.test(cfg.email.from)) throw notifyError("invalid_notify", "email.from 不是合法邮箱");
      for (const addr of cfg.email.to.split(/[,;\s]+/).filter(Boolean)) {
        if (!/^[^\s@]+@[^\s@]+$/.test(addr)) throw notifyError("invalid_notify", "email.to 含非法邮箱");
      }
    }
    if (cfg.ntfy.enabled) {
      if (!isHttpUrl(cfg.ntfy.url)) throw notifyError("invalid_notify", "ntfy.url 必须是 http(s)");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.ntfy.topic)) throw notifyError("invalid_notify", "ntfy.topic 只能是 1..64 位字母数字/下划线/连字符");
    }
  }

  _hasAnyChannel() {
    return this.config.webhook.enabled || this.config.email.enabled || this.config.ntfy.enabled;
  }

  /** 告警事件异步发送（fire-and-forget，串行队列） */
  sendAlert(event) {
    if (!this._hasAnyChannel()) return Promise.resolve({ skipped: true });
    return this._enqueue(() => this._sendAll(event));
  }

  /** 等待队列清空（测试/关闭用） */
  flush() {
    return this.queue;
  }

  _enqueue(job) {
    this.queue = this.queue
      .then(() => job())
      .catch((err) => {
        this._recordError(err);
        return undefined;
      });
    return this.queue;
  }

  _recordError(err) {
    this.lastError = sanitizeError(err);
  }

  async _sendAll(event) {
    const channels = [];
    if (this.config.webhook.enabled) channels.push('webhook');
    if (this.config.email.enabled) channels.push('email');
    if (this.config.ntfy.enabled) channels.push('ntfy');
    let sent = false;
    for (const channel of channels) {
      try {
        await this._sendOne(channel, event);
        sent = true;
      } catch (err) {
        this._recordError(err);
      }
    }
    if (sent) this.lastSentAt = Date.now();
    return { sent };
  }

  /** 发送单条测试消息，返回 {ok, detail, elapsedMs}（detail 不含敏感信息） */
  async test(channel) {
    const start = Date.now();
    try {
      if (channel === 'webhook') {
        if (!this.config.webhook.url || !isHttpUrl(this.config.webhook.url)) {
          return { ok: false, detail: 'not_configured', elapsedMs: Date.now() - start };
        }
        await this._sendWebhook(this._buildText(null, 'test'));
      } else if (channel === 'email') {
        if (!this.config.email.host || !this.config.email.to || !this.config.email.from) {
          return { ok: false, detail: 'not_configured', elapsedMs: Date.now() - start };
        }
        await sendMail(this.config.email, '服务器面板通知测试', this._buildText(null, 'test'), this.timeoutMs);
      } else if (channel === 'ntfy') {
        if (!isHttpUrl(this.config.ntfy.url) || !this.config.ntfy.topic) {
          return { ok: false, detail: 'not_configured', elapsedMs: Date.now() - start };
        }
        await this._sendNtfy(this._buildText(null, 'test'));
      } else {
        return { ok: false, detail: 'invalid_channel', elapsedMs: Date.now() - start };
      }
      return { ok: true, detail: 'ok', elapsedMs: Date.now() - start };
    } catch (err) {
      const detail = sanitizeError(err);
      this._recordError(err);
      return { ok: false, detail, elapsedMs: Date.now() - start };
    }
  }

  async _sendOne(channel, event) {
    const text = this._buildText(event, event.type === 'recover' ? 'recover' : 'alert');
    if (channel === 'webhook') return this._sendWebhook(text, event);
    if (channel === 'email') {
      const severity = event.severity === 'crit' ? '严重' : '警告';
      const subject = event.type === 'recover' ? `【服务器面板】恢复：${event.metricLabel || event.metric}` : `【服务器面板】${severity}：${event.metricLabel || event.metric}`;
      return sendMail(this.config.email, subject, text, this.timeoutMs);
    }
    if (channel === 'ntfy') return this._sendNtfy(text, event);
    throw notifyError('invalid_channel');
  }

  _buildText(event, kind) {
    if (!event) return '【服务器面板】这是一条测试通知，收到即表示通知渠道配置成功。';
    if (kind === 'recover') {
      return `【服务器面板】恢复通知：${event.metricLabel || event.metric} 已恢复正常（当前值 ${event.value}）。`;
    }
    const severity = event.severity === 'crit' ? '严重' : '警告';
    return `【服务器面板】${severity}告警：${event.metricLabel || event.metric} 当前值 ${event.value}，阈值 ${event.threshold}，已持续 ${
      event.durationSec || 0
    } 秒。`;
  }

  _webhookKind(url) {
    const type = this.config.webhook.type;
    if (type && type !== 'auto') return type;
    const value = String(url);
    if (value.includes('qyapi.weixin.qq.com')) return 'wecom';
    if (value.includes('oapi.dingtalk.com')) return 'dingtalk';
    if (value.includes('open.feishu.cn')) return 'feishu';
    return 'generic';
  }

  _webhookPayload(text, kind, event) {
    if (kind === 'wecom' || kind === 'dingtalk') {
      return { msgtype: 'text', text: { content: text } };
    }
    if (kind === 'feishu') {
      return { msg_type: 'text', content: { text } };
    }
    return {
      text,
      source: 'server-panel',
      ...(event
        ? {
            type: event.type || 'alert',
            severity: event.severity,
            metric: event.metric,
            value: event.value,
            threshold: event.threshold,
          }
        : {}),
    };
  }

  async _sendWebhook(text, event) {
    const kind = this._webhookKind(this.config.webhook.url);
    const payload = this._webhookPayload(text, kind, event);
    await httpPost(this.config.webhook.url, JSON.stringify(payload), {}, this.timeoutMs);
  }

  async _sendNtfy(text, event) {
    const base = this.config.ntfy.url.replace(/\/+$/, '');
    const url = `${base}/${encodeURIComponent(this.config.ntfy.topic)}`;
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: 'server-panel',
      Priority: event && event.severity === 'crit' ? '5' : '3',
    };
    await httpPost(url, text, headers, this.timeoutMs);
  }
}

module.exports = {
  Notifier,
  NOTIFY_DEFAULTS,
  defaultNotifyConfig,
  normalizeNotifyConfig,
  sanitizeError,
  sendMail,
  httpPost,
  TIMEOUT_MS,
};
