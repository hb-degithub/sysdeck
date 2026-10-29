'use strict';

/**
 * 备份 / 恢复（零依赖）
 *
 * - 手写 tar（ustar）+ node:zlib gzip，打包：
 *     config.json / data/metrics.db（先 wal_checkpoint(TRUNCATE)）/ data/remember.json / data/audit.log
 * - 存 <DATA_DIR>/backups/server-panel-backup-YYYYMMDD-HHmmss.tar.gz（0600，原子写）
 * - restore 前严格校验 tar：路径白名单、禁止绝对路径 / ..、类型必须普通文件、大小上限
 * - 恢复时原文件先改名为 *.bak，再原子落盘；返回 restartRequired:true
 * - 自动备份：config.backup {auto, keep, hour}，每天检查一次（可补跑当天），只保留最近 keep 份
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const BACKUP_RE = /^server-panel-backup-\d{8}-\d{6}\.tar\.gz$/;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024; // 压缩包上限
const MAX_TAR_BYTES = 512 * 1024 * 1024; // 解压后 tar 上限
const MAX_ENTRY_BYTES = 256 * 1024 * 1024; // 单个成员上限
const MAX_ENTRIES = 16;
const ALLOWED_ENTRIES = new Set(['config.json', 'data/metrics.db', 'data/remember.json', 'data/audit.log']);

const DEFAULTS = Object.freeze({ auto: true, keep: 7, hour: 4 });

function resolveBackupConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const keep = Number(raw.keep);
  const hour = Number(raw.hour);
  return {
    auto: raw.auto !== false,
    keep: Number.isInteger(keep) && keep >= 1 && keep <= 100 ? keep : DEFAULTS.keep,
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULTS.hour,
  };
}

function backupError(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  return err;
}

/* ---------------- tar 写入 ---------------- */

function octal(value, length) {
  const text = Math.max(0, Math.trunc(Number(value) || 0)).toString(8);
  return `${text.padStart(length - 1, '0')}\0`;
}

function writeString(buf, offset, length, text) {
  const raw = Buffer.from(String(text), 'utf8');
  raw.copy(buf, offset, 0, Math.min(raw.length, length));
}

/** 构造一个 512 字节 tar 头 */
function buildTarHeader(name, size, options = {}) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(options.mode === undefined ? 0o600 : options.mode, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(size, 12));
  writeString(header, 136, 12, octal(options.mtime === undefined ? Math.floor(Date.now() / 1000) : options.mtime, 12));
  // checksum 先填 8 个空格，计算后写入
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  header[156] = 0x30; // '0' 普通文件
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, options.uname || 'server-panel');
  writeString(header, 297, 32, options.gname || 'server-panel');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/**
 * 构建 tar 缓冲。
 * @param {Array<{name:string,data:Buffer,mode?:number,mtime?:number}>} entries
 */
function createTarBuffer(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    if (Buffer.byteLength(entry.name, 'utf8') > 100) {
      throw backupError('invalid_entry', 'tar 成员路径过长');
    }
    chunks.push(buildTarHeader(entry.name, data.length, entry));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/* ---------------- tar 解析（严格校验） ---------------- */

function parseOctal(buffer) {
  const text = buffer.toString('utf8').replace(/\0/g, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) return NaN;
  return parseInt(text, 8);
}

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return (end >= 0 ? slice.subarray(0, end) : slice).toString('utf8');
}

function verifyChecksum(header) {
  const stored = parseOctal(header.subarray(148, 156));
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === stored;
}

function isSafeEntryName(name) {
  if (!name) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (name.includes('\0')) return false;
  const parts = name.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) return false;
  if (name.includes('\\')) return false;
  return ALLOWED_ENTRIES.has(name);
}

/**
 * 解析 tar 缓冲并做安全校验。
 * @returns {Array<{name:string, data:Buffer, mode:number}>}
 */
function parseTarBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) throw backupError('invalid_tar', 'tar 数据过短');
  if (buffer.length > MAX_TAR_BYTES) throw backupError('invalid_tar', 'tar 超过大小上限');
  const entries = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // 结束块
    if (!verifyChecksum(header)) throw backupError('invalid_tar', 'tar 头校验失败');
    const typeflag = header[156];
    if (typeflag !== 0x30 && typeflag !== 0) throw backupError('invalid_tar', '仅允许普通文件');
    const name = readString(header, 0, 100);
    if (!isSafeEntryName(name)) throw backupError('invalid_tar', `非法成员路径: ${name}`);
    if (entries.some((entry) => entry.name === name)) throw backupError('invalid_tar', '重复成员');
    const size = parseOctal(header.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) throw backupError('invalid_tar', '成员大小非法');
    const mode = parseOctal(header.subarray(100, 108)) || 0o600;
    const start = offset + 512;
    if (start + size > buffer.length) throw backupError('invalid_tar', '成员数据不完整');
    totalBytes += size;
    if (totalBytes > MAX_TAR_BYTES) throw backupError('invalid_tar', '解压总量超过上限');
    entries.push({ name, data: buffer.subarray(start, start + size), mode });
    if (entries.length > MAX_ENTRIES) throw backupError('invalid_tar', '成员过多');
    offset = start + size + ((512 - (size % 512)) % 512);
  }
  if (entries.length === 0) throw backupError('invalid_tar', '空 tar');
  return entries;
}

function gunzipLimited(buffer) {
  try {
    return zlib.gunzipSync(buffer, { maxOutputLength: MAX_TAR_BYTES });
  } catch (e) {
    throw backupError('invalid_backup', '备份文件不是合法的 gzip/tar');
  }
}

/* ---------------- 时间格式 ---------------- */

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/* ---------------- 备份管理器 ---------------- */

class BackupManager {
  /**
   * @param {{configPath:string, dataDir:string, store?:object, backupConfig?:object, logger?:object}} options
   */
  constructor(options = {}) {
    this.configPath = options.configPath;
    this.dataDir = options.dataDir;
    this.store = options.store || null;
    this.config = resolveBackupConfig(options.backupConfig);
    this.logger = options.logger || console;
    this.backupDir = path.join(this.dataDir, 'backups');
    this.lastAutoDay = null;
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
  }

  get autoView() {
    return { enabled: this.config.auto, keep: this.config.keep };
  }

  /** 更新自动备份设置（server 侧已做类型/范围校验） */
  updateSettings(patch = {}) {
    this.config = resolveBackupConfig({ ...this.config, ...patch });
    return this.autoView;
  }

  _sourceFiles() {
    return [
      { name: 'config.json', file: this.configPath, mode: 0o600 },
      { name: 'data/metrics.db', file: path.join(this.dataDir, 'metrics.db'), mode: 0o600 },
      { name: 'data/remember.json', file: path.join(this.dataDir, 'remember.json'), mode: 0o600 },
      { name: 'data/audit.log', file: path.join(this.dataDir, 'audit.log'), mode: 0o600 },
    ];
  }

  /** 创建备份，返回 {id, filename, size, createdAt} */
  create() {
    if (this.store && typeof this.store.checkpoint === 'function') {
      try {
        this.store.checkpoint();
      } catch (e) {
        /* checkpoint 失败不阻塞备份 */
      }
    }
    const entries = [];
    for (const item of this._sourceFiles()) {
      let stat;
      try {
        stat = fs.statSync(item.file);
      } catch (e) {
        continue; // 文件不存在：跳过
      }
      if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) continue;
      entries.push({ name: item.name, data: fs.readFileSync(item.file), mode: item.mode, mtime: Math.floor(stat.mtimeMs / 1000) });
    }
    if (entries.length === 0) throw backupError('backup_failed', '没有可备份的文件');

    const tar = createTarBuffer(entries);
    const gz = zlib.gzipSync(tar, { level: 9 });
    if (gz.length > MAX_ARCHIVE_BYTES) throw backupError('backup_failed', '备份文件超过大小上限');

