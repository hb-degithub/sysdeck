'use strict';

/**
 * 系统指标采集器
 * 全部直接读取 /proc 与 /sys，不依赖任何外部命令。
 * 通过差分计算速率类指标（CPU%、磁盘 IOPS、网络速率）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROC = '/proc';
const SYS = '/sys';

/* ---------------- 底层读取工具 ---------------- */

function readFileSafe(p, fallback = null) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return fallback;
  }
}

function readIntSafe(p, fallback = 0) {
  const s = readFileSafe(p);
  if (s === null) return fallback;
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析 key: value 形式（/proc/meminfo） */
function parseKeyValue(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    const m = /^(-?\d+)/.exec(rest);
    out[key] = m ? Number(m[1]) : rest;
  }
  return out;
}

/* ---------------- CPU ---------------- */

/** 读取 /proc/stat 的 cpu 行（总 + 每核） */
function readCpuStat() {
  const text = readFileSafe(path.join(PROC, 'stat'), '');
  const total = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
  const cores = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    const nums = parts.slice(1).map(Number);
    const rec = {
      user: nums[0] || 0,
      nice: nums[1] || 0,
      system: nums[2] || 0,
      idle: nums[3] || 0,
      iowait: nums[4] || 0,
      irq: nums[5] || 0,
      softirq: nums[6] || 0,
      steal: nums[7] || 0,
    };
    rec.total =
      rec.user + rec.nice + rec.system + rec.idle + rec.iowait + rec.irq + rec.softirq + rec.steal;
    if (name === 'cpu') {
      Object.assign(total, rec);
    } else {
      const index = parseInt(name.slice(3), 10);
      cores.push({ index, ...rec });
    }
  }
  return { total, cores };
}

/** 由两次采样计算 CPU 使用率 */
function cpuDelta(prev, cur) {
  if (!prev) return { percent: 0, perCore: [], user: 0, system: 0, iowait: 0, idle: 0 };

  const calc = (p, c) => {
    const dt = c.total - p.total;
    if (dt <= 0) return { percent: null, user: 0, system: 0, iowait: 0, idle: 0 };
    const busy = dt - (c.idle - p.idle) - (c.iowait - p.iowait);
    return {
      percent: round1((busy / dt) * 100),
      user: round1(((c.user - p.user + c.nice - p.nice) / dt) * 100),
      system: round1(((c.system - p.system + c.irq - p.irq + c.softirq - p.softirq) / dt) * 100),
      iowait: round1(((c.iowait - p.iowait) / dt) * 100),
      idle: round1(((c.idle - p.idle) / dt) * 100),
    };
  };

  const totalRes = calc(prev.total, cur.total);
  const perCore = cur.cores.map((c, i) => {
    const p = prev.cores[i];
    if (!p) return { index: c.index, percent: 0, user: 0, system: 0, iowait: 0, idle: 0 };
    const r = calc(p, c);
    return {
      index: c.index,
      percent: r.percent === null ? 0 : r.percent,
      user: r.user,
      system: r.system,
      iowait: r.iowait,
      idle: r.idle,
    };
  });

  return { ...totalRes, perCore };
}

/* ---------------- 内存 ---------------- */

function readMemory() {
  const kv = parseKeyValue(readFileSafe(path.join(PROC, 'meminfo'), ''));
  const kb = (k) => (kv[k] || 0) * 1024;
  const total = kb('MemTotal');
  const free = kb('MemFree');
  const available = kb('MemAvailable') || free;
  const buffers = kb('Buffers');
  const cached = kb('Cached');
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');

  const used = total - available;
  return {
    total,
    free,
    available,
    used,
    usedPercent: total > 0 ? round1((used / total) * 100) : 0,
    buffers,
    cached,
    swapTotal,
    swapFree,
    swapUsed: swapTotal - swapFree,
    swapPercent: swapTotal > 0 ? round1(((swapTotal - swapFree) / swapTotal) * 100) : 0,
  };
}

/* ---------------- 负载 / 运行时长 ---------------- */

function readLoad() {
  const text = readFileSafe(path.join(PROC, 'loadavg'), '0 0 0 0/0 0');
  const parts = text.trim().split(/\s+/);
  const procs = (parts[3] || '0/0').split('/');
  return {
    load1: Number(parts[0]) || 0,
    load5: Number(parts[1]) || 0,
    load15: Number(parts[2]) || 0,
    runnable: Number(procs[0]) || 0,
    totalProcs: Number(procs[1]) || 0,
  };
}

function readUptime() {
  const text = readFileSafe(path.join(PROC, 'uptime'), '0 0');
  const parts = text.trim().split(/\s+/);
  return {
    uptimeSeconds: Number(parts[0]) || 0,
    idleSeconds: Number(parts[1]) || 0,
  };
}

/* ---------------- 压力 PSI ---------------- */

function readPressure(resource) {
  const text = readFileSafe(path.join(PROC, 'pressure', resource));
  if (!text) return null;
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(some|full)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const fields = {};
    for (const kv of m[2].split(/\s+/)) {
      const [k, v] = kv.split('=');
      fields[k] = Number(v);
    }
    out[m[1]] = {
      avg10: fields.avg10 || 0,
      avg60: fields.avg60 || 0,
      avg300: fields.avg300 || 0,
      total: fields.total || 0,
    };
  }
  return out;
}

