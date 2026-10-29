'use strict';

/**
 * 磁盘 SMART 健康数据读取
 *
 * 通过白名单包装器 /usr/local/sbin/panel-smartctl 调用 smartctl：
 *   - 该脚本由 sudoers 授予面板用户 NOPASSWD 权限
 *   - 内部限制设备路径（仅真实块设备）并强制 --json=o -a（只读）
 *   - 若未配置该包装器，功能自动降级为「不可用」，不影响其他页面
 *
 * 结果带 60 秒缓存：机械盘查询会唤醒磁盘（spindle up），不宜过于频繁。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const WRAPPER = '/usr/local/sbin/panel-smartctl';
const SMARTCTL = '/usr/sbin/smartctl';
const CACHE_TTL_MS = 60_000;

let cache = new Map(); // device -> { at, data }
let wrapperChecked = null; // { ok, reason }

/** 检查 SMART 读取能力是否可用 */
function checkCapability() {
  if (wrapperChecked) return wrapperChecked;

  const hasWrapper = fs.existsSync(WRAPPER);
  const hasSmartctl = fs.existsSync(SMARTCTL);

  if (!hasSmartctl) {
    wrapperChecked = { ok: false, reason: '未安装 smartmontools（apt install smartmontools）' };
  } else if (!hasWrapper) {
    wrapperChecked = { ok: false, reason: '未安装白名单包装器 /usr/local/sbin/panel-smartctl' };
  } else {
    wrapperChecked = { ok: true, reason: '' };
  }
  return wrapperChecked;
}

/** 执行一次 smartctl（经包装器） */
function runSmartctl(device) {
  return new Promise((resolve, reject) => {
    execFile(
      'sudo',
      ['-n', WRAPPER, device],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        // smartctl 用退出码位表示状态；有 JSON 输出时应优先解析
        if (stdout && stdout.trim().startsWith('{')) {
          try {
            return resolve(JSON.parse(stdout));
          } catch (e) {
            return reject(new Error('SMART 输出解析失败: ' + e.message));
          }
        }
        if (err) {
          const msg = (stderr || err.message || '').trim();
          if (/not allowed|usage:|not a block device/.test(msg)) {
            return reject(new Error('SMART 参数被拒绝: ' + msg));
          }
          if (/a terminal is required|no tty present|password is required/i.test(msg)) {
            return reject(new Error('无权读取 SMART：sudoers 未配置免密'));
          }
          return reject(new Error(msg || 'smartctl 执行失败'));
        }
        reject(new Error('smartctl 未返回 JSON'));
      }
    );
  });
}

/** 从 ATA 属性表中取指定 ID 的原始值 */
function pickAtaAttribute(attrs, id) {
  const table = attrs?.table;
  if (!Array.isArray(table)) return null;
  const row = table.find((a) => a.id === id);
  if (!row) return null;
  const raw = row.raw?.value;
  return {
    id: row.id,
    name: row.name,
    value: typeof raw === 'number' ? raw : null,
    worst: row.worst ?? null,
    thresh: row.thresh ?? null,
    whenFailed: row.when_failed || '',
  };
}

/**
 * 把 smartctl JSON 归一化成 UI 需要的结构
 */
