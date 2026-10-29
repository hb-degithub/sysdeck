'use strict';

/**
 * 审计日志读取（GET /api/audit）
 *
 * audit.log 行格式：`<ISO 时间> <ip> <message>`；message 首词作为 action，其余作为 detail。
 * 兼容历史行：部分旧记录写日志时没有 IP 占位（形如 `<ISO 时间> <message>`），
 * 解析时若第二个 token 不是 IP（IPv4/IPv6/`-`），则把它并入 message，ip 记为 `-`。
 * 只读取文件末尾 maxBytes（默认 2MB），坏行跳过；结果按时间倒序并支持 q 过滤与分页。
 */

const fs = require('node:fs');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(\S+)(?:\s+(.*))?$/;

/** 判断 token 是否像 IP 或占位符 '-'（仅用于解析历史无 IP 行） */
function looksLikeIp(token) {
  if (!token) return false;
  if (token === '-' || token === 'unknown') return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(token)) return true; // IPv4
  if (token.includes(':') && token.length <= 64 && /^[0-9A-Fa-f:.%]+$/.test(token)) return true; // IPv6 / IPv4-mapped
  return false;
}

function parseAuditLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const match = LINE_RE.exec(text);
  if (!match) return null;
  const ts = match[1];
  const second = match[2];
  let ip = '-';
  let message;
  if (looksLikeIp(second)) {
    ip = second;
    message = (match[3] || '').trim();
  } else {
    // 历史行没有 IP 占位：把第二个 token 还给 message
    message = `${second}${match[3] ? ` ${match[3]}` : ''}`.trim();
  }
  if (!message) return null;
  const space = message.search(/\s/);
  const action = space > 0 ? message.slice(0, space) : message;
  const detail = space > 0 ? message.slice(space + 1).trim() : '';
  return { ts, ip, action, detail };
}

/**
 * 读取审计日志尾部并分页。
 * @param {{file:string, limit?:number, offset?:number, q?:string, maxBytes?:number}} options
 * @returns {{entries:Array, total:number, truncated:boolean}}
 */
function readAuditEntries(options = {}) {
  const file = options.file;
  const limit = Math.min(1000, Math.max(1, Math.trunc(Number(options.limit)) || 200));
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0);
  const q = String(options.q || '').trim().toLowerCase();
  const maxBytes = Math.max(4096, Math.trunc(Number(options.maxBytes)) || DEFAULT_MAX_BYTES);

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return { entries: [], total: 0, truncated: false };
  }
  if (!stat.isFile() || stat.size === 0) return { entries: [], total: 0, truncated: false };

  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.alloc(length);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, start);
  } catch (e) {
    return { entries: [], total: 0, truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
    }
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    // 丢弃可能被截断的首行（不含完整行首时间戳）
    const newline = text.indexOf('\n');
    text = newline >= 0 ? text.slice(newline + 1) : '';
  }
  const entries = [];
  for (const line of text.split('\n')) {
    const parsed = parseAuditLine(line);
    if (parsed) entries.push(parsed);
  }
  entries.reverse(); // 最新在前

  const filtered = q
    ? entries.filter((entry) => `${entry.ts} ${entry.ip} ${entry.action} ${entry.detail}`.toLowerCase().includes(q))
    : entries;
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  return {
    entries: page,
    total,
    truncated: start > 0 || offset + page.length < total,
  };
}

module.exports = { readAuditEntries, parseAuditLine, DEFAULT_MAX_BYTES };
