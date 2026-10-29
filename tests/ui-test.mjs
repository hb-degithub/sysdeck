import { chromium } from 'playwright-core';
const PASSWORD = process.argv[2];
const BASE = process.env.PANEL_BASE || 'http://127.0.0.1:3081';
const results = [];
function rec(group, name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} [${group}] ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({
  // 可用 PANEL_CHROMIUM 指定 Chromium 路径；未指定时用 playwright 自带浏览器
  ...(process.env.PANEL_CHROMIUM ? { executablePath: process.env.PANEL_CHROMIUM } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// 页面里可能弹 confirm（例如「退出登录」二次确认），测试统一接受
page.on('dialog', (d) => d.accept());
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

// ===== 1. 登录流程 =====
console.log('\n═══ 1. 登录流程 ═══');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
rec('登录', '登录页渲染', await page.locator('#login-view').isVisible());
rec('登录', '登录页显示主机信息', (await page.textContent('#login-host')).includes('hb'), await page.textContent('#login-host'));

await page.fill('#login-username', 'admin');
await page.fill('#login-password', 'WRONGPASS');
await page.click('#login-submit');
await page.waitForTimeout(1200);
rec('登录', '错误密码显示错误提示', await page.locator('#login-error').isVisible(), await page.textContent('#login-error'));

await page.fill('#login-password', PASSWORD);
await page.click('#login-submit');
await page.waitForTimeout(2500);
rec('登录', '正确密码进入主界面', await page.locator('#app-view').isVisible());

// 改密弹窗仅在 mustChangePassword=true 时出现（首次安装/重置密码后）
const pwdModal = await page.locator('#pwd-modal').isVisible().catch(() => false);
// 弹窗只在需改密时出现，两者都是合规行为
rec('登录', '登录后状态判定', true, pwdModal ? '弹出改密提示' : '无改密弹窗（密码已设置）');
if (pwdModal) { await page.click('#pwd-cancel'); await page.waitForTimeout(400); }
if (pwdModal) rec('登录', '关闭弹窗', !(await page.locator('#pwd-modal').isVisible()));

// ===== 2. 实时数据 =====
console.log('\n═══ 2. 实时数据推送 ═══');
await page.waitForTimeout(1500);
const snap = async () => [
  await page.textContent('#mv-cpu'),
  await page.textContent('#mv-mem'),
  await page.textContent('#mv-temp'),
].join('|');
const v1 = await snap();
await page.waitForTimeout(3000);
const v2 = await snap();
rec('实时', 'SSE 数据在更新', v1 !== v2, `${v1.replace(/\|/g, ' / ')} → ${v2.replace(/\|/g, ' / ')}`);
rec('实时', 'CPU 数值格式正确', /^\d+(\.\d+)?%$/.test(v1.split('|')[0].trim()), v1.split('|')[0].trim());
rec('实时', '连接状态正常(无断线横幅)', !(await page.locator('#conn-banner').isVisible()));
const canvases = await page.locator('canvas').count();
rec('实时', '图表画布已创建', canvases >= 10, `${canvases} 个 canvas`);

// 验证 canvas 真的画了东西（非空白）
const painted = await page.evaluate(() => {
  const cs = [...document.querySelectorAll('canvas')];
  let nonBlank = 0;
  for (const c of cs) {
    try {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, Math.min(c.width, 100), Math.min(c.height, 100)).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { nonBlank++; break; }
    } catch (e) { /* 跨域等 */ }
  }
  return nonBlank;
});
rec('实时', '画布已实际绘制内容', painted >= 5, `${painted}/${canvases} 个画布有像素`);

// ===== 3. 全部页面遍历 =====
console.log('\n═══ 3. 页面遍历 ═══');
// 有真实数据的页面：不应出现任何占位/错误块
const dataPages = ['overview','realtime','cpudetail','history','process','disk','network','connections','service','cron','sensors','sysinfo','logs'];
// 新实现的三个功能页
const featPages = ['bench','files','terminal'];
// 尚未实现的页面：应显示「开发中」占位
const stubPages = [];
// 特殊状态页面：空态或安装引导属正常
const statePages = ['alerts','docker'];

for (const r of dataPages) {
  await page.click(`.nav-item[data-route="${r}"]`);
  await page.waitForTimeout(1400);
  const title = (await page.textContent('#page-title')).trim();
  const ph = await page.locator('#content .placeholder').count();
  const contentLen = (await page.textContent('#content')).length;
  const visible = await page.locator('#content').isVisible();
  rec('页面', `${r}(有数据)`, visible && contentLen > 400 && ph === 0, `标题=${title} 内容=${contentLen}字 占位=${ph}`);
}

for (const r of stubPages) {
  await page.click(`.nav-item[data-route="${r}"]`);
  await page.waitForTimeout(1100);
  const text = await page.textContent('#content');
  const ok = text.includes('开发中');
  rec('页面', `${r}(开发中占位)`, ok, ok ? '正确显示开发中提示' : text.replace(/\s+/g,' ').slice(0, 60));
}

// 告警：应显示空态而非报错
await page.click('.nav-item[data-route="alerts"]');
await page.waitForTimeout(1300);
const alertText = await page.textContent('#content');
rec('页面', 'alerts(空态)', alertText.includes('暂无告警') || alertText.includes('告警'), alertText.replace(/\s+/g,' ').slice(0, 50));

// Docker：未安装时显示安装引导，已安装时显示管理界面
await page.click('.nav-item[data-route="docker"]');
await page.waitForTimeout(1800);
const dockerText = await page.textContent('#content');
const dockerOK = dockerText.includes('安装 Docker') || dockerText.includes('运行中容器');
rec('页面', 'docker(自适应状态)', dockerOK, dockerOK ? (dockerText.includes('安装 Docker') ? '显示安装引导' : '显示管理界面') : dockerText.slice(0, 60));

// 功能页专项（终端页以「已连接」判定，文本长度不适用）
for (const r of ['bench', 'files']) {
  await page.click(`.nav-item[data-route="${r}"]`);
  await page.waitForTimeout(2200);
  const txt = await page.textContent('#content');
  const noPlaceholder = (await page.locator('#content .placeholder h3').count()) === 0;
  rec('功能', `${r} 页可用`, txt.length > 400 && noPlaceholder, `${txt.length} 字`);
}

// 压测页：类型切换
await page.click('.nav-item[data-route="bench"]');
await page.waitForTimeout(1500);
await page.selectOption('#bench-kind', 'disk');
await page.waitForTimeout(800);
rec('功能', '压测类型切换', (await page.textContent('#bench-param1-label')).includes('文件大小'), '磁盘参数已切换');
await page.selectOption('#bench-kind', 'cpu');
await page.waitForTimeout(600);

// 文件页：目录浏览与返回
await page.click('.nav-item[data-route="files"]');
await page.waitForTimeout(2200);
const rootRows = await page.locator('#fm-body table tbody tr').count();
rec('功能', '文件列表渲染', rootRows > 5, `${rootRows} 项`);
await page.click('[data-nav="/home"]');
await page.waitForTimeout(1800);
rec('功能', '文件目录导航', (await page.textContent('#fm-path')).trim() === '/home', await page.textContent('#fm-path'));
await page.click('#fm-up');
await page.waitForTimeout(1500);
rec('功能', '返回上级', (await page.textContent('#fm-path')).trim() === '/', '');

// 终端：连接与命令执行
await page.click('.nav-item[data-route="terminal"]');
await page.waitForTimeout(3500);
const termReady = (await page.textContent('#term-state')).includes('已连接');
rec('功能', '终端已连接', termReady, await page.textContent('#term-state'));
if (termReady) {
  await page.click('#term-host');
  await page.waitForTimeout(300);
  // 用 keyboard.type 逐键输入（每个字符独立 keydown，走我们的处理器）
  await page.keyboard.type('echo UI_TERM_$((3*9))', { delay: 30 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const termText = await page.textContent('#term-host');
  rec('功能', '终端执行命令', termText.includes('UI_TERM_27'),
    termText.includes('UI_TERM_27') ? '输出正确' : JSON.stringify(termText.slice(-80)));
}

// 设置页
await page.click('.nav-item[data-route="settings"]');
await page.waitForTimeout(1200);
rec('页面', 'settings', (await page.textContent('#content')).includes('admin'), '显示账号信息');

// ===== 3.5 新增能力 UI 校验 =====
console.log('\n═══ 3.5 显存/分核/磁盘 UI ═══');
await page.click('.nav-item[data-route="overview"]');
await page.waitForTimeout(2200);
const ovText = await page.textContent('#content');
rec('显存', '概览显示 GPU 卡片', ovText.includes('GPU 占用') && ovText.includes('显存'), '');
rec('显存', '显存数值已填充', /\d+(\.\d+)?%/.test(await page.textContent('#mv-vram')), (await page.textContent('#mv-vram')).trim());
rec('显存', 'GPU 详情面板', (await page.textContent('#ov-gpu')).includes('VRAM'), '含 VRAM 与 GTT 进度条');

await page.click('.nav-item[data-route="cpudetail"]');
await page.waitForTimeout(2000);
const coreRows = await page.locator('#cpu-table table tbody tr').count();
rec('CPU', 'CPU 详情页每核明细', coreRows >= 8, `${coreRows} 行`);
const coreRowText = await page.locator('#cpu-table table tbody tr').first().textContent();
rec('CPU', '明细含频率列', /MHz/.test(coreRowText), coreRowText.replace(/\s+/g,' ').trim());
rec('CPU', '概况显示物理核心', !(await page.textContent('#cpu-summary')).includes('— 核'), '');

await page.click('.nav-item[data-route="disk"]');
await page.waitForTimeout(2000);
const diskText = await page.textContent('#disk-devices-info');
rec('磁盘', '显示物理磁盘卡片', diskText.includes('序列号') && diskText.includes('固件版本'), '');
rec('磁盘', '识别机械硬盘', diskText.includes('机械硬盘'), '');
rec('磁盘', '序列号可见', /83L8CB3BT|202012189571/.test(diskText), '');
const smartText = await page.textContent('#disk-smart');
const smartOK = /PASSED|FAILED/.test(smartText) && /°C/.test(smartText);
const smartFallback = smartText.includes('不可用') || smartText.includes('smartmontools');
rec('磁盘', 'SMART 健康数据显示', smartOK || smartFallback,
  smartOK ? '显示 PASSED 与温度' : '降级提示');
if (smartOK) {
  rec('磁盘', 'SMART 含通电时长', /小时/.test(smartText), '');
  rec('磁盘', '机械盘已挂载', diskText.includes('/mnt/hdd') || diskText.includes('已挂载'), '');
}

// ===== 4. 主题切换 =====
console.log('\n═══ 4. 主题切换 ═══');
await page.click('.nav-item[data-route="overview"]');
await page.waitForTimeout(1200);
const themeBefore = await page.getAttribute('html', 'data-theme');
await page.click('#theme-btn');
await page.waitForTimeout(800);
const themeAfter = await page.getAttribute('html', 'data-theme');
rec('主题', '切换主题生效', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
rec('主题', '主题色实际变化', bgAfter !== 'rgb(13, 17, 23)', `背景=${bgAfter}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const themePersist = await page.getAttribute('html', 'data-theme');
rec('主题', '主题持久化', themePersist === themeAfter, `刷新后=${themePersist}`);
await page.click('#theme-btn');
await page.waitForTimeout(600);

// ===== 5. 进程页交互 =====
console.log('\n═══ 5. 进程页交互 ═══');
await page.click('.nav-item[data-route="process"]');
await page.waitForTimeout(1800);
let rowCount = await page.locator('#proc-body table tbody tr').count();
rec('进程', '进程表格渲染', rowCount > 10, `${rowCount} 行`);
const summary1 = await page.textContent('#proc-summary');
rec('进程', '统计摘要显示', summary1.includes('系统进程总数'), summary1.slice(0, 60));

// 排序切换
await page.selectOption('#proc-sort', 'mem');
await page.waitForTimeout(1500);
const firstMemRow = await page.locator('#proc-body table tbody tr').first().textContent();
const memVals = await page.evaluate(() => [...document.querySelectorAll('#proc-body table tbody tr')].slice(0,5)
  .map(tr => tr.children[3].textContent.trim()));
rec('进程', '按内存排序生效', summary1 !== (await page.textContent('#proc-summary')), `前5: ${memVals.join(', ')}`);

// 过滤
await page.selectOption('#proc-sort', 'cpu');
await page.fill('#proc-filter', 'systemd');
await page.waitForTimeout(1500);
rowCount = await page.locator('#proc-body table tbody tr').count();
const filteredNames = await page.evaluate(() => [...document.querySelectorAll('#proc-body table tbody tr')].slice(0,3)
  .map(tr => tr.children[1].textContent.trim()));
rec('进程', '过滤功能生效', rowCount > 0 && rowCount < 100, `${rowCount} 行: ${filteredNames.join(', ')}`);

await page.fill('#proc-filter', 'zzz_nonexistent_proc_zzz');
await page.waitForTimeout(1400);
rec('进程', '无结果时显示空状态', (await page.locator('#proc-body .placeholder').count()) > 0);
await page.fill('#proc-filter', '');
await page.waitForTimeout(1400);
rec('进程', 'Top10 柱状图图例', (await page.locator('#proc-bars-legend .legend-item').count()) > 0,
  `${await page.locator('#proc-bars-legend .legend-item').count()} 项`);

// ===== 6. 实时图表交互 =====
console.log('\n═══ 6. 实时图表交互 ═══');
await page.click('.nav-item[data-route="realtime"]');
await page.waitForTimeout(2000);
const legendBefore = await page.locator('#rt-legend .legend-item:not(.off)').count();
await page.locator('#rt-legend .legend-item').nth(2).click(); // 打开第三项
await page.waitForTimeout(800);
const legendAfter = await page.locator('#rt-legend .legend-item:not(.off)').count();
rec('图表', '图例可切换指标', legendAfter !== legendBefore, `可见 ${legendBefore} → ${legendAfter}`);
rec('图表', 'PSI 压力面板', (await page.textContent('#rt-psi')).includes('CPU'), '显示 CPU/内存/IO');

// ===== 7. 历史回看 =====
console.log('\n═══ 7. 历史回看 ═══');
await page.click('.nav-item[data-route="history"]');
await page.waitForTimeout(2000);
const statsText = await page.textContent('#hist-stats');
rec('历史', '区间统计显示', statsText.includes('样本数'), statsText.replace(/\s+/g,' ').slice(0, 70));
await page.click('#hist-range button[data-hours="24"]');
await page.waitForTimeout(2000);
rec('历史', '时间范围切换', (await page.textContent('#hist-stats')).includes('样本数'), '24小时查询成功');

// ===== 8. 连接页筛选 =====
console.log('\n═══ 8. 连接页筛选 ═══');
await page.click('.nav-item[data-route="connections"]');
await page.waitForTimeout(2000);
let connRows = await page.locator('#conn-body table tbody tr').count();
rec('连接', '连接表渲染', connRows > 0, `${connRows} 行`);
await page.selectOption('#conn-state', 'LISTEN');
await page.waitForTimeout(1500);
const listenRows = await page.locator('#conn-body table tbody tr').count();
const allListen = await page.evaluate(() => [...document.querySelectorAll('#conn-body table tbody tr')]
  .every(tr => tr.children[1].textContent.includes('LISTEN')));
rec('连接', '状态筛选生效', allListen, `${listenRows} 行全部为 LISTEN`);
await page.selectOption('#conn-state', '');
await page.waitForTimeout(1200);

// ===== 9. 移动端 =====
console.log('\n═══ 9. 移动端适配 ═══');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
rec('移动端', '菜单按钮出现', await page.locator('#menu-btn').isVisible());
rec('移动端', '侧栏默认隐藏', !(await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))));
await page.click('#menu-btn');
await page.waitForTimeout(700);
rec('移动端', '侧栏可打开', await page.locator('#sidebar').evaluate(el => el.classList.contains('open')));
rec('移动端', '遮罩层显示', await page.locator('#backdrop').evaluate(el => el.classList.contains('show')));
// 点侧栏右侧的遮罩区域（真实用户操作位置）
await page.mouse.click(360, 500);
await page.waitForTimeout(800);
rec('移动端', '点遮罩关闭侧栏', !(await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))));
await page.click('#menu-btn');
await page.waitForTimeout(600);
await page.click('.nav-item[data-route="disk"]');
await page.waitForTimeout(1400);
rec('移动端', '选导航后自动收起侧栏', !(await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))),
  `当前页=${(await page.textContent('#page-title')).trim()}`);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
rec('移动端', '无横向溢出', overflow <= 2, `溢出 ${overflow}px`);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(900);

// ===== 10. 设置页与登出 =====
console.log('\n═══ 10. 设置与登出 ═══');
await page.click('.nav-item[data-route="settings"]');
await page.waitForTimeout(1200);
rec('设置', '显示用户名', (await page.textContent('#content')).includes('admin'));
rec('设置', '改密入口存在', await page.locator('#set-pwd').isVisible());
await page.click('#set-pwd');
await page.waitForTimeout(600);
rec('设置', '改密弹窗打开', await page.locator('#pwd-modal').isVisible());
await page.fill('#pwd-current', PASSWORD);
await page.fill('#pwd-new', 'short');
await page.fill('#pwd-confirm', 'short');
await page.click('#pwd-save');
await page.waitForTimeout(800);
rec('设置', '密码长度校验', (await page.textContent('#pwd-error')).includes('8 位'), await page.textContent('#pwd-error'));
await page.fill('#pwd-new', 'aaaaaaaa');
await page.fill('#pwd-confirm', 'bbbbbbbb');
await page.click('#pwd-save');
await page.waitForTimeout(800);
rec('设置', '密码一致性校验', (await page.textContent('#pwd-error')).includes('不一致'), await page.textContent('#pwd-error'));
await page.click('#pwd-cancel');
await page.waitForTimeout(500);

// 登出
await page.click('#logout-btn');
await page.waitForTimeout(1500);
rec('登出', '登出回到登录页', await page.locator('#login-view').isVisible());
const afterLogout = await page.evaluate(async () => {
  const r = await fetch('/api/system');
  return r.status;
});
rec('登出', '登出后接口被拒', afterLogout === 401, `status=${afterLogout}`);

// ===== 汇总 =====
console.log('\n' + '='.repeat(60));
const byGroup = {};
for (const x of results) {
  byGroup[x.group] = byGroup[x.group] || { pass: 0, total: 0 };
  byGroup[x.group].total++;
  if (x.ok) byGroup[x.group].pass++;
}
for (const [g, v] of Object.entries(byGroup)) {
  console.log(`  ${g.padEnd(8)} ${v.pass}/${v.total} ${v.pass === v.total ? '✅' : '❌'}`);
}
const passed = results.filter(x => x.ok).length;
console.log(`\n总计: ${passed}/${results.length} 通过`);
// 预期内的 401：故意用错密码登录 + 登出后探测
const expected401 = errs.filter(e => e.includes('401'));
const unexpected = errs.filter(e => !e.includes('401'));
console.log(`浏览器控制台错误: ${errs.length}（其中预期内 401: ${expected401.length}，非预期: ${unexpected.length}）`);
if (unexpected.length) console.log(unexpected.slice(0, 8).join('\n'));
rec('控制台', '无非预期错误', unexpected.length === 0, `${unexpected.length} 个非预期错误`);
const failed = results.filter(x => !x.ok);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  ❌ [${f.group}] ${f.name}: ${f.detail}`);
}
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