    // 文件名精确到秒；同一秒内多次备份时向后顺延，保证唯一且符合命名规范
    let when = new Date();
    let filename = `server-panel-backup-${formatTimestamp(when)}.tar.gz`;
    for (let i = 0; fs.existsSync(path.join(this.backupDir, filename)) && i < 120; i += 1) {
      when = new Date(when.getTime() + 1000);
      filename = `server-panel-backup-${formatTimestamp(when)}.tar.gz`;
    }
    const target = path.join(this.backupDir, filename);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, gz, { mode: 0o600 });
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch (e) {
      /* ignore */
    }
    const stat = fs.statSync(target);
    return {
      id: filename,
      filename,
      size: stat.size,
      createdAt: Math.round(stat.mtimeMs),
    };
  }

  /** 备份列表（createdAt 倒序） */
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.backupDir);
    } catch (e) {
      names = [];
    }
    const backups = [];
    for (const name of names) {
      if (!BACKUP_RE.test(name)) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(this.backupDir, name));
      } catch (e) {
        continue;
      }
      if (!stat.isFile()) continue;
      backups.push({ id: name, filename: name, size: stat.size, createdAt: Math.round(stat.mtimeMs) });
    }
    backups.sort((a, b) => b.createdAt - a.createdAt);
    return backups;
  }

  _resolveId(id) {
    const value = String(id || '');
    if (!BACKUP_RE.test(value)) throw backupError('backup_not_found', '备份 id 非法');
    const file = path.join(this.backupDir, value);
    if (!fs.existsSync(file)) throw backupError('backup_not_found', '备份不存在');
    return file;
  }

  /** 打开备份文件流（供下载） */
  open(id) {
    const file = this._resolveId(id);
    const stat = fs.statSync(file);
    return { stream: fs.createReadStream(file), size: stat.size, filename: path.basename(file) };
  }

  delete(id) {
    const file = this._resolveId(id);
    fs.unlinkSync(file);
    return { ok: true };
  }

  /**
   * 校验并恢复备份。
   * @returns {{ok:true, restartRequired:true, restored:string[]}}
   */
  restore(id) {
    const file = this._resolveId(id);
    const stat = fs.statSync(file);
    if (stat.size > MAX_ARCHIVE_BYTES) throw backupError('invalid_backup', '备份文件超过大小上限');
    const compressed = fs.readFileSync(file);
    const tar = gunzipLimited(compressed);
    const entries = parseTarBuffer(tar);

    // 先全部校验，再统一写盘
    const targets = entries.map((entry) => {
      const target = entry.name === 'config.json'
        ? this.configPath
        : path.join(this.dataDir, entry.name.replace(/^data\//, ''));
      return { ...entry, target };
    });

    const restored = [];
    for (const item of targets) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true, mode: 0o700 });
      if (fs.existsSync(item.target)) {
        const bak = `${item.target}.bak`;
        try {
          fs.unlinkSync(bak);
        } catch (e) {
          /* ignore */
        }
        fs.renameSync(item.target, bak);
      }
      const tmp = `${item.target}.restore-tmp`;
      fs.writeFileSync(tmp, item.data, { mode: item.mode || 0o600 });
      fs.renameSync(tmp, item.target);
      try {
        fs.chmodSync(item.target, item.mode || 0o600);
      } catch (e) {
        /* ignore */
      }
      restored.push(item.name);
    }
    // 恢复 metrics.db 后清掉旧 WAL/SHM，避免旧预写日志掩盖新数据
    if (restored.includes('data/metrics.db')) {
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.unlinkSync(path.join(this.dataDir, `metrics.db${suffix}`));
        } catch (e) {
          /* ignore */
        }
      }
    }
    return { ok: true, restartRequired: true, restored };
  }

  /** 仅保留最近 keep 份 */
  pruneToKeep(keep = this.config.keep) {
    const backups = this.list();
    let removed = 0;
    for (const backup of backups.slice(keep)) {
      try {
        fs.unlinkSync(path.join(this.backupDir, backup.filename));
        removed += 1;
      } catch (e) {
        /* ignore */
      }
    }
    return removed;
  }

  /**
   * 每天一次自动备份（可补跑当天）：仅在 now.getHours() >= hour 时执行。
   * @returns {{ran:boolean, created?:object, pruned?:number}}
   */
  checkAuto(now = new Date()) {
    if (!this.config.auto) return { ran: false };
    const today = dayKey(now);
    if (this.lastAutoDay === today) return { ran: false };
    if (now.getHours() < this.config.hour) return { ran: false };
    let created;
    try {
      created = this.create();
    } catch (e) {
      this.logger.warn?.(`[backup] 自动备份失败: ${e.code || e.message}`);
      return { ran: false };
    }
    this.lastAutoDay = today;
    const pruned = this.pruneToKeep(this.config.keep);
    return { ran: true, created, pruned };
  }
}

module.exports = {
  BackupManager,
  createTarBuffer,
  parseTarBuffer,
  resolveBackupConfig,
  formatTimestamp,
  BACKUP_RE,
  DEFAULTS,
  MAX_ARCHIVE_BYTES,
  MAX_TAR_BYTES,
  MAX_ENTRY_BYTES,
};
