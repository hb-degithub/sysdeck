'use strict';

/**
 * 文件管理器
 *
 * 支持全盘浏览（根目录 /），提供：
 *   - 目录列表（含大小、权限、属主、修改时间）
 *   - 读取文本文件（带大小上限）
 *   - 写入/新建文本文件
 *   - 新建目录、重命名、删除（递归）
 *   - 上传（流式）、下载（流式）
 *   - 压缩 / 解压（tar.gz / zip）
 *
 * 安全策略：
 *   - 所有路径经 resolve + 校验，禁止路径穿越（../ 逃逸）
 *   - 命令一律用 execFile 传数组参数，不经过 shell，杜绝注入
 *   - 敏感操作由上层记录审计日志
 *   - 上传/写入有大小上限，避免塞满磁盘
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const LIMITS = {
  maxReadBytes: 2 * 1024 * 1024, // 单文件读取上限 2MB
  maxWriteBytes: 10 * 1024 * 1024, // 写入上限 10MB
  maxUploadBytes: 2048 * 1024 * 1024, // 上传上限 2GB
  maxListEntries: 5000, // 单目录最多列出条目
};

/** 系统伪文件系统，浏览时默认隐藏（可显式查看） */
const PSEUDO_FS = new Set([
  '/proc', '/sys', '/dev', '/run', '/snap',
]);

/**
 * 解析并校验路径
 * @param {string} input 用户输入路径
 * @returns {string} 绝对路径
 */
function resolveSafe(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('路径不能为空');
  }
  if (input.includes('\0')) {
    throw new Error('路径包含非法字符');
  }
  // 以 / 为基准解析，消除 ../ 与重复斜杠
  const abs = path.resolve('/', input);
  // 二次确认：解析结果必须以 / 开头且不含 ..
  const normalized = path.normalize(abs);
  if (!normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('非法路径');
  }
  return normalized;
}

/** 权限位转 rwxr-xr-x 形式 */
function modeToString(mode) {
  const rwx = (n, shift) => {
    const bits = (n >> shift) & 7;
    return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  };
  return [
    rwx(mode, 6), rwx(mode, 3), rwx(mode, 0),
  ].join('');
}

function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function kindOf(stat, name) {
  if (stat.isDirectory()) return 'dir';
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isBlockDevice()) return 'block';
  if (stat.isCharacterDevice()) return 'char';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  // 按扩展名猜类型
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  if (['zip', 'gz', 'tar', '7z', 'rar', 'xz', 'bz2'].includes(ext)) return 'archive';
  if (['sh', 'bash', 'py', 'js', 'ts', 'c', 'cpp', 'go', 'rs', 'java', 'lua'].includes(ext)) return 'code';
  return 'file';
}

/**
 * 列出目录
 * @param {string} dirPath
 * @param {{showHidden?: boolean, showPseudo?: boolean}} opts
 */
async function listDir(dirPath, opts = {}) {
  const abs = resolveSafe(dirPath);

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch (e) {
    throw new Error(`无法访问：${e.code === 'ENOENT' ? '路径不存在' : e.message}`);
  }
  if (!stat.isDirectory()) throw new Error('不是目录');

  let names;
  try {
    names = await fsp.readdir(abs);
  } catch (e) {
    throw new Error(`无权限读取目录：${e.code === 'EACCES' ? '权限不足' : e.message}`);
  }

  const showHidden = Boolean(opts.showHidden);
  if (!showHidden) names = names.filter((n) => !n.startsWith('.'));

  const truncated = names.length > LIMITS.maxListEntries;
  if (truncated) names = names.slice(0, LIMITS.maxListEntries);

  const entries = await Promise.all(
    names.map(async (name) => {
      const full = path.join(abs, name);
      try {
        const st = await fsp.lstat(full);
        let size = st.size;
        // 目录不统计递归大小（太慢），显示为 null
        const isDir = st.isDirectory();
        let linkTarget = null;
        if (st.isSymbolicLink()) {
          try {
            linkTarget = await fsp.readlink(full);
          } catch (e) {
            /* ignore */
          }
        }
        return {
          name,
          path: full,
          kind: kindOf(st, name),
          isDir,
          size: isDir ? null : size,
          sizeText: isDir ? '—' : fmtSize(size),
          mode: modeToString(st.mode & 0o777),
          modeRaw: st.mode & 0o777,
          uid: st.uid,
          gid: st.gid,
          mtime: st.mtimeMs,
          linkTarget,
        };
      } catch (e) {
        return {
          name,
          path: full,
          kind: 'unknown',
          isDir: false,
          size: null,
          sizeText: '—',
          mode: '---------',
          modeRaw: 0,
          uid: null,
          gid: null,
          mtime: null,
          error: e.code || e.message,
        };
      }
    })
  );

  // 目录优先，然后按名称（自然顺序）
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  });

  // 上级目录
  const parent = abs === '/' ? null : path.dirname(abs);

  // 磁盘用量
  let usage = null;
  try {
    const sf = await fsp.statfs(abs);
    usage = {
      total: sf.blocks * sf.bsize,
      free: sf.bavail * sf.bsize,
      used: (sf.blocks - sf.bfree) * sf.bsize,
    };
  } catch (e) {
    /* ignore */
  }

  return {
    path: abs,
    parent,
    name: path.basename(abs) || '/',
    entries,
    truncated,
    total: names.length,
    usage,
    writable: await isWritable(abs),
  };
}

