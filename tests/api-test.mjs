const BASE = process.env.PANEL_BASE || 'http://127.0.0.1:3081';
// PANEL_CI=1：GitHub Actions 等无 GPU / hwmon / cpufreq 的虚拟机上，跳过硬件相关断言
const CI_MODE = process.env.PANEL_CI === '1';
const skipped = [];
function noteSkip(name, detail) {
  skipped.push({ name, detail });
  console.log(`⏭️  [跳过] ${name}${detail ? ' — ' + detail : ''}`);
}
/** CI 模式下硬件缺失时跳过，否则按原断言判定 */
function recHw(group, name, ok, detail) {
  if (!ok && CI_MODE) noteSkip(`${group} · ${name}`, `CI 环境无对应硬件（${detail || ''}）`);
  else rec(group, name, ok, detail);
}
let cookie = '', csrf = '';
const PASSWORD = process.argv[2];

async function call(path, opts = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (cookie) h.Cookie = cookie;
  if (csrf && opts.method && opts.method !== 'GET') h['X-CSRF-Token'] = csrf;
  const t0 = Date.now();
  const r = await fetch(BASE + path, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
  for (const c of (r.headers.getSetCookie?.() || [])) if (c.startsWith('panel_session=')) cookie = c.split(';')[0];
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, ms: Date.now() - t0 };
}

