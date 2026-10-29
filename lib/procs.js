'use strict';

/**
 * 进程 / 服务 / 日志
 * 全部为只读操作，不需要 root。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROC = '/proc';
const CLK_TCK = 100; // USER_HZ，Linux 通常为 100

/* ================= 进程 ================= */

let passwdCache = null;

function getPasswdMap() {
  if (passwdCache) return passwdCache;
  const map = new Map();
  try {
    const text = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of text.split('\n')) {
      const p = line.split(':');
      if (p.length >= 3) map.set(Number(p[2]), p[0]);
    }
  } catch (e) {
    /* ignore */
  }
  passwdCache = map;
  return map;
}

function readSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function readUptimeSeconds() {
  const t = readSafe(path.join(PROC, 'uptime'));
  if (!t) return 0;
  return Number(t.trim().split(/\s+/)[0]) || 0;
}

/** 上一次采样，用于计算瞬时 CPU% */
let prevSnapshot = null;

/**
 * 列出进程
 * CPU% 基于两次采样差值计算，首次调用时退化为累计值/存活时间。
 *
 * @param {{sort?: 'cpu'|'mem'|'pid', limit?: number, filter?: string}} opts
 *   sort  - 排序字段，默认 cpu
 *   limit - 最多返回条数，默认 500（total 始终返回完整数量）
 *   filter - 按进程名/PID 子串过滤
 * @returns {{processes: Array, total: number, returned: number, sort: string}}
 */
function listProcesses(opts = {}) {
  let pids;
  try {
    pids = fs.readdirSync(PROC).filter((n) => /^\d+$/.test(n));
  } catch (e) {
    return { processes: [], total: 0 };
  }

  const passwd = getPasswdMap();
  const uptime = readUptimeSeconds();
  const now = Date.now();
  const prev = prevSnapshot;
  const elapsedSec = prev ? Math.max(0.001, (now - prev.at) / 1000) : 0;
  const nextSnapshot = { at: now, ticks: new Map() };

  const list = [];

  for (const pidStr of pids) {
    const pid = Number(pidStr);
    const dir = path.join(PROC, pidStr);

    const stat = readSafe(path.join(dir, 'stat'));
    if (!stat) continue;

    // comm 可能含空格/括号，用最后一个 ')' 定位
    const open = stat.indexOf('(');
    const close = stat.lastIndexOf(')');
    if (open < 0 || close < 0) continue;

    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).trim().split(/\s+/);

    const state = rest[0] || '?';
    const utime = Number(rest[11]) || 0;
    const stime = Number(rest[12]) || 0;
    const starttime = Number(rest[19]) || 0;
    const rssPages = Number(rest[21]) || 0;
    const ticks = utime + stime;

    nextSnapshot.ticks.set(pid, ticks);

    // CPU%：优先用两次采样差值
    let cpuPercent;
    if (prev && prev.ticks.has(pid)) {
      const delta = ticks - prev.ticks.get(pid);
      cpuPercent = (delta / CLK_TCK / elapsedSec) * 100;
    } else {
      const ageSec = Math.max(0.01, uptime - starttime / CLK_TCK);
      cpuPercent = (ticks / CLK_TCK / ageSec) * 100;
    }

    // 用户
    let user = '?';
    const status = readSafe(path.join(dir, 'status'));
    if (status) {
      const m = /^Uid:\s+(\d+)/m.exec(status);
      if (m) {
        const uid = Number(m[1]);
        user = passwd.get(uid) || String(uid);
      }
    }

    // 命令行
    let cmdline = '';
    const raw = readSafe(path.join(dir, 'cmdline'));
    if (raw) cmdline = raw.split('\0').filter(Boolean).join(' ');
    if (!cmdline) cmdline = `[${comm}]`;

    list.push({
      pid,
      comm,
      state,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      rssBytes: rssPages * 4096,
      user,
      cmdline: cmdline.length > 400 ? cmdline.slice(0, 400) + '…' : cmdline,
    });
  }

  prevSnapshot = nextSnapshot;

  // ---- 过滤 ----
  const filter = String(opts.filter || '').trim().toLowerCase();
  let filtered = list;
  if (filter) {
    filtered = list.filter(
      (p) =>
        p.comm.toLowerCase().includes(filter) ||
        String(p.pid).includes(filter) ||
        (p.user || '').toLowerCase().includes(filter) ||
        (p.cmdline || '').toLowerCase().includes(filter)
    );
  }

  // ---- 排序 ----
  const sort = ['cpu', 'mem', 'pid'].includes(opts.sort) ? opts.sort : 'cpu';
  const comparators = {
    cpu: (a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid,
    mem: (a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid,
    pid: (a, b) => a.pid - b.pid,
  };
  filtered.sort(comparators[sort]);

  // ---- 截断 ----
  const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 500));
  const processes = filtered.length > limit ? filtered.slice(0, limit) : filtered;

  return {
    processes,
    total: list.length,        // 系统中进程总数（不受过滤影响）
    matched: filtered.length,  // 过滤后数量
    returned: processes.length,
    sort,
  };
}

/* ================= 服务 ================= */

function exec(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(stdout || '')
    );
  });
}

/** systemd 服务列表 */
async function listServices() {
  const out = await exec('systemctl', [
    'list-units',
    '--type=service',
    '--all',
    '--no-pager',
    '--no-legend',
    '--output=json',
  ]);

  const text = out.trim();
  if (!text) return { units: [], supported: false };

  try {
    let arr;
    if (text.startsWith('[')) {
      arr = JSON.parse(text);
    } else {
      arr = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }

    const units = arr.map((u) => ({
      unit: u.unit || u.name || '',
      load: u.load || '',
      active: u.active || '',
      sub: u.sub || '',
      description: u.description || '',
    }));

    // 运行中的排前面
    const rank = (u) => (u.active === 'active' ? 0 : u.active === 'inactive' ? 1 : 2);
    units.sort((a, b) => {
      const d = rank(a) - rank(b);
      return d !== 0 ? d : a.unit.localeCompare(b.unit);
    });

    return { units, supported: true };
  } catch (e) {
    return { units: [], supported: false, error: '解析 systemctl 输出失败' };
  }
}

/* ================= 日志 ================= */

async function readLogs(lines = 200, unit = null) {
  const args = [
    '-n',
    String(Math.min(2000, Math.max(1, Number(lines) || 200))),
    '--no-pager',
    '--output=short-iso',
  ];
  if (unit) args.push('-u', String(unit));

  const out = await exec('journalctl', args, 15000);
  return out.split('\n').filter((l) => l.trim().length > 0);
}

module.exports = { listProcesses, listServices, readLogs };