async function isWritable(p) {
  try {
    await fsp.access(p, fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 读取文本文件
 * @param {string} filePath
 */
async function readText(filePath) {
  const abs = resolveSafe(filePath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('这是一个目录');
  if (st.size > LIMITS.maxReadBytes) {
    throw new Error(
      `文件过大（${fmtSize(st.size)}），在线编辑上限 ${fmtSize(LIMITS.maxReadBytes)}。请下载后本地编辑。`
    );
  }

  const buf = await fsp.readFile(abs);
  // 简单二进制检测：含 NUL 字节视为二进制
  if (buf.subarray(0, 8192).includes(0)) {
    throw new Error('这是二进制文件，无法在线编辑');
  }
  return {
    path: abs,
    name: path.basename(abs),
    size: st.size,
    mtime: st.mtimeMs,
    mode: modeToString(st.mode & 0o777),
    content: buf.toString('utf8'),
  };
}

/**
 * 写入文本文件（不存在则创建）
 */
async function writeText(filePath, content) {
  const abs = resolveSafe(filePath);
  if (typeof content !== 'string') throw new Error('内容必须是字符串');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > LIMITS.maxWriteBytes) {
    throw new Error(`内容过大（${fmtSize(bytes)}），上限 ${fmtSize(LIMITS.maxWriteBytes)}`);
  }
  await fsp.writeFile(abs, content, 'utf8');
  const st = await fsp.stat(abs);
  return { path: abs, size: st.size, mtime: st.mtimeMs };
}

/** 创建目录 */
async function makeDir(dirPath) {
  const abs = resolveSafe(dirPath);
  await fsp.mkdir(abs, { recursive: true });
  return { path: abs };
}

/** 新建空文件 */
async function makeFile(filePath) {
  const abs = resolveSafe(filePath);
  const fh = await fsp.open(abs, 'a');
  await fh.close();
  return { path: abs };
}

/**
 * 重命名 / 移动
 * @param {string} from
 * @param {string} to 完整目标路径
 */
async function rename(from, to) {
  const src = resolveSafe(from);
  const dst = resolveSafe(to);
  // 禁止把目录移动到自身内部
  if (dst.startsWith(src + path.sep)) throw new Error('不能把目录移动到其自身内部');
  await fsp.rename(src, dst);
  return { from: src, to: dst };
}

/** 删除（文件或目录，目录递归） */
async function remove(target) {
  const abs = resolveSafe(target);
  if (abs === '/') throw new Error('拒绝删除根目录');

  const st = await fsp.lstat(abs);
  if (st.isDirectory()) {
    await fsp.rm(abs, { recursive: true, force: false });
  } else {
    await fsp.unlink(abs);
  }
  return { path: abs, wasDir: st.isDirectory() };
}

/** 修改权限 */
async function chmod(target, mode) {
  const abs = resolveSafe(target);
  const m = Number(mode);
  if (!Number.isInteger(m) || m < 0 || m > 0o777) throw new Error('权限值无效（0-0777）');
  await fsp.chmod(abs, m);
  return { path: abs, mode: modeToString(m) };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim() || '命令执行失败'));
      resolve(stdout);
    });
  });
}

/**
 * 压缩
 * @param {string[]} sources 要压缩的路径
 * @param {string} dest 目标压缩包（.tar.gz / .tar / .zip）
 * @param {string} cwd 工作目录（保证压缩包内路径相对）
 */
