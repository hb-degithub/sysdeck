'use strict';

/**
 * 扩展检测模块
 * 网络连接、端口监听、定时任务、内核模块、软件包、系统服务概览、
 * 磁盘健康、inode、NTP、启动项、温度传感器详情
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROC = '/proc';

function readSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

function exec(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? '' : stdout || '')
    );
  });
}

/* ============ 网络连接 ============ */

const TCP_STATES = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
  '0C': 'NEW_SYN_RECV',
};

/** 把 /proc/net/tcp 的十六进制地址还原成可读形式 */
function decodeHexAddress(hexIp, hexPort, isV6 = false) {
  const port = parseInt(hexPort, 16);
  if (isV6) {
    // IPv6：32 个十六进制字符，按 4 字节一组、小端序
    const groups = [];
    for (let i = 0; i < 32; i += 8) {
      const chunk = hexIp.slice(i, i + 8);
      const bytes = [
        chunk.slice(6, 8),
        chunk.slice(4, 6),
        chunk.slice(2, 4),
        chunk.slice(0, 2),
      ].join('');
      groups.push(bytes);
    }
    const full = groups.join('');
    // 判断是否为 IPv4-mapped
    if (/^00000000000000000000ffff/i.test(full)) {
      const v4 = full.slice(24);
      return {
        address: `${parseInt(v4.slice(0, 2), 16)}.${parseInt(v4.slice(2, 4), 16)}.${parseInt(v4.slice(4, 6), 16)}.${parseInt(v4.slice(6, 8), 16)}`,
        port,
      };
    }
    const parts = [];
    for (let i = 0; i < 32; i += 4) parts.push(full.slice(i, i + 4));
    // 统一小写，与 IPv4 展示风格一致
    return { address: parts.join(':').toLowerCase().replace(/\b0{1,4}\b/g, '0'), port };
  }
  // IPv4：小端序
  const n = parseInt(hexIp, 16);
  return {
    address: `${n & 255}.${(n >> 8) & 255}.${(n >> 16) & 255}.${(n >> 24) & 255}`,
    port,
  };
}

/** 建立 inode -> {pid, comm} 映射（仅本用户进程可读 fd） */
function buildSocketOwnerMap() {
  const map = new Map();
  let pids = [];
  try {
    pids = fs.readdirSync(PROC).filter((n) => /^\d+$/.test(n));
  } catch (e) {
    return map;
  }

  for (const pidStr of pids) {
    const fdDir = path.join(PROC, pidStr, 'fd');
    let fds = [];
    try {
      fds = fs.readdirSync(fdDir);
    } catch (e) {
      continue; // 无权限
    }
    let comm = '';
    const stat = readSafe(path.join(PROC, pidStr, 'stat'));
    if (stat) {
      const close = stat.lastIndexOf(')');
      const open = stat.indexOf('(');
      if (open >= 0 && close > open) comm = stat.slice(open + 1, close);
    }
    for (const fd of fds) {
      let link = '';
      try {
        link = fs.readlinkSync(path.join(fdDir, fd));
      } catch (e) {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m) map.set(m[1], { pid: Number(pidStr), comm });
    }
  }
  return map;
}

/** 解析一个 /proc/net 表 */
function parseNetTable(file, isV6) {
  const text = readSafe(path.join(PROC, 'net', file));
  if (!text) return [];
  const lines = text.trim().split('\n').slice(1);
  const out = [];
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    if (p.length < 10) continue;
    const local = p[1];
    const remote = p[2];
    const st = p[3];
    const inode = p[9];
    if (!local.includes(':')) continue;
    const [lIp, lPort] = local.split(':');
    const [rIp, rPort] = remote.split(':');
    const l = decodeHexAddress(lIp, lPort, isV6);
    const r = decodeHexAddress(rIp, rPort, isV6);
    out.push({
      state: TCP_STATES[st.toUpperCase()] || st,
      localAddress: l.address,
      localPort: l.port,
      remoteAddress: r.address,
      remotePort: r.port,
      inode,
      uid: Number(p[7]) || 0,
    });
  }
  return out;
}

/**
 * 网络连接列表
 * @param {object} opts { state, limit }
 */