/* ---------------- 磁盘 ---------------- */

/**
 * 读取 /proc/diskstats，过滤掉分区与 loop 设备，只保留物理盘。
 * 字段：major minor name reads readsMerged sectorsRead msRead writes ... 
 */
function readDiskStats() {
  const text = readFileSafe(path.join(PROC, 'diskstats'), '');
  const out = {};
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 14) continue;
    const name = p[2];
    if (/^(loop|ram|dm-|sr)/.test(name)) continue;
    // 分区（sda1 / nvme0n1p2）跳过：其父设备已统计
    if (/^(sd[a-z]+|vd[a-z]+|hd[a-z]+)\d+$/.test(name)) continue;
    if (/^nvme\d+n\d+p\d+$/.test(name)) continue;
    if (/^mmcblk\d+p\d+$/.test(name)) continue;

    out[name] = {
      reads: Number(p[3]) || 0,
      sectorsRead: Number(p[5]) || 0,
      msRead: Number(p[6]) || 0,
      writes: Number(p[7]) || 0,
      sectorsWritten: Number(p[9]) || 0,
      msWrite: Number(p[10]) || 0,
      ioInProgress: Number(p[11]) || 0,
      msDoingIo: Number(p[12]) || 0,
      weightedMsDoingIo: Number(p[13]) || 0,
    };
  }
  return out;
}

/** 两次采样差分，得到 IOPS / 吞吐 / await / util */
function diskDelta(prev, cur, elapsedMs) {
  const result = [];
  if (!prev || elapsedMs <= 0) return result;
  const secs = elapsedMs / 1000;

  for (const [name, c] of Object.entries(cur)) {
    const p = prev[name];
    if (!p) continue;
    const dReads = c.reads - p.reads;
    const dWrites = c.writes - p.writes;
    const dReadSectors = c.sectorsRead - p.sectorsRead;
    const dWriteSectors = c.sectorsWritten - p.sectorsWritten;
    const dMsRead = c.msRead - p.msRead;
    const dMsWrite = c.msWrite - p.msWrite;
    const dMsIo = c.msDoingIo - p.msDoingIo;

    const readBytes = dReadSectors * 512;
    const writeBytes = dWriteSectors * 512;

    result.push({
      name,
      readIops: round1(dReads / secs),
      writeIops: round1(dWrites / secs),
      readBytesPerSec: Math.round(readBytes / secs),
      writeBytesPerSec: Math.round(writeBytes / secs),
      // await = 平均每次 IO 耗时（含排队）
      readAwaitMs: dReads > 0 ? round2(dMsRead / dReads) : 0,
      writeAwaitMs: dWrites > 0 ? round2(dMsWrite / dWrites) : 0,
      // util = 设备忙碌时间占比
      utilPercent: round1(Math.min(100, (dMsIo / elapsedMs) * 100)),
      ioInProgress: c.ioInProgress,
    });
  }
  return result;
}

/** 读取挂载点用量 */
function readFilesystems() {
  const text = readFileSafe(path.join(PROC, 'mounts'), '');
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(/\s+/);
    if (p.length < 4) continue;
    const [, mountPoint, fstype] = p;
    if (seen.has(mountPoint)) continue;
    const skipTypes = new Set([
      'proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'pstore',
      'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue',
      'hugetlbfs', 'binfmt_misc', 'autofs', 'ramfs', 'squashfs', 'tmpfs',
      'bpf', 'nsfs', 'efivarfs',
    ]);
    if (skipTypes.has(fstype)) continue;
    if (!fs.existsSync(mountPoint)) continue;

    let stat;
    try {
      stat = fs.statfsSync(mountPoint);
    } catch (e) {
      continue;
    }
    const blockSize = stat.bsize || 4096;
    const total = stat.blocks * blockSize;
    const free = stat.bfree * blockSize;
    const avail = stat.bavail * blockSize;
    const used = total - free;
    if (total === 0) continue;
    seen.add(mountPoint);
    out.push({
      mountPoint,
      device: p[0],
      fstype,
      total,
      used,
      free: avail,
      usedPercent: round1((used / total) * 100),
    });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

/* ---------------- 网络 ---------------- */

function readNetwork() {
  const text = readFileSafe(path.join(PROC, 'net', 'dev'), '');
  const out = {};
  const lines = text.split('\n').slice(2);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const nums = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (nums.length < 16) continue;
    out[name] = {
      rxBytes: nums[0],
      rxPackets: nums[1],
      rxErrors: nums[2],
      rxDropped: nums[3],
      txBytes: nums[8],
      txPackets: nums[9],
      txErrors: nums[10],
      txDropped: nums[11],
    };
  }
  return out;
}

