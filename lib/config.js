'use strict';

/**
 * 配置管理
 * - 首次启动自动生成 config.json（含随机密码、会话密钥）
 * - 权限强制 0600
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultAlertsConfig } = require('./alerts');
const { defaultNotifyConfig } = require('./notify');

const ROOT = path.resolve(__dirname, '..');
// 支持 PANEL_CONFIG 指向其他配置文件，便于并行运行测试实例（不影响正式配置）
const CONFIG_PATH = process.env.PANEL_CONFIG
  ? path.resolve(process.env.PANEL_CONFIG)
  : path.join(ROOT, 'config.json');
const DATA_DIR = process.env.PANEL_DATA_DIR
  ? path.resolve(process.env.PANEL_DATA_DIR)
  : path.join(ROOT, 'data');

/** 生成 n 位可读随机密码（去掉易混淆字符） */
function generatePassword(len = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function defaultConfig() {
  return {
    port: 3081,
    host: '0.0.0.0',
    panel: {
      title: '服务器控制面板',
      // 首次启动生成，登录后可在「面板设置」修改
      username: 'admin',
      passwordHash: null,
      passwordSalt: null,
      mustChangePassword: true,
    },
    session: {
      // 会话签名密钥
      secret: crypto.randomBytes(32).toString('hex'),
      ttlSeconds: 12 * 60 * 60,
      // 「记住密码 / 30 天免登录」：代码内默认值（rememberDays=0 可禁用）
      rememberDays: 30,
      rememberMax: 50,
    },
    sampleIntervalMs: 1000,
    retention: {
      rawMinutes: 10,
      archiveDays: 30,
    },
    thresholds: {
      cpuPercent: 90,
      memPercent: 90,
      diskPercent: 90,
      cpuTempC: 90,
    },
    helper: {
      // root 特权助手（panel-helper）：Unix Socket + HMAC 协议
      socketPath: process.env.PANEL_HELPER_SOCKET || '/run/server-panel/helper.sock',
      secretFile: process.env.PANEL_HELPER_SECRET_FILE || '/etc/server-panel/helper.secret',
      timeoutMs: 10000,
      enabled: true,
    },
    fileManager: {
      // 决策：允许全盘访问
      root: '/',
      allowWrite: true,
      // 回收站保留天数（启动时 + 每天清理）
      trashRetentionDays: 7,
    },
    // 文件下载器（分享链接 + 二维码）：代码内默认，不写用户 config.json
    download: {
      // 分享链接默认有效期（分钟）
      shareTtlMinutes: 60,
      // 同时存在的分享上限
      maxShares: 100,
      // 每个分享默认下载次数上限；0 = 不限（once=true 时强制 1 次）
      maxHits: 0,
    },
    // 告警引擎（阈值规则）：代码内默认，可被 config.alerts 覆盖
    alerts: defaultAlertsConfig(),
    // 通知渠道：密钥字段（webhook.url / email.pass）默认留空
    notify: defaultNotifyConfig(),
    // 自动备份：每天 hour 点检查一次（可补跑当天），保留最近 keep 份
    backup: {
      auto: true,
      keep: 7,
      hour: 4,
    },
    // App 自动更新：扫描该目录下版本号最大的 server-panel-app-*.apk
    appUpdate: {
      // APK 目录：env PANEL_DIST_DIR → <repo>/dist
      distDir: process.env.PANEL_DIST_DIR || path.join(ROOT, 'dist'),
    },
  };
}

function applyPermissions(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    // 非致命
  }
}

/**
 * 加载配置；不存在则创建。
 * @returns {{config: object, created: boolean, generatedPassword: string|null}}
 */
function loadConfig() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(CONFIG_PATH)) {
    let raw;
    try {
      raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) {
      throw new Error(`无法读取 config.json: ${e.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`config.json 格式错误（不是合法 JSON）: ${e.message}`);
    }
    // 与默认值合并，保证升级后新增字段有值
    const merged = deepMerge(defaultConfig(), parsed);
    return { config: merged, created: false, generatedPassword: null };
  }

  const config = defaultConfig();
  const password = generatePassword(16);
  const salt = crypto.randomBytes(16).toString('hex');
  config.panel.passwordSalt = salt;
  config.panel.passwordHash = hashPassword(password, salt);

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  applyPermissions(CONFIG_PATH);

  return { config, created: true, generatedPassword: password };
}

function saveConfig(config) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  applyPermissions(CONFIG_PATH);
}

/** scrypt 加盐哈希，格式：scrypt$N$r$p$hashHex */
function hashPassword(password, salt) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const derived = crypto.scryptSync(password, salt, keylen, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt}$${derived.toString('hex')}`;
}

/** 校验密码（常量时间比较） */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  let derived;
  try {
    derived = crypto.scryptSync(password, salt, expectedHex.length / 2, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch (e) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

function deepMerge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  DATA_DIR,
  loadConfig,
  saveConfig,
  hashPassword,
  verifyPassword,
  generatePassword,
  defaultConfig,
};