function listConnections(opts = {}) {
  const owners = buildSocketOwnerMap();
  const tcp4 = parseNetTable('tcp', false);
  const tcp6 = parseNetTable('tcp6', true);
  const udp4 = parseNetTable('udp', false);
  const udp6 = parseNetTable('udp6', true);

  const tag = (list, proto) =>
    list.map((c) => {
      const owner = owners.get(c.inode);
      return {
        ...c,
        proto,
        process: owner ? owner.comm : '',
        pid: owner ? owner.pid : null,
      };
    });

  let all = [
    ...tag(tcp4, 'tcp'),
    ...tag(tcp6, 'tcp6'),
    ...tag(udp4, 'udp'),
    ...tag(udp6, 'udp6'),
  ];

  if (opts.state) {
    all = all.filter((c) => c.state === opts.state);
  }

  // 监听连接优先，然后按本地端口排序
  all.sort((a, b) => {
    const rank = (c) => (c.state === 'LISTEN' ? 0 : 1);
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return a.localPort - b.localPort;
  });

  const limit = Math.min(3000, Math.max(1, opts.limit || 500));
  return {
    connections: all.slice(0, limit),
    total: all.length,
    summary: {
      established: all.filter((c) => c.state === 'ESTABLISHED').length,
      listen: all.filter((c) => c.state === 'LISTEN').length,
      timeWait: all.filter((c) => c.state === 'TIME_WAIT').length,
      closeWait: all.filter((c) => c.state === 'CLOSE_WAIT').length,
      udp: all.filter((c) => c.proto.startsWith('udp')).length,
    },
  };
}