function networkDelta(prev, cur, elapsedMs) {
  const result = [];
  if (!prev || elapsedMs <= 0) return result;
  const secs = elapsedMs / 1000;
  for (const [name, c] of Object.entries(cur)) {
    if (name === 'lo') continue;
    const p = prev[name];
    if (!p) continue;
    result.push({
      name,
      rxBytesPerSec: Math.max(0, Math.round((c.rxBytes - p.rxBytes) / secs)),
      txBytesPerSec: Math.max(0, Math.round((c.txBytes - p.txBytes) / secs)),
      rxBytesTotal: c.rxBytes,
      txBytesTotal: c.txBytes,
      rxErrors: c.rxErrors,
      txErrors: c.txErrors,
      rxDropped: c.rxDropped,
      txDropped: c.txDropped,
    });
  }
  return result;
}

/** 读取网卡链路状态与速率 */
function readNetworkLinks() {
  const out = [];
  const base = path.join(SYS, 'class', 'net');
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch (e) {
    return out;
  }
  for (const name of names) {
    if (name === 'lo') continue;
    const dir = path.join(base, name);
    const operstate = (readFileSafe(path.join(dir, 'operstate')) || '').trim();
    let speed = readIntSafe(path.join(dir, 'speed'), null);
    if (speed !== null && speed <= 0) speed = null; // 未知速率用 null，不显示假 0
    let address = (readFileSafe(path.join(dir, 'address')) || '').trim();
    out.push({
      name,
      operstate,
      speedMbps: speed,
      mac: address,
    });
  }
  return out;
}


/** 收集所有 DRM 卡对应的真实设备路径（用于把传感器归类到 GPU） */
function readGpuDevicePaths() {
  const out = new Set();
  let cards = [];
  try {
    cards = fs.readdirSync(path.join(SYS, 'class', 'drm')).filter((n) => /^card\d+$/.test(n));
  } catch (e) {
    return out;
  }
  for (const card of cards) {
    try {
      out.add(fs.realpathSync(path.join(SYS, 'class', 'drm', card, 'device')));
    } catch (e) {
      /* 虚拟卡没有 device 节点，忽略 */
    }
  }
  return out;
}

/**
 * 把传感器按设备归类（通用）：
 *  - GPU：hwmon 的 device 真实路径与任一 DRM 卡设备路径一致
 *  - NVMe：设备路径含 /nvme/
 *  - 其它：CPU / 主板 / 网卡等
 */
function classifySensors(sensors) {
  const gpuDevices = readGpuDevicePaths();
  const temps = Array.isArray(sensors?.temps) ? sensors.temps : [];
  const powers = Array.isArray(sensors?.power) ? sensors.power : [];
  const fans = Array.isArray(sensors?.fans) ? sensors.fans : [];
  const isGpu = (item) => Boolean(item.devicePath) && gpuDevices.has(item.devicePath);
  const isNvme = (item) => /\/nvme\//i.test(item.devicePath || '');
  return {
    gpuTemps: temps.filter(isGpu),
    nvmeTemps: temps.filter(isNvme),
    cpuTemps: temps.filter((t) => !isGpu(t) && !isNvme(t)),
    gpuPowers: powers.filter(isGpu),
    gpuFans: fans.filter(isGpu),
  };
}

/**
 * 从全量传感器里挑出主指标（通用，不硬编码 chip 名）：
 *  - GPU 温度/功耗：hwmon 设备路径含 /drm/（AMD/Intel/Nouveau 等）
 *  - NVMe 温度：设备路径含 nvme
 *  - CPU 温度：优先常见 CPU 芯片名，否则取第一个非 GPU/NVMe 温度；都没有 → null
 * 缺字段一律 null（前端据此隐藏）。
 */
function pickPrimarySensors(sensors) {
  const { gpuTemps, nvmeTemps, cpuTemps, gpuPowers } = classifySensors(sensors);

  const prefer = ['k10temp', 'zenpower', 'coretemp', 'cpu_thermal', 'soc_thermal'];
  let cpuTemp = null;
  for (const chip of prefer) {
    const hit = cpuTemps.find((t) => t.chip === chip);
    if (hit) {
      cpuTemp = hit.value;
      break;
    }
  }
  if (cpuTemp === null && cpuTemps.length > 0) cpuTemp = cpuTemps[0].value;

  const maxOf = (list) => (list.length ? Math.max(...list.map((item) => item.value)) : null);
  return {
    cpuTemp,
    gpuTemp: maxOf(gpuTemps),
    nvmeTemp: maxOf(nvmeTemps),
    gpuPower: gpuPowers.length ? gpuPowers[0].value : null,
  };
}

/* ---------------- 温度 ---------------- */