async function compress(sources, dest, cwd) {
  const dst = resolveSafe(dest);
  const workDir = resolveSafe(cwd || path.dirname(dst));
  const names = sources.map((s) => {
    const abs = resolveSafe(s);
    const rel = path.relative(workDir, abs);
    if (rel.startsWith('..')) throw new Error('源文件必须位于同一目录下');
    return rel || '.';
  });

  const lower = dst.toLowerCase();
  if (lower.endsWith('.zip')) {
    await run('zip', ['-r', '-q', dst, ...names], { cwd: workDir });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await run('tar', ['-czf', dst, ...names], { cwd: workDir });
  } else if (lower.endsWith('.tar')) {
    await run('tar', ['-cf', dst, ...names], { cwd: workDir });
  } else if (lower.endsWith('.tar.xz')) {
    await run('tar', ['-cJf', dst, ...names], { cwd: workDir });
  } else if (lower.endsWith('.tar.bz2')) {
    await run('tar', ['-cjf', dst, ...names], { cwd: workDir });
  } else {
    throw new Error('不支持的压缩格式（支持 .zip / .tar / .tar.gz / .tar.xz / .tar.bz2）');
  }

  const st = await fsp.stat(dst);
  return { path: dst, size: st.size };
}

/**
 * 解压到指定目录
 */
async function extract(archive, destDir) {
  const src = resolveSafe(archive);
  const dst = resolveSafe(destDir);
  await fsp.mkdir(dst, { recursive: true });

  const lower = src.toLowerCase();
  if (lower.endsWith('.zip')) {
    await run('unzip', ['-o', '-q', src, '-d', dst]);
  } else if (
    lower.endsWith('.tar.gz') || lower.endsWith('.tgz') ||
    lower.endsWith('.tar') || lower.endsWith('.tar.xz') ||
    lower.endsWith('.tar.bz2')
  ) {
    await run('tar', ['-xf', src, '-C', dst]);
  } else if (lower.endsWith('.gz')) {
    // 单文件 gzip
    await run('sh', ['-c', `gzip -dc "$1" > "$2"`, '--', src, path.join(dst, path.basename(src, '.gz'))]);
  } else {
    throw new Error('不支持的压缩格式');
  }

  return { path: dst, archive: src };
}

/** 获取文件流（供下载） */
async function openReadStream(filePath) {
  const abs = resolveSafe(filePath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('不能下载目录');
  return {
    stream: fs.createReadStream(abs),
    size: st.size,
    name: path.basename(abs),
  };
}

/** 保存上传文件（流式写入） */
async function saveUpload(dirPath, fileName, readStream) {
  const dir = resolveSafe(dirPath);
  // 文件名只取 basename，防止穿越
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || safeName === '.' || safeName === '..') throw new Error('文件名无效');
  const dest = path.join(dir, safeName);

  const st0 = await fsp.stat(dir);
  if (!st0.isDirectory()) throw new Error('目标不是目录');

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: 'wx' }); // wx: 已存在则失败
    let written = 0;
    let aborted = false;

    readStream.on('data', (chunk) => {
      written += chunk.length;
      if (written > LIMITS.maxUploadBytes) {
        aborted = true;
        out.destroy();
        fs.unlink(dest, () => {});
        readStream.destroy();
        reject(new Error(`文件超过上传上限 ${fmtSize(LIMITS.maxUploadBytes)}`));
      }
    });

    readStream.on('error', (e) => {
      if (aborted) return;
      out.destroy();
      fs.unlink(dest, () => {});
      reject(e);
    });

    out.on('error', (e) => {
      if (aborted) return;
      if (e.code === 'EEXIST') {
        return reject(new Error(`文件已存在：${safeName}`));
      }
      reject(e);
    });

    out.on('finish', () => {
      if (aborted) return;
      resolve({ path: dest, size: written, name: safeName });
    });

    readStream.pipe(out);
  });
}

/** 目录树摘要（用于页面顶部统计） */
async function diskUsageSummary() {
  const sf = await fsp.statfs('/');
  return {
    root: {
      total: sf.blocks * sf.bsize,
      free: sf.bavail * sf.bsize,
      used: (sf.blocks - sf.bfree) * sf.bsize,
    },
  };
}

/* ---------------- 回收站（trash） ---------------- */

const TRASH_INDEX_FILE = 'index.json';
const TRASH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TRASH_MAX_ENTRIES = 5000;
const TRASH_MAX_INDEX_BYTES = 4 * 1024 * 1024;

