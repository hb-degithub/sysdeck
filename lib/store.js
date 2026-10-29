'use strict';

/**
 * SQLite 历史数据存储
 * - 原始样本：1s 一条，只留内存（由 collector 的环形缓冲负责）
 * - 归档：每分钟聚合一条写入数据库
 * - 查询：按区间降采样，返回适合绘图的点数
 */

const fs = require('node:fs');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.retentionDays = options.retentionDays || 30;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        ts INTEGER PRIMARY KEY,
        cpu REAL,
        cpu_user REAL,
        cpu_system REAL,
        cpu_iowait REAL,
        mem_used REAL,
        mem_percent REAL,
        swap_percent REAL,
        load1 REAL,
        load5 REAL,
        load15 REAL,
        cpu_temp REAL,
        cpu_freq REAL,
        gpu_temp REAL,
        gpu_busy REAL,
        nvme_temp REAL,
        rx_bytes INTEGER,
        tx_bytes INTEGER,
        disk_read INTEGER,
        disk_write INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        metric TEXT,
        value REAL,
        threshold REAL,
        message TEXT,
        severity TEXT DEFAULT 'warn',
        acknowledged INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

      CREATE TABLE IF NOT EXISTS bench_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        kind TEXT,
        params TEXT,
        score REAL,
        duration_ms INTEGER,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bench_ts ON bench_results(ts);
    `);
    this.migrate();
  }

  /** 轻量 schema 迁移：旧库补 severity 列（不破坏已有数据） */
  migrate() {
    try {
      const columns = this.db.prepare('PRAGMA table_info(alerts)').all().map((row) => row.name);
      if (!columns.includes('severity')) {
        this.db.exec("ALTER TABLE alerts ADD COLUMN severity TEXT DEFAULT 'warn'");
      }
    } catch (e) {
      // 迁移失败不应阻止面板启动；旧列缺失时按 warn 处理
    }
  }

  /** 写入一条聚合样本 */
  insert(sample) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO metrics (
        ts, cpu, cpu_user, cpu_system, cpu_iowait, mem_used, mem_percent,
        swap_percent, load1, load5, load15, cpu_temp, cpu_freq,
        gpu_temp, gpu_busy, nvme_temp, rx_bytes, tx_bytes, disk_read, disk_write
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    const rx = sample.network?.interfaces?.reduce((a, n) => a + n.rxBytesPerSec, 0) || 0;
    const tx = sample.network?.interfaces?.reduce((a, n) => a + n.txBytesPerSec, 0) || 0;
    const diskRead = sample.disks?.reduce((a, d) => a + d.readBytesPerSec, 0) || 0;
    const diskWrite = sample.disks?.reduce((a, d) => a + d.writeBytesPerSec, 0) || 0;

    stmt.run(
      sample.at,
      sample.cpu?.percent ?? 0,
      sample.cpu?.user ?? 0,
      sample.cpu?.system ?? 0,
      sample.cpu?.iowait ?? 0,
      sample.memory?.used ?? 0,
      sample.memory?.usedPercent ?? 0,
      sample.memory?.swapPercent ?? 0,
      sample.load?.load1 ?? 0,
      sample.load?.load5 ?? 0,
      sample.load?.load15 ?? 0,
      sample.sensors?.cpuTemp ?? null,
      sample.cpu?.freq?.averageMhz ?? null,
      sample.sensors?.gpuTemp ?? null,
      sample.sensors?.gpuBusyPercent ?? null,
      sample.sensors?.nvmeTemp ?? null,
      rx,
      tx,
      diskRead,
      diskWrite
    );
  }

  /**
   * 查询区间数据并降采样
   * @param {number} from 起始时间戳
   * @param {number} to 结束时间戳
   * @param {number} maxPoints 最大返回点数
   */
  query(from, to, maxPoints = 300) {
    const rows = this.db
      .prepare(`SELECT * FROM metrics WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`)
      .all(from, to);

    if (rows.length === 0) return { points: [], stats: null };
    if (rows.length <= maxPoints) {
      return { points: rows, stats: this.computeStats(rows) };
    }

    // 按桶降采样，每桶取平均值
    const bucketSize = Math.ceil(rows.length / maxPoints);
    const points = [];
    for (let i = 0; i < rows.length; i += bucketSize) {
      const chunk = rows.slice(i, i + bucketSize);
      points.push(this.averageRows(chunk));
    }
    return { points, stats: this.computeStats(rows) };
  }

  averageRows(chunk) {
    const numericKeys = [
      'ts', 'cpu', 'cpu_user', 'cpu_system', 'cpu_iowait', 'mem_used', 'mem_percent',
      'swap_percent', 'load1', 'load5', 'load15', 'cpu_temp', 'cpu_freq',
      'gpu_temp', 'gpu_busy', 'nvme_temp', 'rx_bytes', 'tx_bytes',
      'disk_read', 'disk_write',
    ];
    const out = {};
    for (const k of numericKeys) {
      let sum = 0;
      let n = 0;
      for (const row of chunk) {
        const v = row[k];
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
      out[k] = n > 0 ? sum / n : null;
    }
    out.ts = Math.round(out.ts);
    return out;
  }

  computeStats(rows) {
    const pick = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const agg = (k) => {
      const arr = pick(k);
      if (arr.length === 0) return null;
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const v of arr) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      return { min, max, avg: sum / arr.length };
    };
    return {
      count: rows.length,
      cpu: agg('cpu'),
      mem: agg('mem_percent'),
      cpuTemp: agg('cpu_temp'),
      load1: agg('load1'),
    };
  }

  /** 清理过期数据 */
  prune() {
    const cutoff = Date.now() - this.retentionDays * 86400 * 1000;
    const r = this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM alerts WHERE ts < ? AND acknowledged = 1').run(cutoff);
    return r.changes || 0;
  }

  /** 记录告警（severity: warn / crit） */
  addAlert(metric, value, threshold, message, severity = 'warn') {
    this.db
      .prepare('INSERT INTO alerts (ts, metric, value, threshold, message, severity) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), metric, value, threshold, message, severity);
  }

  /** 告警列表：limit + severity / 未确认过滤 */
  listAlerts(limit = 100, filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.severity) {
      clauses.push('severity = ?');
      params.push(String(filters.severity));
    }
    if (filters.unacked === true) {
      clauses.push('acknowledged = 0');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Math.min(1000, Math.max(1, Number(limit) || 100)));
    return this.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY ts DESC LIMIT ?`)
      .all(...params);
  }

  /** 确认指定告警，返回实际更新行数 */
  ackAlerts(ids) {
    const stmt = this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ? AND acknowledged = 0');
    let count = 0;
    for (const id of ids) {
      const result = stmt.run(id);
      count += Number(result.changes) || 0;
    }
    return count;
  }

  /** 确认全部未确认告警，返回更新行数 */
  ackAllAlerts() {
    const result = this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run();
    return Number(result.changes) || 0;
  }

  /** 未确认告警数量（供 UI 角标等） */
  unackedAlertCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0').get();
    return Number(row?.n) || 0;
  }

  /** 保存压测结果 */
  saveBench(kind, params, score, durationMs, detail) {
    this.db
      .prepare('INSERT INTO bench_results (ts, kind, params, score, duration_ms, detail) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), kind, JSON.stringify(params || {}), score, durationMs, JSON.stringify(detail || {}));
  }

  listBench(kind = null, limit = 50) {
    if (kind) {
      return this.db
        .prepare('SELECT * FROM bench_results WHERE kind = ? ORDER BY ts DESC LIMIT ?')
        .all(kind, limit);
    }
    return this.db.prepare('SELECT * FROM bench_results ORDER BY ts DESC LIMIT ?').all(limit);
  }

  /** WAL checkpoint（备份前调用，确保 metrics.db 主文件是最新数据） */
  checkpoint() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch (e) {
      return false;
    }
  }

  close() {
    try {
      this.db.close();
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = { Store };