/** 扫描 /sys/class/hwmon，收集所有温度与风扇传感器 */
function readSensors() {
  const out = { temps: [], fans: [], voltages: [], power: [], freq: [] };
  const hwmonRoot = path.join(SYS, 'class', 'hwmon');
  let dirs = [];
  try {
    dirs = fs.readdirSync(hwmonRoot);
  } catch (e) {
    return out;
  }

  for (const d of dirs) {
    const dir = path.join(hwmonRoot, d);
    const chip = (readFileSafe(path.join(dir, 'name'), 'unknown') || 'unknown').trim();
    // 关联到实际设备（drm=GPU / nvme=SSD / 其它=CPU 域），供通用归类
    let devicePath = '';
    try {
      devicePath = fs.realpathSync(path.join(dir, 'device'));
    } catch (e) {
      devicePath = '';
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }

    for (const entry of entries) {
      const m = /^(temp|fan|in|power)(\d+)_input$/.exec(entry);
      if (!m) continue;
      const kind = m[1];
      const idx = m[2];
      const raw = readIntSafe(path.join(dir, entry), null);
      if (raw === null) continue;
      const label =
        (readFileSafe(path.join(dir, `${kind}${idx}_label`)) || '').trim() || `${chip} ${kind}${idx}`;

      if (kind === 'temp') {
        out.temps.push({ chip, label, value: round1(raw / 1000), raw, devicePath, source: `${d}/${entry}` });
      } else if (kind === 'fan') {
        out.fans.push({ chip, label, value: raw, devicePath, source: `${d}/${entry}` });
      } else if (kind === 'in') {
        out.voltages.push({ chip, label, value: round2(raw / 1000), devicePath, source: `${d}/${entry}` });
      } else if (kind === 'power') {
        // hwmon power*_input 单位是微瓦
        out.power.push({ chip, label, value: Math.round(raw / 1e6 * 10) / 10, unit: 'W', devicePath, source: `${d}/${entry}` });
      }
    }
  }
  return out;
}

/** CPU 频率（MHz），取所有核平均 */
function readCpuFreq() {
  const base = path.join(SYS, 'devices', 'system', 'cpu');
  let cpus = [];
  try {
    cpus = fs.readdirSync(base).filter((n) => /^cpu\d+$/.test(n));
  } catch (e) {
    return { averageMhz: 0, minMhz: 0, maxMhz: 0, governor: '', perCore: [] };
  }

  const perCore = [];
  let governor = '';
  for (const c of cpus) {
    const dir = path.join(base, c, 'cpufreq');
    const cur = readIntSafe(path.join(dir, 'scaling_cur_freq'), 0);
    if (!governor) governor = (readFileSafe(path.join(dir, 'scaling_governor')) || '').trim();
    if (cur > 0) {
      const index = parseInt(c.slice(3), 10);
      perCore.push({ index, mhz: round1(cur / 1000) });
    }
  }
  const first = path.join(base, cpus[0] || 'cpu0', 'cpufreq');
  const minMhz = round1(readIntSafe(path.join(first, 'cpuinfo_min_freq'), 0) / 1000);
  const maxMhz = round1(readIntSafe(path.join(first, 'cpuinfo_max_freq'), 0) / 1000);
  const averageMhz =
    perCore.length > 0 ? round1(perCore.reduce((a, b) => a + b.mhz, 0) / perCore.length) : 0;

  return { averageMhz, minMhz, maxMhz, governor, perCore };
}

/* ---------------- GPU / 显存（通用，不假设厂商） ---------------- */

/** PCI vendor id → 通用厂商名 */
const GPU_VENDORS = {
  '0x1002': 'AMD',
  '0x8086': 'Intel',
  '0x10de': 'NVIDIA',
  '0x13b5': 'ARM',
  '0x1af4': 'Virtio',
  '0x15ad': 'VMware',
  '0x1234': 'QEMU',
};

let gpuModelCache = null;

/** 读取 NVIDIA 驱动信息（/proc/driver/nvidia/gpus/*\/information 的 Model 行） */
function readNvidiaModel() {
  const root = '/proc/driver/nvidia/gpus';
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch (e) {
    return null;
  }
  for (const dir of dirs) {
    const text = readFileSafe(path.join(root, dir, 'information'));
    const m = /^Model\s*:\s*(.+)$/m.exec(text);
    if (m) return m[1].trim();
  }
  return null;
}

