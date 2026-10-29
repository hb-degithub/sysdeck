'use strict';

/**
 * 性能压测引擎
 *
 * 设计原则：
 *   1. 默认不运行任何任务，必须显式 start()
 *   2. 每个任务都有硬性上限（时长 / 线程数 / 内存 / 文件大小）
 *   3. 支持随时中止，且中止后立即释放资源
 *   4. 压测期间持续采样温度与频率，超过温度墙自动中止
 *   5. 同一时刻只允许一个任务（避免互相干扰导致数据失真）
 *
 * 三类任务：
 *   - CPU：worker_threads 多线程整数/浮点混合运算，统计每秒完成量
 *   - 内存：顺序读写带宽 + 随机访问延迟
 *   - 磁盘：顺序/随机读写 IOPS 与吞吐（写入目标目录可配）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// ============================================================
// CPU worker：在独立线程里跑混合运算
// ============================================================
function cpuWorkerMain() {
  const { durationMs } = workerData;
  const deadline = Date.now() + durationMs;

  // 一个 64 位整数 + 双精度浮点混合的工作负载，防止 JIT 优化掉
  let intState = 0x9e3779b9;
  let floatState = 1.0000001;

  const buffer = Buffer.allocUnsafe(64 * 1024);
  let iterations = 0;
  let bytesHashed = 0;
  let lastReport = Date.now();
  let opsSinceReport = 0;

  // 主循环：分块执行，每块后检查是否超时
  while (Date.now() < deadline) {
    for (let i = 0; i < 2000; i++) {
      // 整数运算：xorshift + 乘法混合
      intState ^= intState << 13;
      intState ^= intState >>> 17;
      intState ^= intState << 5;
      intState = (intState * 1103515245 + 12345) | 0;

      // 浮点运算：避免被常量折叠
      floatState = floatState * 1.0000001 + 0.000001;
      if (floatState > 1e6) floatState = 1.0000001;
    }

    // 每 2000 次迭代做一次哈希，模拟真实加密负载
    buffer.writeUInt32BE(intState >>> 0, 0);
    buffer.writeDoubleBE(floatState, 8);
    crypto.createHash('sha256').update(buffer.subarray(0, 16)).digest();
    bytesHashed += 16;
    iterations += 2000;
    opsSinceReport += 2000;

    // 每 250ms 上报一次进度
    const now = Date.now();
    if (now - lastReport >= 250) {
      parentPort.postMessage({
        type: 'progress',
        iterations,
        bytesHashed,
        opsPerSec: Math.round((opsSinceReport / (now - lastReport)) * 1000),
      });
      opsSinceReport = 0;
      lastReport = now;
    }
  }

  parentPort.postMessage({
    type: 'done',
    iterations,
    bytesHashed,
    intState: intState >>> 0,
    floatState,
  });
}

if (!isMainThread && workerData && workerData.__benchCpu) {
  cpuWorkerMain();
  return;
}

// ============================================================
// 通用工具
// ============================================================

function readIntSafe(p, fallback = null) {
  try {
    const v = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

/** 读取 CPU 温度（Tctl 优先） */
function readCpuTemp() {
  const hwmonRoot = '/sys/class/hwmon';
  let dirs = [];
  try {
    dirs = fs.readdirSync(hwmonRoot);
  } catch (e) {
    return null;
  }
  for (const d of dirs) {
    const dir = path.join(hwmonRoot, d);
    let name = '';
    try {
      name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim();
    } catch (e) {
      continue;
    }
    if (name !== 'k10temp' && name !== 'coretemp') continue;
    const raw = readIntSafe(path.join(dir, 'temp1_input'));
    if (raw === null) continue;
    return Math.round(raw / 100) / 10;
  }
  return null;
}

/** 读取平均 CPU 频率（MHz） */
function readAvgFreqMhz() {
  const base = '/sys/devices/system/cpu';
  let cpus = [];
  try {
    cpus = fs.readdirSync(base).filter((n) => /^cpu\d+$/.test(n));
  } catch (e) {
    return null;
  }
  let sum = 0;
  let count = 0;
  for (const c of cpus) {
    const v = readIntSafe(path.join(base, c, 'cpufreq', 'scaling_cur_freq'));
    if (v) {
      sum += v;
      count++;
    }
  }
  return count > 0 ? Math.round((sum / count / 1000) * 10) / 10 : null;
}