function fileError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function assertTrashId(id) {
  const value = String(id || '');
  if (!TRASH_ID_RE.test(value)) throw fileError('invalid_trash_id', '回收站条目 id 非法');
  return value;
}

function trashIndexPath(trashRoot) {
  return path.join(trashRoot, TRASH_INDEX_FILE);
}

function isValidTrashEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      TRASH_ID_RE.test(entry.id) &&
      typeof entry.path === 'string' &&
      entry.path.startsWith('/') &&
      !entry.path.split('/').includes('..') &&
      Number.isFinite(entry.deletedAt) &&
      Number.isFinite(entry.size)
  );
}

/** 读取回收站索引（损坏/缺失返回空数组） */
function readTrashIndex(trashRoot) {
  const file = trashIndexPath(trashRoot);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return [];
  }
  if (!stat.isFile() || stat.size > TRASH_MAX_INDEX_BYTES) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.filter(isValidTrashEntry);
  } catch (e) {
    return [];
  }
}

/** 原子写回收站索引（0600） */
function writeTrashIndex(trashRoot, entries) {
  const safe = entries.filter(isValidTrashEntry).slice(-TRASH_MAX_ENTRIES);
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const file = trashIndexPath(trashRoot);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: safe }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    /* ignore */
  }
}

/** 递归计算大小（不跟随符号链接，深度/条目有上限） */
async function pathSize(target, depth = 0) {
  let st;
  try {
    st = await fsp.lstat(target);
  } catch (e) {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size || 0;
  if (depth >= 8) return 0;
  let total = 0;
  let names = [];
  try {
    names = await fsp.readdir(target);
  } catch (e) {
    return 0;
  }
  for (const name of names.slice(0, 2000)) {
    total += await pathSize(path.join(target, name), depth + 1);
  }
  return total;
}

async function pathExists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (e) {
    return false;
  }
}