/** 读取 NVIDIA 利用率（/proc/driver/nvidia/gpus/*\/utilization 的 Graphics 百分比） */
function readNvidiaBusy() {
  const root = '/proc/driver/nvidia/gpus';
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch (e) {
    return null;
  }
  for (const dir of dirs) {
    const text = readFileSafe(path.join(root, dir, 'utilization'));
    const m = /Graphics\s*:\s*(\d+)\s*%/i.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 用 lspci 友好名称兜底（失败返回 null） */
function readLspciModel(dev) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('lspci', ['-mm'], { encoding: 'utf8', timeout: 3000 });
    for (const line of out.split('\n')) {
      if (!/vga|3d|display/i.test(line)) continue;
      const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (parts.length >= 3) return parts[2];
    }
  } catch (e) {
    /* 忽略：没有 lspci 或不支持 */
  }
  if (dev) {
    try {
      return path.basename(fs.readlinkSync(dev));
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

/**
 * GPU 信息（通用）：按 /sys/class/drm/card*\/device 的 PCI vendor id 识别厂商，
 * 字段拿不到一律 null（前端隐藏），不假设 AMD/amdgpu 存在。
 * @param {object} [sensors] 可选，复用已扫描的传感器，避免重复读 sysfs
 */
function readGpuInfo(sensors) {
  const drmRoot = path.join(SYS, 'class', 'drm');
  let cards = [];
  try {
    cards = fs.readdirSync(drmRoot).filter((n) => /^card\d+$/.test(n)).sort();
  } catch (e) {
    return null;
  }
  if (cards.length === 0) return null;

  // 优先选择有真实 PCI vendor id 的卡（跳过 simpledrm 等虚拟设备）
  let chosen = null;
  for (const card of cards) {
    const dev = path.join(drmRoot, card, 'device');
    const vendorRaw = (readFileSafe(path.join(dev, 'vendor')) || '').trim().toLowerCase();
    chosen = { card, dev, vendorRaw, vendor: GPU_VENDORS[vendorRaw] || (vendorRaw ? 'Unknown' : null) };
    if (chosen.vendor && chosen.vendor !== 'Unknown') break;
  }
  const { card, dev, vendorRaw, vendor } = chosen;
  const isAmd = vendorRaw === '0x1002';
  const isNvidia = vendorRaw === '0x10de';

  const vramTotal = readIntSafe(path.join(dev, 'mem_info_vram_total'), null);
  const vramUsed = readIntSafe(path.join(dev, 'mem_info_vram_used'), null);
  const gttTotal = readIntSafe(path.join(dev, 'mem_info_gtt_total'), null);
  const gttUsed = readIntSafe(path.join(dev, 'mem_info_gtt_used'), null);
  let busy = readIntSafe(path.join(dev, 'gpu_busy_percent'), null);
  if (busy === null && isNvidia) busy = readNvidiaBusy();

  const sensorData = sensors || readSensors();
  const { gpuTemps, gpuPowers } = classifySensors(sensorData);
  const gpuTemp = gpuTemps.length ? Math.max(...gpuTemps.map((t) => t.value)) : null;
  const gpuPower = gpuPowers.length ? gpuPowers[0].value : null;

  // 型号：NVIDIA 用 /proc 驱动信息；其余 lspci；都失败回退 PCI 地址
  let model = gpuModelCache;
  if (!model) {
    model = (isNvidia ? readNvidiaModel() : null) || readLspciModel(dev);
    if (model) gpuModelCache = model;
  }

  // 时钟/电压/档位：仅部分驱动通过 sysfs 暴露；缺失保持 null
  let sclkMhz = null;
  let mclkMhz = null;
  let sclkLevels = [];
  let vddgfxMv = null;
  let vddnbMv = null;
  let gpuDevReal = '';
  try {
    gpuDevReal = fs.realpathSync(dev);
  } catch (e) {
    gpuDevReal = '';
  }
  let hwmonDirs = [];
  try {
    hwmonDirs = fs.readdirSync(path.join(SYS, 'class', 'hwmon'));
  } catch (e) {
    hwmonDirs = [];
  }
  for (const d of hwmonDirs) {
    const dir = path.join(SYS, 'class', 'hwmon', d);
    let devicePath = '';
    try {
      devicePath = fs.realpathSync(path.join(dir, 'device'));
    } catch (e) {
      devicePath = '';
    }
    if (!gpuDevReal || !devicePath || devicePath !== gpuDevReal) continue;
    const f1 = readIntSafe(path.join(dir, 'freq1_input'), null);
    if (f1 !== null && f1 > 0) sclkMhz = round1(f1 / 1e6);
    const f2 = readIntSafe(path.join(dir, 'freq2_input'), null);
    if (f2 !== null && f2 > 0) mclkMhz = round1(f2 / 1e6);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      entries = [];
    }
    for (const entry of entries) {
      const m = /^in(\d+)_input$/.exec(entry);
      if (!m) continue;
      const label = (readFileSafe(path.join(dir, `in${m[1]}_label`)) || '').trim();
      const raw = readIntSafe(path.join(dir, entry), null);
      if (raw === null) continue;
      if (label === 'vddgfx') vddgfxMv = round1(raw);
      else if (label === 'vddnb') vddnbMv = round1(raw);
    }
    break;
  }

  // DPM 档位（AMD 专有；其它厂商无此文件 → 空数组）
  const dpmText = isAmd ? readFileSafe(path.join(dev, 'pp_dpm_sclk')) : '';
  if (dpmText) {
    sclkLevels = dpmText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(\d+):\s*(\d+)Mhz\s*(\*?)$/.exec(l);
        if (!m) return null;
        return { level: Number(m[1]), mhz: Number(m[2]), active: m[3] === '*' };
      })
      .filter(Boolean);
  }
  const mclkText = isAmd ? readFileSafe(path.join(dev, 'pp_dpm_mclk')) : '';
  if (mclkText && mclkMhz === null) {
    for (const l of mclkText.split('\n')) {
      const m = /^(\d+):\s*(\d+)Mhz\s*\*/.exec(l.trim());
      if (m) {
        mclkMhz = Number(m[2]);
        break;
      }
    }
  }

  const hasVram = vramTotal !== null && vramTotal > 0;
  const hasGtt = gttTotal !== null && gttTotal > 0;

  return {
    card,
    vendor: vendor || null,
    vendorId: vendorRaw || null,
    model: model || null,
    busyPercent: busy,
    tempC: gpuTemp,
    powerW: gpuPower,
    // 显存/GTT：拿不到时字段为 null（不显示假 0）
    vram: {
      total: hasVram ? vramTotal : null,
      used: hasVram && vramUsed !== null ? vramUsed : null,
      free: hasVram && vramUsed !== null ? Math.max(0, vramTotal - vramUsed) : null,
      percent: hasVram && vramUsed !== null ? round1((vramUsed / vramTotal) * 100) : null,
    },
    gtt: {
      total: hasGtt ? gttTotal : null,
      used: hasGtt && gttUsed !== null ? gttUsed : null,
      free: hasGtt && gttUsed !== null ? Math.max(0, gttTotal - gttUsed) : null,
      percent: hasGtt && gttUsed !== null ? round1((gttUsed / gttTotal) * 100) : null,
    },
    sclkMhz,
    mclkMhz,
    vddgfxMv,
    vddnbMv,
    sclkLevels,
    available: Boolean(vendor) || busy !== null || hasVram,
  };
}