/** 查找 amdgpu 的 hwmon 目录（可能不存在） */
function findGpuHwmon() {
  const cards = [];
  try {
    for (const name of fs.readdirSync('/sys/class/drm')) {
      if (/^card\d+$/.test(name)) cards.push(path.join('/sys/class/drm', name, 'device'));
    }
  } catch (e) {
    return null;
  }
  for (const dev of cards) {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dev, 'hwmon'));
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const dir = path.join(dev, 'hwmon', entry);
      const name = (() => {
        try {
          return fs.readFileSync(path.join(dir, 'name'), 'utf8').trim();
        } catch (e) {
          return '';
        }
      })();
      if (name === 'amdgpu') return dir;
    }
  }
  return null;
}

/**
 * 读取 GPU 观测值（不可用则对应字段缺失/为 null）。
 * @returns {{gpuBusy?:number,gpuTempC?:number,gpuPowerW?:number,gpuVramUsed?:number,gpuVramTotal?:number,gpuVramPercent?:number}}
 */
function readGpuSample() {
  const out = {};
  const busy = readIntSafe('/sys/class/drm/card0/device/gpu_busy_percent', null);
  if (busy !== null) out.gpuBusy = busy;
  const dev = '/sys/class/drm/card0/device';
  const vramUsed = readIntSafe(path.join(dev, 'mem_info_vram_used'), null);
  const vramTotal = readIntSafe(path.join(dev, 'mem_info_vram_total'), null);
  if (vramUsed !== null) out.gpuVramUsed = vramUsed;
  if (vramTotal !== null && vramTotal > 0) {
    out.gpuVramTotal = vramTotal;
    if (vramUsed !== null) out.gpuVramPercent = round((vramUsed / vramTotal) * 100, 1);
  }
  const hw = findGpuHwmon();
  if (hw) {
    const temp = readIntSafe(path.join(hw, 'temp1_input'), null);
    if (temp !== null) out.gpuTempC = round(temp / 1000, 1);
    const power = readIntSafe(path.join(hw, 'power1_average'), null);
    if (power !== null) out.gpuPowerW = round(power / 1000000, 1);
  }
  return out;
}

function round(n, digits = 2) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 压测管理器
// ============================================================

const DEFAULTS = {
  maxDurationMs: 5 * 60 * 1000, // 单次最长 5 分钟
  maxThreads: 64,
  tempLimitC: 90, // 温度墙
  maxMemMb: 2048, // 内存测试上限 2GB
  maxDiskFileMb: 2048, // 磁盘测试文件上限 2GB
  diskDir: '/tmp', // 默认写入 /tmp
};