/** 仅监听端口（供概览/网络页使用） */
function listListenPorts() {
  const { connections } = listConnections({ state: 'LISTEN', limit: 2000 });
  // 同一端口 IPv4/IPv6 去重
  const seen = new Set();
  const out = [];
  for (const c of connections) {
    const key = `${c.localPort}/${c.proto.startsWith('udp') ? 'udp' : 'tcp'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      port: c.localPort,
      proto: c.proto.startsWith('udp') ? 'udp' : 'tcp',
      address: c.localAddress,
      process: c.process,
      pid: c.pid,
    });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * 网络协议栈统计
 * /proc/net/snmp 是「表头行 + 数值行」交替出现，同一协议紧邻两行，无空行分隔。
 */
function readNetStats() {
  const out = { sockets: {}, tcp: {}, udp: {}, ip: {}, icmp: {}, tcpExt: {} };

  // ---- sockstat：「KEY: k v ...」形式 ----
  const sockstat = readSafe(path.join(PROC, 'net', 'sockstat'));
  if (sockstat) {
    for (const raw of sockstat.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = /^([\w]+):\s*(.+)$/.exec(line);
      if (!m) continue;
      const name = m[1].toLowerCase();
      const vals = {};
      const tokens = m[2].trim().split(/\s+/);
      // 两种格式： "used 1118" 与 "inuse:25 orphan:0"
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.includes(':')) {
          const [k, v] = t.split(':');
          if (k) vals[k] = Number(v);
        } else if (i + 1 < tokens.length) {
          vals[t] = Number(tokens[i + 1]);
          i++;
        }
      }
      out.sockets[name] = vals;
    }
  }

  // ---- snmp：按协议名成对读取 ----
  const snmp = readSafe(path.join(PROC, 'net', 'snmp'));
  if (snmp) {
    const lines = snmp.split('\n').filter((l) => l.trim());
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const headLine = lines[i].trim();
      const valLine = lines[i + 1].trim();
      const proto = headLine.split(':')[0].trim();
      const names = headLine.slice(headLine.indexOf(':') + 1).trim().split(/\s+/);
      const vals = valLine.slice(valLine.indexOf(':') + 1).trim().split(/\s+/);
      if (names.length === 0 || vals.length === 0) continue;
      const obj = {};
      names.forEach((n, k) => {
        const v = Number(vals[k]);
        if (Number.isFinite(v)) obj[n] = v;
      });
      const key = proto.toLowerCase();
      if (['tcp', 'udp', 'ip', 'icmp'].includes(key)) out[key] = obj;
    }
  }

  // ---- netstat：TCP 扩展统计（重传、乱序等）----
  const netstat = readSafe(path.join(PROC, 'net', 'netstat'));
  if (netstat) {
    const lines = netstat.split('\n').filter((l) => l.trim());
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const headLine = lines[i].trim();
      const valLine = lines[i + 1].trim();
      const proto = headLine.split(':')[0].trim();
      if (proto !== 'TcpExt') continue;
      const names = headLine.slice(headLine.indexOf(':') + 1).trim().split(/\s+/);
      const vals = valLine.slice(valLine.indexOf(':') + 1).trim().split(/\s+/);
      const obj = {};
      names.forEach((n, k) => {
        const v = Number(vals[k]);
        if (Number.isFinite(v)) obj[n] = v;
      });
      out.tcpExt = obj;
      break;
    }
  }

  return out;
}

/* ============ 定时任务 ============ */

/** 解析 crontab 文本 */
function parseCrontab(text, source) {
  const jobs = [];
  if (!text) return jobs;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // 环境变量行
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) continue;

    // 支持 @reboot 等特殊表达式
    const special = /^(@\w+)\s+(.+)$/.exec(trimmed);
    if (special) {
      jobs.push({
        source,
        schedule: special[1],
        command: special[2].trim(),
        raw: trimmed,
      });
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    jobs.push({
      source,
      schedule: parts.slice(0, 5).join(' '),
      command: parts.slice(5).join(' '),
      raw: trimmed,
    });
  }
  return jobs;
}

/** 列出所有定时任务 */
async function listCronJobs() {
  const jobs = [];

  // 当前用户的 crontab
  const userCron = await exec('crontab', ['-l']);
  jobs.push(...parseCrontab(userCron, '当前用户 crontab'));

  // 系统级 crontab
  const sysCron = readSafe('/etc/crontab');
  jobs.push(...parseCrontab(sysCron, '/etc/crontab'));

  // /etc/cron.d
  try {
    const files = fs.readdirSync('/etc/cron.d');
    for (const f of files) {
      const t = readSafe(path.join('/etc/cron.d', f));
      jobs.push(...parseCrontab(t, `/etc/cron.d/${f}`));
    }
  } catch (e) {
    /* 无权限 */
  }

  // 周期性目录概览
  const periodic = {};
  for (const dir of ['/etc/cron.hourly', '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly']) {
    try {
      periodic[dir] = fs.readdirSync(dir);
    } catch (e) {
      periodic[dir] = [];
    }
  }

  // systemd timer
  const timersOut = await exec('systemctl', [
    'list-timers', '--all', '--no-pager', '--no-legend', '--output=json',
  ]);
  let timers = [];
  const t = timersOut.trim();
  if (t) {
    try {
      const arr = t.startsWith('[') ? JSON.parse(t) : t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // systemd 的时间字段是「微秒时间戳」，需要转换成可读格式
      const usToMs = (us) => {
        const n = Number(us);
        if (!Number.isFinite(n) || n <= 0) return null;
        const ms = n / 1000;
        // 明显早于 2001 年的视为无效
        return ms > 978307200000 ? ms : null;
      };
      const relMs = (ms) => {
        if (!ms) return '';
        const diff = ms - Date.now();
        const abs = Math.abs(diff);
        const mins = Math.round(abs / 60000);
        const label =
          abs < 60000 ? '刚刚'
          : mins < 60 ? `${mins} 分钟`
          : mins < 1440 ? `${Math.round(mins / 60)} 小时`
          : `${Math.round(mins / 1440)} 天`;
        return diff >= 0 ? `${label}后` : `${label}前`;
      };

      timers = arr.map((x) => {
        const nextMs = usToMs(x.next);
        const lastMs = usToMs(x.last);
        return {
          unit: x.unit || '',
          activates: x.activates || '',
          next: nextMs ? new Date(nextMs).toISOString() : '',
          nextText: nextMs ? new Date(nextMs).toLocaleString('zh-CN', { hour12: false }) : '—',
          nextRel: relMs(nextMs),
          last: lastMs ? new Date(lastMs).toISOString() : '',
          lastText: lastMs ? new Date(lastMs).toLocaleString('zh-CN', { hour12: false }) : '—',
          lastRel: lastMs ? relMs(lastMs) : '',
        };
      });
    } catch (e) {
      /* 解析失败忽略 */
    }
  }

  return { jobs, periodic, timers };
}

/* ============ 内核模块 ============ */

function listKernelModules(limit = 300) {
  const text = readSafe(path.join(PROC, 'modules'));
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = line.trim().split(/\s+/);
    out.push({
      name: p[0],
      size: Number(p[1]) || 0,
      refCount: Number(p[2]) || 0,
      users: (p[3] || '').replace(/,/g, ', '),
      state: p[4] || '',
    });
  }
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit);
}

/* ============ 软件包 ============ */

async function listPackages(limit = 100) {
  const out = await exec('dpkg-query', [
    '-W',
    '-f=${Package}\t${Version}\t${Status}\t${Installed-Size}\n',
  ], 20000);

  const packages = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, version, status, size] = line.split('\t');
    if (!name) continue;
    packages.push({
      name,
      version: version || '',
      installed: (status || '').includes('installed'),
      sizeKB: Number(size) || 0,
    });
  }
  const installed = packages.filter((p) => p.installed);
  installed.sort((a, b) => b.sizeKB - a.sizeKB);
  return {
    total: packages.length,
    installed: installed.length,
    largest: installed.slice(0, limit),
  };
}

/* ============ 系统信息扩展 ============ */

/** inode 使用情况 */
function readInodes() {
  const text = readSafe(path.join(PROC, 'mounts'));
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(/\s+/);
    if (p.length < 4) continue;
    const [, mountPoint, fstype] = p;
    if (seen.has(mountPoint)) continue;
    const skipFs = ['proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'pstore',
      'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue',
      'hugetlbfs', 'binfmt_misc', 'autofs', 'bpf', 'nsfs', 'efivarfs',
      // 只读镜像/快照：inode 恒满，属正常现象，不参与统计
      'squashfs', 'overlay', 'ramfs', 'iso9660'];
    if (skipFs.includes(fstype)) continue;
    if (mountPoint.startsWith('/snap/')) continue;
    try {
      const st = fs.statfsSync(mountPoint);
      if (!st.files || st.files === 0) continue;
      seen.add(mountPoint);
      out.push({
        mountPoint,
        fstype,
        totalInodes: st.files,
        freeInodes: st.ffree,
        usedInodes: st.files - st.ffree,
        usedPercent: Math.round(((st.files - st.ffree) / st.files) * 1000) / 10,
      });
    } catch (e) {
      /* 跳过 */
    }
  }
  return out;
}

/** NTP / 时间同步状态 */
async function readTimeSync() {
  const out = await exec('timedatectl', ['show', '--no-pager']);
  const kv = {};
  for (const line of out.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) kv[line.slice(0, idx)] = line.slice(idx + 1);
  }
  // TimeUSec 可能是格式化字符串（如 "Mon 2026-10-19 08:40:07 CST"），也可能是微秒数
  const parseTime = (v) => {
    if (!v) return '';
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12) {
      return new Date(n / 1000).toLocaleString('zh-CN', { hour12: false });
    }
    return String(v);
  };

  return {
    ntp: kv.NTP || '',
    synchronized: kv.NTPSynchronized === 'yes',
    canNtp: kv.CanNTP || '',
    timezone: kv.Timezone || '',
    localTime: parseTime(kv.TimeUSec),
    rtcTime: parseTime(kv.RTCTimeUSec),
    localRtc: kv.LocalRTC === 'yes',
    server: kv.ServerName || '',
    offset: kv.Offset || '',
  };
}

/** 启动时间与启动耗时 */
function readBootInfo() {
  const uptimeText = readSafe(path.join(PROC, 'uptime'));
  const uptimeSec = uptimeText ? Number(uptimeText.split(/\s+/)[0]) : 0;
  const btime = (() => {
    const stat = readSafe(path.join(PROC, 'stat')) || '';
    const m = /^btime\s+(\d+)/m.exec(stat);
    return m ? Number(m[1]) * 1000 : null;
  })();

  const loadavg = (readSafe(path.join(PROC, 'loadavg')) || '').trim();
  return {
    uptimeSeconds: uptimeSec,
    bootTime: btime,
    loadavg,
    cmdline: (readSafe(path.join(PROC, 'cmdline')) || '').replace(/\0/g, ' ').trim(),
  };
}

/** 虚拟内存与内核参数概览 */
function readVmStats() {
  const text = readSafe(path.join(PROC, 'vmstat'));
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length === 2) out[p[0]] = Number(p[1]);
  }
  return {
    pgpgin: out.pgpgin,
    pgpgout: out.pgpgout,
    pswpin: out.pswpin,
    pswpout: out.pswpout,
    pgfault: out.pgfault,
    pgmajfault: out.pgmajfault,
    oomKill: out.oom_kill,
    nrFreePages: out.nr_free_pages,
  };
}

/** 磁盘调度器与队列参数 */
function readDiskSchedulers() {
  const out = [];
  let devices = [];
  try {
    devices = fs.readdirSync('/sys/block').filter((d) => !/^(loop|ram|dm-|sr|zd)/.test(d));
  } catch (e) {
    return out;
  }
  for (const dev of devices) {
    const base = path.join('/sys/block', dev);
    const scheduler = (readSafe(path.join(base, 'queue', 'scheduler')) || '').trim();
    const active = scheduler.split(/[[\]]/)[1] || scheduler.split(/\s+/)[0] || '';
    out.push({
      device: dev,
      scheduler,
      activeScheduler: active,
      rotational: (readSafe(path.join(base, 'queue', 'rotational')) || '0').trim() === '1',
      readAheadKB: Number((readSafe(path.join(base, 'queue', 'read_ahead_kb')) || '0').trim()) || 0,
      nrRequests: Number((readSafe(path.join(base, 'queue', 'nr_requests')) || '0').trim()) || 0,
      model: (readSafe(path.join(base, 'device', 'model')) || '').trim(),
      sizeGB: (() => {
        const sectors = Number((readSafe(path.join(base, 'size')) || '0').trim()) || 0;
        return Math.round((sectors * 512) / 1e9 * 10) / 10;
      })(),
    });
  }
  return out;
}

/** 所有传感器（温度/风扇/电压/功耗） */
function readAllSensors() {
  const root = '/sys/class/hwmon';
  const out = { temps: [], fans: [], voltages: [], power: [], chips: [] };
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch (e) {
    return out;
  }

  for (const d of dirs) {
    const dir = path.join(root, d);
    const chip = (readSafe(path.join(dir, 'name')) || 'unknown').trim();
    out.chips.push({ id: d, name: chip });
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const m = /^(temp|fan|in|power|curr)(\d+)_input$/.exec(entry);
      if (!m) continue;
      const kind = m[1];
      const idx = m[2];
      const rawText = readSafe(path.join(dir, entry));
      if (rawText === null) continue;
      const raw = Number(rawText.trim());
      if (!Number.isFinite(raw)) continue;
      const label =
        (readSafe(path.join(dir, `${kind}${idx}_label`)) || '').trim() || `${chip} ${kind}${idx}`;

      if (kind === 'temp') {
        out.temps.push({ chip, label, value: Math.round(raw / 100) / 10, raw, id: `${d}/${entry}` });
      } else if (kind === 'fan') {
        out.fans.push({ chip, label, value: raw, unit: 'RPM', id: `${d}/${entry}` });
      } else if (kind === 'in') {
        out.voltages.push({ chip, label, value: Math.round(raw / 10) / 100, unit: 'V', id: `${d}/${entry}` });
      } else if (kind === 'power') {
        // hwmon power*_input 单位是微瓦
        out.power.push({ chip, label, value: Math.round(raw / 1e6 * 10) / 10, unit: 'W', id: `${d}/${entry}` });
      } else if (kind === 'curr') {
        // hwmon curr*_input 单位是毫安
        out.power.push({ chip, label, value: raw, unit: 'mA', id: `${d}/${entry}` });
      }
    }
  }

  out.temps.sort((a, b) => b.value - a.value);
  return out;
}

/** PCI 设备 */
function listPciDevices(limit = 60) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync('/sys/bus/pci/devices');
  } catch (e) {
    return out;
  }
  for (const d of dirs) {
    const base = path.join('/sys/bus/pci/devices', d);
    const className = (readSafe(path.join(base, 'class')) || '').trim();
    out.push({
      slot: d,
      vendorId: (readSafe(path.join(base, 'vendor')) || '').trim(),
      deviceId: (readSafe(path.join(base, 'device')) || '').trim(),
      className,
      driver: (() => {
        try {
          return path.basename(fs.readlinkSync(path.join(base, 'driver')));
        } catch (e) {
          return '';
        }
      })(),
    });
  }
  return out.slice(0, limit);
}

/** 网卡详细统计 */
function readInterfaceStats() {
  const text = readSafe(path.join(PROC, 'net', 'dev'));
  const out = [];
  if (!text) return out;
  for (const line of text.split('\n').slice(2)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const n = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (n.length < 16) continue;
    out.push({
      name,
      rxBytes: n[0], rxPackets: n[1], rxErrors: n[2], rxDropped: n[3],
      rxFifo: n[4], rxFrame: n[5], rxCompressed: n[6], rxMulticast: n[7],
      txBytes: n[8], txPackets: n[9], txErrors: n[10], txDropped: n[11],
      txFifo: n[12], txColls: n[13], txCarrier: n[14], txCompressed: n[15],
    });
  }
  return out;
}


/* ============ 磁盘详细信息（含机械盘） ============ */

/**
 * 从 /dev/disk/by-id 解析磁盘序列号
 * 链接形如：ata-TOSHIBA_MQ01ABF032_83L8CB3BT -> ../../sda
 * 序列号是最后一段（型号中可能含下划线，因此取最后一段）
 */
function readDiskSerials() {
  const map = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync('/dev/disk/by-id');
  } catch (e) {
    return map;
  }
  for (const name of entries) {
    if (name.includes('-part')) continue;
    if (!/^(ata|nvme|scsi|wwn)-/.test(name)) continue;
    let target = '';
    try {
      target = path.basename(fs.readlinkSync(path.join('/dev/disk/by-id', name)));
    } catch (e) {
      continue;
    }
    // 保留 by-id 中的型号+序列号原始串，稍后按 model 前缀剥离
    const raw = name.replace(/^(ata|nvme|scsi|wwn)-/, '');
    if (!map.has(target)) map.set(target, raw);
  }
  return map;
}

/** 解析 /proc/mounts，得到 设备 -> 挂载点/文件系统 */
function readMountMap() {
  const map = new Map();
  const text = readSafe('/proc/mounts');
  if (!text) return map;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(/\s+/);
    if (p.length < 3) continue;
    map.set(p[0], { mountPoint: p[1], fstype: p[2] });
  }
  return map;
}

let lsblkCache = { at: 0, data: null };

/**
 * 解析 lsblk -J，补全未挂载分区的 FSTYPE(依赖 libblkid，普通用户可读)
 * 缓存 30 秒，避免每次采样都起进程
 */
function readLsblkMap() {
  const now = Date.now();
  if (lsblkCache.data && now - lsblkCache.at < 30000) return lsblkCache.data;

  const map = new Map();
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(
      'lsblk',
      ['-J', '-o', 'NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,ROTA,MODEL'],
      { encoding: 'utf8', timeout: 4000 }
    );
    const parsed = JSON.parse(out);
    const walk = (nodes) => {
      for (const n of nodes || []) {
        map.set(n.name, {
          fstype: n.fstype || null,
          mountpoint: n.mountpoint || null,
          type: n.type || null,
          model: n.model ? String(n.model).trim() : null,
        });
        if (n.children) walk(n.children);
      }
    };
    walk(parsed.blockdevices);
  } catch (e) {
    /* lsblk 不可用则退回 /proc/mounts */
  }
  lsblkCache = { at: now, data: map };
  return map;
}

/**
 * 列出所有物理磁盘的详细信息
 * 覆盖 NVMe / SATA 机械盘 / SATA 固态盘
 */
function listDisksInfo() {
  const serials = readDiskSerials();
  const mounts = readMountMap();
  const lsblk = readLsblkMap();
  const out = [];

  let devices = [];
  try {
    devices = fs.readdirSync('/sys/block').filter((d) => !/^(loop|ram|dm-|sr|zram)/.test(d));
  } catch (e) {
    return out;
  }

  for (const name of devices) {
    const base = path.join('/sys/block', name);
    const isNvme = /^nvme\d+n\d+$/.test(name);
    const rotational = (readSafe(path.join(base, 'queue', 'rotational')) || '0').trim() === '1';

    // 型号
    let model = (readSafe(path.join(base, 'device', 'model')) || '').trim();
    if (isNvme) {
      const nvmeDir = name.split('n').slice(0, 2).join('n'); // nvme0
      model =
        (readSafe(path.join('/sys/class/nvme', nvmeDir, 'model')) || model || '').trim() || model;
    }

    // lsblk 的 MODEL 更完整（sysfs 会截断到 16 字符）
    const blkModel = (lsblk.get(name) || {}).model;
    if (blkModel && blkModel.length > model.length) model = blkModel;

    const vendor = (readSafe(path.join(base, 'device', 'vendor')) || '').trim();
    const firmware = (
      isNvme
        ? readSafe(path.join('/sys/class/nvme', name.split('n').slice(0, 2).join('n'), 'firmware_rev')) || ''
        : readSafe(path.join(base, 'device', 'rev')) || ''
    ).trim();

    const sectors = Number((readSafe(path.join(base, 'size')) || '0').trim()) || 0;
    const sizeBytes = sectors * 512;

    // 序列号：NVMe 直接读 sysfs（最权威）；其余从 by-id 剥离型号前缀
    const nvmeCtl = name.split('n').slice(0, 2).join('n'); // nvme0
    let serial = '';
    if (isNvme) {
      serial = (readSafe(path.join('/sys/class/nvme', nvmeCtl, 'serial')) || '').trim();
    }
    if (!serial) {
      const rawSerial = serials.get(name) || '';
      if (rawSerial) {
        // by-id 形如 TOSHIBA_MQ01ABF032_83L8CB3BT，型号部分用下划线连接
        const modelKey = model.trim().replace(/\s+/g, '_');
        if (modelKey && rawSerial.startsWith(modelKey + '_')) {
          serial = rawSerial.slice(modelKey.length + 1);
        } else {
          // 退而求其次：取最后一段
          const segs = rawSerial.split('_');
          serial = segs.length > 1 ? segs[segs.length - 1] : rawSerial;
        }
      }
    }
    if (!serial) {
      serial = (readSafe(path.join(base, 'device', 'wwid')) || '').trim();
    }

    // 分区
    let partitionNames = [];
    try {
      partitionNames = fs.readdirSync(base).filter((f) => f.startsWith(name) && f !== name);
    } catch (e) {
      /* ignore */
    }

    const partitions = [];
    for (const pName of partitionNames) {
      const pSectors = Number((readSafe(path.join(base, pName, 'size')) || '0').trim()) || 0;
      const pBytes = pSectors * 512;
      const devPath = `/dev/${pName}`;
      const mount = mounts.get(devPath);
      const blk = lsblk.get(pName) || {};
      const mountPoint = mount ? mount.mountPoint : blk.mountpoint || null;
      const fstype = mount ? mount.fstype : blk.fstype || null;
      partitions.push({
        name: pName,
        device: devPath,
        size: pBytes,
        mountPoint,
        fstype,
        mounted: Boolean(mountPoint),
      });
    }

    // 类型判定
    let kind = 'SSD';
    let kindLabel = '固态硬盘';
    if (rotational) {
      kind = 'HDD';
      kindLabel = '机械硬盘';
    } else if (isNvme) {
      kind = 'NVMe';
      kindLabel = 'NVMe 固态';
    }

    // 健康信息：SMART 需要 smartctl + root，这里只做能力标记
    const smartAvailable = Boolean(
      readSafe('/sys/block/' + name + '/device/state') !== null
    );

    out.push({
      name,
      device: `/dev/${name}`,
      model: model || '未知型号',
      vendor,
      serial: serial || '',
      firmware,
      size: sizeBytes,
      sizeHuman: fmtBytes(sizeBytes),
      kind,
      kindLabel,
      rotational,
      isNvme,
      removable: (readSafe(path.join(base, 'removable')) || '0').trim() === '1',
      scheduler: (() => {
        const raw = (readSafe(path.join(base, 'queue', 'scheduler')) || '').trim();
        return raw.split(/[\[\]]/)[1] || raw.split(/\s+/)[0] || '';
      })(),
      readAheadKB: Number((readSafe(path.join(base, 'queue', 'read_ahead_kb')) || '0').trim()) || 0,
      queueDepth: Number((readSafe(path.join(base, 'device', 'queue_depth')) || '0').trim()) || 0,
      physicalBlockSize:
        Number((readSafe(path.join(base, 'queue', 'physical_block_size')) || '0').trim()) || 0,
      logicalBlockSize:
        Number((readSafe(path.join(base, 'queue', 'logical_block_size')) || '0').trim()) || 0,
      state: (readSafe(path.join(base, 'device', 'state')) || 'unknown').trim(),
      partitions,
      mounted: partitions.some((p) => p.mounted),
      smartSupported: smartAvailable,
    });
  }

  // 机械盘排在后面（固态优先展示）
  const rank = { NVMe: 0, SSD: 1, HDD: 2, 其他: 3 };
  out.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  return out;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  listConnections,
  listListenPorts,
  readNetStats,
  listCronJobs,
  listKernelModules,
  listPackages,
  readInodes,
  readTimeSync,
  readBootInfo,
  readVmStats,
  readDiskSchedulers,
  readAllSensors,
  listPciDevices,
  readInterfaceStats,
  listDisksInfo,
};