/** CPU 降频判定：当前平均频率 < 基础频率的 80% 且负载高 */
function detectThrottle(cpuPercent, freq) {
  const max = freq && freq.maxMhz ? freq.maxMhz : 0;
  const ratio = max > 0 && freq.averageMhz > 0 ? freq.averageMhz / max : 0;
  return {
    // 低负载时频率自然低，不算降频
    throttled: Boolean(max > 0 && cpuPercent >= 50 && ratio < 0.8),
    ratio: round2(ratio),
    percentOfMax: round1(ratio * 100),
  };
}

/* ---------------- 系统信息 ---------------- */

let cachedStaticInfo = null;

function readStaticInfo() {
  if (cachedStaticInfo) return cachedStaticInfo;

  const cpuinfo = readFileSafe(path.join(PROC, 'cpuinfo'), '');
  let modelName = '';
  const m = /model name\s*:\s*(.+)/.exec(cpuinfo);
  if (m) modelName = m[1].trim();

  const osRelease = parseOsRelease(readFileSafe('/etc/os-release', ''));
  const procVersion = (readFileSafe(path.join(PROC, 'version'), '') || '').trim();
  const hostname = os.hostname();

  const mem = readMemory();
  const freq = readCpuFreq();

  cachedStaticInfo = {
    hostname,
    cpuModel: modelName || os.cpus()[0]?.model || 'Unknown',
    cpuCores: detectCpuTopology().threads,
    cpuPhysicalCores: detectCpuTopology().physicalCores,
    cpuThreadsPerCore: detectCpuTopology().threadsPerCore,
    cpuSmt: detectCpuTopology().smt,
    cpuPhysicalCoresEstimated: detectCpuTopology().physicalCoresEstimated,
    memTotal: mem.total,
    osName: osRelease.PRETTY_NAME || 'Linux',
    osVersion: osRelease.VERSION_ID || '',
    kernel: procVersion,
    nodeVersion: process.version,
    arch: os.arch(),
    baseFreqMhz: freq.maxMhz,
  };
  return cachedStaticInfo;
}

/* ---------------- CPU 拓扑（通用，不假设厂商/核型） ---------------- */

/** 从 sysfs topology 的 [{packageId, coreId}] 去重计算物理核 */
function computeCoresFromSys(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const pairs = new Set();
  for (const entry of entries) {
    if (!entry || !Number.isInteger(entry.packageId) || !Number.isInteger(entry.coreId)) return null;
    if (entry.packageId < 0 || entry.coreId < 0) return null;
    pairs.add(`${entry.packageId}:${entry.coreId}`);
  }
  return pairs.size > 0 ? pairs.size : null;
}

/**
 * 从 /proc/cpuinfo 文本解析物理核。
 * 优先 (physical id, core id)；其次用 siblings / cpu cores 推算（estimated=true）。
 * @param {string} text
 * @param {number} threads
 * @returns {{physicalCores:number, estimated:boolean, source:string}|null}
 */
function parseCpuinfoTopology(text, threads) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const blocks = text.split(/\n\s*\n/).filter((block) => /^processor\s*:/m.test(block));
  if (blocks.length === 0) return null;

  const pairs = new Set();
  for (const block of blocks) {
    const phys = /^physical id\s*:\s*(\d+)/m.exec(block);
    const core = /^core id\s*:\s*(\d+)/m.exec(block);
    if (phys && core) pairs.add(`${phys[1]}:${core[1]}`);
  }
  if (pairs.size > 0) {
    return { physicalCores: pairs.size, estimated: false, source: 'cpuinfo:physical-core' };
  }

  for (const block of blocks) {
    const sib = /^siblings\s*:\s*(\d+)/m.exec(block);
    const cores = /^cpu cores\s*:\s*(\d+)/m.exec(block);
    if (!sib || !cores) continue;
    const siblings = Number(sib[1]);
    const perPackage = Number(cores[1]);
    if (!(siblings > 0 && perPackage > 0) || siblings < perPackage) continue;
    const totalThreads = Math.max(1, Math.trunc(Number(threads)) || blocks.length);
    const packages = Math.max(1, Math.round(totalThreads / siblings));
    const physical = Math.max(1, Math.min(totalThreads, packages * perPackage));
    return { physicalCores: physical, estimated: true, source: 'cpuinfo:siblings' };
  }
  return null;
}