function normalize(raw, device) {
  // smartctl 即使失败也会输出 JSON，其中 messages 里含错误说明
  const msgs = raw.smartctl?.messages || [];
  const permMsg = msgs.find((m) => /permission denied|operation not permitted/i.test(m.string || ''));
  if (permMsg) {
    return {
      device,
      name: path.basename(device),
      available: false,
      error: '权限不足：' + permMsg.string,
    };
  }

  const out = {
    device,
    available: true,
    model: raw.model_name || raw.device?.info_name || '',
    serial: raw.serial_number || '',
    firmware: raw.firmware_version || '',
    protocol: raw.device?.protocol || '',
    type: raw.device?.type || '',
    health: {
      passed: raw.smart_status?.passed ?? null,
      text: raw.smart_status?.passed === true ? 'PASSED'
        : raw.smart_status?.passed === false ? 'FAILED'
        : '未知',
    },
    temperature: raw.temperature?.current ?? null,
    tempMax: raw.temperature?.drive_trip?.maximum ?? null,
    powerOnHours: raw.power_on_time?.hours ?? null,
    powerCycles: raw.power_cycle_count ?? null,
    rotationRpm: raw.rotation_rate ?? null,
  };

  // ---- ATA（机械盘 / SATA SSD）----
  if (raw.ata_smart_attributes) {
    const attrs = raw.ata_smart_attributes;
    const grab = (id) => pickAtaAttribute(attrs, id);
    out.kind = 'ATA';
    out.ata = {
      reallocatedSectors: grab(5)?.value ?? null,
      powerOnHours: grab(9)?.value ?? out.powerOnHours,
      startStopCount: grab(4)?.value ?? null,
      spinRetryCount: grab(10)?.value ?? null,
      reportedUncorrect: grab(187)?.value ?? null,
      commandTimeout: grab(188)?.value ?? null,
      temperature: grab(194)?.value ?? out.temperature,
      reallocatedEvents: grab(196)?.value ?? null,
      pendingSectors: grab(197)?.value ?? null,
      offlineUncorrectable: grab(198)?.value ?? null,
      udmaCrcErrors: grab(199)?.value ?? null,
      // 关键告警：任一 > 0 都说明盘况恶化
      critical:
        (grab(5)?.value ?? 0) > 0 ||
        (grab(197)?.value ?? 0) > 0 ||
        (grab(198)?.value ?? 0) > 0,
      // 自检结果
      selfTestStatus: raw.ata_smart_data?.self_test?.status?.string || null,
      selfTestPassed: raw.ata_smart_data?.self_test?.status?.passed ?? null,
      errorLogCount: raw.ata_smart_error_log?.summary?.count ?? null,
      // 全部属性（供高级查看）
      attributeCount: Array.isArray(attrs.table) ? attrs.table.length : 0,
    };
  }

  // ---- NVMe ----
  const nv = raw.nvme_smart_health_information_log;
  if (nv) {
    out.kind = 'NVMe';
    // NVMe 的 data_units_* 单位是 512000 字节
    const unitBytes = 512000;
    out.nvme = {
      criticalWarning: nv.critical_warning ?? 0,
      temperature: nv.temperature ?? out.temperature,
      availableSpare: nv.available_spare ?? null,
      availableSpareThreshold: nv.available_spare_threshold ?? null,
      percentageUsed: nv.percentage_used ?? null,
      dataUnitsRead: nv.data_units_read != null ? nv.data_units_read * unitBytes : null,
      dataUnitsWritten: nv.data_units_written != null ? nv.data_units_written * unitBytes : null,
      hostReads: nv.host_read_commands ?? null,
      hostWrites: nv.host_write_commands ?? null,
      powerCycles: nv.power_cycles ?? out.powerCycles,
      powerOnHours: nv.power_on_hours ?? out.powerOnHours,
      unsafeShutdowns: nv.unsafe_shutdowns ?? null,
      mediaErrors: nv.media_errors ?? null,
      errorLogEntries: nv.num_err_log_entries ?? null,
      warningTempTime: nv.warning_temp_time ?? null,
      criticalTempTime: nv.critical_comp_time ?? null,
      critical:
        (nv.critical_warning ?? 0) > 0 ||
        (nv.media_errors ?? 0) > 0 ||
        (nv.available_spare != null &&
          nv.available_spare_threshold != null &&
          nv.available_spare <= nv.available_spare_threshold),
    };
  }

  // 综合健康评级
  let severity = 'ok';
  if (out.health.passed === false || out.kind === 'ATA' && out.ata?.critical || out.kind === 'NVMe' && out.nvme?.critical) {
    severity = 'crit';
  } else if (
    (out.temperature != null && out.temperature >= 55) ||
    (out.kind === 'NVMe' && out.nvme?.percentageUsed >= 80) ||
    (out.kind === 'ATA' && out.ata?.udmaCrcErrors > 0)
  ) {
    severity = 'warn';
  }
  out.severity = severity;

  return out;
}

/** 列出可用于查询 SMART 的物理磁盘 */
function listPhysicalDisks() {
  let names = [];
  try {
    names = fs.readdirSync('/sys/block').filter((n) => !/^(loop|ram|dm-|sr|zram|md)/.test(n));
  } catch (e) {
    return [];
  }
  return names.sort();
}

/**
 * 读取所有磁盘的 SMART（带缓存）
 * @param {boolean} force 强制刷新
 */
async function readAllSmart(force = false) {
  const cap = checkCapability();
  if (!cap.ok) {
    return { available: false, reason: cap.reason, disks: [] };
  }

  const devices = listPhysicalDisks().map((n) => `/dev/${n}`);
  const now = Date.now();
  const results = [];
  const errors = [];

  for (const dev of devices) {
    const cached = cache.get(dev);
    if (!force && cached && now - cached.at < CACHE_TTL_MS) {
      results.push(cached.data);
      continue;
    }
    try {
      const raw = await runSmartctl(dev);
      const data = normalize(raw, dev);
      data.name = path.basename(dev);
      data.at = now;
      cache.set(dev, { at: now, data });
      results.push(data);
    } catch (e) {
      errors.push({ device: dev, error: e.message });
      // 缓存失败也不要让页面整体失败
      const fallback = {
        device: dev,
        name: path.basename(dev),
        available: false,
        error: e.message,
        at: now,
      };
      results.push(fallback);
    }
  }

  return {
    available: results.some((r) => r.available),
    reason: results.some((r) => r.available) ? '' : errors[0]?.error || '无法读取 SMART',
    disks: results,
    errors,
  };
}

/** 读取单块磁盘 SMART */
async function readOneSmart(device, force = false) {
  const cap = checkCapability();
  if (!cap.ok) return { available: false, reason: cap.reason };

  const dev = device.startsWith('/dev/') ? device : `/dev/${device}`;
  const cached = cache.get(dev);
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const raw = await runSmartctl(dev);
    const data = normalize(raw, dev);
    data.name = path.basename(dev);
    data.at = now;
    cache.set(dev, { at: now, data });
    return data;
  } catch (e) {
    return { device: dev, name: path.basename(dev), available: false, error: e.message };
  }
}

module.exports = { readAllSmart, readOneSmart, checkCapability, listPhysicalDisks };