/** 把路径移入回收站，返回索引条目 */
async function trashPut(trashRoot, target) {
  const abs = resolveSafe(target);
  if (abs === '/') throw fileError('invalid_path', '拒绝删除根目录');
  const st = await fsp.lstat(abs);
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
  const entry = {
    id,
    path: abs,
    name: path.basename(abs),
    size: await pathSize(abs),
    deletedAt: Date.now(),
    type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
  };
  fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const dest = path.join(trashRoot, id);
  try {
    await fsp.rename(abs, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(abs, dest, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await fsp.rm(abs, { recursive: true, force: false });
  }
  const entries = readTrashIndex(trashRoot);
  entries.push(entry);
  writeTrashIndex(trashRoot, entries);
  return entry;
}

/** 回收站列表（deletedAt 倒序，过滤已丢失实体） */
async function trashList(trashRoot) {
  const entries = readTrashIndex(trashRoot);
  const alive = [];
  for (const entry of entries) {
    if (await pathExists(path.join(trashRoot, entry.id))) alive.push(entry);
  }
  if (alive.length !== entries.length) writeTrashIndex(trashRoot, alive);
  alive.sort((a, b) => b.deletedAt - a.deletedAt);
  return alive;
}

/** 从回收站恢复（目标已存在则报错，不覆盖） */
async function trashRestore(trashRoot, id) {
  const safeId = assertTrashId(id);
  const entries = readTrashIndex(trashRoot);
  const entry = entries.find((item) => item.id === safeId);
  if (!entry) throw fileError('trash_not_found', '回收站条目不存在');
  const source = path.join(trashRoot, safeId);
  if (!(await pathExists(source))) {
    writeTrashIndex(trashRoot, entries.filter((item) => item.id !== safeId));
    throw fileError('trash_not_found', '回收站内容已丢失');
  }
  const target = resolveSafe(entry.path);
  if (await pathExists(target)) throw fileError('target_exists', '原路径已被占用，无法恢复');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
    await fsp.rm(source, { recursive: true, force: false });
  }
  writeTrashIndex(trashRoot, entries.filter((item) => item.id !== safeId));
  return { id: safeId, path: target, name: entry.name, type: entry.type };
}

/**
 * 彻底删除回收站条目。
 * @param {string} trashRoot
 * @param {{id?:string, all?:boolean}} options
 */
async function trashPurge(trashRoot, options = {}) {
  const entries = readTrashIndex(trashRoot);
  let targets;
  if (options.all === true) {
    targets = entries;
  } else {
    const safeId = assertTrashId(options.id);
    targets = entries.filter((item) => item.id === safeId);
    if (targets.length === 0) throw fileError('trash_not_found', '回收站条目不存在');
  }
  let count = 0;
  for (const entry of targets) {
    try {
      await fsp.rm(path.join(trashRoot, entry.id), { recursive: true, force: true });
      count += 1;
    } catch (e) {
      /* ignore */
    }
  }
  const ids = new Set(targets.map((item) => item.id));
  writeTrashIndex(trashRoot, entries.filter((item) => !ids.has(item.id)));
  return { count };
}

/** 清理超过 retentionDays 的回收站条目 */
async function trashCleanup(trashRoot, retentionDays = 7) {
  const days = Math.max(1, Math.min(365, Number(retentionDays) || 7));
  const cutoff = Date.now() - days * 86400 * 1000;
  const entries = readTrashIndex(trashRoot);
  const expired = entries.filter((entry) => entry.deletedAt < cutoff);
  if (expired.length === 0) return { count: 0 };
  for (const entry of expired) {
    try {
      await fsp.rm(path.join(trashRoot, entry.id), { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }
  const ids = new Set(expired.map((entry) => entry.id));
  writeTrashIndex(trashRoot, entries.filter((entry) => !ids.has(entry.id)));
  return { count: expired.length };
}

/* ---------------- 批量操作 ---------------- */

const BATCH_LIMIT = 200;

function assertBatchPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw fileError('invalid_paths', 'paths 不能为空');
  if (paths.length > BATCH_LIMIT) throw fileError('too_many_paths', '单次最多 ' + BATCH_LIMIT + ' 项');
  return paths.map((item) => resolveSafe(item));
}

/**
 * 批量 move / copy / delete（delete 进回收站）。
 * @param {{op:string, paths:string[], target?:string, trashRoot:string}} input
 */
async function batchOp(input) {
  const op = String(input.op || '');
  if (!['move', 'copy', 'delete'].includes(op)) throw fileError('invalid_op', 'op 仅允许 move/copy/delete');
  const sources = assertBatchPaths(input.paths);

  if (op === 'delete') {
    const trashed = [];
    for (const src of sources) {
      if (src === '/') throw fileError('invalid_path', '拒绝删除根目录');
      trashed.push(await trashPut(input.trashRoot, src));
    }
    return { op, done: trashed };
  }

  const targetDir = resolveSafe(input.target || '');
  let targetStat;
  try {
    targetStat = await fsp.stat(targetDir);
  } catch (e) {
    throw fileError('invalid_target', '目标目录不存在');
  }
  if (!targetStat.isDirectory()) throw fileError('invalid_target', '目标必须是目录');

  // 先做冲突预检，避免部分成功
  const planned = [];
  const conflicts = [];
  const seen = new Set();
  for (const src of sources) {
    const base = path.basename(src);
    const dest = path.join(targetDir, base);
    if (dest === src) {
      conflicts.push({ path: src, reason: 'same_path' });
      continue;
    }
    if (seen.has(dest)) {
      conflicts.push({ path: src, dest, reason: 'duplicate_name' });
      continue;
    }
    seen.add(dest);
    if (await pathExists(dest)) {
      conflicts.push({ path: src, dest, reason: 'exists' });
      continue;
    }
    if (dest.startsWith(src + path.sep)) throw fileError('invalid_target', '不能移动到自身内部');
    planned.push({ src, dest });
  }
  if (conflicts.length) {
    const err = fileError('conflicts', '目标已存在同名文件');
    err.conflicts = conflicts;
    throw err;
  }

  const done = [];
  for (const pair of planned) {
    const src = pair.src;
    const dest = pair.dest;
    if (op === 'move') {
      try {
        await fsp.rename(src, dest);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false });
        await fsp.rm(src, { recursive: true, force: false });
      }
    } else {
      await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false, dereference: false });
    }
    done.push({ from: src, to: dest });
  }
  return { op, done };
}

module.exports = {
  LIMITS,
  PSEUDO_FS,
  resolveSafe,
  listDir,
  readText,
  writeText,
  makeDir,
  makeFile,
  rename,
  remove,
  chmod,
  compress,
  extract,
  openReadStream,
  saveUpload,
  diskUsageSummary,
  fmtSize,
  batchOp,
  BATCH_LIMIT,
  trashPut,
  trashList,
  trashRestore,
  trashPurge,
  trashCleanup,
  readTrashIndex,
  writeTrashIndex,
  trashIndexPath,
};