/**
 * 纯函数：根据各来源计算 CPU 拓扑。
 * 顺序：sysfs topology → /proc/cpuinfo → threads_per_core 推算 → 回退（physicalCores=threads）
 * @param {{threads:number, sysEntries?:Array|null, cpuinfoText?:string, threadsPerCore?:number|null}} input
 * @returns {{threads:number, physicalCores:number, threadsPerCore:number, smt:boolean, physicalCoresEstimated:boolean, source:string}}
 */
function computeTopology(input = {}) {
  const threads = Math.max(1, Math.trunc(Number(input.threads)) || 1);

  const sysCores = computeCoresFromSys(input.sysEntries);
  if (sysCores && sysCores <= threads) {
    const tpc = Math.max(1, Math.round(threads / sysCores));
    return { threads, physicalCores: sysCores, threadsPerCore: tpc, smt: tpc > 1, physicalCoresEstimated: false, source: 'sysfs' };
  }

  const info = parseCpuinfoTopology(input.cpuinfoText, threads);
  if (info && info.physicalCores >= 1 && info.physicalCores <= threads) {
    const tpc = Math.max(1, Math.round(threads / info.physicalCores));
    return { threads, physicalCores: info.physicalCores, threadsPerCore: tpc, smt: tpc > 1, physicalCoresEstimated: info.estimated, source: info.source };
  }

  const tpcRaw = Number(input.threadsPerCore);
  if (Number.isFinite(tpcRaw) && tpcRaw >= 1) {
    const tpc = Math.max(1, Math.round(tpcRaw));
    const physical = Math.max(1, Math.round(threads / tpc));
    return { threads, physicalCores: physical, threadsPerCore: tpc, smt: tpc > 1, physicalCoresEstimated: true, source: 'threads_per_core' };
  }

  return { threads, physicalCores: threads, threadsPerCore: 1, smt: false, physicalCoresEstimated: true, source: 'fallback' };
}

/** 读取 sysfs 每个逻辑 CPU 的 topology（任一缺失返回 null，交给上层回退） */
function readSysTopology() {
  const base = path.join(SYS, 'devices', 'system', 'cpu');
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => /^cpu\d+$/.test(n));
  } catch (e) {
    return null;
  }
  if (names.length === 0) return null;
  const entries = [];
  for (const name of names) {
    const topo = path.join(base, name, 'topology');
    const packageId = readIntSafe(path.join(topo, 'physical_package_id'), null);
    const coreId = readIntSafe(path.join(topo, 'core_id'), null);
    if (packageId === null || coreId === null) return null;
    entries.push({ packageId, coreId });
  }
  return entries;
}

/** 读取 sysfs threads_per_core（缺失返回 null） */
function readThreadsPerCore() {
  const base = path.join(SYS, 'devices', 'system', 'cpu');
  let names = [];
  try {
    names = fs.readdirSync(base).filter((n) => /^cpu\d+$/.test(n));
  } catch (e) {
    return null;
  }
  for (const name of names) {
    const value = readIntSafe(path.join(base, name, 'topology', 'threads_per_core'), null);
    if (value !== null && value > 0) return value;
  }
  return null;
}

let cachedTopology = null;
/** 检测本机 CPU 拓扑（缓存；纯计算逻辑见 computeTopology） */
function detectCpuTopology() {
  if (cachedTopology) return cachedTopology;
  cachedTopology = computeTopology({
    threads: os.cpus().length || 1,
    sysEntries: readSysTopology(),
    cpuinfoText: readFileSafe(path.join(PROC, 'cpuinfo'), ''),
    threadsPerCore: readThreadsPerCore(),
  });
  return cachedTopology;
}

/** 兼容旧接口：返回物理核数 */
function detectPhysicalCores() {
  return detectCpuTopology().physicalCores;
}