const results = [];
function fmtG(bytes) {
  if (!bytes) return '0';
  const g = bytes / 1073741824;
  return g >= 1 ? g.toFixed(1) + ' GB' : (bytes / 1048576).toFixed(0) + ' MB';
}
function rec(group, name, ok, detail, ms) {
  results.push({ group, name, ok, detail, ms });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}${ms !== undefined ? ` (${ms}ms)` : ''}`);
}

// ============ 1. 鉴权 ============
console.log('\n═══ 1. 鉴权与会话 ═══');
let r = await call('/api/public-info');
rec('鉴权', '公开信息接口(免登录)', r.status === 200 && r.body.hostname, `${r.body.hostname} / ${r.body.osName}`, r.ms);

r = await call('/api/system');
rec('鉴权', '未登录访问受保护接口 → 401', r.status === 401, `status=${r.status}`, r.ms);

r = await call('/api/session');
rec('鉴权', '未登录会话检查', r.status === 200 && r.body.authenticated === false, `authenticated=${r.body.authenticated}`, r.ms);

r = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'WRONG' }) });
rec('鉴权', '错误密码被拒绝 → 401', r.status === 401, r.body.error, r.ms);

r = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'nobody', password: PASSWORD }) });
rec('鉴权', '错误用户名被拒绝', r.status === 401, r.body.error, r.ms);

r = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) });
csrf = r.body.csrf;
rec('鉴权', '正确凭据登录成功', r.status === 200 && r.body.ok, `csrf=${csrf?.slice(0, 12)}…`, r.ms);

r = await call('/api/session');
rec('鉴权', '登录后会话有效', r.body.authenticated === true && r.body.username === 'admin', `user=${r.body.username}`, r.ms);

const noCsrf = await fetch(BASE + '/api/password', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'test' }),
});
rec('鉴权', '写操作缺少 CSRF → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

// ============ 2. 监控核心 ============
console.log('\n═══ 2. 监控核心 ═══');
r = await call('/api/system');
const st = r.body.static || {};
rec('监控', '系统信息', r.body.ok && st.hostname, `${st.hostname} | ${st.cpuPhysicalCores}核${st.cpuCores}线程 | ${(st.memTotal / 1e9).toFixed(1)}GB`, r.ms);

r = await call('/api/metrics/latest');
const m = r.body.data || {};
rec('监控', '实时指标快照', r.body.ok && m.cpu, `CPU ${m.cpu?.percent}% / 内存 ${m.memory?.usedPercent}% / 温度 ${m.sensors?.cpuTemp}°C`, r.ms);
rec('监控', '├ CPU 分核数据', m.cpu?.perCore?.length > 0, `${m.cpu?.perCore?.length} 核`);
recHw('监控', '├ CPU 频率与降频判定', m.cpu?.freq?.averageMhz > 0, `${m.cpu.freq.averageMhz}MHz, 降频=${m.cpu?.throttle?.throttled}`);
rec('监控', '├ 内存与 Swap', m.memory?.total > 0, `${(m.memory.used / 1e9).toFixed(1)}/${(m.memory.total / 1e9).toFixed(1)}GB, swap ${m.memory.swapPercent}%`);
rec('监控', '├ 负载', m.load?.load1 !== undefined, `${m.load?.load1}/${m.load?.load5}/${m.load?.load15}`);
rec('监控', '├ 磁盘 IO', Array.isArray(m.disks) && m.disks.length > 0, m.disks?.map(d => d.name).join(','));
rec('监控', '├ 文件系统', m.filesystems?.length > 0, m.filesystems?.map(f => `${f.mountPoint}(${f.usedPercent}%)`).join(' '));
rec('监控', '├ 网络接口', m.network?.interfaces?.length > 0, m.network?.interfaces?.map(n => n.name).join(','));
rec('监控', '├ 网卡链路状态', m.network?.links?.length > 0, m.network?.links?.map(l => `${l.name}=${l.operstate}`).join(' '));
recHw('监控', '├ 温度传感器', m.sensors?.all?.length > 0, m.sensors?.all?.map(s => `${s.label}=${s.value}°C`).join(' '));
rec('监控', '├ GPU 数据', m.sensors?.gpuTemp !== undefined, `GPU ${m.sensors?.gpuTemp}°C, 占用 ${m.sensors?.gpuBusyPercent}%, 功耗 ${m.sensors?.gpuPowerW}W`);
rec('监控', '├ PSI 压力', !!m.pressure?.cpu, `cpu=${m.pressure?.cpu?.some?.avg10}, mem=${m.pressure?.memory?.some?.avg10}, io=${m.pressure?.io?.some?.avg10}`);
rec('监控', '└ 运行时长', m.uptime?.uptimeSeconds > 0, `${(m.uptime.uptimeSeconds / 3600).toFixed(1)} 小时`);

const now = Date.now();
r = await call(`/api/metrics/history?from=${now - 3600000}&to=${now}&points=120`);
rec('监控', '历史查询(1小时)', r.body.ok, `${r.body.points?.length} 点, 样本 ${r.body.stats?.count}`, r.ms);
r = await call(`/api/metrics/history?from=${now - 86400000}&to=${now}&points=300`);
rec('监控', '历史查询(24小时)', r.body.ok, `${r.body.points?.length} 点`, r.ms);
r = await call(`/api/metrics/history?from=${now}&to=${now - 1000}`);
rec('监控', '历史查询参数校验(非法区间)', r.status === 400, r.body.error, r.ms);

r = await call('/api/metrics/memory-history');
rec('监控', '内存环形缓冲', r.body.ok, `${r.body.points?.length} 点`, r.ms);

r = await call('/api/processes/summary');
rec('监控', '进程摘要', r.body.ok, `${r.body.total} 进程, top=${r.body.top?.[0]?.comm}`, r.ms);

// ============ 3. 系统管理 ============
console.log('\n═══ 3. 系统管理 ═══');
r = await call('/api/processes?limit=20');
rec('系统', '进程列表', r.body.ok && r.body.processes?.length > 0, `${r.body.total} 个, 显示 ${r.body.processes?.length}`, r.ms);
const p0 = r.body.processes?.[0];
rec('系统', '├ 进程字段完整性', p0?.pid && p0?.comm && p0?.user !== undefined && p0?.cmdline, `pid=${p0?.pid} user=${p0?.user} cpu=${p0?.cpuPercent}%`);

const cpuSorted = (await call('/api/processes?sort=cpu&limit=3')).body.processes?.map(p => p.cpuPercent);
rec('系统', '├ 按 CPU 排序', cpuSorted?.[0] >= cpuSorted?.[1], `${cpuSorted?.join(' ≥ ')}`);
const memSorted = (await call('/api/processes?sort=mem&limit=3')).body.processes?.map(p => (p.rssBytes / 1e6).toFixed(0) + 'MB');
rec('系统', '└ 按内存排序', memSorted?.length === 3, memSorted?.join(' ≥ '));

r = await call('/api/services');
rec('系统', 'systemd 服务列表', r.body.units?.length > 0, `${r.body.units?.length} 个服务`, r.ms);
const activeCount = r.body.units?.filter(u => u.active === 'active').length;
rec('系统', '└ 服务状态统计', activeCount > 0, `${activeCount} 个运行中`);

r = await call('/api/logs?lines=50');
rec('系统', 'journalctl 日志', r.body.lines?.length > 0, `${r.body.lines?.length} 行`, r.ms);

// ============ 4. 扩展检测 ============
console.log('\n═══ 4. 扩展检测 ═══');
r = await call('/api/connections?limit=100');
rec('扩展', '网络连接表', r.body.total > 0, `${r.body.total} 条 (ESTABLISHED=${r.body.summary?.established} LISTEN=${r.body.summary?.listen} TW=${r.body.summary?.timeWait})`, r.ms);
const withProc = r.body.connections?.filter(c => c.process).length;
rec('扩展', '├ 连接→进程归属', withProc > 0, `${withProc} 条可归属`);
r = await call('/api/connections?state=LISTEN&limit=50');
rec('扩展', '└ 状态筛选', r.body.connections?.every(c => c.state === 'LISTEN'), `${r.body.connections?.length} 条 LISTEN`);

r = await call('/api/ports');
rec('扩展', '监听端口', r.body.ports?.length > 0, `${r.body.ports?.length} 个: ${r.body.ports?.slice(0, 6).map(p => p.port).join(',')}`, r.ms);

r = await call('/api/netstats');
const tcp = r.body.stats?.tcp || {}, sk = r.body.stats?.sockets || {};
rec('扩展', '协议栈统计', tcp.CurrEstab !== undefined, `TCP建立=${tcp.CurrEstab} 重传=${tcp.RetransSegs} 重传率=${tcp.OutSegs ? ((tcp.RetransSegs / tcp.OutSegs) * 100).toFixed(3) : 0}%`, r.ms);
rec('扩展', '└ socket 统计', sk.tcp?.inuse !== undefined, `tcp=${sk.tcp?.inuse} udp=${sk.udp?.inuse} 总=${sk.sockets?.used}`);

r = await call('/api/cron');
rec('扩展', '定时任务', r.body.jobs?.length >= 0, `${r.body.jobs?.length} cron + ${r.body.timers?.length} timer`, r.ms);
rec('扩展', '└ 周期性目录', Object.keys(r.body.periodic || {}).length === 4, Object.entries(r.body.periodic || {}).map(([k, v]) => `${k.split('/').pop()}:${v.length}`).join(' '));

r = await call('/api/sensors');
recHw('扩展', '传感器总览', r.body.temps?.length > 0, `${r.body.temps?.length} 温度 / ${r.body.power?.length} 功耗 / ${r.body.voltages?.length} 电压`, r.ms);
const pw = r.body.power?.find(p => p.unit === 'W');
rec('扩展', '└ 功耗单位正确性', !pw || pw.value < 500, pw ? `${pw.label}=${pw.value}W (应 <500W)` : '无功耗传感器');

r = await call('/api/modules?limit=50');
rec('扩展', '内核模块', r.body.modules?.length > 0, `${r.body.modules?.length} 个, 最大 ${r.body.modules?.[0]?.name}`, r.ms);

r = await call('/api/packages?limit=20');
rec('扩展', '软件包', r.body.total > 0, `共 ${r.body.total}, 已装 ${r.body.installed}`, r.ms);

r = await call('/api/inodes');
rec('扩展', 'inode 使用', r.body.inodes?.length > 0, `${r.body.inodes?.length} 个挂载点`, r.ms);
const snapInode = r.body.inodes?.filter(i => i.mountPoint.startsWith('/snap/'));
rec('扩展', '└ 已过滤只读镜像', snapInode?.length === 0, `snap 条目=${snapInode?.length}`);

r = await call('/api/timesync');
rec('扩展', '时间同步', r.body.ntp !== undefined, `NTP=${r.body.ntp} 同步=${r.body.synchronized} 时区=${r.body.timezone}`, r.ms);
rec('扩展', '└ 时间字段非空', !!r.body.localTime, `本地=${r.body.localTime}`);

r = await call('/api/boot');
rec('扩展', '启动信息', r.body.uptimeSeconds > 0, `运行 ${(r.body.uptimeSeconds / 3600).toFixed(1)}h`, r.ms);
rec('扩展', '└ 虚拟内存统计', r.body.vm?.pgfault > 0, `缺页=${r.body.vm?.pgfault?.toLocaleString()} OOM=${r.body.vm?.oomKill}`);

r = await call('/api/disks/queue');
rec('扩展', '磁盘调度器', r.body.disks?.length > 0, r.body.disks?.map(d => `${d.device}(${d.activeScheduler},${d.rotational ? 'HDD' : 'SSD'})`).join(' '), r.ms);

r = await call('/api/pci');
rec('扩展', 'PCI 设备', r.body.devices?.length > 0, `${r.body.devices?.length} 个`, r.ms);

r = await call('/api/interfaces/stats');
rec('扩展', '网卡详细统计', r.body.interfaces?.length > 0, `${r.body.interfaces?.length} 块网卡`, r.ms);

// ============ 4.5 显存 / CPU 分核 / 磁盘详情 ============
console.log('\n═══ 4.5 新增检测能力 ═══');

r = await call('/api/gpu');
const gpu = r.body.gpu || {};
rec('显存', 'GPU 信息接口', r.body.ok && gpu.available, `${gpu.model || '—'}`, r.ms);
recHw('显存', '├ 显存总量', gpu.vram?.total > 0, `${fmtG(gpu.vram?.total)}`, r.ms);
rec('显存', '├ 显存已用', gpu.vram?.used >= 0, `${fmtG(gpu.vram?.used)} (${gpu.vram?.percent}%)`);
recHw('显存', '├ GTT 共享显存', gpu.gtt?.total > 0, `${fmtG(gpu.gtt?.used)} / ${fmtG(gpu.gtt?.total)}`);
recHw('显存', '├ GPU 温度/功耗', gpu.tempC !== null, `${gpu.tempC}°C / ${gpu.powerW}W`);
recHw('显存', '└ 频率与电压', gpu.sclkMhz > 0, `sclk=${gpu.sclkMhz}MHz mclk=${gpu.mclkMhz}MHz vddgfx=${gpu.vddgfxMv}mV`);

r = await call('/api/cpu/cores');
const cores = r.body.cores || [];
rec('CPU', '分核数据接口', r.body.ok && cores.length > 0, `${r.body.coreCount} 核`, r.ms);
rec('CPU', '├ 每核使用率', cores.every(c => typeof c.percent === 'number'), `核0=${cores[0]?.percent}%`);
rec('CPU', '├ 每核用户/系统/等待', cores.every(c => c.user !== undefined && c.system !== undefined && c.iowait !== undefined), `核0: user=${cores[0]?.user} sys=${cores[0]?.system} io=${cores[0]?.iowait}`);
recHw('CPU', '├ 每核频率', cores.filter(c => c.mhz > 0).length > 0, `${cores.filter(c => c.mhz > 0).length}/${cores.length} 核有频率读数`);
rec('CPU', '└ 降频判定含百分比', typeof r.body.throttle?.percentOfMax === 'number', `${r.body.throttle?.percentOfMax}% of max`);

r = await call('/api/disks/info');
const disks = r.body.disks || [];
rec('磁盘', '磁盘详情接口', r.body.ok && disks.length > 0, `${disks.length} 块`, r.ms);
rec('磁盘', '├ 型号与序列号', disks.every(d => d.model && d.model !== '未知型号'), disks.map(d => `${d.name}:${d.model.trim()}/${d.serial}`).join(' | '));
rec('磁盘', '├ 类型区分(固态/机械)', disks.every(d => ['NVMe','SSD','HDD'].includes(d.kind)), disks.map(d => `${d.name}=${d.kindLabel}`).join(' '));
const hdd = disks.find(d => d.rotational === true);
recHw('磁盘', '├ 能识别机械硬盘', !!hdd, hdd ? `${hdd.name} ${hdd.model.trim()} ${hdd.sizeHuman}` : '本机无机械盘');
rec('磁盘', '├ 分区与挂载点', disks.every(d => Array.isArray(d.partitions)), disks.flatMap(d => d.partitions.map(p => `${p.name}(${p.fstype || '?'})`)).join(' '));
rec('磁盘', '└ 每块盘容量', disks.every(d => d.size > 0), disks.map(d => `${d.name}=${d.sizeHuman}`).join(' '));

// ============ 5. Docker ============
console.log('\n═══ 5. Docker 管理 ═══');
r = await call('/api/docker/status');
const dockerUp = Boolean(r.body.reachable);
rec('Docker', '状态探测', r.body.ok && r.body.installed !== undefined, `installed=${r.body.installed} reachable=${r.body.reachable}`, r.ms);
rec('Docker', '└ 探测候选 socket', Array.isArray(r.body.candidates), r.body.candidates?.map(c => `${c.socket}=${c.exists}`).join(' '));

if (dockerUp) {
  // 已安装：各接口应正常返回数据
  rec('Docker', '版本信息', Boolean(r.body.version), `${r.body.version} (API ${r.body.apiVersion})`);
  const dInfo = r.body.info;
  rec('Docker', '守护进程信息', Boolean(dInfo), dInfo ? `${dInfo.containersRunning}运行/${dInfo.containersStopped}停止 · 驱动 ${dInfo.driver} · Cgroup v${dInfo.cgroupVersion}` : '');

  r = await call('/api/docker/containers');
  rec('Docker', '容器列表', r.body.ok && Array.isArray(r.body.containers), `${r.body.containers?.length ?? 0} 个`);
  r = await call('/api/docker/images');
  rec('Docker', '镜像列表', r.body.ok && Array.isArray(r.body.images), `${r.body.images?.length ?? 0} 个`);
  r = await call('/api/docker/networks');
  rec('Docker', '网络列表', r.body.ok && r.body.networks?.length > 0, r.body.networks?.map(n => n.name).join(','));
  r = await call('/api/docker/volumes');
  rec('Docker', '数据卷列表', r.body.ok && Array.isArray(r.body.volumes), `${r.body.volumes?.length ?? 0} 个`);
  r = await call('/api/docker/df');
  rec('Docker', '磁盘占用', r.body.ok && r.body.usage, `镜像 ${r.body.usage?.images?.count ?? 0} 个 / ${((r.body.usage?.images?.size ?? 0) / 1048576).toFixed(0)}MB`);

  // 若有运行中的容器，验证详情/日志/资源接口
  const running = (await call('/api/docker/containers')).body.containers?.find(c => c.state === 'running');
  if (running) {
    r = await call(`/api/docker/containers/detail?id=${running.id}`);
    rec('Docker', '容器详情', r.body.ok && Boolean(r.body.detail), running.name, r.ms);
    rec('Docker', '└ 资源统计', r.body.stats !== undefined, r.body.stats ? `CPU ${r.body.stats.cpuPercent}% 内存 ${(r.body.stats.memUsage / 1048576).toFixed(1)}MB` : '无');
    r = await call(`/api/docker/containers/logs?id=${running.id}&tail=10`);
    rec('Docker', '容器日志', r.body.ok, `${r.body.lines?.length ?? 0} 行`, r.ms);
  } else {
    rec('Docker', '容器详情/日志', true, '当前无运行中容器，跳过');
  }
  // 写操作无 CSRF 应被拒绝
  const dNoCsrf = await fetch(BASE + '/api/docker/containers/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'x', action: 'start' }),
  });
  rec('Docker', '写操作缺 CSRF → 403', dNoCsrf.status === 403, `status=${dNoCsrf.status}`);
} else {
  // 未安装：应优雅降级，返回明确错误而非崩溃
  r = await call('/api/docker/containers');
  rec('Docker', '容器列表(优雅降级)', r.body.ok === false && Boolean(r.body.error), r.body.error, r.ms);
  r = await call('/api/docker/images');
  rec('Docker', '镜像列表(优雅降级)', r.body.ok === false, r.body.error, r.ms);
  r = await call('/api/docker/networks');
  rec('Docker', '网络列表(优雅降级)', r.body.ok === false, r.body.error, r.ms);
  r = await call('/api/docker/volumes');
  rec('Docker', '数据卷列表(优雅降级)', r.body.ok === false, r.body.error, r.ms);
  r = await call('/api/docker/df');
  rec('Docker', '磁盘占用(优雅降级)', r.body.ok === false, r.body.error, r.ms);
}

// ============ 6. 静态资源与 SSE ============
console.log('\n═══ 6. 静态资源与实时推送 ═══');
for (const [p, expect] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/charts.js', 'javascript'], ['/style.css', 'text/css']]) {
  const res = await fetch(BASE + p);
  const ct = res.headers.get('content-type') || '';
  const size = (await res.text()).length;
  rec('静态', `资源 ${p}`, res.status === 200 && ct.includes(expect), `${ct.split(';')[0]} ${(size / 1024).toFixed(1)}KB`);
}
const sec = await fetch(BASE + '/');
rec('静态', '安全响应头', sec.headers.get('x-content-type-options') === 'nosniff' && sec.headers.get('x-frame-options') === 'DENY',
  `nosniff=${sec.headers.get('x-content-type-options')} frame=${sec.headers.get('x-frame-options')}`);

const ctrl = new AbortController();
const sseRes = await fetch(BASE + '/api/stream', { headers: { Cookie: cookie }, signal: ctrl.signal });
const reader = sseRes.body.getReader();
const dec = new TextDecoder();
let buf = '', got = 0;
const t0 = Date.now();
while (Date.now() - t0 < 5000) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  got = (buf.match(/event: metrics/g) || []).length;
  if (got >= 3) break;
}
ctrl.abort();
rec('实时', 'SSE 推送', got >= 3, `收到 ${got} 条事件`);
const sseData = buf.match(/data: (\{[^\n]*\})\n\n/);
if (sseData) {
  const d = JSON.parse(sseData[1]);
  rec('实时', '└ SSE 数据结构', d.cpu && d.memory && d.sensors, `CPU ${d.cpu.percent}% 温度 ${d.sensors.cpuTemp}°C`);
}
const sseUnauth = await fetch(BASE + '/api/stream');
rec('实时', 'SSE 未登录被拒', sseUnauth.status === 401, `status=${sseUnauth.status}`);

// ============ 7. 404 与边界 ============
console.log('\n═══ 7. 边界情况 ═══');
r = await call('/api/nonexistent');
rec('边界', '未知接口 → 404', r.status === 404, r.body.error, r.ms);
r = await call('/api/processes', { method: 'DELETE' });
rec('边界', '错误方法 → 404/405', r.status === 404 || r.status === 405, `status=${r.status}`, r.ms);
const trav = await fetch(BASE + '/../server.js');
rec('边界', '目录穿越防护', trav.status !== 200 || !(await trav.text()).includes('createServer'), `status=${trav.status}`);

// ============ 8. 登出 ============
console.log('\n═══ 8. 登出 ═══');
r = await call('/api/logout', { method: 'POST' });
rec('鉴权', '登出成功', r.body.ok, '', r.ms);
r = await call('/api/session');
rec('鉴权', '登出后会话失效', r.body.authenticated === false, '');

// ============ 汇总 ============
console.log('\n' + '='.repeat(64));
const byGroup = {};
for (const x of results) {
  byGroup[x.group] = byGroup[x.group] || { pass: 0, total: 0 };
  byGroup[x.group].total++;
  if (x.ok) byGroup[x.group].pass++;
}
console.log('分组结果:');
for (const [g, v] of Object.entries(byGroup)) {
  console.log(`  ${g.padEnd(10)} ${v.pass}/${v.total} ${v.pass === v.total ? '✅' : '❌'}`);
}
const passed = results.filter(x => x.ok).length;
console.log(`\n总计: ${passed}/${results.length} 通过${skipped.length ? `（${skipped.length} 项因 CI 环境无硬件而跳过）` : ''}`);
const failed = results.filter(x => !x.ok);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  ❌ [${f.group}] ${f.name}: ${f.detail}`);
}
const slow = results.filter(x => x.ms > 1000).sort((a, b) => b.ms - a.ms);
if (slow.length) {
  console.log('\n慢接口(>1s):');
  for (const s of slow.slice(0, 6)) console.log(`  ${s.ms}ms  ${s.name}`);
}
process.exit(passed === results.length ? 0 : 1);
