'use strict';

/**
 * App 自动更新：扫描 dist 目录里版本号最大的 server-panel-app-*.apk，
 * 提供更新元信息与最新 APK 文件（供免登录下载）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APK_RE = /^server-panel-app-(.+)\.apk$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 APK 文件名里的版本号，非法返回 null */
function parseApkVersion(filename) {
  const match = APK_RE.exec(String(filename || ''));
  if (!match) return null;
  const version = match[1];
  const semver = VERSION_RE.exec(version);
  if (!semver) return null;
  return {
    version,
    parts: [Number(semver[1]), Number(semver[2]), Number(semver[3])],
    prerelease: semver[4] || '',
  };
}

/** 比较两个版本；a>b 返回正数 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  // 正式版（无 prerelease）大于同版本预发布
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? 1 : -1;
}

/**
 * 扫描目录找最新 APK。
 * @returns {{filePath:string, filename:string, version:string, size:number, mtimeMs:number}|null}
 */
function scanLatestApk(distDir) {
  let names;
  try {
    names = fs.readdirSync(distDir);
  } catch (e) {
    return null;
  }
  let best = null;
  for (const name of names) {
    const parsed = parseApkVersion(name);
    if (!parsed) continue;
    const filePath = path.join(distDir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      continue;
    }
    if (!stat.isFile()) continue;
    const candidate = {
      filePath,
      filename: name,
      version: parsed.version,
      parts: parsed.parts,
      prerelease: parsed.prerelease,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const cmp = compareVersions(candidate, best);
    if (cmp > 0 || (cmp === 0 && candidate.mtimeMs > best.mtimeMs)) best = candidate;
  }
  return best;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class AppUpdateManager {
  constructor(options = {}) {
    // 默认：env PANEL_DIST_DIR → <repo>/dist（开源通用，不写死本机路径）
    this.distDir = options.distDir || process.env.PANEL_DIST_DIR || path.join(__dirname, '..', 'dist');
    this.cache = null; // {filePath, mtimeMs, size, sha256, version}
  }

  /** 最新 APK（不存在返回 null） */
  latest() {
    if (!this.distDir) return null;
    return scanLatestApk(this.distDir);
  }

  /** 更新信息；dist 为空/不存在时 {version:null} */
  async info() {
    const latest = this.latest();
    if (!latest) return { version: null };
    if (!this.cache || this.cache.filePath !== latest.filePath || this.cache.mtimeMs !== latest.mtimeMs || this.cache.size !== latest.size) {
      const sha256 = await sha256File(latest.filePath);
      this.cache = { filePath: latest.filePath, mtimeMs: latest.mtimeMs, size: latest.size, sha256, version: latest.version };
    }
    return {
      version: latest.version,
      downloadUrl: '/app/latest.apk',
      size: latest.size,
      sha256: this.cache.sha256,
      notes: '',
    };
  }
}

module.exports = {
  AppUpdateManager,
  scanLatestApk,
  parseApkVersion,
  compareVersions,
  sha256File,
  APK_RE,
};