function parseOsRelease(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* ---------------- 进程（快速摘要） ---------------- */

/** 仅统计数量与 Top 进程，用于概览页 */
function readProcessSummary() {
  let entries = [];
  try {
    entries = fs.readdirSync(PROC).filter((n) => /^\d+$/.test(n));
  } catch (e) {
    return { total: 0, top: [] };
  }

  let total = 0;
  const procs = [];
  const clk = 100; // USER_HZ 通常为 100
  const uptimeSec = readUptime().uptimeSeconds;

  for (const pidStr of entries) {
    const pid = Number(pidStr);
    const statText = readFileSafe(path.join(PROC, pidStr, 'stat'));
    if (!statText) continue;
    total++;
    // comm 可能包含空格与括号，用最后一个 ) 定位
    const close = statText.lastIndexOf(')');
    if (close < 0) continue;
    const comm = statText.slice(statText.indexOf('(') + 1, close);
    const rest = statText.slice(close + 2).split(/\s+/);
    const state = rest[0];
    const utime = Number(rest[11]) || 0;
    const stime = Number(rest[12]) || 0;
    const rssPages = Number(rest[21]) || 0;

    const totalTicks = utime + stime;
    // 进程 CPU% = 累计 CPU 时间 / 进程存活时间
    const startTicks = Number(rest[19]) || 0;
    const ageSec = Math.max(0.01, uptimeSec - startTicks / clk);
    const cpuPercent = round1((totalTicks / clk / ageSec) * 100);

    procs.push({
      pid,
      comm,
      state,
      cpuPercent,
      rssBytes: rssPages * 4096,
    });
  }

  procs.sort((a, b) => b.cpuPercent - a.cpuPercent);
  return { total, top: procs.slice(0, 5) };
}

/* ---------------- 工具 ---------------- */

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ---------------- 采集器主体 ---------------- */

class Collector {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || 1000;
    this.prev = {
      cpu: null,
      disk: null,
      net: null,
      at: 0,
    };
    this.latest = null;
    this.timer = null;
    this.listeners = new Set();
    this.history = []; // 环形缓冲，保留最近 N 个样本
    this.historyLimit = options.historyLimit || 600;
  }

  /** 采集一次完整快照 */
  sample() {
    const now = Date.now();
    const elapsedMs = this.prev.at ? now - this.prev.at : 0;

    const cpuStat = readCpuStat();
    const diskStats = readDiskStats();
    const netStats = readNetwork();
    const mem = readMemory();
    const load = readLoad();
    const uptime = readUptime();
    const sensors = readSensors();
    const freq = readCpuFreq();
    const fsList = readFilesystems();
    const memPressure = readPressure('memory');
    const cpuPressure = readPressure('cpu');
    const ioPressure = readPressure('io');

    const topo = detectCpuTopology();
    const cpu = cpuDelta(this.prev.cpu, cpuStat);
    const disks = diskDelta(this.prev.disk, diskStats, elapsedMs);
    const nets = networkDelta(this.prev.net, netStats, elapsedMs);

    // 传感器按设备归类（drm=GPU / nvme=SSD / 其余=CPU），不依赖具体 chip 名
    const picked = pickPrimarySensors(sensors);
    const cpuTemp = picked.cpuTemp;
    const gpuTemp = picked.gpuTemp;
    const nvmeTemp = picked.nvmeTemp;
    const gpuPower = picked.gpuPower;

    const throttle = detectThrottle(cpu.percent, freq);
    const gpu = readGpuInfo(sensors);

    // 把每核频率合并进分核数据
    const freqMap = new Map((freq.perCore || []).map((c) => [c.index, c.mhz]));
    const perCoreDetail = (cpu.perCore || []).map((c) => ({
      ...c,
      mhz: freqMap.get(c.index) ?? null,
    }));

    const snapshot = {
      at: now,
      intervalMs: elapsedMs,
      cpu: {
        percent: cpu.percent ?? 0,
        user: cpu.user,
        system: cpu.system,
        iowait: cpu.iowait,
        idle: cpu.idle,
        perCore: perCoreDetail,
        // coreCount 保留兼容（= 线程数）；physicalCores/threads 为通用字段
        coreCount: topo.threads,
        physicalCores: topo.physicalCores,
        threads: topo.threads,
        threadsPerCore: topo.threadsPerCore,
        smt: topo.smt,
        physicalCoresEstimated: topo.physicalCoresEstimated,
        temp: cpuTemp,
        freq,
        throttle,
      },
      memory: { ...mem },
      load,
      uptime,
      disks,
      filesystems: fsList,
      gpu,
      network: {
        interfaces: nets,
        links: readNetworkLinks(),
      },
      sensors: {
        cpuTemp,
        gpuTemp: gpuTemp,
        nvmeTemp: nvmeTemp,
        gpuBusyPercent: gpu ? gpu.busyPercent : null,
        gpuPowerW: gpuPower,
        gpuVramUsed: gpu ? gpu.vram.used : null,
        gpuVramTotal: gpu ? gpu.vram.total : null,
        gpuVramPercent: gpu ? gpu.vram.percent : null,
        all: sensors.temps,
        power: sensors.power,
      },
      pressure: {
        cpu: cpuPressure,
        memory: memPressure,
        io: ioPressure,
      },
    };

    this.prev = { cpu: cpuStat, disk: diskStats, net: netStats, at: now };
    this.latest = snapshot;

    this.history.push({
      at: now,
      cpu: snapshot.cpu.percent,
      mem: snapshot.memory.usedPercent,
      cpuTemp: snapshot.sensors.cpuTemp,
      rx: nets.reduce((a, n) => a + n.rxBytesPerSec, 0),
      tx: nets.reduce((a, n) => a + n.txBytesPerSec, 0),
    });
    if (this.history.length > this.historyLimit) this.history.shift();

    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch (e) {
        // 监听器异常不影响采集
      }
    }
    return snapshot;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (this.timer) return;
    this.sample(); // 建立基线
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLatest() {
    return this.latest;
  }

  getHistory() {
    return this.history;
  }
}

module.exports = {
  Collector,
  readStaticInfo,
  readProcessSummary,
  readMemory,
  readLoad,
  readUptime,
  readSensors,
  readCpuFreq,
  readFilesystems,
  readDiskStats,
  readNetwork,
  computeCoresFromSys,
  parseCpuinfoTopology,
  computeTopology,
  detectCpuTopology,
  detectPhysicalCores,
  pickPrimarySensors,
  classifySensors,
  readGpuDevicePaths,
  round1,
  round2,
};