class BenchManager {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.current = null; // { kind, startedAt, ... }
    this.lastResult = null;
    this.tempSamples = [];
    this._tempTimer = null;
  }

  /** 当前状态（供轮询） */
  status() {
    if (!this.current) {
      return { running: false, lastResult: this.lastResult };
    }
    return {
      running: true,
      kind: this.current.kind,
      startedAt: this.current.startedAt,
      elapsedMs: Date.now() - this.current.startedAt,
      progress: this.current.progress || {},
      tempSamples: this.tempSamples.slice(-120),
      config: this.current.config,
    };
  }

  /** 启动温度监控 */
  _startTempMonitor() {
    this.tempSamples = [];
    const tick = () => {
      this.tempSamples.push({
        at: Date.now(),
        temp: readCpuTemp(),
        freq: readAvgFreqMhz(),
        gpu: readGpuSample(),
      });
      if (this.tempSamples.length > 600) this.tempSamples.shift();

      // 温度墙保护
      if (this.current) {
        const t = this.tempSamples[this.tempSamples.length - 1];
        if (t.temp !== null && t.temp >= this.opts.tempLimitC) {
          this.abort(`CPU 温度达到 ${t.temp}°C，超过 ${this.opts.tempLimitC}°C 上限，已自动中止`);
        }
      }
    };
    tick();
    this._tempTimer = setInterval(tick, 1000);
    if (this._tempTimer.unref) this._tempTimer.unref();
  }

  _stopTempMonitor() {
    if (this._tempTimer) {
      clearInterval(this._tempTimer);
      this._tempTimer = null;
    }
  }

  /** 中止当前任务 */
  abort(reason = '用户中止') {
    if (!this.current) return { ok: false, error: '当前没有运行中的任务' };
    const job = this.current;
    job.aborted = true;
    job.abortReason = reason;
    if (job.cleanup) {
      try {
        job.cleanup();
      } catch (e) {
        /* ignore */
      }
    }
    return { ok: true, reason };
  }

  /** 汇总温度统计 */
  _tempStats() {
    const vals = this.tempSamples.map((s) => s.temp).filter((v) => v !== null);
    const freqs = this.tempSamples.map((s) => s.freq).filter((v) => v !== null);
    if (vals.length === 0) return { min: null, max: null, avg: null, freqMax: null, freqMin: null };
    return {
      min: Math.min(...vals),
      max: Math.max(...vals),
      avg: round(vals.reduce((a, b) => a + b, 0) / vals.length, 1),
      freqMax: freqs.length ? Math.max(...freqs) : null,
      freqMin: freqs.length ? Math.min(...freqs) : null,
    };
  }

  // ==========================================================
  // CPU 压测
  // ==========================================================
  async runCpu(config = {}) {
    if (this.current) throw new Error('已有压测任务在运行，请先中止');

    const threads = Math.max(1, Math.min(this.opts.maxThreads, Number(config.threads) || os.cpus().length));
    const durationMs = Math.max(1000, Math.min(this.opts.maxDurationMs, (Number(config.durationSec) || 30) * 1000));

    const job = {
      kind: 'cpu',
      startedAt: Date.now(),
      config: { threads, durationSec: durationMs / 1000 },
      progress: { threads, opsPerSec: 0, iterations: 0 },
      aborted: false,
      workers: [],
    };
    this.current = job;
    this._startTempMonitor();

    const baseTemp = readCpuTemp();
    const baseFreq = readAvgFreqMhz();

    const cleanup = () => {
      for (const w of job.workers) {
        try {
          w.terminate();
        } catch (e) {
          /* ignore */
        }
      }
      job.workers = [];
    };
    job.cleanup = cleanup;

    try {
      const workerPromises = [];
      for (let i = 0; i < threads; i++) {
        workerPromises.push(
          new Promise((resolve, reject) => {
            const w = new Worker(__filename, {
              workerData: { __benchCpu: true, durationMs },
            });
            job.workers.push(w);
            let finalIterations = 0;
            w.on('message', (msg) => {
              if (msg.type === 'progress') {
                job.progress.iterations += msg.iterations - (w._lastIter || 0);
                w._lastIter = msg.iterations;
                // 汇总所有 worker 的瞬时吞吐
                job.progress.opsPerSec =
                  job.workers.reduce((a, x) => a + (x._opsPerSec || 0), 0);
                w._opsPerSec = msg.opsPerSec;
              } else if (msg.type === 'done') {
                finalIterations = msg.iterations;
                resolve({ iterations: finalIterations, bytesHashed: msg.bytesHashed });
              }
            });
            w.on('error', reject);
            w.on('exit', () => {
              if (finalIterations === 0) resolve({ iterations: 0, bytesHashed: 0 });
            });
          })
        );
      }

      const results = await Promise.all(workerPromises);
      const actualMs = Date.now() - job.startedAt;
      const totalIterations = results.reduce((a, r) => a + r.iterations, 0);

      const tempStats = this._tempStats();
      const samples = this.tempSamples.map((sample) => {
        const item = { t: sample.at };
        if (sample.freq !== null && sample.freq !== undefined) item.cpuFreqMhz = sample.freq;
        if (sample.temp !== null && sample.temp !== undefined) item.cpuTempC = sample.temp;
        if (sample.gpu) {
          for (const key of ['gpuBusy', 'gpuTempC', 'gpuPowerW', 'gpuVramUsed', 'gpuVramTotal', 'gpuVramPercent']) {
            if (sample.gpu[key] !== undefined && sample.gpu[key] !== null) item[key] = sample.gpu[key];
          }
        }
        return item;
      });
      const gpuSamples = this.tempSamples.map((sample) => sample.gpu || {});
      const gpuBusyVals = gpuSamples.map((g) => g.gpuBusy).filter((v) => typeof v === 'number');
      const gpuTempVals = gpuSamples.map((g) => g.gpuTempC).filter((v) => typeof v === 'number');
      const gpuPowerVals = gpuSamples.map((g) => g.gpuPowerW).filter((v) => typeof v === 'number');
      const gpuStats = gpuBusyVals.length || gpuTempVals.length || gpuPowerVals.length
        ? {
            busyMax: gpuBusyVals.length ? Math.max(...gpuBusyVals) : null,
            busyAvg: gpuBusyVals.length ? round(gpuBusyVals.reduce((a, b) => a + b, 0) / gpuBusyVals.length, 1) : null,
            tempMax: gpuTempVals.length ? Math.max(...gpuTempVals) : null,
            powerMax: gpuPowerVals.length ? Math.max(...gpuPowerVals) : null,
            samples: gpuSamples.filter((g) => Object.keys(g).length > 0).length,
          }
        : null;
      const result = {
        kind: 'cpu',
        at: Date.now(),
        durationMs: actualMs,
        threads,
        totalIterations,
        opsPerSec: Math.round(totalIterations / (actualMs / 1000)),
        // 评分：每秒千次迭代
        score: Math.round(totalIterations / (actualMs / 1000) / 1000),
        baseTemp,
        baseFreq,
        temp: tempStats,
        samples,
        gpu: gpuStats,
        aborted: job.aborted,
        abortReason: job.abortReason || null,
      };
      this.lastResult = result;
      return result;
    } finally {
      cleanup();
      this._stopTempMonitor();
      this.current = null;
    }
  }

  // ==========================================================
  // 内存压测
  // ==========================================================
  async runMemory(config = {}) {
    if (this.current) throw new Error('已有压测任务在运行，请先中止');

    const sizeMb = Math.max(16, Math.min(this.opts.maxMemMb, Number(config.sizeMb) || 256));
    const durationMs = Math.max(1000, Math.min(this.opts.maxDurationMs, (Number(config.durationSec) || 20) * 1000));

    const job = {
      kind: 'memory',
      startedAt: Date.now(),
      config: { sizeMb, durationSec: durationMs / 1000 },
      progress: {},
      aborted: false,
    };
    this.current = job;
    this._startTempMonitor();

    try {
      const sizeBytes = sizeMb * 1024 * 1024;
      const words = sizeBytes / 8; // 按 Float64 计
      const buffer = Buffer.allocUnsafe(sizeBytes);
      const view = new Float64Array(buffer.buffer, buffer.byteOffset, words);

      // ---- 1. 顺序写 ----
      let t0 = Date.now();
      for (let i = 0; i < words; i++) view[i] = i * 1.0000001;
      const seqWriteMs = Math.max(1, Date.now() - t0);
      const seqWriteMbs = round(sizeBytes / (seqWriteMs / 1000) / 1048576, 1);
      job.progress.stage = '顺序读';

      // ---- 2. 顺序读 ----
      t0 = Date.now();
      let sum = 0;
      for (let i = 0; i < words; i++) sum += view[i];
      const seqReadMs = Math.max(1, Date.now() - t0);
      const seqReadMbs = round(sizeBytes / (seqReadMs / 1000) / 1048576, 1);
      job.progress.stage = '随机读写';

      // ---- 3. 随机访问延迟 ----
      const probes = Math.min(200000, Math.max(10000, Math.floor(words / 8)));
      const idxArr = new Uint32Array(probes);
      const rnd = crypto.randomBytes(probes * 4);
      for (let i = 0; i < probes; i++) {
        idxArr[i] = rnd.readUInt32BE(i * 4) % words;
      }

      t0 = process.hrtime.bigint();
      let acc = 0;
      for (let i = 0; i < probes; i++) {
        acc += view[idxArr[i]];
      }
      const randNs = Number(process.hrtime.bigint() - t0);
      const randLatencyNs = round(randNs / probes, 1);
      const randOpsPerSec = Math.round((probes / randNs) * 1e9);
      job.progress.stage = '完成';

      // 防止优化掉
      if (sum === Infinity && acc === -Infinity) console.log('');

      const tempStats = this._tempStats();
      const result = {
        kind: 'memory',
        at: Date.now(),
        durationMs: Date.now() - job.startedAt,
        sizeMb,
        sequential: {
          writeMbs: seqWriteMbs,
          writeMs: seqWriteMs,
          readMbs: seqReadMbs,
          readMs: seqReadMs,
        },
        random: {
          probes,
          latencyNs: randLatencyNs,
          opsPerSec: randOpsPerSec,
        },
        score: seqReadMbs,
        temp: tempStats,
        aborted: job.aborted,
      };
      this.lastResult = result;
      return result;
    } finally {
      this._stopTempMonitor();
      this.current = null;
    }
  }

  // ==========================================================
  // 磁盘压测
  // ==========================================================

  // ==========================================================
  // 网络吞吐（本机 loopback TCP）
  // ==========================================================
  async runNetwork(config = {}) {
    if (this.current) throw new Error('已有压测任务在运行，请先中止');

    const durationMs = Math.max(1000, Math.min(60000, (Number(config.durationSec) || 10) * 1000));
    const connections = Math.max(1, Math.min(4, Number(config.connected) || 1));
    const msgSize = Math.max(16 * 1024, Math.min(1024 * 1024, Number(config.msgSize) || 64 * 1024));

    const job = {
      kind: 'network',
      startedAt: Date.now(),
      config: { durationSec: durationMs / 1000, connected: connections, msgSize, loopback: true },
      progress: { connections, uploadMB: 0, downloadMB: 0, elapsedMs: 0 },
      aborted: false,
      cleanup: null,
    };
    this.current = job;
    this._startTempMonitor();

    let server = null;
    let sockets = [];
    let uploadBytes = 0;
    let downloadBytes = 0;
    const cleanup = () => {
      try {
        if (server) server.close();
      } catch (e) {
        /* ignore */
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch (e) {
          /* ignore */
        }
      }
      sockets = [];
    };
    job.cleanup = () => {
      job.aborted = true;
      job.abortReason = '用户中止';
      cleanup();
    };

    try {
      const payload = Buffer.allocUnsafe(msgSize);
      crypto.randomFillSync(payload);
      const cpuStart = process.cpuUsage();

      server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          uploadBytes += chunk.length;
          try {
            if (!socket.destroyed) socket.write(chunk);
          } catch (e) {
            /* ignore */
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;

      const clients = [];
      for (let i = 0; i < connections; i += 1) {
        const client = await new Promise((resolve, reject) => {
          const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
          socket.once('error', reject);
          socket.on('error', () => {});
          socket.on('data', (chunk) => {
            downloadBytes += chunk.length;
          });
          sockets.push(socket);
        });
        clients.push(client);
      }

      const deadline = Date.now() + durationMs;
      const pump = () => {
        if (job.aborted || Date.now() >= deadline) return;
        for (const client of clients) {
          if (client.destroyed || !client.writable) continue;
          try {
            client.write(payload);
          } catch (e) {
            /* ignore */
          }
        }
        setImmediate(pump);
      };
      pump();

      await new Promise((resolve) => {
        const poll = setInterval(() => {
          job.progress.uploadMB = round(uploadBytes / 1048576, 1);
          job.progress.downloadMB = round(downloadBytes / 1048576, 1);
          job.progress.elapsedMs = Date.now() - job.startedAt;
          if (job.aborted || Date.now() >= deadline) {
            clearInterval(poll);
            resolve();
          }
        }, 200);
        if (poll.unref) poll.unref();
      });

      const actualMs = Math.max(1, Date.now() - job.startedAt);
      const cpu = process.cpuUsage(cpuStart);
      const cpuPercent = round(((cpu.user + cpu.system) / 1000 / actualMs) * 100, 1);
      const uploadMbps = round(uploadBytes / (actualMs / 1000) / 1048576, 1);
      const downloadMbps = round(downloadBytes / (actualMs / 1000) / 1048576, 1);
      const samples = this.tempSamples.map((sample) => ({
        t: sample.at,
        ...(sample.freq !== null && sample.freq !== undefined ? { cpuFreqMhz: sample.freq } : {}),
        ...(sample.temp !== null && sample.temp !== undefined ? { cpuTempC: sample.temp } : {}),
        ...(sample.gpu || {}),
      }));
      const result = {
        kind: 'network',
        at: Date.now(),
        durationMs: actualMs,
        // 重要：本机 loopback，不代表网卡/对端性能
        loopback: true,
        connected: connections,
        msgSize,
        upload: { bytes: uploadBytes, mbps: uploadMbps },
        download: { bytes: downloadBytes, mbps: downloadMbps },
        cpuPercent,
        score: Math.round(downloadMbps),
        samples,
        temp: this._tempStats(),
        aborted: job.aborted,
        abortReason: job.abortReason || null,
        note: 'loopback 压测仅测本机 TCP 栈吞吐，不代表真实网卡/对端网络性能',
      };
      this.lastResult = result;
      return result;
    } finally {
      cleanup();
      this._stopTempMonitor();
      this.current = null;
    }
  }

  async runDisk(config = {}) {
    if (this.current) throw new Error('已有压测任务在运行，请先中止');

    const sizeMb = Math.max(16, Math.min(this.opts.maxDiskFileMb, Number(config.sizeMb) || 256));
    const mode = config.mode === 'random' ? 'random' : 'sequential';
    const durationMs = Math.max(1000, Math.min(this.opts.maxDurationMs, (Number(config.durationSec) || 20) * 1000));
    const dir = config.dir || this.opts.diskDir;

    // 目标目录必须存在且可写
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      throw new Error(`目录不可写：${dir}`);
    }

    const testFile = path.join(dir, `.panel-bench-${Date.now()}.dat`);
    const blockSize = mode === 'random' ? 4096 : 1024 * 1024;

    const job = {
      kind: 'disk',
      startedAt: Date.now(),
      config: { sizeMb, mode, dir, blockSize, durationSec: durationMs / 1000 },
      progress: { stage: '准备' },
      aborted: false,
      cleanup: null,
    };
    this.current = job;
    this._startTempMonitor();

    const cleanup = () => {
      try {
        fs.unlinkSync(testFile);
      } catch (e) {
        /* ignore */
      }
    };
    job.cleanup = () => {
      cleanup();
      job.aborted = true;
    };

    try {
      const totalBytes = sizeMb * 1024 * 1024;
      const block = Buffer.allocUnsafe(blockSize);
      crypto.randomFillSync(block);

      // ---- 写 ----
      job.progress.stage = mode === 'random' ? '随机写' : '顺序写';
      const fd = fs.openSync(testFile, 'w');
      let written = 0;
      let t0 = Date.now();
      if (mode === 'sequential') {
        while (written < totalBytes && Date.now() - t0 < durationMs && !job.aborted) {
          written += fs.writeSync(fd, block, 0, blockSize);
        }
      } else {
        // 随机写：先分配文件大小
        fs.ftruncateSync(fd, totalBytes);
        const maxOff = Math.max(0, totalBytes - blockSize);
        while (written < totalBytes && Date.now() - t0 < durationMs && !job.aborted) {
          const off = Math.floor(Math.random() * (maxOff / blockSize)) * blockSize;
          fs.writeSync(fd, block, 0, blockSize, off);
          written += blockSize;
        }
      }
      fs.fsyncSync(fd);
      const writeMs = Math.max(1, Date.now() - t0);
      job.progress.stage = '写完成，读测试中';

      // ---- 读 ----
      const readCtx = fs.openSync(testFile, 'r');
      let readBytes = 0;
      t0 = Date.now();
      const readBuf = Buffer.allocUnsafe(blockSize);
      const fileSize = fs.fstatSync(readCtx).size;
      if (mode === 'sequential') {
        let pos = 0;
        while (pos < fileSize && Date.now() - t0 < durationMs && !job.aborted) {
          const n = fs.readSync(readCtx, readBuf, 0, blockSize, pos);
          if (n <= 0) break;
          readBytes += n;
          pos += n;
        }
      } else {
        const maxOff = Math.max(0, fileSize - blockSize);
        while (readBytes < fileSize && Date.now() - t0 < durationMs && !job.aborted) {
          const off = Math.floor(Math.random() * (maxOff / blockSize)) * blockSize;
          const n = fs.readSync(readCtx, readBuf, 0, blockSize, off);
          if (n <= 0) break;
          readBytes += n;
        }
      }
      const readMs = Math.max(1, Date.now() - t0);
      fs.closeSync(readCtx);
      fs.closeSync(fd);
      job.progress.stage = '完成';

      const tempStats = this._tempStats();
      const result = {
        kind: 'disk',
        at: Date.now(),
        durationMs: Date.now() - job.startedAt,
        mode,
        dir,
        blockSize,
        sizeMb,
        write: {
          bytes: written,
          ms: writeMs,
          mbps: round(written / (writeMs / 1000) / 1048576, 1),
          iops: Math.round(written / blockSize / (writeMs / 1000)),
        },
        read: {
          bytes: readBytes,
          ms: readMs,
          mbps: round(readBytes / (readMs / 1000) / 1048576, 1),
          iops: Math.round(readBytes / blockSize / (readMs / 1000)),
        },
        score: round(readBytes / (readMs / 1000) / 1048576, 1),
        // 刚写入的文件会命中 page cache，读取数值可能远高于磁盘物理性能
        cacheNotice: '读取可能命中系统缓存（page cache），实际磁盘性能通常低于此值',
        temp: tempStats,
        aborted: job.aborted,
      };
      this.lastResult = result;
      return result;
    } finally {
      cleanup();
      this._stopTempMonitor();
      this.current = null;
    }
  }
}

module.exports = { BenchManager, readCpuTemp, readAvgFreqMhz, readGpuSample, DEFAULTS };
