/* ==========================================================================
   app.js — 服务器控制面板前端
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     状态
     ====================================================================== */
  const state = {
    authenticated: false,
    username: '',
    csrf: '',
    mustChangePassword: false,
    system: null,
    latest: null,
    historyPoints: [],   // 最近 10 分钟内存缓冲
    route: 'overview',
    charts: {},
    cleanups: [],
    sparks: {},
    sse: null,
    sseRetries: 0,
    theme: localStorage.getItem('panel-theme') || 'dark',
    sidebarOpen: false,
    appInfo: null,
    installPrompt: null,
    standalone: false,
    swRegistration: null,
    // 「记住我」当前设备状态（来自 /api/login 或 /api/session 的 remember 字段）
    remember: null,        // { expiresAt } | null
    resumed: false,        // 本次是否由记住令牌自动登录
    // DSH 控制页状态（跨导航保留，任务流在后台继续接收）
    dsh: {
      allowTask: null,       // null=未知 / true / false
      mode: 'new',           // 'new' | 'continue'
      sessionId: null,
      sessionLabel: '',
      taskId: null,
      running: false,
      taskStatus: null,      // { label, cls }
      logs: [],              // [{ kind, text }]，上限 3000 行
      taskEs: null,
      sessions: [],          // 会话目录（新接口）
      sessionsQ: '',
      workspace: '',
      workspaces: [],
      capabilities: null,    // 能力信息
      capabilitiesError: null,
      sdk: null,             // GET /api/dsh/sdk/status
      sdkError: null,
      channel: 'auto',       // auto | headless | sdk
      boundChat: null,       // SDK 绑定后的面板聊天会话 {id, dshSessionId, title}
      selectedIsWeb: false,  // 当前选中会话是否为 Web(preset) 会话
      sessionsPayload: null,
    },
    // 「下载」页：当前分享结果与倒计时
    download: {
      current: null,
      timer: null,
      shares: [],
      sharesLoaded: false,
    },
    // 「审计」页分页/搜索状态（跨导航保留）
    audit: {
      q: '',
      offset: 0,
      limit: 200,
      total: 0,
    },
    // B2：特权助手状态与待执行的电源操作
    host: {
      helper: null,      // null=未知 / true / false
      version: null,
      error: null,
      power: null,       // { action, delaySeconds, at }
      devices: null,     // 挂载设备候选
    },
    // B3：Docker 容器 shell 跳转到终端页时携带的会话
    terminalAttach: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ======================================================================
     API 封装
     ====================================================================== */
  async function api(path, opts = {}) {
    const init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (state.csrf && init.method !== 'GET') {
      init.headers['X-CSRF-Token'] = state.csrf;
    }

    const res = await fetch(path, init);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = { ok: false, error: '响应解析失败' };
    }
    if (res.status === 401) {
      showLogin();
      throw new Error(data.error || '未登录');
    }
    if (!res.ok || data.ok === false) {
      const msg = data.error || `请求失败 (${res.status})`;
      // 后端校验错误常带 detail（如规则第几行），一并展示便于定位
      const err = new Error(data.detail ? `${msg}：${data.detail}` : msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ======================================================================
     格式化工具
     ====================================================================== */
  function fmtBytes(bytes, decimals = 1) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    const v = bytes / Math.pow(k, i);
    return `${v.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
  }

  function fmtRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
    return fmtBytes(bytesPerSec) + '/s';
  }

  function fmtPercent(v, decimals = 1) {
    if (!Number.isFinite(v)) return '—';
    return `${v.toFixed(decimals)}%`;
  }

  function fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分`;
  }

  function fmtDateTime(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    try {
      return new Date(ms).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  /** 时间字段兼容：epoch 毫秒 / ISO 字符串 */
  function fmtAnyTime(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return fmtDateTime(num);
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString('zh-CN', { hour12: false });
    return String(value);
  }

  function fmtAgo(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return fmtDateTime(ms);
  }

  function fmtMhz(v) {
    if (!Number.isFinite(v)) return '—';
    return `${(v / 1000).toFixed(2)} GHz`;
  }

  /* ---------------- CPU 拓扑（物理核 / 线程 / 超线程） ---------------- */

  /**
   * 归一化 CPU 拓扑信息，兼容新旧后端字段：
   * - metrics.cpu: physicalCores / threads / threadsPerCore / smt / physicalCoresEstimated（新）
   * - metrics.cpu: coreCount（旧，等于逻辑线程数）
   * - /api/system: cpuPhysicalCores / cpuCores
   */
  function getCpuInfo(snapshot, system) {
    const cpu = (snapshot && snapshot.cpu) || {};
    const sys = system || {};
    const perCoreList = Array.isArray(cpu.perCore) ? cpu.perCore : [];

    let threads = Number(cpu.threads);
    if (!Number.isFinite(threads) || threads <= 0) threads = Number(sys.cpuCores);
    if (!Number.isFinite(threads) || threads <= 0) threads = Number(cpu.coreCount);
    if (!Number.isFinite(threads) || threads <= 0) threads = perCoreList.length;
    if (!Number.isFinite(threads) || threads <= 0) threads = null;

    let physical = Number(cpu.physicalCores);
    if (!Number.isFinite(physical) || physical <= 0) physical = Number(sys.cpuPhysicalCores);
    if (!Number.isFinite(physical) || physical <= 0) physical = null;

    let perCore = Number(cpu.threadsPerCore);
    if (!Number.isFinite(perCore) || perCore <= 0) {
      perCore = physical && threads ? Math.max(1, Math.round(threads / physical)) : null;
    }

    let smt = typeof cpu.smt === 'boolean' ? cpu.smt : null;
    if (smt === null && perCore) smt = perCore > 1;
    if (smt === true && perCore === 1) smt = false;

    return {
      threads,
      physical,
      perCore,
      smt,
      estimated: cpu.physicalCoresEstimated === true,
    };
  }

  /** 完整文案：8 核 16 线程（超线程 2 线程/核） */
  function cpuFullLabel(info) {
    if (!info || (!info.threads && !info.physical)) return 'CPU 拓扑未知';
    const threads = info.threads || info.physical;
    const physical = info.physical;
    let text = physical ? `${physical} 核 ${threads} 线程` : `${threads} 线程`;
    if (physical && info.smt !== null) {
      text += info.smt ? `（超线程 ${info.perCore || 2} 线程/核）` : '（无超线程）';
    }
    if (info.estimated) text += '（推算）';
    return text;
  }

  /** 物理核 / 逻辑线程（用于表格行） */
  function cpuPairLabel(info) {
    if (!info || (!info.threads && !info.physical)) return '—';
    const threads = info.threads || info.physical;
    if (!info.physical) return `${threads} 线程`;
    return `${info.physical} 核 / ${threads} 线程${info.estimated ? '（推算）' : ''}`;
  }

  /** 短文案：8 核 16 线程 / 8 核 8 线程；无法确定物理核时只写线程数 */
  function cpuShortLabel(info) {
    if (!info || (!info.threads && !info.physical)) return 'CPU';
    const threads = info.threads || info.physical;
    if (!info.physical) return `${threads} 线程`;
    const base = `${info.physical} 核 ${threads} 线程`;
    return info.estimated ? `${base}（推算）` : base;
  }

  /** 紧凑文案：8C/16T · HT */
  function cpuCompactLabel(info) {
    if (!info || (!info.threads && !info.physical)) return 'CPU';
    const threads = info.threads || info.physical;
    if (!info.physical) return `${threads}T`;
    let text = `${info.physical}C/${threads}T`;
    if (info.smt) text += ' · HT';
    if (info.estimated) text += ' *';
    return text;
  }

  /** 超线程补充说明（用于卡片副标题） */
  function cpuTopologyHint(info) {
    if (!info || !info.physical) return '';
    const bits = [];
    if (info.smt !== null) bits.push(info.smt ? `超线程 ${info.perCore || 2} 线程/核` : '无超线程');
    bits.push(`物理核 ${info.physical} · 逻辑核 ${info.threads || info.physical}`);
    if (info.estimated) bits.push('物理核为推算值');
    return bits.join(' · ');
  }

  function cpuThreadCount(info) {
    if (!info) return 0;
    return Number(info.threads) || Number(info.physical) || 0;
  }

  /** 核数多时用网格展示，避免图表/图例过宽 */
  function renderThreadBars(opts) {
    const { canvas, grid, legend, values, info, unitSuffix } = opts;
    const list = Array.isArray(values) ? values.map((v) => Number(v) || 0) : [];
    const threads = cpuThreadCount(info) || list.length;
    const useGrid = list.length > 32;
    if (canvas) canvas.classList.toggle('hidden', useGrid);
    const chartWrap = canvas ? canvas.closest('.chart-wrap') : null;
    if (chartWrap) chartWrap.classList.toggle('hidden', useGrid);
    if (grid) {
      grid.classList.toggle('hidden', !useGrid);
      if (useGrid) {
        grid.innerHTML = list
          .map((v, i) => {
            const cls = v >= 90 ? 'crit' : v >= 70 ? 'warn' : 'ok';
            return `<div class="core-cell" title="线程 ${i}：${v.toFixed(1)}%">
              <span class="core-name">${i}</span>
              <span class="core-bar"><i class="${cls}" style="width:${Math.max(1, Math.min(100, v)).toFixed(0)}%"></i></span>
              <span class="core-val">${v.toFixed(0)}${unitSuffix || '%'}</span>
            </div>`;
          })
          .join('');
      }
    }
    if (legend) {
      legend.innerHTML = useGrid
        ? `<span class="legend-item">共 ${list.length} 个逻辑线程${threads ? `（${threads} 线程）` : ''}</span>`
        : list
            .map((v, i) => `<span class="legend-item">线程 ${i} <b>${v.toFixed(0)}${unitSuffix || '%'}</b></span>`)
            .join('');
    }
    return { useGrid, threads };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 根据百分比返回颜色等级 */
  function levelClass(pct, warn = 75, crit = 90) {
    if (pct >= crit) return 'crit';
    if (pct >= warn) return 'warn';
    return 'ok';
  }

  /* ======================================================================
     主题
     ====================================================================== */
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('panel-theme', theme);
    // 两套 media theme-color 都同步为当前主题，避免系统配色与手动切换冲突
    const color = theme === 'dark' ? '#0d1117' : '#f6f8fa';
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.setAttribute('content', color);
    });
    // 重绘所有图表以适配新配色
    for (const c of Object.values(state.charts)) if (c?.draw) c.draw();
    for (const s of Object.values(state.sparks)) if (s?.draw) s.draw();
    if (state.latest) updateSparkColors();
  }

  function toggleTheme() {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  }

  function updateSparkColors() {
    // sparkline 颜色从 CSS 变量读取，重绘即可
    for (const s of Object.values(state.sparks)) if (s?.draw) s.draw();
  }

  /* ======================================================================
     Toast
     ====================================================================== */
  function toast(message, type = 'info', duration = 3200) {
    const wrap = $('#toast-wrap');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    const icon = {
      ok: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>',
      err: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
      warn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
      info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 16v-4M12 8h.01"/></svg>',
    }[type] || '';
    el.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .2s';
      setTimeout(() => el.remove(), 220);
    }, duration);
  }

  /* ======================================================================
     登录 / 登出
     ====================================================================== */
  const LAST_USER_KEY = 'panel.lastUser';
  const REMEMBER_CACHE_KEY = 'panel.remember';

  /** 归一化 remember 字段（兼容缺省 / 秒级时间戳） */
  function normalizeRemember(remember) {
    if (!remember || typeof remember !== 'object') return null;
    const raw = Number(remember.expiresAt);
    const expiresAt = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : null;
    return { ...remember, expiresAt };
  }

  /**
   * 本设备记住登录的本地缓存。
   * /api/session 在「已有普通会话」时不返回 remember 字段（后端契约允许），
   * 这里用 localStorage 里上次登录/自动登录拿到的到期时间补足展示，避免刷新后误显示“未记住”。
   */
  function getCachedRemember() {
    try {
      const raw = localStorage.getItem(REMEMBER_CACHE_KEY);
      if (!raw) return null;
      const remember = normalizeRemember(JSON.parse(raw));
      if (!remember) return null;
      if (remember.expiresAt && remember.expiresAt <= Date.now()) {
        localStorage.removeItem(REMEMBER_CACHE_KEY);
        return null;
      }
      return remember;
    } catch (e) {
      return null;
    }
  }

  function saveRememberCache(remember) {
    try {
      if (remember && remember.expiresAt) {
        localStorage.setItem(REMEMBER_CACHE_KEY, JSON.stringify({ expiresAt: remember.expiresAt }));
      } else {
        localStorage.removeItem(REMEMBER_CACHE_KEY);
      }
    } catch (e) {
      /* 隐私模式等场景忽略 */
    }
  }

  function clearRememberCache() {
    try {
      localStorage.removeItem(REMEMBER_CACHE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function rememberText(remember) {
    if (!remember) return '';
    if (!remember.expiresAt) return '已记住登录';
    const days = Math.max(0, Math.ceil((remember.expiresAt - Date.now()) / 86400000));
    const suffix = days > 0 ? `（剩余 ${days} 天）` : '（即将到期）';
    return `已记住 · ${fmtDateTime(remember.expiresAt)} 到期${suffix}`;
  }

  function getLastUser() {
    try {
      return localStorage.getItem(LAST_USER_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function saveLastUser(username) {
    try {
      if (username) localStorage.setItem(LAST_USER_KEY, username);
    } catch (e) {
      /* 隐私模式等场景忽略 */
    }
  }

  /** 主动刷新 /api/session，同步 remember 状态（后端旧版本时静默失败） */
  async function refreshSessionInfo() {
    try {
      const data = await api('/api/session');
      if (data && data.authenticated) {
        if (data.username) state.username = data.username;
        if (data.csrf) state.csrf = data.csrf;
        const remember = normalizeRemember(data.remember);
        state.remember = remember || getCachedRemember();
        if (remember) saveRememberCache(remember);
        return true;
      }
    } catch (e) {
      /* 忽略：不影响已登录状态 */
    }
    return false;
  }

  function showLogin() {
    state.authenticated = false;
    state.csrf = '';
    closeSse();
    dshCloseTaskStream();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-error')?.classList.add('hidden');

    // 回填上次登录的用户名（只回填用户名，绝不保存密码）
    const userInput = $('#login-username');
    const pwdInput = $('#login-password');
    const lastUser = getLastUser();
    if (userInput && lastUser && !userInput.value.trim()) userInput.value = lastUser;
    if (pwdInput) pwdInput.value = '';
    setTimeout(() => {
      if (userInput && userInput.value.trim()) pwdInput?.focus();
      else userInput?.focus();
    }, 60);
  }

  function showApp() {
    state.authenticated = true;
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    startSse();
  }

  async function doLogin(e) {
    e.preventDefault();
    const btn = $('#login-submit');
    const errBox = $('#login-error');
    errBox.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '登录中…';

    const rememberBox = $('#login-remember');
    const wantRemember = rememberBox ? rememberBox.checked : false;

    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: {
          username: $('#login-username').value.trim(),
          password: $('#login-password').value,
          remember: wantRemember,
        },
      });
      const rememberFromLogin = normalizeRemember(data.remember);
      // 本次明确未勾选时，若本设备曾记住过登录，则撤销遗留令牌（旧后端无此接口时忽略）
      const hadRemember = Boolean(rememberFromLogin || getCachedRemember());
      state.username = data.username;
      state.csrf = data.csrf;
      state.mustChangePassword = data.mustChangePassword;
      state.resumed = false;
      state.remember = rememberFromLogin;
      saveRememberCache(rememberFromLogin);
      saveLastUser(data.username || '');
      $('#login-password').value = '';
      await boot();
      showApp();
      // 兼容只在 /api/session 返回 remember 的后端实现
      if (!state.remember && wantRemember) refreshSessionInfo();
      if (!wantRemember && hadRemember) {
        api('/api/remember/forget', { method: 'POST' }).catch(() => {
          /* 旧后端无此接口时忽略 */
        });
      }
      if (state.mustChangePassword) {
        toast('请尽快修改默认密码', 'warn', 5000);
        setTimeout(openPasswordModal, 800);
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  }

  async function doLogout() {
    const confirmed = window.confirm(
      '退出登录后将撤销本设备的记住登录，下次打开面板需要重新输入密码。确定退出？'
    );
    if (!confirmed) return;
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (e) {
      /* ignore */
    }
    state.remember = null;
    state.resumed = false;
    clearRememberCache();
    showLogin();
    toast('已退出登录', 'info', 2400);
  }

  /* ======================================================================
     路由与导航
     ====================================================================== */
  const ICONS = {
    overview: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    realtime: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 5-8 4 5"/></svg>',
    history: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    process: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg>',
    disk: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3"/></svg>',
    network: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5 6.5 17M12 11.5 17.5 17"/></svg>',
    service: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 9.2 8 10 4.6-.8 8-5 8-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
    logs: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    bench: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M6 20v-6M11 20V9M16 20v-9M21 20V5"/></svg>',
    alerts: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    files: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 5 4-5 4M13 16h6"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
    gpu: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M15 10h4M15 14h4"/></svg>',
    docker: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4v4H3zM8 12h4v4H8zM13 12h4v4h-4zM8 7h4v4H8zM13 7h4v4h-4z"/><path d="M2 16h19c0 3-2.5 5-6 5H8c-3.5 0-6-2-6-5z"/></svg>',
    conn: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/></svg>',
    cron: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/></svg>',
    sensors: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/></svg>',
    system: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    dsh: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="m7 9 2.5 2.5L7 14M12.5 14H17"/><path d="M8 21h8"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4 20h16"/></svg>',
    audit: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h6M9 16h6"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="m20 20 2 2"/></svg>',
    host: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 17.5h.01"/><path d="M12 7.5h5M12 17.5h5"/></svg>',
  };

  const NAV = [
    {
      label: '监控',
      items: [
        { id: 'overview', name: '概览', icon: 'overview' },
        { id: 'realtime', name: '实时图表', icon: 'realtime' },
        { id: 'cpudetail', name: 'CPU 详情', icon: 'cpu' },
        { id: 'history', name: '历史回看', icon: 'history' },
      ],
    },
    {
      label: '系统',
      items: [
        { id: 'process', name: '进程', icon: 'process' },
        { id: 'disk', name: '磁盘', icon: 'disk' },
        { id: 'network', name: '网络', icon: 'network' },
        { id: 'connections', name: '连接与端口', icon: 'conn' },
        { id: 'service', name: '服务', icon: 'service' },
        { id: 'cron', name: '定时任务', icon: 'cron' },
        { id: 'sensors', name: '传感器', icon: 'sensors' },
        { id: 'sysinfo', name: '系统详情', icon: 'system' },
        { id: 'logs', name: '日志', icon: 'logs' },
        { id: 'audit', name: '审计', icon: 'audit' },
        { id: 'host', name: '主机控制', icon: 'host' },
      ],
    },
    {
      label: '容器',
      items: [
        { id: 'docker', name: 'Docker', icon: 'docker' },
      ],
    },
    {
      label: '性能',
      items: [
        { id: 'bench', name: '压测', icon: 'bench' },
        { id: 'alerts', name: '告警', icon: 'alerts' },
      ],
    },
    {
      label: '工具',
      items: [
        { id: 'files', name: '文件', icon: 'files' },
        { id: 'download', name: '下载', icon: 'download' },
        { id: 'terminal', name: '终端', icon: 'terminal' },
        { id: 'dsh', name: 'DSH 控制', icon: 'dsh' },
        { id: 'settings', name: '设置', icon: 'settings' },
      ],
    },
  ];

  const ROUTES = {
    overview: { title: '概览', render: renderOverview },
    realtime: { title: '实时图表', render: renderRealtime },
    cpudetail: { title: 'CPU 详情', render: renderCpuDetail },
    history: { title: '历史回看', render: renderHistory },
    process: { title: '进程', render: renderProcess },
    disk: { title: '磁盘', render: renderDisk },
    network: { title: '网络', render: renderNetwork },
    connections: { title: '连接与端口', render: renderConnections },
    service: { title: '服务', render: renderService },
    cron: { title: '定时任务', render: renderCron },
    sensors: { title: '传感器', render: renderSensors },
    sysinfo: { title: '系统详情', render: renderSysinfo },
    docker: { title: 'Docker 管理', render: renderDocker },
    logs: { title: '日志', render: renderLogs },
    bench: { title: '性能压测', render: renderBench },
    alerts: { title: '告警', render: renderAlerts },
    files: { title: '文件管理', render: renderFiles },
    download: { title: '下载', render: renderDownload },
    terminal: { title: '终端', render: renderTerminal },
    dsh: { title: 'DSH 控制', render: renderDsh },
    audit: { title: '审计', render: renderAudit },
    host: { title: '主机控制', render: renderHost },
    settings: { title: '设置', render: renderSettings },
  };

  function buildNav() {
    const nav = $('#nav');
    nav.innerHTML = '';
    for (const group of NAV) {
      const label = document.createElement('div');
      label.className = 'nav-group-label';
      label.textContent = group.label;
      nav.appendChild(label);

      for (const item of group.items) {
        const btn = document.createElement('button');
        btn.className = 'nav-item';
        btn.dataset.route = item.id;
        btn.innerHTML = `${ICONS[item.icon] || ''}<span>${item.name}</span>`;
        btn.addEventListener('click', () => navigate(item.id));
        nav.appendChild(btn);
      }
    }
  }

  async function navigate(routeId) {
    if (!ROUTES[routeId]) routeId = 'overview';
    state.route = routeId;
    closeSidebar();

    $$('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.route === routeId);
    });

    const def = ROUTES[routeId];
    $('#page-title').textContent = def.title;

    // 清理上一页的图表实例与事件监听
    for (const c of Object.values(state.charts)) if (c?.destroy) c.destroy();
    for (const s of Object.values(state.sparks)) if (s?.destroy) s.destroy();
    for (const fn of state.cleanups) {
      try {
        fn();
      } catch (e) {
        /* 清理失败不影响导航 */
      }
    }
    state.charts = {};
    state.sparks = {};
    state.cleanups = [];

    const content = $('#content');
    content.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:60%;height:14px"></div><div class="skeleton" style="width:80%;height:14px"></div></div>';

    try {
      await def.render(content);
    } catch (err) {
      content.innerHTML = `<div class="placeholder"><h3>页面加载失败</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  /* ======================================================================
     SSE 实时数据
     ====================================================================== */
  function startSse() {
    closeSse();
    const es = new EventSource('/api/stream');
    state.sse = es;

    es.addEventListener('metrics', (ev) => {
      state.sseRetries = 0;
      $('#conn-banner').classList.add('hidden');
      try {
        const data = JSON.parse(ev.data);
        onMetrics(data);
      } catch (e) {
        /* ignore */
      }
    });

    es.onerror = () => {
      $('#conn-banner').classList.remove('hidden');
      // EventSource 会自动重连，这里只做提示
      state.sseRetries++;
    };

    es.onopen = () => {
      $('#conn-banner').classList.add('hidden');
      state.sseRetries = 0;
    };
  }

  function closeSse() {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
  }

  /** 收到新指标 */
  function onMetrics(s) {
    state.latest = s;

    // 内存缓冲（最近 600 点）
    state.historyPoints.push({
      at: s.at,
      cpu: s.cpu?.percent ?? 0,
      mem: s.memory?.usedPercent ?? 0,
      cpuTemp: s.sensors?.cpuTemp ?? null,
      rx: s.network?.interfaces?.reduce((a, n) => a + n.rxBytesPerSec, 0) ?? 0,
      tx: s.network?.interfaces?.reduce((a, n) => a + n.txBytesPerSec, 0) ?? 0,
    });
    if (state.historyPoints.length > 600) state.historyPoints.shift();

    // 更新当前页
    const updater = PAGE_UPDATERS[state.route];
    if (updater) {
      try {
        updater(s);
      } catch (e) {
        console.error('更新页面失败', e);
      }
    }
  }

  /* ======================================================================
     页面：概览
     ====================================================================== */
  const PAGE_UPDATERS = {};

  async function renderOverview(root) {
    const sys = state.system;
    root.innerHTML = `
      <div class="grid grid-cards cols-4" id="ov-cards"></div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head">
            <h3>CPU 使用率</h3>
            <span class="spacer"></span>
            <span class="card-sub" id="ov-cpu-sub">—</span>
          </div>
          <div class="chart-wrap"><canvas id="ov-cpu-chart"></canvas></div>
          <div class="legend" id="ov-cpu-legend"></div>
        </div>
        <div class="card">
          <div class="card-head">
            <h3>内存与交换</h3>
            <span class="spacer"></span>
            <span class="card-sub" id="ov-mem-sub">—</span>
          </div>
          <div class="chart-wrap"><canvas id="ov-mem-chart"></canvas></div>
          <div class="legend" id="ov-mem-legend"></div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>网络吞吐</h3></div>
          <div class="chart-wrap"><canvas id="ov-net-chart"></canvas></div>
          <div class="legend" id="ov-net-legend"></div>
        </div>
        <div class="card" id="ov-temp-card">
          <div class="card-head"><h3>温度与频率</h3><span class="spacer"></span><span class="card-sub" id="ov-temp-sub"></span></div>
          <div class="chart-wrap"><canvas id="ov-temp-chart"></canvas></div>
          <div class="legend" id="ov-temp-legend"></div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card" id="ov-cores-card">
          <div class="card-head">
            <h3 id="ov-cores-title">CPU 各线程使用率</h3>
            <span class="spacer"></span>
            <span class="card-sub" id="ov-cores-sub"></span>
          </div>
          <div class="chart-wrap" style="height:110px"><canvas id="ov-cores"></canvas></div>
          <div class="core-grid hidden" id="ov-cores-grid"></div>
          <div class="legend" id="ov-cores-legend"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>系统信息</h3></div>
          <div id="ov-sysinfo"></div>
        </div>
      </div>
      <div class="card" id="ov-gpu-card">
        <div class="card-head">
          <h3>GPU / 显存</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="ov-gpu-model"></span>
        </div>
        <div id="ov-gpu"></div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>磁盘分区</h3></div>
          <div id="ov-fs"></div>
        </div>
        <div class="card" id="ov-sensors-card">
          <div class="card-head"><h3>温度传感器</h3></div>
          <div id="ov-sensors"></div>
        </div>
      </div>
    `;

    // 指标卡片
    const cards = [
      { id: 'cpu', label: 'CPU', icon: 'cpu', color: 'accent' },
      { id: 'mem', label: '内存', icon: 'mem', color: 'purple' },
      { id: 'load', label: '负载', icon: 'load', color: 'cyan' },
      { id: 'disk', label: '磁盘用量', icon: 'disk', color: 'orange' },
      { id: 'net', label: '网络', icon: 'net', color: 'green' },
      { id: 'temp', label: 'CPU 温度', icon: 'temp', color: 'red' },
      { id: 'gpu', label: 'GPU 占用', icon: 'gpu', color: 'cyan' },
      { id: 'vram', label: '显存', icon: 'gpu', color: 'purple' },
    ];

    const cardHost = $('#ov-cards', root);
    cardHost.innerHTML = cards
      .map(
        (c) => `
      <div class="card metric-card" id="mc-${c.id}">
        <div class="metric-top">
          <div class="metric-label" id="ml-${c.id}">${c.label}</div>
        </div>
        <div class="metric-value" id="mv-${c.id}">—</div>
        <div class="metric-foot" id="mf-${c.id}">&nbsp;</div>
        <canvas class="metric-spark" id="sp-${c.id}"></canvas>
      </div>`
      )
      .join('');

    // 图表
    const cpuChart = new Charts.LineChart($('#ov-cpu-chart', root), {
      series: [
        { key: 'user', name: '用户', color: 'var(--accent)' },
        { key: 'system', name: '系统', color: 'var(--purple)' },
      ],
      yMax: 100,
      maxPoints: 120,
    });
    state.charts.cpu = cpuChart;

    const memChart = new Charts.LineChart($('#ov-mem-chart', root), {
      series: [
        { key: 'mem', name: '内存', color: 'var(--purple)' },
        { key: 'swap', name: 'Swap', color: 'var(--orange)' },
      ],
      yMax: 100,
      maxPoints: 120,
    });
    state.charts.mem = memChart;

    const netChart = new Charts.LineChart($('#ov-net-chart', root), {
      series: [
        { key: 'rx', name: '下行', color: 'var(--green)' },
        { key: 'tx', name: '上行', color: 'var(--cyan)' },
      ],
      maxPoints: 120,
    });
    state.charts.net = netChart;

    const tempChart = new Charts.LineChart($('#ov-temp-chart', root), {
      series: [
        { key: 'cpu', name: 'CPU', color: 'var(--red)' },
        { key: 'gpu', name: 'GPU', color: 'var(--orange)' },
        { key: 'nvme', name: 'NVMe', color: 'var(--purple)' },
      ],
      maxPoints: 120,
    });
    state.charts.temp = tempChart;

    // 图例
    const legends = [
      ['ov-cpu-legend', [{ n: '用户', c: 'var(--accent)' }, { n: '系统', c: 'var(--purple)' }]],
      ['ov-mem-legend', [{ n: '内存', c: 'var(--purple)' }, { n: 'Swap', c: 'var(--orange)' }]],
      ['ov-net-legend', [{ n: '下行', c: 'var(--green)' }, { n: '上行', c: 'var(--cyan)' }]],
      ['ov-temp-legend', [{ n: 'CPU', c: 'var(--red)' }, { n: 'GPU', c: 'var(--orange)' }, { n: 'NVMe', c: 'var(--purple)' }]],
    ];
    for (const [id, items] of legends) {
      const el = $('#' + id, root);
      if (el) {
        el.innerHTML = items
          .map(
            (it) =>
              `<span class="legend-item"><span class="legend-swatch" style="background:${it.c}"></span>${it.n}</span>`
          )
          .join('');
      }
    }

    // 迷你走势
    state.sparks.cpu = new Charts.Sparkline($('#sp-cpu', root), { color: '#2f81f7' });
    state.sparks.mem = new Charts.Sparkline($('#sp-mem', root), { color: '#a371f7' });
    state.sparks.load = new Charts.Sparkline($('#sp-load', root), { color: '#39c5cf' });
    state.sparks.disk = new Charts.Sparkline($('#sp-disk', root), { color: '#db6d28' });
    state.sparks.net = new Charts.Sparkline($('#sp-net', root), { color: '#3fb950' });
    state.sparks.temp = new Charts.Sparkline($('#sp-temp', root), { color: '#f85149' });
    state.sparks.gpu = new Charts.Sparkline($('#sp-gpu', root), { color: '#39c5cf' });
    state.sparks.vram = new Charts.Sparkline($('#sp-vram', root), { color: '#a371f7' });

    // 用内存缓冲回填历史
    const hist = state.historyPoints;
    cpuChart.setData(hist.map((p) => ({ values: { user: p.cpu } })));
    tempChart.setData(
      hist.map((p) => ({ values: { cpu: p.cpuTemp, gpu: null, nvme: null } }))
    );

    let lastTempSignature = '';
    PAGE_UPDATERS.overview = (s) => updateOverview(s);
    if (state.latest) updateOverview(state.latest);

    function updateOverview(s) {
      const cpu = s.cpu?.percent ?? 0;
      const mem = s.memory?.usedPercent ?? 0;
      const load = s.load?.load1 ?? 0;
      const temp = s.sensors?.cpuTemp;
      const cpuInfo = getCpuInfo(s, sys);

      // CPU 卡片带拓扑（8 核 16 线程），悬停看超线程/推算说明
      const cpuLabelEl = $('#ml-cpu', root);
      if (cpuLabelEl) {
        const smtHint = cpuInfo.physical
          ? cpuInfo.smt === null
            ? ''
            : cpuInfo.smt
              ? `超线程 ${cpuInfo.perCore || 2} 线程/核`
              : '无超线程'
          : '';
        cpuLabelEl.innerHTML =
          `CPU · ${escapeHtml(cpuShortLabel(cpuInfo))}` +
          (smtHint || cpuInfo.estimated
            ? `<span class="metric-hint">${escapeHtml(
                [smtHint, cpuInfo.estimated ? '物理核为推算值' : ''].filter(Boolean).join(' · ')
              )}</span>`
            : '');
        cpuLabelEl.title = cpuFullLabel(cpuInfo);
      }
      $('#mv-cpu', root).innerHTML = `${cpu.toFixed(1)}<span class="unit">%</span>`;
      $('#mf-cpu', root).textContent =
        `${s.cpu?.user?.toFixed(1) ?? 0}% 用户 · ${s.cpu?.system?.toFixed(1) ?? 0}% 系统`;
      state.sparks.cpu.push(cpu);

      // 内存
      $('#mv-mem', root).innerHTML = `${mem.toFixed(1)}<span class="unit">%</span>`;
      $('#mf-mem', root).textContent =
        `${fmtBytes(s.memory?.used)} / ${fmtBytes(s.memory?.total)}`;
      state.sparks.mem.push(mem);

      // 负载
      const loadThreads = cpuThreadCount(cpuInfo) || (s.cpu?.perCore || []).length;
      $('#mv-load', root).innerHTML =
        `${load.toFixed(2)}<span class="unit">/ ${loadThreads ? `${loadThreads} 线程` : '— 线程'}</span>`;
      const loadLabelEl = $('#ml-load', root);
      if (loadLabelEl) loadLabelEl.title = cpuFullLabel(cpuInfo);
      $('#mf-load', root).textContent =
        `5m ${(s.load?.load5 ?? 0).toFixed(2)} · 15m ${(s.load?.load15 ?? 0).toFixed(2)}`;
      state.sparks.load.push(load);

      // 磁盘
      const rootFs = s.filesystems?.find((f) => f.mountPoint === '/') || s.filesystems?.[0];
      if (rootFs) {
        $('#mv-disk', root).innerHTML =
          `${rootFs.usedPercent.toFixed(1)}<span class="unit">%</span>`;
        $('#mf-disk', root).textContent =
          `${fmtBytes(rootFs.used)} / ${fmtBytes(rootFs.total)}`;
        state.sparks.disk.push(rootFs.usedPercent);
      }

      // 网络
      const rx = s.network?.interfaces?.reduce((a, n) => a + n.rxBytesPerSec, 0) ?? 0;
      const tx = s.network?.interfaces?.reduce((a, n) => a + n.txBytesPerSec, 0) ?? 0;
      $('#mv-net', root).innerHTML = `${fmtBytes(rx + tx)}<span class="unit">/s</span>`;
      $('#mf-net', root).textContent = `↓ ${fmtRate(rx)} · ↑ ${fmtRate(tx)}`;
      state.sparks.net.push(rx + tx);

      // 温度
      $('#mv-temp', root).innerHTML =
        temp !== null && temp !== undefined ? `${temp.toFixed(1)}<span class="unit">°C</span>` : '—';
      const freq = s.cpu?.freq;
      const thr = s.cpu?.throttle;
      $('#mf-temp', root).textContent = freq
        ? `${fmtMhz(freq.averageMhz)}${thr?.throttled ? ' · 降频中' : ''}`
        : '—';
      if (temp) state.sparks.temp.push(temp);

      // 图表
      $('#ov-cpu-sub', root).textContent = `${cpu.toFixed(1)}%`;
      cpuChart.push({ values: { user: s.cpu?.user ?? 0, system: s.cpu?.system ?? 0 } });
      $('#ov-mem-sub', root).textContent = `${fmtBytes(s.memory?.used)}`;
      memChart.push({
        values: { mem: mem, swap: s.memory?.swapPercent ?? 0 },
      });
      netChart.push({ values: { rx: rx, tx: tx } });
      tempChart.push({
        values: {
          cpu: s.sensors?.cpuTemp ?? null,
          gpu: s.sensors?.gpuTemp ?? null,
          nvme: s.sensors?.nvmeTemp ?? null,
        },
      });

      // 各线程（核数 > 32 时自动切换为网格，避免横向溢出）
      const cores = (s.cpu?.perCore || []).map((c) => c.percent);
      const coresTitle = $('#ov-cores-title', root);
      if (coresTitle) {
        coresTitle.textContent = `CPU 各线程使用率（${cpuShortLabel(cpuInfo)}）`;
        coresTitle.title = cpuFullLabel(cpuInfo);
      }
      const coresSub = $('#ov-cores-sub', root);
      if (coresSub) {
        const hints = [];
        if (cpuInfo.smt !== null) hints.push(cpuInfo.smt ? `超线程 ${cpuInfo.perCore || 2} 线程/核` : '无超线程');
        if (cpuInfo.estimated) hints.push('物理核为推算值');
        coresSub.textContent = hints.join(' · ');
      }
      const cc = $('#ov-cores', root);
      if (cc && cores.length) {
        const rendered = renderThreadBars({
          canvas: cc,
          grid: $('#ov-cores-grid', root),
          legend: $('#ov-cores-legend', root),
          values: cores,
          info: cpuInfo,
        });
        if (!rendered.useGrid) Charts.drawBars(cc, cores, { threshold: { warn: 70, crit: 90 } });
      }

      // 系统信息
      if (sys) {
        $('#ov-sysinfo', root).innerHTML = `
          <div class="stat-row"><span class="k">主机名</span><span class="v mono">${escapeHtml(sys.hostname)}</span></div>
          <div class="stat-row"><span class="k">操作系统</span><span class="v">${escapeHtml(sys.osName)}</span></div>
          <div class="stat-row"><span class="k">内核</span><span class="v mono" style="font-size:11.5px">${escapeHtml((sys.kernel || '').split(' ').slice(0, 3).join(' '))}</span></div>
          <div class="stat-row"><span class="k">CPU</span><span class="v" style="font-size:12px">${escapeHtml(sys.cpuModel)}</span></div>
          <div class="stat-row"><span class="k">核心</span><span class="v" title="${escapeHtml(cpuFullLabel(cpuInfo))}">${escapeHtml(cpuPairLabel(cpuInfo))}</span></div>
          <div class="stat-row"><span class="k">内存</span><span class="v">${fmtBytes(sys.memTotal)}</span></div>
          <div class="stat-row"><span class="k">运行时长</span><span class="v">${fmtDuration(s.uptime?.uptimeSeconds)}</span></div>
        `;
      }

      // GPU / 显存（没有 GPU 时整块隐藏，不显示假 0）
      const gpu = s.gpu;
      const gpuAvailable = !!(
        gpu &&
        (gpu.busyPercent != null ||
          gpu.tempC != null ||
          gpu.powerW != null ||
          gpu.model ||
          (gpu.vram && (gpu.vram.total || gpu.vram.used != null)))
      );
      const vramAvailable = !!(gpu && gpu.vram && Number.isFinite(Number(gpu.vram.total)));
      ['#mc-gpu', '#ov-gpu-card'].forEach((sel) => {
        const el = $(sel, root);
        if (el) el.classList.toggle('hidden', !gpuAvailable);
      });
      const vramCard = $('#mc-vram', root);
      if (vramCard) vramCard.classList.toggle('hidden', !vramAvailable);
      if (gpuAvailable) {
        const gpuBusy = gpu.busyPercent ?? 0;
        const vramPct = gpu.vram?.percent ?? 0;

        const elGpu = $('#mv-gpu', root);
        if (elGpu) elGpu.innerHTML = `${gpuBusy}<span class="unit">%</span>`;
        const elGpuF = $('#mf-gpu', root);
        if (elGpuF) {
          elGpuF.textContent = gpu.tempC !== null && gpu.tempC !== undefined
            ? `${gpu.tempC}°C · ${gpu.powerW ?? 0}W`
            : `sclk ${gpu.sclkMhz ?? 0} MHz`;
        }

        if (vramAvailable) {
          const elVram = $('#mv-vram', root);
          if (elVram) elVram.innerHTML = `${vramPct.toFixed(1)}<span class="unit">%</span>`;
          const elVramF = $('#mf-vram', root);
          if (elVramF) elVramF.textContent = `${fmtBytes(gpu.vram.used)} / ${fmtBytes(gpu.vram.total)}`;
          state.sparks.vram.push(vramPct);
        }

        state.sparks.gpu.push(gpuBusy);

        // GPU 详情面板（字段缺失时逐项隐藏，不渲染假 0）
        const gpuHost = $('#ov-gpu', root);
        const modelHost = $('#ov-gpu-model', root);
        if (modelHost) modelHost.textContent = gpu.model || '';
        if (gpuHost) {
          const bar = (label, percent, used, total, color) => `
            <div style="margin-bottom:12px">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
                <span>${label}</span>
                <span class="muted">${fmtBytes(used)} / ${fmtBytes(total)}${Number.isFinite(percent) ? ` · ${percent.toFixed(1)}%` : ''}</span>
              </div>
              <div class="progress">
                <div class="progress-bar" style="width:${Math.max(0.5, Math.min(100, percent || 0))}%;background:${color}"></div>
              </div>
            </div>`;

          const left = [];
          if (gpu.vram && Number.isFinite(gpu.vram.total)) {
            left.push(bar('显存 VRAM', gpu.vram.percent, gpu.vram.used, gpu.vram.total, 'var(--purple)'));
          }
          if (gpu.gtt && Number.isFinite(gpu.gtt.total)) {
            left.push(bar('GTT 共享显存', gpu.gtt.percent, gpu.gtt.used, gpu.gtt.total, 'var(--cyan)'));
          }
          if (gpu.gpuUsagePercent != null && gpuBusy == null) {
            left.push(`<div class="stat-row"><span class="k">GPU 使用率</span><span class="v">${gpu.gpuUsagePercent}%</span></div>`);
          }

          const rows = [];
          const pushRow = (k, v) => {
            if (v !== null && v !== undefined && v !== '') rows.push(`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`);
          };
          if (gpu.busyPercent != null) pushRow('GPU 占用', `${gpu.busyPercent}%`);
          if (gpu.tempC != null) pushRow('温度', `${gpu.tempC} °C`);
          if (gpu.powerW != null) pushRow('功耗', `${gpu.powerW} W`);
          if (gpu.sclkMhz != null) pushRow('核心频率', `${gpu.sclkMhz} MHz`);
          if (gpu.mclkMhz != null) pushRow('显存频率', `${gpu.mclkMhz} MHz`);
          if (gpu.vddgfxMv != null || gpu.vddnbMv != null) {
            pushRow('电压', `${gpu.vddgfxMv ?? '—'} / ${gpu.vddnbMv ?? '—'} mV`);
          }
          if (gpu.fanPercent != null) pushRow('风扇', `${gpu.fanPercent}%`);

          if (!left.length && !rows.length) {
            gpuHost.innerHTML = '<div class="muted" style="font-size:12.5px">未检测到可用的 GPU 指标</div>';
          } else {
            gpuHost.innerHTML = `<div class="grid grid-2" style="margin:0 0 14px">
              <div>${left.join('')}</div>
              <div>${rows.join('')}</div>
            </div>`;
          }
        }
      }

      // 分区
      if (s.filesystems) {
        $('#ov-fs', root).innerHTML = s.filesystems
          .map(
            (f) => `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
              <span class="mono">${escapeHtml(f.mountPoint)}</span>
              <span class="muted">${fmtBytes(f.used)} / ${fmtBytes(f.total)}</span>
            </div>
            <div class="progress">
              <div class="progress-bar ${levelClass(f.usedPercent, 80, 92)}" style="width:${f.usedPercent}%"></div>
            </div>
          </div>`
          )
          .join('');
      }

      // 传感器（没有数据时整块隐藏）
      const allSensors = Array.isArray(s.sensors?.all)
        ? s.sensors.all.slice().sort((a, b) => b.value - a.value)
        : [];
      const sensorsCard = $('#ov-sensors-card', root);
      if (sensorsCard) sensorsCard.classList.toggle('hidden', allSensors.length === 0);
      if (allSensors.length) {
        $('#ov-sensors', root).innerHTML = allSensors
          .map(
            (t) => `
          <div class="stat-row">
            <span class="k">${escapeHtml(t.label)}</span>
            <span class="v"><span class="chip ${t.value >= 80 ? 'crit' : t.value >= 65 ? 'warn' : 'ok'}">${t.value.toFixed(1)} °C</span></span>
          </div>`
          )
          .join('');
      }

      // 温度与频率：没有任何温度/频率数据时隐藏；图例只保留实际有数据的序列
      const hasCpuTemp = s.sensors?.cpuTemp !== null && s.sensors?.cpuTemp !== undefined;
      const hasGpuTemp = s.sensors?.gpuTemp !== null && s.sensors?.gpuTemp !== undefined;
      const hasNvmeTemp = s.sensors?.nvmeTemp !== null && s.sensors?.nvmeTemp !== undefined;
      const hasFreq = !!(s.cpu?.freq && (s.cpu.freq.averageMhz || s.cpu.freq.maxMhz));
      const tempCard = $('#ov-temp-card', root);
      if (tempCard) tempCard.classList.toggle('hidden', !(hasCpuTemp || hasGpuTemp || hasNvmeTemp || hasFreq));
      const tempSub = $('#ov-temp-sub', root);
      if (tempSub) {
        const bits = [];
        if (hasCpuTemp) bits.push(`CPU ${s.sensors.cpuTemp}°C`);
        if (hasGpuTemp) bits.push(`GPU ${s.sensors.gpuTemp}°C`);
        if (hasNvmeTemp) bits.push(`NVMe ${s.sensors.nvmeTemp}°C`);
        if (hasFreq) bits.push(fmtMhz(s.cpu.freq.averageMhz));
        tempSub.textContent = bits.join(' · ');
      }
      const tempSig = `${hasCpuTemp}|${hasGpuTemp}|${hasNvmeTemp}|${hasFreq}`;
      const tempLegend = $('#ov-temp-legend', root);
      if (tempLegend && tempSig !== lastTempSignature) {
        lastTempSignature = tempSig;
        const items = [];
        if (hasCpuTemp) items.push({ n: 'CPU', c: 'var(--red)' });
        if (hasGpuTemp) items.push({ n: 'GPU', c: 'var(--orange)' });
        if (hasNvmeTemp) items.push({ n: 'NVMe', c: 'var(--purple)' });
        if (!items.length && hasFreq) items.push({ n: '频率（右侧参考）', c: 'var(--accent)' });
        tempLegend.innerHTML = items
          .map(
            (it) =>
              `<span class="legend-item"><span class="legend-swatch" style="background:${it.c}"></span>${it.n}</span>`
          )
          .join('');
      }
    }
  }

  /* ======================================================================
     页面：实时图表
     ====================================================================== */
  async function renderRealtime(root) {
    const METRICS = [
      { key: 'cpu', name: 'CPU 使用率', unit: '%', color: '#2f81f7', max: 100 },
      { key: 'mem', name: '内存使用率', unit: '%', color: '#a371f7', max: 100 },
      { key: 'temp', name: 'CPU 温度', unit: '°C', color: '#f85149', max: null },
      { key: 'load', name: '负载 (1m)', unit: '', color: '#39c5cf', max: null },
      { key: 'netIn', name: '网络下行', unit: 'B/s', color: '#3fb950', max: null },
      { key: 'netOut', name: '网络上行', unit: 'B/s', color: '#db6d28', max: null },
      { key: 'diskRead', name: '磁盘读', unit: 'B/s', color: '#58a6ff', max: null },
      { key: 'diskWrite', name: '磁盘写', unit: 'B/s', color: '#d29922', max: null },
    ];

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>实时指标</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="rt-unit-hint"></span>
          <span class="card-sub">每秒刷新 · 最近 2 分钟</span>
        </div>
        <div class="chart-wrap chart-lg"><canvas id="rt-chart"></canvas></div>
        <div class="legend" id="rt-legend"></div>
        <div class="muted" style="font-size:11.5px;margin-top:6px">点击图例可切换指标；同一坐标轴内建议只保留同单位指标</div>
      </div>
      <div class="grid grid-2">
        <div class="card" id="rt-cores-card">
          <div class="card-head">
            <h3 id="rt-cores-title">CPU 各线程使用率</h3>
            <span class="spacer"></span>
            <span class="card-sub" id="rt-cores-sub"></span>
          </div>
          <div class="chart-wrap" style="height:120px"><canvas id="rt-cores"></canvas></div>
          <div class="core-grid hidden" id="rt-cores-grid"></div>
          <div class="legend" id="rt-cores-legend"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>压力指标 PSI</h3></div>
          <div id="rt-psi"></div>
        </div>
      </div>
    `;

    // 默认只显示百分比类指标，避免不同单位挤在同一坐标轴
    const visible = new Set(['cpu', 'mem']);
    // 默认两项都是百分比 → 固定 0-100 轴，读数才准确
    const chart = new Charts.LineChart($('#rt-chart', root), {
      series: METRICS.filter((m) => visible.has(m.key)).map((m) => ({
        key: m.key,
        name: m.name,
        color: m.color,
      })),
      yMax: 100,
      maxPoints: 120,
    });
    state.charts.realtime = chart;

    // 图例（可点击切换）
    const legend = $('#rt-legend', root);
    legend.innerHTML = METRICS.map(
      (m) => `
      <span class="legend-item ${visible.has(m.key) ? '' : 'off'}" data-key="${m.key}">
        <span class="legend-swatch" style="background:${m.color}"></span>${m.name}
      </span>`
    ).join('');

    const unitHint = $('#rt-unit-hint', root);

    legend.addEventListener('click', (e) => {
      const item = e.target.closest('.legend-item');
      if (!item) return;
      const key = item.dataset.key;
      if (visible.has(key)) {
        if (visible.size <= 1) return; // 至少保留一条
        visible.delete(key);
        item.classList.add('off');
      } else {
        visible.add(key);
        item.classList.remove('off');
      }
      const shown = METRICS.filter((m) => visible.has(m.key));
      chart.opts.series = shown.map((m) => ({ key: m.key, name: m.name, color: m.color }));
      // 全部同单位时固定为 100%，否则自动缩放
      const units = new Set(shown.map((m) => m.unit));
      chart.opts.yMax = units.size === 1 && units.has('%') ? 100 : null;
      chart.draw();
      if (unitHint) {
        if (units.size > 1) {
          unitHint.innerHTML =
            `<span class="chip warn">混合单位</span> ` +
            [...units].map((u) => u || '数值').join(' / ') +
            ' 共用同一坐标轴，读数仅供参考';
        } else {
          unitHint.textContent = '';
        }
      }
    });

    // 回填
    const hist = state.historyPoints;
    chart.setData(
      hist.map((p) => ({
        values: { cpu: p.cpu, mem: p.mem, temp: p.cpuTemp },
      }))
    );

    PAGE_UPDATERS.realtime = (s) => {
      const netIn = s.network?.interfaces?.reduce((a, n) => a + n.rxBytesPerSec, 0) ?? 0;
      const netOut = s.network?.interfaces?.reduce((a, n) => a + n.txBytesPerSec, 0) ?? 0;
      const diskRead = s.disks?.reduce((a, d) => a + d.readBytesPerSec, 0) ?? 0;
      const diskWrite = s.disks?.reduce((a, d) => a + d.writeBytesPerSec, 0) ?? 0;

      chart.push({
        values: {
          cpu: s.cpu?.percent ?? 0,
          mem: s.memory?.usedPercent ?? 0,
          temp: s.sensors?.cpuTemp ?? null,
          load: s.load?.load1 ?? 0,
          netIn,
          netOut,
          diskRead,
          diskWrite,
        },
      });

      const rtInfo = getCpuInfo(s, state.system);
      const cores = (s.cpu?.perCore || []).map((c) => c.percent);
      const rtTitle = $('#rt-cores-title', root);
      if (rtTitle) {
        rtTitle.textContent = `CPU 各线程使用率（${cpuShortLabel(rtInfo)}）`;
        rtTitle.title = cpuFullLabel(rtInfo);
      }
      const rtSub = $('#rt-cores-sub', root);
      if (rtSub) {
        const bits = [];
        if (rtInfo.smt !== null) bits.push(rtInfo.smt ? `超线程 ${rtInfo.perCore || 2} 线程/核` : '无超线程');
        if (rtInfo.estimated) bits.push('物理核为推算值');
        rtSub.textContent = bits.join(' · ');
      }
      const cc = $('#rt-cores', root);
      if (cc && cores.length) {
        const rendered = renderThreadBars({
          canvas: cc,
          grid: $('#rt-cores-grid', root),
          legend: $('#rt-cores-legend', root),
          values: cores,
          info: rtInfo,
        });
        if (!rendered.useGrid) Charts.drawBars(cc, cores, { threshold: { warn: 70, crit: 90 } });
      }

      // PSI
      const psi = s.pressure || {};
      const rows = [
        { name: 'CPU', data: psi.cpu?.some },
        { name: '内存', data: psi.memory?.some },
        { name: 'IO', data: psi.io?.some },
      ];
      $('#rt-psi', root).innerHTML = rows
        .map(
          (r) => `
        <div class="stat-row">
          <span class="k">${r.name} some</span>
          <span class="v">${r.data ? `${r.data.avg10.toFixed(2)} / ${r.data.avg60.toFixed(2)} / ${r.data.avg300.toFixed(2)}` : '不可用'}</span>
        </div>`
        )
        .join('') +
        `<div style="font-size:11.5px;color:var(--text-faint);margin-top:10px">数值为 avg10 / avg60 / avg300，单位 %，表示资源争抢导致任务等待的时间占比</div>`;
    };
  }


  /* ======================================================================
     页面：CPU 详情（每线程）
     ====================================================================== */
  async function renderCpuDetail(root) {
    root.innerHTML = `
      <div class="grid grid-cards" id="cpu-cards"></div>

      <div class="card">
        <div class="card-head">
          <h3 id="cpu-cores-title">每线程占用</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="cpu-core-sub"></span>
        </div>
        <div class="chart-wrap" style="height:150px"><canvas id="cpu-cores-bars"></canvas></div>
        <div class="core-grid hidden" id="cpu-cores-grid"></div>
        <div class="legend" id="cpu-cores-legend"></div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>每线程频率 (MHz)</h3></div>
          <div class="chart-wrap" style="height:130px"><canvas id="cpu-freq-bars"></canvas></div>
          <div class="core-grid hidden" id="cpu-freq-grid"></div>
          <div class="legend" id="cpu-freq-legend"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>CPU 概况</h3></div>
          <div id="cpu-summary"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>线程明细</h3>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="cpu-refresh">刷新</button>
        </div>
        <div id="cpu-table"></div>
      </div>
    `;

    let latest = null;

    function draw() {
      if (!latest) return;
      const cores = latest.cpu.perCore || [];
      const percents = cores.map((c) => c.percent || 0);
      const freqs = cores.map((c) => c.mhz || 0);
      const info = getCpuInfo(latest, state.system);

      const coresTitle = $('#cpu-cores-title', root);
      if (coresTitle) coresTitle.textContent = `每线程占用（${cpuCompactLabel(info)}）`;

      // 占用柱状图（线程多时切换为网格）
      const barCanvas = $('#cpu-cores-bars', root);
      if (barCanvas && cores.length) {
        const rendered = renderThreadBars({
          canvas: barCanvas,
          grid: $('#cpu-cores-grid', root),
          legend: $('#cpu-cores-legend', root),
          values: percents,
          info,
        });
        if (!rendered.useGrid) Charts.drawBars(barCanvas, percents, { threshold: { warn: 70, crit: 90 } });
      }

      // 频率柱状图
      const freqCanvas = $('#cpu-freq-bars', root);
      if (freqCanvas && freqs.length) {
        const maxF = Math.max(...freqs, 1);
        const normalized = freqs.map((f) => (f / maxF) * 100);
        const freqRendered = renderThreadBars({
          canvas: freqCanvas,
          grid: $('#cpu-freq-grid', root),
          legend: null,
          values: normalized,
          info,
        });
        if (!freqRendered.useGrid) Charts.drawBars(freqCanvas, normalized, { color: cssVarAccent(root) });
      }

      $('#cpu-core-sub', root).textContent =
        `${cpuShortLabel(info)} · ${cores.length} 线程 · 平均 ${(percents.reduce((a, b) => a + b, 0) / Math.max(1, percents.length)).toFixed(1)}%`;

      // 顶部卡片
      const busyCores = percents.filter((p) => p > 50).length;
      const idleCores = percents.filter((p) => p < 5).length;
      const avgFreq = freqs.filter(Boolean).reduce((a, b) => a + b, 0) / Math.max(1, freqs.filter(Boolean).length);
      const maxPct = percents.length ? Math.max(...percents) : 0;

      const cardDefs = [
        { label: '最高线程占用', value: `${maxPct.toFixed(1)}%`, color: 'var(--red)' },
        { label: '平均频率', value: `${avgFreq.toFixed(0)} MHz`, color: 'var(--accent)' },
        { label: '高负载线程 (>50%)', value: `${busyCores} / ${cores.length}`, color: 'var(--yellow)' },
        { label: '空闲线程 (<5%)', value: `${idleCores} / ${cores.length}`, color: 'var(--green)' },
      ];
      if (latest.cpu.temp != null) {
        cardDefs.push({ label: 'CPU 温度', value: `${latest.cpu.temp} °C`, color: 'var(--orange)' });
      }
      if (latest.cpu.throttle && typeof latest.cpu.throttle.throttled === 'boolean') {
        cardDefs.push({
          label: '降频状态',
          value: latest.cpu.throttle.throttled ? '降频中' : '正常',
          color: latest.cpu.throttle.throttled ? 'var(--red)' : 'var(--green)',
        });
      }
      $('#cpu-cards', root).innerHTML = cardDefs
        .map(
          (c) => `
        <div class="card metric-card">
          <div class="metric-top"><div class="metric-label">${c.label}</div></div>
          <div class="metric-value" style="color:${c.color};font-size:22px">${c.value}</div>
        </div>`
        )
        .join('');

      const maxFreq = Math.max(...freqs, 1);
      $('#cpu-freq-legend', root).innerHTML =
        `<span class="legend-item">最高 <b>${maxFreq.toFixed(0)} MHz</b></span>` +
        `<span class="legend-item">最低 <b>${Math.min(...freqs).toFixed(0)} MHz</b></span>`;

      // 概况
      const f = latest.cpu.freq || {};
      $('#cpu-summary', root).innerHTML = `
        <div class="stat-row"><span class="k">总占用</span><span class="v">${(latest.cpu.percent || 0).toFixed(1)} %</span></div>
        <div class="stat-row"><span class="k">用户态</span><span class="v">${(latest.cpu.user || 0).toFixed(1)} %</span></div>
        <div class="stat-row"><span class="k">系统态</span><span class="v">${(latest.cpu.system || 0).toFixed(1)} %</span></div>
        <div class="stat-row"><span class="k">IO 等待</span><span class="v">${(latest.cpu.iowait || 0).toFixed(1)} %</span></div>
        <div class="stat-row"><span class="k">空闲</span><span class="v">${(latest.cpu.idle || 0).toFixed(1)} %</span></div>
        <div class="stat-row"><span class="k">频率调节器</span><span class="v mono">${escapeHtml(f.governor || '—')}</span></div>
        <div class="stat-row"><span class="k">频率范围</span><span class="v">${(f.minMhz || 0).toFixed(0)} ~ ${(f.maxMhz || 0).toFixed(0)} MHz</span></div>
        <div class="stat-row"><span class="k">当前平均</span><span class="v">${(f.averageMhz || 0).toFixed(0)} MHz（最大值的 ${latest.cpu.throttle?.percentOfMax ?? 0}%）</span></div>
        <div class="stat-row"><span class="k">物理 / 逻辑核心</span><span class="v">${info.physical ?? '—'} 核 / ${info.threads || cores.length} 线程</span></div>
        <div class="stat-row"><span class="k">线程 / 核</span><span class="v">${info.perCore ?? '—'}</span></div>
        <div class="stat-row"><span class="k">超线程</span><span class="v">${info.smt === null ? '未知' : info.smt ? '是' : '否'}</span></div>
        ${info.estimated ? '<div class="stat-row"><span class="k">物理核来源</span><span class="v muted">推算值（非硬件实测）</span></div>' : ''}
      `;

      // 明细表
      $('#cpu-table', root).innerHTML = `
        <div class="table-wrap scroll-y" style="max-height:46vh;overflow-y:auto">
          <table class="data">
            <thead>
              <tr>
                <th>逻辑核（线程）</th><th class="num">使用率</th><th class="num">用户</th>
                <th class="num">系统</th><th class="num">IO 等待</th><th class="num">空闲</th>
                <th class="num">频率</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${cores
                .map((c) => {
                  const lvl = c.percent >= 90 ? 'crit' : c.percent >= 70 ? 'warn' : 'ok';
                  const status = c.percent >= 90 ? '满载' : c.percent >= 70 ? '繁忙' : c.percent >= 20 ? '活跃' : '空闲';
                  return `
                <tr>
                  <td class="mono">线程 ${c.index}</td>
                  <td class="num"><span class="chip ${lvl}">${(c.percent || 0).toFixed(1)}%</span></td>
                  <td class="num">${(c.user || 0).toFixed(1)}%</td>
                  <td class="num">${(c.system || 0).toFixed(1)}%</td>
                  <td class="num">${(c.iowait || 0).toFixed(1)}%</td>
                  <td class="num muted">${(c.idle || 0).toFixed(1)}%</td>
                  <td class="num">${c.mhz ? c.mhz.toFixed(0) + ' MHz' : '—'}</td>
                  <td class="muted">${status}</td>
                </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="muted" style="margin-top:10px;font-size:12px">
          数据每秒刷新。${escapeHtml(cpuFullLabel(info))} · ${cores.length} 个逻辑线程
        </div>
      `;
    }

    PAGE_UPDATERS.cpudetail = (snap) => {
      latest = snap;
      draw();
    };

    $('#cpu-refresh', root).addEventListener('click', async () => {
      try {
        const d = await api('/api/cpu/cores');
        latest = state.latest || { cpu: { perCore: d.cores, freq: d.freq, throttle: d.throttle, temp: d.temp, percent: 0 } };
        draw();
        toast('已刷新', 'ok', 1500);
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    if (state.latest) {
      latest = state.latest;
      draw();
    }
  }

  /** 读取主题色，供画布使用 */
  function cssVarAccent(root) {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2f81f7';
  }

  /* ======================================================================
     页面：历史回看
     ====================================================================== */
  async function renderHistory(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>历史趋势</h3>
          <span class="spacer"></span>
          <div class="seg" id="hist-range">
            <button class="btn btn-sm active" data-hours="1">1 小时</button>
            <button class="btn btn-sm" data-hours="6">6 小时</button>
            <button class="btn btn-sm" data-hours="24">24 小时</button>
            <button class="btn btn-sm" data-hours="168">7 天</button>
          </div>
        </div>
        <div class="chart-wrap chart-lg"><canvas id="hist-cpu"></canvas></div>
        <div id="hist-hint" class="hidden" style="font-size:12.5px;color:var(--text-dim);margin-top:8px"></div>
        <div class="legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#2f81f7"></span>CPU %</span>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>内存使用率</h3></div>
          <div class="chart-wrap"><canvas id="hist-mem"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>CPU 温度</h3></div>
          <div class="chart-wrap"><canvas id="hist-temp"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>区间统计</h3></div>
        <div id="hist-stats"><div class="muted">加载中…</div></div>
      </div>
    `;

    const cpuChart = new Charts.LineChart($('#hist-cpu', root), {
      series: [{ key: 'cpu', name: 'CPU', color: 'var(--accent)' }],
      yMax: 100,
      maxPoints: 300,
    });
    const memChart = new Charts.LineChart($('#hist-mem', root), {
      series: [{ key: 'mem', name: '内存', color: 'var(--purple)' }],
      yMax: 100,
      maxPoints: 300,
    });
    const tempChart = new Charts.LineChart($('#hist-temp', root), {
      series: [{ key: 'temp', name: '温度', color: 'var(--red)' }],
      maxPoints: 300,
    });

    async function load(hours) {
      const to = Date.now();
      const from = to - hours * 3600 * 1000;
      try {
        const data = await api(`/api/metrics/history?from=${from}&to=${to}&points=300`);
        const pts = data.points || [];
        cpuChart.setData(pts.map((p) => ({ at: p.ts, values: { cpu: p.cpu } })));
        memChart.setData(pts.map((p) => ({ at: p.ts, values: { mem: p.mem_percent } })));
        tempChart.setData(pts.map((p) => ({ at: p.ts, values: { temp: p.cpu_temp } })));

        const insufficient = pts.length < 2;
        const hint = $('#hist-hint', root);
        if (hint) {
          if (insufficient) {
            hint.innerHTML =
              '<span class="chip warn">数据不足</span> 该时段只有 ' + pts.length +
              ' 个采样点（每分钟聚合一次），曲线需至少 2 个点才能绘制。换更长的时间范围，或稍后再看。';
            hint.classList.remove('hidden');
          } else {
            hint.classList.add('hidden');
          }
        }

        const st = data.stats;
        if (st && st.count > 0) {
          const fmt = (o, unit = '') =>
            o ? `${o.min.toFixed(1)}${unit} / ${o.avg.toFixed(1)}${unit} / ${o.max.toFixed(1)}${unit}` : '—';
          $('#hist-stats', root).innerHTML = `
            <div class="stat-row"><span class="k">样本数</span><span class="v">${st.count}</span></div>
            <div class="stat-row"><span class="k">CPU（最小/平均/最大）</span><span class="v">${fmt(st.cpu, '%')}</span></div>
            <div class="stat-row"><span class="k">内存（最小/平均/最大）</span><span class="v">${fmt(st.mem, '%')}</span></div>
            <div class="stat-row"><span class="k">CPU 温度（最小/平均/最大）</span><span class="v">${fmt(st.cpuTemp, '°C')}</span></div>
            <div class="stat-row"><span class="k">负载 1m（最小/平均/最大）</span><span class="v">${fmt(st.load1)}</span></div>
          `;
        } else {
          $('#hist-stats', root).innerHTML =
            '<div class="muted">该时段暂无数据。数据每分钟聚合一条，运行一段时间后即有记录。</div>';
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    }

    $('#hist-range', root).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-hours]');
      if (!btn) return;
      $$('#hist-range button', root).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      load(Number(btn.dataset.hours));
    });

    await load(1);
  }

  /* ======================================================================
     页面：进程
     ====================================================================== */
  /** 前端保护：1 号进程 / 面板自身进程树（后端 helper 也会二次拒绝） */
  function isProtectedProcess(proc) {
    const pid = Number(proc && proc.pid);
    if (!Number.isFinite(pid) || pid <= 1) return true;
    const cmd = String((proc && proc.cmdline) || '');
    return /server\.js|panel-helper\.js/.test(cmd);
  }

  async function renderProcess(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>进程列表</h3>
          <span class="spacer"></span>
          <select id="proc-sort" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
            <option value="cpu">按 CPU 排序</option>
            <option value="mem">按内存排序</option>
            <option value="pid">按 PID 排序</option>
          </select>
          <input type="text" id="proc-filter" placeholder="搜索进程名 / PID / 用户 / 命令行…"
                 style="width:240px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
          <button class="btn btn-sm" id="proc-refresh">刷新</button>
        </div>
        <div id="proc-host-banner"></div>
        <div id="proc-summary" class="muted" style="font-size:12px;margin-bottom:10px"></div>
        <div id="proc-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>CPU / 内存占用 Top 10</h3></div>
        <div class="chart-wrap" style="height:130px"><canvas id="proc-bars"></canvas></div>
        <div class="legend" id="proc-bars-legend"></div>
      </div>
    `;

    let lastData = null;

    async function load() {
      const sort = $('#proc-sort', root)?.value || 'cpu';
      const filter = $('#proc-filter', root)?.value.trim() || '';
      try {
        await loadHostStatus();
        $('#proc-host-banner', root).innerHTML = hostBannerHtml();
        const qs = new URLSearchParams({ sort, limit: '400' });
        if (filter) qs.set('filter', filter);
        const data = await api('/api/processes?' + qs.toString());
        lastData = data;

        const procs = data.processes || [];
        $('#proc-summary', root).textContent =
          `系统进程总数 ${data.total} · 匹配 ${data.matched ?? procs.length} · 显示 ${procs.length} · 排序方式：${
            { cpu: 'CPU', mem: '内存', pid: 'PID' }[data.sort] || data.sort
          }`;

        if (procs.length === 0) {
          $('#proc-body', root).innerHTML = '<div class="placeholder"><p>没有匹配的进程</p></div>';
          return;
        }

        $('#proc-body', root).innerHTML = `
          <div class="table-wrap scroll-y" style="max-height:60vh;overflow-y:auto">
            <table class="data">
              <thead>
                <tr>
                  <th>PID</th><th>进程名</th><th class="num">CPU%</th>
                  <th class="num">内存</th><th>状态</th><th>用户</th><th>命令行</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${procs
                  .map(
                    (p) => `
                  <tr>
                    <td class="mono">${p.pid}</td>
                    <td class="mono">${escapeHtml(p.comm)}</td>
                    <td class="num">${(p.cpuPercent ?? 0).toFixed(1)}</td>
                    <td class="num">${fmtBytes(p.rssBytes)}</td>
                    <td><span class="chip ${p.state === 'R' ? 'ok' : p.state === 'Z' ? 'crit' : ''}">${escapeHtml(p.state)}</span></td>
                    <td class="muted">${escapeHtml(p.user || '—')}</td>
                    <td class="mono muted" style="font-size:11.5px;max-width:340px;overflow:hidden;text-overflow:ellipsis"
                        title="${escapeHtml(p.cmdline || '')}">${escapeHtml((p.cmdline || '').slice(0, 80))}</td>
                    <td>
                      ${isProtectedProcess(p)
                        ? '<button class="btn btn-sm" type="button" disabled title="1 号进程 / 面板自身进程受保护">结束</button>'
                        : `<button class="btn btn-sm btn-danger" type="button" data-kill-pid="${p.pid}"${hostOk() ? '' : ' disabled'}>结束</button>`}
                    </td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `;

        drawTopBars();
      } catch (e) {
        $('#proc-body', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    /** 用资源占比画 Top 10 柱状图 */
    function drawTopBars() {
      const canvas = $('#proc-bars', root);
      if (!canvas || !lastData) return;
      const top = (lastData.processes || []).slice(0, 10);
      const vals = top.map((p) => p.cpuPercent || 0);

      Charts.drawBars(canvas, vals, { threshold: { warn: 25, crit: 60 } });

      $('#proc-bars-legend', root).innerHTML = top
        .map(
          (p, i) =>
            `<span class="legend-item" title="${escapeHtml(p.cmdline || '')}">${i + 1}. ${escapeHtml(
              p.comm.slice(0, 14)
            )} <b>${(p.cpuPercent || 0).toFixed(1)}%</b></span>`
        )
        .join('');
    }

    $('#proc-sort', root).addEventListener('change', load);
    $('#proc-filter', root).addEventListener('input', debounce(load, 300));
    $('#proc-refresh', root).addEventListener('click', load);
    $('#proc-body', root).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-kill-pid]');
      if (!btn) return;
      if (!hostOk()) {
        toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
        return;
      }
      const pid = Number(btn.dataset.killPid);
      const proc = ((lastData && lastData.processes) || []).find((x) => x.pid === pid);
      if (!proc) return;
      openHostConfirmModal({
        title: '结束进程',
        bodyHtml: `<div class="notice">确定结束该进程？强制结束（KILL）可能导致数据丢失。</div>
          <div class="stat-row"><span class="k">PID</span><span class="v mono">${proc.pid}</span></div>
          <div class="stat-row"><span class="k">进程</span><span class="v mono">${escapeHtml(proc.comm || '')}</span></div>
          <div class="stat-row"><span class="k">用户</span><span class="v">${escapeHtml(proc.user || '—')}</span></div>
          <p class="mono muted" style="font-size:11.5px;overflow-wrap:anywhere;margin:8px 0 14px">${escapeHtml(proc.cmdline || '')}</p>
          <label class="field"><span>信号</span>
            <select id="host-kill-signal">
              <option value="TERM">TERM（温和，推荐）</option>
              <option value="KILL">KILL（强制）</option>
            </select>
          </label>`,
        confirmText: '结束进程',
        onConfirm: async () => {
          const signalEl = document.querySelector('#host-kill-signal');
          const signal = (signalEl && signalEl.value) || 'TERM';
          await api('/api/host/process/kill', { method: 'POST', body: { pid, signal } });
          toast(`已发送 ${signal} 到 PID ${pid}`, 'ok');
          await load();
        },
      });
    });

    // resize 重绘柱状图；离开页面时移除监听
    const onResize = () => drawTopBars();
    window.addEventListener('resize', onResize);
    state.cleanups.push(() => window.removeEventListener('resize', onResize));

    await load();
  }

  /* ======================================================================
     页面：磁盘
     ====================================================================== */
  async function renderDisk(root) {
    root.innerHTML = `
      <div class="card" id="smart-card">
        <div class="card-head">
          <h3>磁盘健康 (SMART)</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="smart-sub"></span>
          <button class="btn btn-sm" id="smart-refresh">刷新</button>
        </div>
        <div id="disk-smart"><div class="muted">加载中…</div></div>
      </div>

      <div class="card" id="disks-card">
        <div class="card-head">
          <h3>物理磁盘</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="disk-summary"></span>
          <button class="btn btn-sm" id="disk-refresh">刷新</button>
        </div>
        <div id="disk-devices-info"><div class="muted">加载中…</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>磁盘分区用量</h3></div>
        <div id="disk-fs"><div class="muted">加载中…</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>磁盘 IO 实时</h3></div>
        <div class="chart-wrap chart-lg"><canvas id="disk-io-chart"></canvas></div>
        <div class="legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#58a6ff"></span>读</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#d29922"></span>写</span>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>设备 IO 明细</h3>
          <span class="spacer"></span>
          <span class="card-sub">每秒刷新</span>
        </div>
        <div id="disk-devices"><div class="muted">等待数据…</div></div>
      </div>
    `;

    const ioChart = new Charts.LineChart($('#disk-io-chart', root), {
      series: [
        { key: 'read', name: '读', color: '#58a6ff' },
        { key: 'write', name: '写', color: '#d29922' },
      ],
      maxPoints: 120,
    });
    state.charts.diskIo = ioChart;

    // 磁盘静态信息
    let diskInfo = [];

    async function loadDiskInfo() {
      try {
        const d = await api('/api/disks/info');
        diskInfo = d.disks || [];

        const total = diskInfo.reduce((a, x) => a + x.size, 0);
        const hdd = diskInfo.filter((x) => x.rotational).length;
        $('#disk-summary', root).textContent =
          `${diskInfo.length} 块磁盘 · 合计 ${fmtBytes(total)} · 机械盘 ${hdd} 块`;

        const disksCard = $('#disks-card', root);
        if (diskInfo.length === 0) {
          if (disksCard) disksCard.classList.add('hidden');
          return;
        }
        if (disksCard) disksCard.classList.remove('hidden');

        $('#disk-devices-info', root).innerHTML = diskInfo
          .map((d) => {
            const kindChip =
              d.kind === 'HDD' ? 'warn' : d.kind === 'NVMe' ? 'info' : 'ok';
            const parts = (d.partitions || []).length
              ? d.partitions
                  .map(
                    (p) => `
                <div class="stat-row">
                  <span class="k mono">${escapeHtml(p.device)}</span>
                  <span class="v muted" style="font-size:12px">
                    ${fmtBytes(p.size)}
                    ${p.fstype ? ` · ${escapeHtml(p.fstype)}` : ''}
                    ${p.mounted ? ` · 挂载于 <span class="mono">${escapeHtml(p.mountPoint)}</span>` : ' · 未挂载'}
                  </span>
                </div>`
                  )
                  .join('')
              : '<div class="muted" style="font-size:12px">无分区</div>';

            return `
            <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
                <span class="mono" style="font-weight:600;font-size:14px">${escapeHtml(d.name)}</span>
                <span class="chip ${kindChip}">${escapeHtml(d.kindLabel)}</span>
                <span class="chip ${d.mounted ? 'ok' : ''}">${d.mounted ? '已挂载' : '未挂载'}</span>
                <span class="muted" style="font-size:12px">${escapeHtml(d.model.trim())}</span>
                <span class="spacer" style="margin-left:auto"></span>
                <span class="mono muted" style="font-size:12.5px">${d.sizeHuman}</span>
              </div>
              <div class="grid grid-2" style="margin:0">
                <div>
                  <div class="stat-row"><span class="k">序列号</span><span class="v mono" style="font-size:12px">${escapeHtml(d.serial || '—')}</span></div>
                  <div class="stat-row"><span class="k">固件版本</span><span class="v mono" style="font-size:12px">${escapeHtml(d.firmware || '—')}</span></div>
                  <div class="stat-row"><span class="k">调度器</span><span class="v mono">${escapeHtml(d.scheduler || '—')}</span></div>
                  <div class="stat-row"><span class="k">块大小</span><span class="v">物理 ${d.physicalBlockSize || '—'} / 逻辑 ${d.logicalBlockSize || '—'}</span></div>
                </div>
                <div>
                  <div class="stat-row"><span class="k">类型</span><span class="v">${d.rotational ? '旋转盘（机械）' : '非旋转盘（固态）'}</span></div>
                  <div class="stat-row"><span class="k">状态</span><span class="v">${escapeHtml(d.state || '—')}</span></div>
                  <div class="stat-row"><span class="k">队列深度</span><span class="v">${d.queueDepth || '—'}</span></div>
                  <div class="stat-row"><span class="k">预读</span><span class="v">${d.readAheadKB} KB</span></div>
                </div>
              </div>
              <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-soft)">
                <div class="muted" style="font-size:11.5px;margin-bottom:4px">分区</div>
                ${parts}
              </div>
            </div>`;
          })
          .join('');


      } catch (e) {
        $('#disk-devices-info', root).innerHTML =
          `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    // ---- SMART 健康数据 ----
    async function loadSmart(force = false) {
      const host = $('#disk-smart', root);
      if (!host) return;
      if (force) host.innerHTML = '<div class="muted">正在读取 SMART（机械盘需唤醒，约 2-5 秒）…</div>';
      try {
        const d = await api('/api/disks/smart' + (force ? '?force=1' : ''));
        const smartCard = $('#smart-card', root);
        if (!d.available || !(d.disks || []).length) {
          // 没有 SMART 能力/磁盘时整块隐藏，不展示权限/路径等本机细节
          if (smartCard) smartCard.classList.add('hidden');
          return;
        }
        if (smartCard) smartCard.classList.remove('hidden');

        const disks = d.disks || [];
        const okCount = disks.filter((x) => x.available && x.health?.passed).length;
        $('#smart-sub', root).textContent = `${disks.length} 块磁盘 · ${okCount} 块通过自检`;

        const fmtHours = (h) => {
          if (h == null) return '—';
          const d = Math.floor(h / 24);
          return `${h.toLocaleString()} 小时${d >= 1 ? `（${d} 天）` : ''}`;
        };
        const sevChip = (sev) =>
          sev === 'crit' ? '<span class="chip crit">异常</span>'
          : sev === 'warn' ? '<span class="chip warn">注意</span>'
          : '<span class="chip ok">良好</span>';

        host.innerHTML = disks.map((x) => {
          if (!x.available) {
            return `
              <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
                <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
                  <span class="mono" style="font-weight:600">${escapeHtml(x.name)}</span>
                  <span class="chip">读取失败</span>
                </div>
                <div class="muted" style="font-size:12px">${escapeHtml(x.error || '')}</div>
              </div>`;
          }

          const rows = [];
          rows.push(['健康状态', `<span class="chip ${x.health.passed ? 'ok' : 'crit'}">${escapeHtml(x.health.text)}</span> ${sevChip(x.severity)}`]);
          if (x.temperature != null) rows.push(['温度', `${x.temperature} °C`]);
          if (x.powerOnHours != null) rows.push(['通电时长', fmtHours(x.powerOnHours)]);

          if (x.ata && ['reallocatedSectors', 'pendingSectors', 'offlineUncorrectable', 'udmaCrcErrors', 'startStopCount', 'selfTestStatus']
            .some((k) => x.ata[k] !== null && x.ata[k] !== undefined)) {
            const a = x.ata;
            rows.push(['重映射扇区', `<span class="chip ${a.reallocatedSectors > 0 ? 'crit' : 'ok'}">${a.reallocatedSectors ?? '—'}</span>`]);
            rows.push(['待映射扇区', `<span class="chip ${a.pendingSectors > 0 ? 'crit' : 'ok'}">${a.pendingSectors ?? '—'}</span>`]);
            rows.push(['不可校正扇区', `<span class="chip ${a.offlineUncorrectable > 0 ? 'crit' : 'ok'}">${a.offlineUncorrectable ?? '—'}</span>`]);
            rows.push(['CRC 校验错误', `<span class="chip ${a.udmaCrcErrors > 0 ? 'warn' : 'ok'}">${a.udmaCrcErrors ?? '—'}</span>`]);
            rows.push(['启停次数', a.startStopCount ?? '—']);
            if (a.selfTestStatus) rows.push(['最近自检', escapeHtml(a.selfTestStatus)]);
          }
          if (x.nvme && ['percentageUsed', 'availableSpare', 'dataUnitsWritten', 'mediaErrors', 'unsafeShutdowns']
            .some((k) => x.nvme[k] !== null && x.nvme[k] !== undefined)) {
            const n = x.nvme;
            if (n.percentageUsed != null) rows.push(['寿命已用', `<span class="chip ${n.percentageUsed >= 80 ? 'warn' : 'ok'}">${n.percentageUsed}%</span>`]);
            if (n.availableSpare != null) {
              rows.push(['可用备用', `${n.availableSpare}%${n.availableSpareThreshold != null ? ` (阈值 ${n.availableSpareThreshold}%)` : ''}`]);
            }
            if (n.dataUnitsWritten != null) rows.push(['累计写入', fmtBytes(n.dataUnitsWritten)]);
            if (n.mediaErrors != null) rows.push(['媒体错误', `<span class="chip ${n.mediaErrors > 0 ? 'crit' : 'ok'}">${n.mediaErrors}</span>`]);
            if (n.unsafeShutdowns != null) rows.push(['异常断电', n.unsafeShutdowns]);
          }
          if (x.model || x.serial) {
            rows.push([
              '型号 / 序列号',
              `<span class="mono" style="font-size:11.5px">${escapeHtml(x.model || '—')}${x.serial ? ` / ${escapeHtml(x.serial)}` : ''}</span>`,
            ]);
          }

          return `
            <div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px">
              <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
                <span class="mono" style="font-weight:600;font-size:14px">${escapeHtml(x.name)}</span>
                <span class="chip ${x.severity === 'crit' ? 'crit' : x.severity === 'warn' ? 'warn' : 'ok'}">${escapeHtml(x.health.text)}</span>
                <span class="muted" style="font-size:12px">${escapeHtml(x.kind || '')}</span>
                <span class="muted" style="font-size:12px">${escapeHtml(x.firmware || '')}</span>
              </div>
              <div class="grid grid-2" style="margin:0">
                ${rows.map((r) => `<div class="stat-row"><span class="k">${r[0]}</span><span class="v">${r[1]}</span></div>`).join('')}
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        const smartCard = $('#smart-card', root);
        if (smartCard) smartCard.classList.add('hidden');
      }
    }

    $('#smart-refresh', root)?.addEventListener('click', () => loadSmart(true));
    $('#disk-refresh', root).addEventListener('click', () => { loadDiskInfo(); loadSmart(true); });

    PAGE_UPDATERS.disk = (s) => {
      const r = s.disks?.reduce((a, d) => a + d.readBytesPerSec, 0) ?? 0;
      const w = s.disks?.reduce((a, d) => a + d.writeBytesPerSec, 0) ?? 0;
      ioChart.push({ values: { read: r, write: w } });

      if (s.filesystems) {
        $('#disk-fs', root).innerHTML = s.filesystems
          .map(
            (f) => `
          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
              <span><span class="mono">${escapeHtml(f.mountPoint)}</span>
                <span class="muted" style="font-size:11.5px"> · ${escapeHtml(f.device)} · ${escapeHtml(f.fstype)}</span></span>
              <span class="muted">${fmtBytes(f.used)} / ${fmtBytes(f.total)}（${f.usedPercent.toFixed(1)}%）</span>
            </div>
            <div class="progress">
              <div class="progress-bar ${levelClass(f.usedPercent, 80, 92)}" style="width:${f.usedPercent}%"></div>
            </div>
          </div>`
          )
          .join('');
      }

      if (s.disks) {
        $('#disk-devices', root).innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>设备</th><th>类型</th><th class="num">读 IOPS</th><th class="num">写 IOPS</th>
                  <th class="num">读吞吐</th><th class="num">写吞吐</th>
                  <th class="num">读延迟</th><th class="num">写延迟</th><th class="num">利用率</th>
                </tr>
              </thead>
              <tbody>
                ${s.disks
                  .map((d) => {
                    const info = diskInfo.find((x) => x.name === d.name);
                    return `
                  <tr>
                    <td class="mono">${escapeHtml(d.name)}</td>
                    <td><span class="chip ${info?.kind === 'HDD' ? 'warn' : info?.kind === 'NVMe' ? 'info' : 'ok'}">${info ? info.kindLabel : '—'}</span></td>
                    <td class="num">${d.readIops.toFixed(0)}</td>
                    <td class="num">${d.writeIops.toFixed(0)}</td>
                    <td class="num">${fmtRate(d.readBytesPerSec)}</td>
                    <td class="num">${fmtRate(d.writeBytesPerSec)}</td>
                    <td class="num">${d.readAwaitMs.toFixed(2)} ms</td>
                    <td class="num">${d.writeAwaitMs.toFixed(2)} ms</td>
                    <td class="num"><span class="chip ${levelClass(d.utilPercent, 70, 90)}">${d.utilPercent.toFixed(1)}%</span></td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>`;
      }
    };

    await Promise.all([loadDiskInfo(), loadSmart()]);
    if (state.latest) PAGE_UPDATERS.disk(state.latest);
  }

  /* ======================================================================
     页面：网络
     ====================================================================== */
  async function renderNetwork(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>网络吞吐</h3></div>
        <div class="chart-wrap chart-lg"><canvas id="net-chart"></canvas></div>
        <div class="legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#3fb950"></span>下行</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#39c5cf"></span>上行</span>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>网卡详情</h3></div>
        <div id="net-ifaces"><div class="muted">等待数据…</div></div>
      </div>
    `;

    const chart = new Charts.LineChart($('#net-chart', root), {
      series: [
        { key: 'rx', name: '下行', color: '#3fb950' },
        { key: 'tx', name: '上行', color: '#39c5cf' },
      ],
      maxPoints: 120,
    });

    PAGE_UPDATERS.network = (s) => {
      const rx = s.network?.interfaces?.reduce((a, n) => a + n.rxBytesPerSec, 0) ?? 0;
      const tx = s.network?.interfaces?.reduce((a, n) => a + n.txBytesPerSec, 0) ?? 0;
      chart.push({ values: { rx, tx } });

      const links = s.network?.links || [];
      const ifaces = s.network?.interfaces || [];
      $('#net-ifaces', root).innerHTML = `
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr><th>网卡</th><th>状态</th><th class="num">速率</th><th class="num">下行</th>
                  <th class="num">上行</th><th class="num">累计接收</th><th class="num">累计发送</th>
                  <th class="num">丢包</th></tr>
            </thead>
            <tbody>
              ${ifaces
                .map((n) => {
                  const link = links.find((l) => l.name === n.name);
                  return `
                <tr>
                  <td class="mono">${escapeHtml(n.name)}</td>
                  <td><span class="chip ${link?.operstate === 'up' ? 'ok' : ''}">${escapeHtml(link?.operstate || '—')}</span></td>
                  <td class="num">${link?.speedMbps > 0 ? link.speedMbps + ' Mb' : '—'}</td>
                  <td class="num">${fmtRate(n.rxBytesPerSec)}</td>
                  <td class="num">${fmtRate(n.txBytesPerSec)}</td>
                  <td class="num">${fmtBytes(n.rxBytesTotal)}</td>
                  <td class="num">${fmtBytes(n.txBytesTotal)}</td>
                  <td class="num">${n.rxDropped + n.txDropped}</td>
                </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    };

    if (state.latest) PAGE_UPDATERS.network(state.latest);
  }

  /* ======================================================================
     页面：服务（占位）
     ====================================================================== */
  /* ======================================================================
     B2：特权主机操作（panel-helper）
     ====================================================================== */
  const HOST_INSTALL_CMD = 'sudo bash scripts/install-helper.sh';

  function hostOk() {
    return !!(state.host && state.host.helper === true);
  }

  async function loadHostStatus() {
    const prev = state.host || {};
    try {
      const data = await api('/api/host/status');
      state.host = {
        helper: data && data.helper === true,
        version: (data && data.version) || null,
        error: null,
        power: prev.power || null,
        devices: prev.devices || null,
      };
    } catch (err) {
      state.host = {
        helper: false,
        version: null,
        error: featureErrorText(err, '特权助手'),
        power: prev.power || null,
        devices: prev.devices || null,
      };
    }
    return state.host;
  }

  function hostBannerHtml() {
    const h = state.host || {};
    if (h.error) {
      return `<div class="host-banner host-banner-warn">
        <strong>特权助手状态不可用</strong>
        <p>${escapeHtml(h.error)}</p>
        <p>安装/检查：<code class="host-cmd">${HOST_INSTALL_CMD}</code></p>
      </div>`;
    }
    if (h.helper) {
      return `<div class="host-banner host-banner-ok">
        <span class="chip ok">特权助手已连接${h.version ? ' v' + escapeHtml(String(h.version)) : ''}</span>
        <span class="muted">特权操作可用，所有操作都会写入审计日志。</span>
      </div>`;
    }
    return `<div class="host-banner host-banner-warn">
      <strong>需要安装特权助手</strong>
      <p>服务启停、结束进程、编辑 cron、电源、挂载、防火墙、系统更新需要 root 特权助手（panel-helper）。</p>
      <p>在服务器执行：<code class="host-cmd">${HOST_INSTALL_CMD}</code></p>
      <p>安装后 <b>无需重启面板</b>，刷新本页即可；验收：顶部变为「特权助手已连接」，且 <span class="mono">GET /api/host/status</span> 返回 <span class="mono">helper:true</span>。</p>
      <p class="muted">未安装时所有特权按钮保持禁用，监控与只读功能不受影响。</p>
    </div>`;
  }

  function hostErrText(err) {
    const msg = (err && err.message) || String(err || '');
    if (/helper_unavailable|panel-helper|特权助手/.test(msg) && /unavailable|未|安装/.test(msg)) {
      return `需要安装特权助手：${HOST_INSTALL_CMD}`;
    }
    if (/helper_timeout/.test(msg)) return '特权助手响应超时，请稍后重试。';
    if (/helper_denied/.test(msg)) return msg.replace(/^helper_denied[：:]\s*/, '');
    if (/helper_error/.test(msg)) return `特权操作失败：${msg.replace(/^helper_error[：:]\s*/, '')}`;
    if (/接口不存在|not_found|404/.test(msg)) return '特权接口未就绪（后端未更新）：请更新并重启面板后端。';
    if (/响应解析失败|Unexpected token|not valid JSON/i.test(msg)) return '特权接口暂不可用（后端返回了非 JSON 响应）。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '无法连接面板服务，请检查网络后重试。';
    return msg || '未知错误';
  }

  function hostToastError(err) {
    toast(hostErrText(err), 'err', 6500);
  }

  /** 通用确认弹窗（可要求输入确认码） */
  function openHostConfirmModal(opts) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(opts.title || '确认操作')}</h3>
        <button class="icon-btn" type="button" data-close aria-label="关闭">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body">
        ${opts.bodyHtml || ''}
        ${
          opts.code
            ? `<label class="field"><span>输入 ${escapeHtml(opts.code)} 以确认</span>
                 <input type="text" id="host-confirm-code" placeholder="${escapeHtml(opts.code)}" autocomplete="off" spellcheck="false">
               </label>`
            : ''
        }
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-close>取消</button>
        <button class="btn ${opts.danger === false ? 'btn-primary' : 'btn-danger'}" id="host-confirm-ok" type="button"${
          opts.code ? ' disabled' : ''
        }>${escapeHtml(opts.confirmText || '确认')}</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);
    const okBtn = wrap.querySelector('#host-confirm-ok');
    if (opts.code) {
      const input = wrap.querySelector('#host-confirm-code');
      input.addEventListener('input', () => {
        okBtn.disabled = input.value.trim() !== opts.code;
      });
      setTimeout(() => input.focus(), 50);
    }
    okBtn.addEventListener('click', async () => {
      okBtn.disabled = true;
      const oldText = okBtn.textContent;
      okBtn.textContent = '执行中…';
      try {
        await opts.onConfirm();
        close();
      } catch (err) {
        hostToastError(err);
        okBtn.disabled = false;
        okBtn.textContent = oldText;
      }
    });
  }

  async function renderHost(root) {
    root.innerHTML = `
      <div id="host-banner"></div>
      <div class="grid host-grid">
        <div class="card">
          <div class="card-head"><h3>电源</h3><span class="spacer"></span><span class="card-sub">重启 / 关机（60 秒倒计时）</span></div>
          <div id="host-power-body"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>磁盘挂载</h3><span class="spacer"></span><button class="btn btn-sm" id="host-mount-refresh" type="button">刷新</button></div>
          <div id="host-mount-body"><div class="muted">加载中…</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>防火墙（ufw）</h3><span class="spacer"></span><button class="btn btn-sm" id="host-fw-refresh" type="button">刷新</button></div>
        <div id="host-fw-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>系统更新</h3><span class="spacer"></span>
          <button class="btn btn-sm" id="host-pkg-update" type="button"${hostOk() ? '' : ' disabled'}>更新索引</button>
          <button class="btn btn-sm btn-danger" id="host-pkg-upgrade" type="button"${hostOk() ? '' : ' disabled'}>升级全部</button>
          <button class="btn btn-sm" id="host-pkg-refresh" type="button">刷新</button>
        </div>
        <div id="host-pkg-body"><div class="muted">加载中…</div></div>
      </div>`;

    await loadHostStatus();
    $('#host-banner', root).innerHTML = hostBannerHtml();
    ['host-pkg-update', 'host-pkg-upgrade'].forEach((id) => {
      const el = $('#' + id, root);
      if (el) el.disabled = !hostOk();
    });

    /* ---------------- 电源 ---------------- */
    function renderPower() {
      const body = $('#host-power-body', root);
      if (!body) return;
      if (state.host.powerTimer) {
        clearInterval(state.host.powerTimer);
        state.host.powerTimer = null;
      }
      const p = state.host.power;
      body.innerHTML = `
        <p class="muted host-note">重启/关机会在 60 秒后执行，期间可在本页取消。执行前请保存所有工作。</p>
        ${p ? `<div class="notice host-power-scheduled">
          <div>${p.action === 'reboot' ? '重启' : '关机'} 已安排：<b id="host-power-countdown">${p.delaySeconds} 秒</b>后执行</div>
          <div style="margin-top:8px"><button class="btn btn-sm" id="host-power-cancel" type="button">取消${p.action === 'reboot' ? '重启' : '关机'}</button></div>
        </div>` : ''}
        <div class="host-actions">
          <button class="btn btn-danger" id="host-reboot" type="button"${hostOk() ? '' : ' disabled'}>重启系统</button>
          <button class="btn btn-danger" id="host-shutdown" type="button"${hostOk() ? '' : ' disabled'}>关闭系统</button>
        </div>`;
      if (!hostOk()) {
        body.insertAdjacentHTML('beforeend', '<div class="muted host-note">特权助手未安装，电源操作已禁用。</div>');
      }
      const askPower = (action) => {
        const code = action === 'reboot' ? 'REBOOT' : 'SHUTDOWN';
        const label = action === 'reboot' ? '重启' : '关机';
        if (!hostOk()) {
          toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
          return;
        }
        openHostConfirmModal({
          title: `${label}服务器`,
          bodyHtml: `<div class="notice">${label}将在 60 秒后执行，期间可以在本页取消。请确认已保存所有工作。</div>`,
          code,
          confirmText: `确认${label}`,
          onConfirm: async () => {
            const data = await api('/api/host/power', { method: 'POST', body: { action, confirm: code } });
            const delay = Number(data && data.result && data.result.delaySeconds) || 60;
            state.host.power = { action, delaySeconds: delay, at: Date.now() + delay * 1000 };
            renderPower();
            toast(`${label}已安排：${delay} 秒后执行`, 'warn', 6500);
          },
        });
      };
      $('#host-reboot', root)?.addEventListener('click', () => askPower('reboot'));
      $('#host-shutdown', root)?.addEventListener('click', () => askPower('shutdown'));
      $('#host-power-cancel', root)?.addEventListener('click', async () => {
        try {
          await api('/api/host/power', { method: 'POST', body: { action: 'cancel' } });
          state.host.power = null;
          renderPower();
          toast('已取消计划中的电源操作', 'ok');
        } catch (err) {
          hostToastError(err);
        }
      });
      if (p) {
        const tick = () => {
          const el = $('#host-power-countdown', root);
          if (!el || !state.host.power) return;
          const left = Math.max(0, Math.ceil((state.host.power.at - Date.now()) / 1000));
          el.textContent = left > 0 ? `${left} 秒` : '正在执行…';
        };
        tick();
        state.host.powerTimer = setInterval(tick, 1000);
      }
    }

    /* ---------------- 挂载 ---------------- */
    let mounts = [];
    async function loadDevices() {
      if (state.host.devices) return state.host.devices;
      try {
        const d = await api('/api/disks/info');
        const list = [];
        for (const disk of d.disks || []) {
          for (const p of disk.partitions || []) {
            if (p.device) list.push({ device: p.device, label: `${p.device} · ${fmtBytes(p.size)}${p.fstype ? ' · ' + p.fstype : ''}` });
          }
          if (!(disk.partitions || []).length && disk.device) {
            list.push({ device: disk.device, label: `${disk.device} · ${fmtBytes(disk.size)}` });
          }
        }
        state.host.devices = list;
      } catch (e) {
        state.host.devices = [];
      }
      return state.host.devices;
    }

    function renderMounts() {
      const body = $('#host-mount-body', root);
      if (!body) return;
      const managed = mounts.filter((m) => m.managed);
      body.innerHTML = `
        ${managed.length
          ? `<div class="host-list">${managed
              .map(
                (m) => `<div class="host-row">
                  <div class="host-row-main">
                    <div class="host-row-title mono">${escapeHtml(m.mountPoint)}</div>
                    <div class="host-row-meta">${escapeHtml(m.device)} · ${escapeHtml(m.fstype)}</div>
                  </div>
                  <button class="btn btn-sm btn-danger" type="button" data-umount="${escapeHtml(m.mountPoint)}"${hostOk() ? '' : ' disabled'}>卸载</button>
                </div>`
              )
              .join('')}</div>`
          : '<div class="muted host-note">没有 /mnt 或 /media 下的挂载点</div>'}
        <div class="host-form">
          <label class="field"><span>块设备</span>
            <input type="text" id="host-mount-device" list="host-mount-devices" placeholder="/dev/sdb1"${hostOk() ? '' : ' disabled'}>
            <datalist id="host-mount-devices"></datalist>
          </label>
          <label class="field"><span>挂载点（/mnt 或 /media 下，需已存在）</span>
            <input type="text" id="host-mount-point" placeholder="/mnt/data"${hostOk() ? '' : ' disabled'}>
          </label>
          <button class="btn btn-sm" id="host-mount-btn" type="button"${hostOk() ? '' : ' disabled'}>挂载</button>
        </div>
        ${hostOk() ? '' : `<div class="muted host-note">需要安装特权助手后才能挂载/卸载。</div>`}`;
      const dl = $('#host-mount-devices', root);
      if (dl && state.host.devices) {
        dl.innerHTML = state.host.devices.map((d) => `<option value="${escapeHtml(d.device)}">${escapeHtml(d.label)}</option>`).join('');
      }
      $('#host-mount-btn', root)?.addEventListener('click', async () => {
        const device = $('#host-mount-device', root).value.trim();
        const mountPoint = $('#host-mount-point', root).value.trim();
        if (!device || !mountPoint) {
          toast('请填写块设备与挂载点', 'warn');
          return;
        }
        try {
          await api('/api/host/mount', { method: 'POST', body: { device, mountPoint } });
          toast('挂载成功', 'ok');
          loadMounts();
        } catch (err) {
          hostToastError(err);
        }
      });
      body.querySelectorAll('[data-umount]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm(`确定卸载 ${btn.dataset.umount}？`)) return;
          try {
            await api('/api/host/umount', { method: 'POST', body: { mountPoint: btn.dataset.umount } });
            toast('已卸载', 'ok');
            loadMounts();
          } catch (err) {
            hostToastError(err);
          }
        });
      });
    }

    async function loadMounts() {
      const body = $('#host-mount-body', root);
      if (!body) return;
      if (!hostOk()) {
        body.innerHTML = `<div class="muted host-note">挂载管理不可用：需要安装特权助手（<code class="host-cmd">${HOST_INSTALL_CMD}</code>）。</div>`;
        return;
      }
      body.innerHTML = '<div class="muted">加载中…</div>';
      try {
        await loadDevices();
        const data = await api('/api/host/mounts');
        mounts = Array.isArray(data.mounts) ? data.mounts : [];
        renderMounts();
      } catch (err) {
        body.innerHTML = `<div class="dl-error">${escapeHtml(hostErrText(err))}</div>`;
      }
    }

    /* ---------------- 防火墙 ---------------- */
    async function loadFirewall() {
      const body = $('#host-fw-body', root);
      if (!body) return;
      if (!hostOk()) {
        body.innerHTML = `<div class="muted host-note">防火墙管理不可用：需要安装特权助手。</div>`;
        return;
      }
      body.innerHTML = '<div class="muted">加载中…</div>';
      try {
        const data = await api('/api/host/firewall');
        const output = String((data && data.output) || '');
        body.innerHTML = `
          <div class="host-actions">
            <button class="btn btn-sm" id="host-fw-enable" type="button">启用 ufw</button>
            <button class="btn btn-sm btn-danger" id="host-fw-disable" type="button">禁用 ufw</button>
          </div>
          <pre class="host-pre">${escapeHtml(output || '（ufw 无输出）')}</pre>
          <div class="host-fw-form">
            <label class="field"><span>动作</span>
              <select id="host-fw-action">
                <option value="allow">允许</option><option value="deny">拒绝</option><option value="delete">删除规则</option>
              </select>
            </label>
            <label class="field"><span>端口</span><input type="number" id="host-fw-port" min="1" max="65535" placeholder="22"></label>
            <label class="field"><span>协议</span>
              <select id="host-fw-proto"><option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option></select>
            </label>
            <label class="field"><span>应用 profile（可选）</span><input type="text" id="host-fw-profile" placeholder="OpenSSH"></label>
            <label class="field"><span>删除时规则类型</span>
              <select id="host-fw-ruleaction"><option value="allow">allow</option><option value="deny">deny</option></select>
            </label>
          </div>
          <div class="host-actions">
            <button class="btn btn-sm btn-primary" id="host-fw-apply" type="button">执行规则</button>
            <span class="muted host-note">端口与 profile 二选一；来源 IP 限制未在当前 helper 契约中提供。</span>
          </div>`;
        $('#host-fw-refresh', root)?.addEventListener('click', loadFirewall);
        const askFirewallPower = (action) => {
          openHostConfirmModal({
            title: action === 'enable' ? '启用 ufw' : '禁用 ufw',
            bodyHtml: `<div class="notice">${action === 'enable' ? '启用防火墙会按现有规则放行/拦截流量。' : '禁用防火墙会让所有端口暴露在网络上。'}</div>`,
            confirmText: action === 'enable' ? '启用' : '禁用',
            danger: action !== 'enable',
            onConfirm: async () => {
              await api('/api/host/firewall', { method: 'POST', body: { action } });
              toast(action === 'enable' ? '已启用 ufw' : '已禁用 ufw', 'ok');
              loadFirewall();
            },
          });
        };
        $('#host-fw-enable', root)?.addEventListener('click', () => askFirewallPower('enable'));
        $('#host-fw-disable', root)?.addEventListener('click', () => askFirewallPower('disable'));
        $('#host-fw-apply', root)?.addEventListener('click', async () => {
          const action = $('#host-fw-action', root).value;
          const port = $('#host-fw-port', root).value.trim();
          const proto = $('#host-fw-proto', root).value;
          const profile = $('#host-fw-profile', root).value.trim();
          const ruleAction = $('#host-fw-ruleaction', root).value;
          if (!port && !profile) {
            toast('请填写端口或应用 profile', 'warn');
            return;
          }
          const body = { action };
          if (profile) body.profile = profile;
          else {
            body.port = Number(port);
            body.proto = proto;
          }
          if (action === 'delete') body.ruleAction = ruleAction;
          try {
            await api('/api/host/firewall', { method: 'POST', body });
            toast('防火墙规则已应用', 'ok');
            loadFirewall();
          } catch (err) {
            hostToastError(err);
          }
        });
      } catch (err) {
        body.innerHTML = `<div class="dl-error">${escapeHtml(hostErrText(err))}</div>`;
      }
    }

    /* ---------------- 系统更新 ---------------- */
    let pkgBusy = false;
    let pkgResult = '';
    function setPkgBusy(busy, label) {
      pkgBusy = busy;
      ['host-pkg-update', 'host-pkg-upgrade', 'host-pkg-refresh'].forEach((id) => {
        const el = $('#' + id, root);
        if (el) el.disabled = busy || (id !== 'host-pkg-refresh' && !hostOk());
      });
      if (busy) {
        const body = $('#host-pkg-body', root);
        if (body) body.insertAdjacentHTML('afterbegin', `<div class="host-busy" id="host-pkg-busy">${escapeHtml(label || '执行中…')}，可能需要数分钟，请勿关闭页面。</div>`);
      } else {
        $('#host-pkg-busy', root)?.remove();
      }
    }

    function renderPackages(data) {
      const body = $('#host-pkg-body', root);
      if (!body) return;
      const packages = Array.isArray(data && data.packages) ? data.packages : [];
      const count = Number(data && data.count) || packages.length;
      body.innerHTML = `
        <div class="muted host-note">可升级软件包：<b>${count}</b> 个${packages.length < count ? `（仅显示前 ${packages.length} 个）` : ''}</div>
        ${pkgResult ? `<pre class="host-pre">${escapeHtml(pkgResult)}</pre>` : ''}
        ${
          packages.length
            ? `<div class="host-list host-list-scroll">${packages
                .map(
                  (pkg) => `<div class="host-row">
                    <div class="host-row-main">
                      <div class="host-row-title mono">${escapeHtml(pkg.name)}</div>
                      <div class="host-row-meta">${escapeHtml(pkg.current || '—')} → ${escapeHtml(pkg.candidate || '—')}</div>
                    </div>
                  </div>`
                )
                .join('')}</div>`
            : '<div class="placeholder"><p>没有可升级的软件包</p></div>'
        }`;
      $('#host-pkg-refresh', root)?.addEventListener('click', loadPackages);
      ['host-pkg-update', 'host-pkg-upgrade'].forEach((id) => {
        const el = $('#' + id, root);
        if (el) el.disabled = pkgBusy || !hostOk();
      });
    }

    async function loadPackages() {
      const body = $('#host-pkg-body', root);
      if (!body) return;
      if (!hostOk()) {
        body.innerHTML = `<div class="muted host-note">系统更新不可用：需要安装特权助手。</div>
          <div class="host-actions"><button class="btn btn-sm" disabled>更新索引</button><button class="btn btn-sm btn-danger" disabled>升级全部</button></div>`;
        return;
      }
      body.innerHTML = '<div class="muted">加载中…</div>';
      try {
        const data = await api('/api/host/packages/upgradable');
        renderPackages(data);
      } catch (err) {
        body.innerHTML = `<div class="dl-error">${escapeHtml(hostErrText(err))}</div>`;
      }
    }

    async function runPackages(action) {
      if (pkgBusy || !hostOk()) return;
      setPkgBusy(true, action === 'update' ? '正在更新软件索引…' : '正在升级全部软件包…');
      pkgResult = '';
      try {
        const body = action === 'upgrade' ? { action, confirm: 'UPGRADE' } : { action };
        const data = await api('/api/host/packages', { method: 'POST', body });
        pkgResult = String((data && data.result && data.result.output) || '').slice(0, 6000);
        toast(action === 'update' ? '索引更新完成' : '系统升级完成', 'ok', 5000);
        setPkgBusy(false);
        loadPackages();
      } catch (err) {
        hostToastError(err);
        setPkgBusy(false);
      }
    }

    $('#host-mount-refresh', root)?.addEventListener('click', loadMounts);
    $('#host-fw-refresh', root)?.addEventListener('click', loadFirewall);
    $('#host-pkg-refresh', root)?.addEventListener('click', loadPackages);
    $('#host-pkg-update', root)?.addEventListener('click', () => runPackages('update'));
    $('#host-pkg-upgrade', root)?.addEventListener('click', () => {
      if (!hostOk()) {
        toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
        return;
      }
      openHostConfirmModal({
        title: '升级全部软件包',
        bodyHtml: `<div class="notice">将执行 apt-get -y upgrade，可能耗时数分钟；升级过程中服务可能短暂中断。</div>`,
        code: 'UPGRADE',
        confirmText: '确认升级',
        onConfirm: () => runPackages('upgrade'),
      });
    });

    state.cleanups.push(() => {
      if (state.host && state.host.powerTimer) {
        clearInterval(state.host.powerTimer);
        state.host.powerTimer = null;
      }
    });

    renderPower();
    loadMounts();
    loadFirewall();
    loadPackages();
  }

  async function renderService(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>系统服务</h3>
          <span class="spacer"></span>
          <select id="svc-state" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
            <option value="">全部状态</option>
            <option value="active">仅运行中</option>
            <option value="inactive">仅已停止</option>
            <option value="failed">仅失败</option>
          </select>
          <input type="text" id="svc-filter" placeholder="搜索服务名或描述…"
                 style="width:220px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
          <button class="btn btn-sm" id="svc-refresh">刷新</button>
        </div>
        <div id="svc-host-banner"></div>
        <div id="svc-summary" class="muted" style="font-size:12px;margin-bottom:10px"></div>
        <div id="svc-body"><div class="muted">加载中…</div></div>
      </div>
    `;

    let allUnits = [];

    function render() {
      const state = $('#svc-state', root)?.value || '';
      const kw = ($('#svc-filter', root)?.value || '').trim().toLowerCase();

      let list = allUnits;
      if (state) list = list.filter((u) => u.active === state);
      if (kw) {
        list = list.filter(
          (u) =>
            u.unit.toLowerCase().includes(kw) ||
            (u.description || '').toLowerCase().includes(kw)
        );
      }

      const counts = {
        total: allUnits.length,
        active: allUnits.filter((u) => u.active === 'active').length,
        failed: allUnits.filter((u) => u.active === 'failed').length,
      };
      $('#svc-summary', root).textContent =
        `共 ${counts.total} 个服务 · 运行中 ${counts.active} · 失败 ${counts.failed} · 当前显示 ${list.length} 个`;

      if (list.length === 0) {
        $('#svc-body', root).innerHTML = '<div class="placeholder"><p>没有匹配的服务</p></div>';
        return;
      }

      $('#svc-body', root).innerHTML = `
        <div class="table-wrap scroll-y" style="max-height:64vh;overflow-y:auto">
          <table class="data">
            <thead><tr><th>服务</th><th>状态</th><th>子状态</th><th>描述</th><th>操作</th></tr></thead>
            <tbody>
              ${list
                .map((u) => {
                  const cls =
                    u.active === 'active' ? 'ok' : u.active === 'failed' ? 'crit' : '';
                  return `
                <tr>
                  <td class="mono">${escapeHtml(u.unit)}</td>
                  <td><span class="chip ${cls}">${escapeHtml(u.active)}</span></td>
                  <td class="muted">${escapeHtml(u.sub)}</td>
                  <td class="muted" style="white-space:normal;max-width:420px">${escapeHtml(u.description)}</td>
                  <td>
                    <div class="svc-actions">
                      ${u.active === 'active'
                        ? `<button class="btn btn-sm" type="button" data-svc-action="stop" data-unit="${escapeHtml(u.unit)}"${hostOk() ? '' : ' disabled'}>停止</button>
                           <button class="btn btn-sm" type="button" data-svc-action="restart" data-unit="${escapeHtml(u.unit)}"${hostOk() ? '' : ' disabled'}>重启</button>`
                        : `<button class="btn btn-sm" type="button" data-svc-action="start" data-unit="${escapeHtml(u.unit)}"${hostOk() ? '' : ' disabled'}>启动</button>`}
                      <button class="btn btn-sm" type="button" data-svc-action="enable" data-unit="${escapeHtml(u.unit)}"${hostOk() ? '' : ' disabled'}>开机自启</button>
                      <button class="btn btn-sm" type="button" data-svc-action="disable" data-unit="${escapeHtml(u.unit)}"${hostOk() ? '' : ' disabled'}>取消自启</button>
                    </div>
                  </td>
                </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    async function load() {
      try {
        await loadHostStatus();
        $('#svc-host-banner', root).innerHTML = hostBannerHtml();
        const data = await api('/api/services');
        allUnits = data.units || [];
        render();
      } catch (e) {
        $('#svc-body', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    $('#svc-state', root).addEventListener('change', render);
    $('#svc-filter', root).addEventListener('input', debounce(render, 200));
    $('#svc-refresh', root).addEventListener('click', load);
    $('#svc-body', root).addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-svc-action]');
      if (!btn) return;
      const unit = btn.dataset.unit;
      const action = btn.dataset.svcAction;
      const labels = { start: '启动', stop: '停止', restart: '重启', enable: '设置开机自启', disable: '取消开机自启' };
      if (!hostOk()) {
        toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
        return;
      }
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = '执行中…';
      try {
        await api('/api/host/service', { method: 'POST', body: { unit, action } });
        toast(`${labels[action] || action} ${unit} 成功`, 'ok');
        await load();
      } catch (err) {
        hostToastError(err);
        btn.disabled = false;
        btn.textContent = oldText;
      }
    });
    await load();
  }

  /* ======================================================================
     页面：日志（占位）
     ====================================================================== */
  async function renderLogs(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>系统日志</h3>
          <span class="spacer"></span>
          <input type="text" id="log-unit" placeholder="按 unit 过滤（如 ssh.service）"
                 style="width:200px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
          <input type="text" id="log-kw" placeholder="关键字过滤…"
                 style="width:160px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
          <select id="log-lines" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
            <option value="100">100 行</option>
            <option value="200" selected>200 行</option>
            <option value="500">500 行</option>
            <option value="1000">1000 行</option>
          </select>
          <button class="btn btn-sm" id="log-refresh">刷新</button>
        </div>
        <div id="log-summary" class="muted" style="font-size:12px;margin-bottom:8px"></div>
        <pre id="log-body" class="mono" style="max-height:62vh;overflow:auto;font-size:12px;line-height:1.65;margin:0;white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:14px;border-radius:8px">加载中…</pre>
      </div>
    `;

    let rawLines = [];

    function paint() {
      const kw = ($('#log-kw', root)?.value || '').trim().toLowerCase();
      const lines = kw ? rawLines.filter((l) => l.toLowerCase().includes(kw)) : rawLines;
      const el = $('#log-body', root);

      $('#log-summary', root).textContent =
        `共 ${rawLines.length} 行` + (kw ? `，匹配「${kw}」${lines.length} 行` : '');

      if (lines.length === 0) {
        el.textContent = kw ? '没有匹配的日志行' : '（无日志）';
        return;
      }

      // 级别着色：error/fail/crit 红，warn 黄，其余默认
      el.innerHTML = lines
        .map((l) => {
          const low = l.toLowerCase();
          let color = '';
          if (/\b(error|fail|critical|crit|panic|fatal)\b/.test(low)) color = 'color:var(--red)';
          else if (/\bwarn(ing)?\b/.test(low)) color = 'color:var(--yellow)';
          return `<span style="${color}">${escapeHtml(l)}</span>`;
        })
        .join('\n');
    }

    async function load() {
      const lines = Number($('#log-lines', root)?.value) || 200;
      const unit = ($('#log-unit', root)?.value || '').trim();
      $('#log-body', root).textContent = '加载中…';
      try {
        const qs = new URLSearchParams({ lines: String(lines) });
        if (unit) qs.set('unit', unit);
        const data = await api('/api/logs?' + qs.toString());
        rawLines = data.lines || [];
        paint();
        const el = $('#log-body', root);
        el.scrollTop = el.scrollHeight;
      } catch (e) {
        $('#log-body', root).textContent = e.message;
      }
    }

    $('#log-refresh', root).addEventListener('click', load);
    $('#log-lines', root).addEventListener('change', load);
    $('#log-unit', root).addEventListener('change', load);
    $('#log-kw', root).addEventListener('input', debounce(paint, 200));
    await load();
  }

  /* ======================================================================
     页面：连接与端口
     ====================================================================== */
  async function renderConnections(root) {
    root.innerHTML = `
      <div class="grid grid-cards" id="conn-cards"></div>
      <div class="card">
        <div class="card-head">
          <h3>网络连接</h3>
          <span class="spacer"></span>
          <select id="conn-state" style="padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
            <option value="">全部状态</option>
            <option value="LISTEN">监听</option>
            <option value="ESTABLISHED">已建立</option>
            <option value="TIME_WAIT">TIME_WAIT</option>
            <option value="CLOSE_WAIT">CLOSE_WAIT</option>
          </select>
          <input type="text" id="conn-filter" placeholder="筛选端口/地址/进程…"
                 style="width:180px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:7px;font-size:12.5px">
        </div>
        <div id="conn-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>监听端口</h3></div>
          <div id="conn-ports"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>协议栈统计</h3></div>
          <div id="conn-stats"><div class="muted">加载中…</div></div>
        </div>
      </div>
    `;

    async function load() {
      const state = $('#conn-state', root)?.value || '';
      const filter = ($('#conn-filter', root)?.value || '').toLowerCase();

      try {
        const [connRes, portRes, statRes] = await Promise.all([
          api('/api/connections?limit=800' + (state ? `&state=${state}` : '')),
          api('/api/ports'),
          api('/api/netstats'),
        ]);

        // 汇总卡
        const s = connRes.summary || {};
        $('#conn-cards', root).innerHTML = [
          { label: '已建立', value: s.established ?? 0, color: 'var(--green)' },
          { label: '监听端口', value: s.listen ?? 0, color: 'var(--accent)' },
          { label: 'TIME_WAIT', value: s.timeWait ?? 0, color: 'var(--yellow)' },
          { label: 'CLOSE_WAIT', value: s.closeWait ?? 0, color: 'var(--red)' },
          { label: 'UDP', value: s.udp ?? 0, color: 'var(--purple)' },
          { label: '总连接', value: connRes.total ?? 0, color: 'var(--cyan)' },
        ]
          .map(
            (c) => `
          <div class="card metric-card">
            <div class="metric-top"><div class="metric-label">${c.label}</div></div>
            <div class="metric-value" style="color:${c.color}">${c.value}</div>
          </div>`
          )
          .join('');

        // 连接表
        const conns = (connRes.connections || []).filter(
          (c) =>
            !filter ||
            String(c.localPort).includes(filter) ||
            String(c.remotePort).includes(filter) ||
            c.localAddress.includes(filter) ||
            c.remoteAddress.includes(filter) ||
            (c.process || '').toLowerCase().includes(filter)
        );

        if (conns.length === 0) {
          $('#conn-body', root).innerHTML = '<div class="placeholder"><p>没有匹配的连接</p></div>';
        } else {
          $('#conn-body', root).innerHTML = `
            <div class="table-wrap" style="max-height:50vh;overflow-y:auto">
              <table class="data">
                <thead>
                  <tr><th>协议</th><th>状态</th><th>本地地址</th><th>远端地址</th><th>进程</th><th>PID</th></tr>
                </thead>
                <tbody>
                  ${conns
                    .slice(0, 400)
                    .map(
                      (c) => `
                    <tr>
                      <td class="mono">${escapeHtml(c.proto)}</td>
                      <td><span class="chip ${c.state === 'LISTEN' ? 'info' : c.state === 'ESTABLISHED' ? 'ok' : c.state === 'TIME_WAIT' ? 'warn' : ''}">${escapeHtml(c.state)}</span></td>
                      <td class="mono">${escapeHtml(c.localAddress)}:${c.localPort}</td>
                      <td class="mono">${c.remotePort ? escapeHtml(c.remoteAddress) + ':' + c.remotePort : '—'}</td>
                      <td class="mono">${escapeHtml(c.process || '—')}</td>
                      <td class="mono muted">${c.pid ?? '—'}</td>
                    </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
            <div class="muted" style="margin-top:10px;font-size:12px">
              共 ${conns.length} 条${conns.length > 400 ? '（显示前 400）' : ''}
              · 进程归属仅对当前用户可见进程有效
            </div>
          `;
        }

        // 端口列表
        const ports = portRes.ports || [];
        $('#conn-ports', root).innerHTML =
          ports.length === 0
            ? '<div class="muted">无监听端口</div>'
            : ports
                .map(
                  (p) => `
          <div class="stat-row">
            <span class="k">
              <span class="mono">${p.port}</span>
              <span class="muted" style="font-size:11px">/${p.proto}</span>
              ${p.process ? `<span class="muted" style="font-size:11.5px"> · ${escapeHtml(p.process)}</span>` : ''}
            </span>
            <span class="v mono muted" style="font-size:11.5px">${escapeHtml(p.address)}</span>
          </div>`
                )
                .join('');

        // 协议栈统计
        const st = statRes.stats || {};
        const tcp = st.tcp || {};
        const sock = st.sockets || {};
        const retransRate =
          tcp.OutSegs > 0 ? ((tcp.RetransSegs / tcp.OutSegs) * 100).toFixed(3) : '0.000';
        $('#conn-stats', root).innerHTML = `
          <div class="stat-row"><span class="k">TCP 已建立</span><span class="v">${tcp.CurrEstab ?? '—'}</span></div>
          <div class="stat-row"><span class="k">TCP 主动连接</span><span class="v">${tcp.ActiveOpens ?? '—'}</span></div>
          <div class="stat-row"><span class="k">TCP 被动连接</span><span class="v">${tcp.PassiveOpens ?? '—'}</span></div>
          <div class="stat-row"><span class="k">TCP 重传数</span><span class="v">${tcp.RetransSegs ?? '—'}</span></div>
          <div class="stat-row"><span class="k">重传率</span><span class="v"><span class="chip ${parseFloat(retransRate) > 1 ? 'warn' : 'ok'}">${retransRate}%</span></span></div>
          <div class="stat-row"><span class="k">连接失败</span><span class="v">${tcp.AttemptFails ?? '—'}</span></div>
          <div class="stat-row"><span class="k">socket 使用</span><span class="v">${sock.sockets?.used ?? sock.sockets?.inuse ?? '—'}</span></div>
          <div class="stat-row"><span class="k">TCP inuse</span><span class="v">${sock.tcp?.inuse ?? '—'}</span></div>
          <div class="stat-row"><span class="k">UDP inuse</span><span class="v">${sock.udp?.inuse ?? '—'}</span></div>
          <div class="stat-row"><span class="k">监听溢出</span><span class="v">${st.tcpExt?.ListenOverflows ?? '—'}</span></div>
        `;
      } catch (e) {
        $('#conn-body', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    $('#conn-state', root).addEventListener('change', load);
    $('#conn-filter', root).addEventListener('input', debounce(load, 300));
    await load();
  }


  /* ======================================================================
     页面：定时任务
     ====================================================================== */
  async function renderCron(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Cron 定时任务</h3>
          <span class="spacer"></span>
          <span class="card-sub">系统 crontab / systemd 只读</span>
        </div>
        <div id="cron-host-banner"></div>
        <div id="cron-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>用户 crontab</h3><span class="spacer"></span>
          <span class="card-sub" id="cron-user-label">当前登录用户</span>
          <button class="btn btn-sm" id="cron-edit-btn" type="button"${hostOk() ? '' : ' disabled'}>编辑</button>
        </div>
        <div id="cron-editor-box" class="hidden">
          <p class="muted host-note">每行一条 cron 任务（支持 # 注释）；保存会覆盖当前用户 crontab。</p>
          <textarea id="cron-editor" class="cron-editor" spellcheck="false" placeholder="0 4 * * * /srv/app/backup.sh"></textarea>
          <div class="host-actions">
            <button class="btn btn-sm btn-primary" id="cron-save" type="button"${hostOk() ? '' : ' disabled'}>保存 crontab</button>
            <button class="btn btn-sm" id="cron-reload" type="button">重新读取</button>
            <span class="muted" id="cron-editor-msg"></span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>systemd 定时器</h3></div>
        <div id="timer-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>周期性任务目录</h3></div>
        <div id="periodic-body"><div class="muted">加载中…</div></div>
      </div>
    `;

    await loadHostStatus();
    $('#cron-host-banner', root).innerHTML = hostBannerHtml();
    ['cron-edit-btn', 'cron-save'].forEach((id) => {
      const el = $('#' + id, root);
      if (el) el.disabled = !hostOk();
    });

    async function loadCronEditor() {
      if (!hostOk()) {
        toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
        return;
      }
      const box = $('#cron-editor-box', root);
      const ta = $('#cron-editor', root);
      const msg = $('#cron-editor-msg', root);
      if (!box || !ta) return;
      box.classList.remove('hidden');
      if (msg) msg.textContent = '读取中…';
      try {
        const data = await api('/api/host/cron');
        const lines = Array.isArray(data.lines) ? data.lines : [];
        ta.value = lines.join('\n');
        const userLabel = $('#cron-user-label', root);
        if (userLabel && data.user) userLabel.textContent = `用户 ${data.user}`;
        if (msg) msg.textContent = `已读取 ${lines.length} 行（用户 ${data.user || '当前用户'}）`;
      } catch (err) {
        if (msg) msg.textContent = hostErrText(err);
        hostToastError(err);
      }
    }

    $('#cron-edit-btn', root).addEventListener('click', loadCronEditor);
    $('#cron-reload', root).addEventListener('click', loadCronEditor);
    $('#cron-save', root).addEventListener('click', async () => {
      if (!hostOk()) {
        toast(`需要安装特权助手：${HOST_INSTALL_CMD}`, 'warn', 6000);
        return;
      }
      const ta = $('#cron-editor', root);
      const msg = $('#cron-editor-msg', root);
      const lines = String(ta.value || '')
        .split('\n')
        .map((line) => line.replace(/\s+$/, '').trim())
        .filter((line) => line.length > 0);
      if (!window.confirm(`保存将覆盖当前用户 crontab（${lines.length} 行），确定继续？`)) return;
      const btn = $('#cron-save', root);
      if (btn) {
        btn.disabled = true;
        btn.textContent = '保存中…';
      }
      try {
        await api('/api/host/cron/write', { method: 'POST', body: { lines } });
        toast('用户 crontab 已保存', 'ok');
        if (msg) msg.textContent = `已保存 ${lines.length} 行`;
      } catch (err) {
        hostToastError(err);
        if (msg) msg.textContent = hostErrText(err);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '保存 crontab';
        }
      }
    });

    try {
      const data = await api('/api/cron');
      const jobs = data.jobs || [];

      if (jobs.length === 0) {
        $('#cron-body', root).innerHTML = '<div class="placeholder"><p>没有找到 cron 任务</p></div>';
      } else {
        $('#cron-body', root).innerHTML = `
          <div class="table-wrap" style="max-height:40vh;overflow-y:auto">
            <table class="data">
              <thead><tr><th>来源</th><th>执行计划</th><th>命令</th></tr></thead>
              <tbody>
                ${jobs
                  .map(
                    (j) => `
                  <tr>
                    <td class="mono muted">${escapeHtml(j.source)}</td>
                    <td class="mono">${escapeHtml(j.schedule)}</td>
                    <td class="mono" style="white-space:normal;max-width:500px">${escapeHtml(j.command)}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:10px;font-size:12px">共 ${jobs.length} 个任务</div>
        `;
      }

      const timers = data.timers || [];
      $('#timer-body', root).innerHTML =
        timers.length === 0
          ? '<div class="muted">没有 systemd 定时器</div>'
          : `
          <div class="table-wrap" style="max-height:40vh;overflow-y:auto">
            <table class="data">
              <thead><tr><th>定时器</th><th>激活目标</th><th>下次运行</th><th>上次运行</th></tr></thead>
              <tbody>
                ${timers
                  .map(
                    (t) => `
                  <tr>
                    <td class="mono">${escapeHtml(t.unit)}</td>
                    <td class="mono muted">${escapeHtml(t.activates)}</td>
                    <td>${escapeHtml(t.nextText || '—')}
                      ${t.nextRel ? `<span class="chip info" style="margin-left:6px">${escapeHtml(t.nextRel)}</span>` : ''}</td>
                    <td class="muted">${escapeHtml(t.lastText || '—')}
                      ${t.lastRel ? `<span class="muted" style="font-size:11px;margin-left:6px">${escapeHtml(t.lastRel)}</span>` : ''}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:10px;font-size:12px">共 ${timers.length} 个定时器</div>
        `;

      const periodic = data.periodic || {};
      $('#periodic-body', root).innerHTML = Object.entries(periodic)
        .map(
          ([dir, files]) => `
        <div class="stat-row">
          <span class="k mono">${escapeHtml(dir)}</span>
          <span class="v muted">${files.length} 个脚本</span>
        </div>
        ${files.length > 0 ? `<div class="muted" style="font-size:11.5px;margin:0 0 8px 0;padding-left:8px">${files.map(escapeHtml).join(', ')}</div>` : ''}`
        )
        .join('');
    } catch (e) {
      $('#cron-body', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }
  }


  /* ======================================================================
     页面：传感器
     ====================================================================== */
  async function renderSensors(root) {
    root.innerHTML = `
      <div class="grid grid-cards" id="sensor-cards"><div class="muted">加载中…</div></div>
      <div class="card" id="sensor-temps-card">
        <div class="card-head"><h3>温度传感器</h3></div>
        <div id="sensor-temps"><div class="muted">加载中…</div></div>
      </div>
      <div class="grid grid-2" id="sensor-mid-grid">
        <div class="card" id="sensor-power-card">
          <div class="card-head"><h3>功耗与电流</h3></div>
          <div id="sensor-power"><div class="muted">加载中…</div></div>
        </div>
        <div class="card" id="sensor-volt-card">
          <div class="card-head"><h3>电压 / 风扇</h3></div>
          <div id="sensor-volt"><div class="muted">加载中…</div></div>
        </div>
      </div>
      <div class="card" id="sensor-chips-card">
        <div class="card-head"><h3>硬件芯片</h3></div>
        <div id="sensor-chips"><div class="muted">加载中…</div></div>
      </div>
    `;

    async function load() {
      try {
        const data = await api('/api/sensors');
        const temps = data.temps || [];
        const fans = data.fans || [];
        const power = data.power || [];
        const volts = data.voltages || [];
        const chips = data.chips || [];

        // 全部为空：整页只给一个通用空态，不显示一排「—」占位
        if (!temps.length && !fans.length && !power.length && !volts.length && !chips.length) {
          root.innerHTML = `<div class="card"><div class="placeholder">
            <h3>未检测到硬件传感器</h3>
            <p>当前设备/系统未暴露温度、风扇、功耗等传感器数据（虚拟机、容器或驱动不支持时常见）。</p>
          </div></div>`;
          return;
        }

        const show = (id, visible) => {
          const el = $('#' + id, root);
          if (el) el.classList.toggle('hidden', !visible);
        };
        show('sensor-temps-card', temps.length > 0);
        show('sensor-power-card', power.length > 0);
        show('sensor-volt-card', volts.length > 0 || fans.length > 0);
        show('sensor-chips-card', chips.length > 0);
        show('sensor-mid-grid', power.length > 0 || volts.length > 0 || fans.length > 0);

        const maxTemp = temps.length > 0 ? temps.reduce((m, t) => Math.max(m, t.value), 0) : null;
        const totalPower = power.filter((p) => p.unit === 'W').reduce((a, p) => a + p.value, 0);

        // 只渲染实际存在的指标卡，避免一排「—」/假 0
        const metricCards = [];
        if (maxTemp !== null) {
          metricCards.push({
            label: '最高温度',
            value: `${maxTemp.toFixed(1)}°C`,
            color: maxTemp >= 80 ? 'var(--red)' : maxTemp >= 65 ? 'var(--yellow)' : 'var(--green)',
          });
          metricCards.push({ label: '温度传感器', value: `${temps.length} 个`, color: 'var(--accent)' });
        }
        if (totalPower > 0) metricCards.push({ label: '总功耗', value: `${totalPower} W`, color: 'var(--orange)' });
        if (fans.length) metricCards.push({ label: '风扇', value: `${fans.length} 个`, color: 'var(--cyan)' });
        const sensorCardsEl = $('#sensor-cards', root);
        if (sensorCardsEl) {
          sensorCardsEl.classList.toggle('hidden', metricCards.length === 0);
          sensorCardsEl.innerHTML = metricCards
            .map(
              (c) => `
          <div class="card metric-card">
            <div class="metric-top"><div class="metric-label">${c.label}</div></div>
            <div class="metric-value" style="color:${c.color}">${c.value}</div>
          </div>`
            )
            .join('');
        }

        $('#sensor-temps', root).innerHTML =
          temps.length === 0
            ? '<div class="muted">未检测到温度传感器</div>'
            : temps
                .map((t) => {
                  const cls = t.value >= 80 ? 'crit' : t.value >= 65 ? 'warn' : 'ok';
                  const pct = Math.min(100, (t.value / 100) * 100);
                  return `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
              <span>${escapeHtml(t.label)} <span class="muted" style="font-size:11px">· ${escapeHtml(t.chip)}</span></span>
              <span class="chip ${cls}">${t.value.toFixed(1)} °C</span>
            </div>
            <div class="progress">
              <div class="progress-bar ${cls}" style="width:${pct}%"></div>
            </div>
          </div>`;
                })
                .join('');

        $('#sensor-power', root).innerHTML =
          power.length === 0
            ? '<div class="muted">未检测到功耗传感器</div>'
            : power
                .map(
                  (p) => `
          <div class="stat-row">
            <span class="k">${escapeHtml(p.label)} <span class="muted" style="font-size:11px">· ${escapeHtml(p.chip)}</span></span>
            <span class="v">${p.value} ${p.unit}</span>
          </div>`
                )
                .join('');

        $('#sensor-volt', root).innerHTML =
          volts.length === 0 && fans.length === 0
            ? '<div class="muted">未检测到电压/风扇传感器</div>'
            : [...volts.map((v) => ({ ...v, unit: v.unit || 'V' })), ...fans]
                .map(
                  (v) => `
          <div class="stat-row">
            <span class="k">${escapeHtml(v.label)}</span>
            <span class="v">${v.value} ${v.unit}</span>
          </div>`
                )
                .join('');

        $('#sensor-chips', root).innerHTML = chips
          .map(
            (c) => `
          <div class="stat-row">
            <span class="k mono">${escapeHtml(c.id)}</span>
            <span class="v mono">${escapeHtml(c.name)}</span>
          </div>`
          )
          .join('');
      } catch (e) {
        root.innerHTML = `<div class="card"><div class="placeholder"><p>${escapeHtml(e.message)}</p></div></div>`;
      }
    }

    await load();
  }


  /* ======================================================================
     页面：系统详情
     ====================================================================== */
  async function renderSysinfo(root) {
    root.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>系统信息</h3></div>
          <div id="si-basic"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>时间同步</h3></div>
          <div id="si-time"><div class="muted">加载中…</div></div>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>虚拟内存统计</h3></div>
          <div id="si-vm"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>inode 使用</h3></div>
          <div id="si-inode"><div class="muted">加载中…</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>磁盘队列与调度器</h3></div>
        <div id="si-disk"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>内核模块</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="si-mod-count"></span>
        </div>
        <div id="si-modules"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>已安装软件包</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="si-pkg-count"></span>
        </div>
        <div id="si-packages"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>PCI 设备</h3></div>
        <div id="si-pci"><div class="muted">加载中…</div></div>
      </div>
    `;

    const fmtUptime = (s) => {
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      return d > 0 ? `${d} 天 ${h} 小时 ${m} 分` : `${h} 小时 ${m} 分`;
    };

    // 基础信息
    try {
      const [boot, sys] = await Promise.all([api('/api/boot'), api('/api/system')]);
      const st = sys.static || {};
      const siInfo = getCpuInfo(null, st);
      $('#si-basic', root).innerHTML = `
        <div class="stat-row"><span class="k">主机名</span><span class="v mono">${escapeHtml(st.hostname || '')}</span></div>
        <div class="stat-row"><span class="k">操作系统</span><span class="v">${escapeHtml(st.osName || '')}</span></div>
        <div class="stat-row"><span class="k">内核版本</span><span class="v mono" style="font-size:11.5px">${escapeHtml((st.kernel || '').split(' ').slice(0, 3).join(' '))}</span></div>
        <div class="stat-row"><span class="k">CPU 型号</span><span class="v" style="font-size:12px">${escapeHtml(st.cpuModel || '')}</span></div>
        <div class="stat-row"><span class="k">CPU 核心</span><span class="v" title="${escapeHtml(cpuFullLabel(siInfo))}">${escapeHtml(cpuPairLabel(siInfo))}</span></div>
        <div class="stat-row"><span class="k">线程 / 核</span><span class="v">${siInfo.perCore ?? '—'}</span></div>
        <div class="stat-row"><span class="k">超线程</span><span class="v">${siInfo.smt === null ? '未知' : siInfo.smt ? '是' : '否'}</span></div>
        <div class="stat-row"><span class="k">最高频率</span><span class="v">${fmtMhz(st.baseFreqMhz)}</span></div>
        <div class="stat-row"><span class="k">内存总量</span><span class="v">${fmtBytes(st.memTotal)}</span></div>
        <div class="stat-row"><span class="k">架构</span><span class="v">${escapeHtml(st.arch || '')}</span></div>
        <div class="stat-row"><span class="k">运行时长</span><span class="v">${fmtUptime(boot.uptimeSeconds || 0)}</span></div>
        <div class="stat-row"><span class="k">启动时间</span><span class="v">${boot.bootTime ? new Date(boot.bootTime).toLocaleString('zh-CN') : '—'}</span></div>
        <div class="stat-row"><span class="k">Node.js</span><span class="v mono">${escapeHtml(st.nodeVersion || '')}</span></div>
      `;

      // 虚拟内存
      const vm = boot.vm || {};
      $('#si-vm', root).innerHTML = `
        <div class="stat-row"><span class="k">页换入 (pgpgin)</span><span class="v">${(vm.pgpgin ?? 0).toLocaleString()}</span></div>
        <div class="stat-row"><span class="k">页换出 (pgpgout)</span><span class="v">${(vm.pgpgout ?? 0).toLocaleString()}</span></div>
        <div class="stat-row"><span class="k">Swap 换入</span><span class="v">${vm.pswpin ?? 0}</span></div>
        <div class="stat-row"><span class="k">Swap 换出</span><span class="v">${vm.pswpout ?? 0}</span></div>
        <div class="stat-row"><span class="k">缺页总数</span><span class="v">${(vm.pgfault ?? 0).toLocaleString()}</span></div>
        <div class="stat-row"><span class="k">主缺页</span><span class="v">${(vm.pgmajfault ?? 0).toLocaleString()}</span></div>
        <div class="stat-row"><span class="k">OOM Kill</span><span class="v"><span class="chip ${vm.oomKill > 0 ? 'crit' : 'ok'}">${vm.oomKill ?? 0}</span></span></div>
        <div class="stat-row"><span class="k">空闲页</span><span class="v">${(vm.nrFreePages ?? 0).toLocaleString()}</span></div>
      `;

      $('#si-basic', root).insertAdjacentHTML(
        'beforeend',
        `<div class="stat-row"><span class="k">启动参数</span><span class="v mono" style="font-size:10.5px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(boot.cmdline || '')}">${escapeHtml((boot.cmdline || '').slice(0, 60))}…</span></div>`
      );
    } catch (e) {
      $('#si-basic', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // 时间同步
    try {
      const t = await api('/api/timesync');
      $('#si-time', root).innerHTML = `
        <div class="stat-row"><span class="k">NTP 启用</span><span class="v"><span class="chip ${t.ntp === 'yes' ? 'ok' : 'warn'}">${escapeHtml(t.ntp)}</span></span></div>
        <div class="stat-row"><span class="k">时钟已同步</span><span class="v"><span class="chip ${t.synchronized ? 'ok' : 'crit'}">${t.synchronized ? '是' : '否'}</span></span></div>
        <div class="stat-row"><span class="k">时区</span><span class="v mono">${escapeHtml(t.timezone || '')}</span></div>
        <div class="stat-row"><span class="k">本地时间</span><span class="v mono" style="font-size:12px">${escapeHtml(t.localTime || '')}</span></div>
        <div class="stat-row"><span class="k">硬件时钟 (RTC)</span><span class="v mono" style="font-size:12px">${escapeHtml(t.rtcTime || '—')}</span></div>
      `;
    } catch (e) {
      $('#si-time', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // inode
    try {
      const d = await api('/api/inodes');
      const list = (d.inodes || []).slice(0, 12);
      $('#si-inode', root).innerHTML = list
        .map(
          (i) => `
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
            <span class="mono">${escapeHtml(i.mountPoint)}</span>
            <span class="muted">${i.usedInodes.toLocaleString()} / ${i.totalInodes.toLocaleString()}（${i.usedPercent}%）</span>
          </div>
          <div class="progress">
            <div class="progress-bar ${levelClass(i.usedPercent, 80, 92)}" style="width:${Math.max(1, i.usedPercent)}%"></div>
          </div>
        </div>`
        )
        .join('');
    } catch (e) {
      $('#si-inode', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // 磁盘队列
    try {
      const d = await api('/api/disks/queue');
      $('#si-disk', root).innerHTML = `
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>设备</th><th>型号</th><th class="num">容量</th><th>类型</th><th>调度器</th><th class="num">预读</th><th class="num">队列深度</th></tr></thead>
            <tbody>
              ${(d.disks || [])
                .map(
                  (x) => `
                <tr>
                  <td class="mono">${escapeHtml(x.device)}</td>
                  <td class="muted">${escapeHtml(x.model)}</td>
                  <td class="num">${x.sizeGB} GB</td>
                  <td><span class="chip ${x.rotational ? 'warn' : 'ok'}">${x.rotational ? '机械盘' : '固态'}</span></td>
                  <td class="mono">${escapeHtml(x.activeScheduler)}</td>
                  <td class="num">${x.readAheadKB} KB</td>
                  <td class="num">${x.nrRequests}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      $('#si-disk', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // 内核模块
    try {
      const d = await api('/api/modules?limit=60');
      const mods = d.modules || [];
      $('#si-mod-count', root).textContent = `${mods.length} 个（按大小排序）`;
      $('#si-modules', root).innerHTML = `
        <div class="table-wrap" style="max-height:40vh;overflow-y:auto">
          <table class="data">
            <thead><tr><th>模块</th><th class="num">大小</th><th class="num">引用</th><th>使用者</th></tr></thead>
            <tbody>
              ${mods
                .map(
                  (m) => `
                <tr>
                  <td class="mono">${escapeHtml(m.name)}</td>
                  <td class="num">${(m.size / 1024).toFixed(0)} KB</td>
                  <td class="num">${m.refCount}</td>
                  <td class="muted mono" style="font-size:11.5px">${escapeHtml(m.users || '—')}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      $('#si-modules', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // 软件包
    try {
      const d = await api('/api/packages?limit=40');
      $('#si-pkg-count', root).textContent = `共 ${d.total} 个，已安装 ${d.installed}`;
      $('#si-packages', root).innerHTML = `
        <div class="table-wrap" style="max-height:40vh;overflow-y:auto">
          <table class="data">
            <thead><tr><th>包名</th><th>版本</th><th class="num">占用</th></tr></thead>
            <tbody>
              ${(d.largest || [])
                .map(
                  (p) => `
                <tr>
                  <td class="mono">${escapeHtml(p.name)}</td>
                  <td class="mono muted" style="font-size:11.5px">${escapeHtml(p.version)}</td>
                  <td class="num">${(p.sizeKB / 1024).toFixed(1)} MB</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="muted" style="margin-top:10px;font-size:12px">按安装体积排序，显示前 40 个</div>
      `;
    } catch (e) {
      $('#si-packages', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }

    // PCI
    try {
      const d = await api('/api/pci');
      $('#si-pci', root).innerHTML = `
        <div class="table-wrap" style="max-height:36vh;overflow-y:auto">
          <table class="data">
            <thead><tr><th>插槽</th><th>厂商</th><th>设备</th><th>类别</th><th>驱动</th></tr></thead>
            <tbody>
              ${(d.devices || [])
                .map(
                  (p) => `
                <tr>
                  <td class="mono">${escapeHtml(p.slot)}</td>
                  <td class="mono muted">${escapeHtml(p.vendorId)}</td>
                  <td class="mono muted">${escapeHtml(p.deviceId)}</td>
                  <td class="mono muted" style="font-size:11.5px">${escapeHtml(p.className)}</td>
                  <td class="mono">${escapeHtml(p.driver || '—')}</td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (e) {
      $('#si-pci', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
    }
  }


  /* ======================================================================
     页面：Docker 管理
     ====================================================================== */
  async function renderDocker(root) {
    root.innerHTML = '<div class="placeholder"><p>正在探测 Docker…</p></div>';

    let status;
    try {
      status = await api('/api/docker/status');
    } catch (e) {
      root.innerHTML = `<div class="card"><div class="placeholder"><h3>Docker 状态检查失败</h3><p>${escapeHtml(e.message)}</p></div></div>`;
      return;
    }

    // ---- 未安装 / 不可达：显示引导 ----
    if (!status.reachable) {
      const isPerm = status.permissionDenied;
      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h3>Docker 管理</h3>
            <span class="spacer"></span>
            <span class="chip ${isPerm ? 'warn' : ''}">${isPerm ? '权限不足' : '未检测到 Docker'}</span>
          </div>
          <div class="placeholder">
            <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M3 12h4v4H3zM8 12h4v4H8zM13 12h4v4h-4zM8 7h4v4H8zM13 7h4v4h-4z"/>
              <path d="M2 16h19c0 3-2.5 5-6 5H8c-3.5 0-6-2-6-5z"/>
            </svg>
            <h3>${isPerm ? '无权访问 Docker socket' : '本机尚未安装 Docker'}</h3>
            <p>${isPerm
              ? '面板进程需要访问 /var/run/docker.sock。请将运行面板的用户加入 docker 组，然后重启面板。'
              : '安装 Docker 后刷新此页，即可在这里管理容器、镜像、网络和数据卷。'}</p>
          </div>
        </div>

        ${isPerm ? `
        <div class="card">
          <div class="card-head"><h3>修复权限</h3></div>
          <pre class="mono" style="background:var(--bg);padding:14px;border-radius:8px;overflow-x:auto;font-size:12.5px;margin:0">sudo usermod -aG docker $USER
# 重新登录（或执行 newgrp docker）后重启面板</pre>
        </div>` : `
        <div class="card">
          <div class="card-head"><h3>安装 Docker</h3></div>
          <p class="muted" style="font-size:13px;margin:0 0 12px">
            以下命令需要 root 权限，请在终端手动执行。安装完成后点击「重新检测」。
          </p>
          <pre class="mono" style="background:var(--bg);padding:14px;border-radius:8px;overflow-x:auto;font-size:12.5px;margin:0 0 14px"># 官方安装脚本（推荐）
curl -fsSL https://get.docker.com | sudo sh

# 将当前用户加入 docker 组（免 sudo 使用）
sudo usermod -aG docker $USER

# 启动并设为开机自启
sudo systemctl enable --now docker</pre>
          <div class="muted" style="font-size:12px">
            说明：Docker 会占用 22 端口以外的资源，安装前请确认磁盘空间充足（当前根分区剩余
            ${fmtBytes((state.latest?.filesystems?.find(f => f.mountPoint === '/')?.free) ?? 0)}）。
          </div>
        </div>`}

        <div class="card">
          <div class="card-head"><h3>检测详情</h3></div>
          <div class="stat-row"><span class="k">docker 二进制</span><span class="v"><span class="chip ${status.installed ? 'ok' : ''}">${status.installed ? '已安装' : '未安装'}</span></span></div>
          <div class="stat-row"><span class="k">socket 可达</span><span class="v"><span class="chip ${status.reachable ? 'ok' : 'crit'}">${status.reachable ? '是' : '否'}</span></span></div>
          ${(status.candidates || []).map((c) => `
          <div class="stat-row"><span class="k mono" style="font-size:11.5px">${escapeHtml(c.socket)}</span><span class="v"><span class="chip ${c.exists ? 'ok' : ''}">${c.exists ? '存在' : '不存在'}</span></span></div>`).join('')}
          ${status.error ? `<div class="stat-row"><span class="k">错误</span><span class="v muted" style="font-size:12px">${escapeHtml(status.error)}</span></div>` : ''}
        </div>

        <div style="display:flex;gap:10px;margin-top:4px">
          <button class="btn btn-primary" id="docker-recheck">重新检测</button>
        </div>
      `;
      $('#docker-recheck', root).addEventListener('click', () => navigate('docker'));
      return;
    }

    // ---- 已安装：完整管理界面 ----
    const info = status.info || {};
    root.innerHTML = `
      <div class="grid grid-cards">
        <div class="card metric-card">
          <div class="metric-top"><div class="metric-label">运行中容器</div></div>
          <div class="metric-value" style="color:var(--green)">${info.containersRunning ?? 0}</div>
          <div class="metric-foot">共 ${info.containers ?? 0} 个</div>
        </div>
        <div class="card metric-card">
          <div class="metric-top"><div class="metric-label">已停止</div></div>
          <div class="metric-value" style="color:var(--text-dim)">${info.containersStopped ?? 0}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-top"><div class="metric-label">镜像</div></div>
          <div class="metric-value" style="color:var(--accent)">${info.images ?? 0}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-top"><div class="metric-label">Docker 版本</div></div>
          <div class="metric-value" style="font-size:20px">${escapeHtml(info.serverVersion || status.version || '')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>Compose 项目</h3>
          <span class="spacer"></span>
          <span class="card-sub">整体启动 / 停止 / 重启</span>
          <button class="btn btn-sm" id="docker-compose-refresh" type="button">刷新</button>
        </div>
        <div id="docker-compose"><div class="muted">加载中…</div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>容器</h3>
          <span class="spacer"></span>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-dim);cursor:pointer">
            <input type="checkbox" id="docker-show-all" checked> 显示已停止
          </label>
          <button class="btn btn-sm" id="docker-refresh">刷新</button>
        </div>
        <div id="docker-containers"><div class="muted">加载中…</div></div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>镜像</h3></div>
          <div id="docker-images"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>磁盘占用</h3></div>
          <div id="docker-df"><div class="muted">加载中…</div></div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>网络</h3></div>
          <div id="docker-networks"><div class="muted">加载中…</div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>数据卷</h3></div>
          <div id="docker-volumes"><div class="muted">加载中…</div></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Docker 信息</h3></div>
        <div class="grid grid-2" style="margin:0">
          <div id="docker-info-1"></div>
          <div id="docker-info-2"></div>
        </div>
      </div>
    `;

    const containersHost = $('#docker-containers', root);

    async function loadContainers() {
      const all = $('#docker-show-all', root)?.checked !== false;
      containersHost.innerHTML = '<div class="muted">加载中…</div>';
      try {
        const d = await api(`/api/docker/containers?all=${all ? 1 : 0}`);
        if (!d.ok) {
          containersHost.innerHTML = `<div class="placeholder"><p>${escapeHtml(d.error || '读取失败')}</p></div>`;
          return;
        }
        const list = d.containers || [];
        if (list.length === 0) {
          containersHost.innerHTML = '<div class="placeholder"><p>没有容器</p></div>';
          return;
        }

        containersHost.innerHTML = `
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>创建</th><th style="text-align:right">操作</th></tr>
              </thead>
              <tbody>
                ${list
                  .map((c) => {
                    const running = c.state === 'running';
                    // Docker 会为同一绑定同时返回 IPv4/IPv6 两条记录，需去重
                    const seenPorts = new Set();
                    const ports = (c.ports || [])
                      .filter((p) => p.publicPort)
                      .map((p) => `${p.publicPort}→${p.privatePort}/${p.type}`)
                      .filter((t) => (seenPorts.has(t) ? false : seenPorts.add(t)))
                      .join(', ');
                    return `
                  <tr>
                    <td class="mono"><b>${escapeHtml(c.name)}</b></td>
                    <td class="mono muted" style="font-size:11.5px">${escapeHtml(c.image)}</td>
                    <td><span class="chip ${running ? 'ok' : c.state === 'paused' ? 'warn' : ''}">${escapeHtml(c.state)}</span></td>
                    <td class="mono muted" style="font-size:11.5px">${escapeHtml(ports || '—')}</td>
                    <td class="muted" style="font-size:11.5px">${new Date(c.created).toLocaleDateString('zh-CN')}</td>
                    <td style="text-align:right;white-space:nowrap">
                      ${running
                        ? `<button class="btn btn-sm" data-act="shell" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">进入 shell</button>
                           <button class="btn btn-sm" data-act="stop" data-id="${escapeHtml(c.id)}">停止</button>
                           <button class="btn btn-sm" data-act="restart" data-id="${escapeHtml(c.id)}">重启</button>`
                        : `<button class="btn btn-sm" data-act="start" data-id="${escapeHtml(c.id)}">启动</button>`}
                      <button class="btn btn-sm" data-act="logs" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">日志</button>
                      <button class="btn btn-sm btn-danger" data-act="remove" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">删除</button>
                    </td>
                  </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:10px;font-size:12px">共 ${list.length} 个容器</div>
        `;

        // 操作绑定
        containersHost.querySelectorAll('button[data-act]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const act = btn.dataset.act;
            const id = btn.dataset.id;
            const name = btn.dataset.name || id.slice(0, 12);

            if (act === 'shell') {
              btn.disabled = true;
              btn.textContent = '打开中…';
              try {
                const sess = await api('/api/terminal/create', {
                  method: 'POST',
                  body: { container: id, cols: 100, rows: 30 },
                });
                state.terminalAttach = { id: sess.id, container: sess.container };
                toast(`已打开容器 ${name} 的 shell`, 'ok');
                navigate('terminal');
              } catch (e) {
                toast(`无法进入容器 shell：${e.message}`, 'err', 6000);
                btn.disabled = false;
                btn.textContent = '进入 shell';
              }
              return;
            }

            if (act === 'logs') {
              openContainerLogs(id, name);
              return;
            }

            if (act === 'remove') {
              if (!confirm(`确定删除容器「${name}」？\n\n此操作不可恢复，容器内未持久化的数据会丢失。`)) return;
              btn.disabled = true;
              try {
                await api('/api/docker/containers/remove', {
                  method: 'POST',
                  body: { id, force: true },
                });
                toast(`容器 ${name} 已删除`, 'ok');
                await loadContainers();
              } catch (e) {
                toast(e.message, 'err');
                btn.disabled = false;
              }
              return;
            }

            btn.disabled = true;
            try {
              await api('/api/docker/containers/action', {
                method: 'POST',
                body: { id, action: act },
              });
              toast(`${name}: ${act} 成功`, 'ok');
              await loadContainers();
            } catch (e) {
              toast(e.message, 'err');
              btn.disabled = false;
            }
          });
        });
      } catch (e) {
        containersHost.innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    async function loadCompose() {
      const box = $('#docker-compose', root);
      if (!box) return;
      box.innerHTML = '<div class="muted">加载中…</div>';
      try {
        const d = await api('/api/docker/compose');
        if (!d.ok) {
          box.innerHTML = `<div class="muted">${escapeHtml(d.error === 'docker_unavailable' ? 'Docker 不可用' : d.error || '读取失败')}</div>`;
          return;
        }
        const projects = Array.isArray(d.projects) ? d.projects : [];
        if (!projects.length) {
          box.innerHTML = '<div class="placeholder"><p>没有 Compose 项目</p></div>';
          return;
        }
        const statusChip = (st) =>
          st === 'running'
            ? '<span class="chip ok">运行中</span>'
            : st === 'partial'
              ? '<span class="chip warn">部分运行</span>'
              : '<span class="chip">已停止</span>';
        box.innerHTML = `<div class="host-list">${projects
          .map(
            (p) => `<div class="host-row">
              <div class="host-row-main">
                <div class="host-row-title">${escapeHtml(p.name)} ${statusChip(p.status)}</div>
                <div class="host-row-meta">容器 ${p.running}/${p.total} · 服务：${(p.services || [])
                  .map((svc) => escapeHtml(svc.name))
                  .join(', ') || '—'}</div>
              </div>
              <div class="svc-actions">
                <button class="btn btn-sm" type="button" data-compose-act="start" data-project="${escapeHtml(p.name)}">启动</button>
                <button class="btn btn-sm" type="button" data-compose-act="stop" data-project="${escapeHtml(p.name)}">停止</button>
                <button class="btn btn-sm" type="button" data-compose-act="restart" data-project="${escapeHtml(p.name)}">重启</button>
              </div>
            </div>`
          )
          .join('')}</div>`;
        box.querySelectorAll('[data-compose-act]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const project = btn.dataset.project;
            const action = btn.dataset.composeAct;
            const labels = { start: '启动', stop: '停止', restart: '重启' };
            if (!confirm(`确定${labels[action]} Compose 项目「${project}」的全部容器？`)) return;
            btn.disabled = true;
            const oldText = btn.textContent;
            btn.textContent = '执行中…';
            try {
              const res = await api('/api/docker/compose/action', {
                method: 'POST',
                body: { project, action },
              });
              const failed = (res.results || []).filter((r) => !r.ok).length;
              toast(
                failed
                  ? `${project} ${labels[action]}完成，${failed} 个容器失败`
                  : `${project} ${labels[action]}成功`,
                failed ? 'warn' : 'ok'
              );
              await loadCompose();
              await loadContainers();
            } catch (e) {
              toast(e.message, 'err', 6000);
              btn.disabled = false;
              btn.textContent = oldText;
            }
          });
        });
      } catch (e) {
        box.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }
    }

    async function loadImages() {
      try {
        const d = await api('/api/docker/images');
        const imgs = d.images || [];
        if (!d.ok || imgs.length === 0) {
          $('#docker-images', root).innerHTML = `<div class="muted">${d.ok ? '没有镜像' : escapeHtml(d.error || '')}</div>`;
          return;
        }
        $('#docker-images', root).innerHTML = `
          <div class="table-wrap" style="max-height:34vh;overflow-y:auto">
            <table class="data">
              <thead><tr><th>标签</th><th class="num">大小</th><th class="num">容器</th><th></th></tr></thead>
              <tbody>
                ${imgs
                  .map(
                    (i) => `
                  <tr>
                    <td class="mono" style="font-size:11.5px">${escapeHtml(i.tags.join(', '))}</td>
                    <td class="num">${fmtBytes(i.size)}</td>
                    <td class="num">${i.containers}</td>
                    <td><button class="btn btn-sm btn-danger" data-img="${escapeHtml(i.id)}" data-tag="${escapeHtml(i.tags[0])}">删除</button></td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `;
        $('#docker-images', root).querySelectorAll('button[data-img]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm(`删除镜像「${btn.dataset.tag}」？`)) return;
            btn.disabled = true;
            try {
              await api('/api/docker/images/remove', { method: 'POST', body: { id: btn.dataset.img } });
              toast('镜像已删除', 'ok');
              await loadImages();
            } catch (e) {
              toast(e.message, 'err');
              btn.disabled = false;
            }
          });
        });
      } catch (e) {
        $('#docker-images', root).innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }
    }

    async function loadMisc() {
      // 磁盘占用
      try {
        const d = await api('/api/docker/df');
        if (d.ok && d.usage) {
          const u = d.usage;
          const rows = [
            { k: '镜像', v: `${u.images.count} 个`, s: u.images.size },
            { k: '容器（可写层）', v: `${u.containers.count} 个`, s: u.containers.size },
            { k: '数据卷', v: `${u.volumes.count} 个`, s: u.volumes.size },
            { k: '构建缓存', v: `${u.buildCache.count} 个`, s: u.buildCache.size },
          ];
          $('#docker-df', root).innerHTML =
            rows
              .map(
                (r) => `
            <div class="stat-row">
              <span class="k">${r.k} <span class="muted" style="font-size:11px">${r.v}</span></span>
              <span class="v">${fmtBytes(r.s)}</span>
            </div>`
              )
              .join('') +
            `<div class="stat-row"><span class="k">镜像层总计</span><span class="v">${fmtBytes(u.layersSize)}</span></div>`;
        } else {
          $('#docker-df', root).innerHTML = `<div class="muted">${escapeHtml(d.error || '不可用')}</div>`;
        }
      } catch (e) {
        $('#docker-df', root).innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }

      // 网络
      try {
        const d = await api('/api/docker/networks');
        const nets = d.networks || [];
        $('#docker-networks', root).innerHTML = !d.ok
          ? `<div class="muted">${escapeHtml(d.error || '')}</div>`
          : nets.length === 0
          ? '<div class="muted">没有网络</div>'
          : nets
              .map(
                (n) => `
          <div class="stat-row">
            <span class="k mono">${escapeHtml(n.name)}${n.driver ? ` <span class="muted" style="font-size:11px">${escapeHtml(n.driver)}</span>` : ''}</span>
            <span class="v muted" style="font-size:11.5px">${escapeHtml(n.subnet || '—')} · ${n.containers} 容器</span>
          </div>`
              )
              .join('');
      } catch (e) {
        $('#docker-networks', root).innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }

      // 数据卷
      try {
        const d = await api('/api/docker/volumes');
        const vols = d.volumes || [];
        $('#docker-volumes', root).innerHTML = !d.ok
          ? `<div class="muted">${escapeHtml(d.error || '')}</div>`
          : vols.length === 0
          ? '<div class="muted">没有数据卷</div>'
          : vols
              .map(
                (v) => `
          <div class="stat-row">
            <span class="k mono">${escapeHtml(v.name)}</span>
            <span class="v muted" style="font-size:11.5px">${escapeHtml(v.driver)}</span>
          </div>`
              )
              .join('');
      } catch (e) {
        $('#docker-volumes', root).innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }

      // 信息
      $('#docker-info-1', root).innerHTML = `
        <div class="stat-row"><span class="k">主机名</span><span class="v mono">${escapeHtml(info.name || '')}</span></div>
        <div class="stat-row"><span class="k">操作系统</span><span class="v">${escapeHtml(info.operatingSystem || '')}</span></div>
        <div class="stat-row"><span class="k">内核</span><span class="v mono" style="font-size:11.5px">${escapeHtml(info.kernelVersion || '')}</span></div>
        <div class="stat-row"><span class="k">架构</span><span class="v">${escapeHtml(info.architecture || '')}</span></div>
        <div class="stat-row"><span class="k">CPU</span><span class="v">${info.cpus ?? '—'} 核</span></div>
        <div class="stat-row"><span class="k">内存</span><span class="v">${fmtBytes(info.memTotal)}</span></div>
      `;
      $('#docker-info-2', root).innerHTML = `
        <div class="stat-row"><span class="k">存储驱动</span><span class="v mono">${escapeHtml(info.storageDriver || '')}</span></div>
        <div class="stat-row"><span class="k">日志驱动</span><span class="v mono">${escapeHtml(info.loggingDriver || '')}</span></div>
        <div class="stat-row"><span class="k">Cgroup</span><span class="v">v${escapeHtml(info.cgroupVersion || '?')} (${escapeHtml(info.cgroupDriver || '')})</span></div>
        <div class="stat-row"><span class="k">数据目录</span><span class="v mono" style="font-size:11.5px">${escapeHtml(info.dockerRootDir || '')}</span></div>
        <div class="stat-row"><span class="k">暂停容器</span><span class="v">${info.containersPaused ?? 0}</span></div>
        <div class="stat-row"><span class="k">警告</span><span class="v">${(info.warnings || []).length}</span></div>
      `;
    }

    /** 容器日志弹窗 */
    function openContainerLogs(id, name) {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `
        <div class="modal" style="max-width:900px;width:100%">
          <div class="modal-head">
            <h3>容器日志 · ${escapeHtml(name)}</h3>
            <button class="icon-btn" data-close aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body" style="padding:0">
            <pre class="mono" style="margin:0;padding:16px;max-height:60vh;overflow:auto;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all">加载中…</pre>
          </div>
          <div class="modal-foot">
            <button class="btn" data-close>关闭</button>
          </div>
        </div>
      `;
      document.body.appendChild(wrap);
      const pre = wrap.querySelector('pre');
      const close = () => wrap.remove();
      wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close();
      });

      api(`/api/docker/containers/logs?id=${encodeURIComponent(id)}&tail=500`)
        .then((d) => {
          pre.textContent = (d.lines || []).join('\n') || '（无日志）';
          pre.scrollTop = pre.scrollHeight;
        })
        .catch((e) => {
          pre.textContent = `读取失败：${e.message}`;
        });
    }

    $('#docker-show-all', root).addEventListener('change', loadContainers);
    $('#docker-refresh', root).addEventListener('click', () => {
      loadContainers();
      loadCompose();
      loadImages();
      loadMisc();
    });
    $('#docker-compose-refresh', root).addEventListener('click', loadCompose);

    await Promise.all([loadContainers(), loadCompose(), loadImages(), loadMisc()]);
  }


  /* ======================================================================
     页面：压测（占位，默认关闭）
     ====================================================================== */
  async function renderBench(root) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>性能压测</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="bench-state">未运行</span>
          <span class="chip warn">会占满资源，请谨慎</span>
        </div>
        <div class="grid grid-3" style="margin-bottom:0">
          <label class="field" style="margin:0">
            <span>测试类型</span>
            <select id="bench-kind">
              <option value="cpu">CPU 多线程运算</option>
              <option value="memory">内存带宽与延迟</option>
              <option value="disk">磁盘读写</option>
              <option value="network">网络吞吐（loopback）</option>
            </select>
          </label>
          <label class="field" style="margin:0" id="bench-param1-wrap">
            <span id="bench-param1-label">线程数</span>
            <input type="number" id="bench-param1" value="8" min="1" max="64">
          </label>
          <label class="field" style="margin:0">
            <span>时长（秒，最长 300）</span>
            <input type="number" id="bench-duration" value="20" min="1" max="300">
          </label>
        </div>
        <div class="grid grid-3" style="margin-top:14px">
          <label class="field" style="margin:0" id="bench-param2-wrap">
            <span id="bench-param2-label">—</span>
            <input type="text" id="bench-param2" value="" disabled>
          </label>
          <div style="display:flex;align-items:flex-end;gap:10px;grid-column:span 2">
            <button class="btn btn-primary" id="bench-start">开始压测</button>
            <button class="btn btn-danger" id="bench-abort" disabled>中止</button>
            <span class="muted" style="font-size:12px" id="bench-hint"></span>
          </div>
        </div>
      </div>

      <div class="card hidden" id="bench-live">
        <div class="card-head">
          <h3>实时监控</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="bench-live-sub"></span>
        </div>
        <div class="chart-wrap" style="height:160px"><canvas id="bench-temp-chart"></canvas></div>
        <div class="legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#f85149"></span>温度 °C</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#2f81f7"></span>频率 MHz</span>
        </div>
        <div id="bench-progress" class="muted" style="font-size:12px;margin-top:10px"></div>
      </div>

      <div class="card hidden" id="bench-result-card">
        <div class="card-head">
          <h3>本次结果</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="bench-result-kind"></span>
        </div>
        <div id="bench-result"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>历史结果</h3>
          <span class="spacer"></span>
          <button class="btn btn-sm" id="bench-reload-history">刷新</button>
        </div>
        <div id="bench-history"><div class="muted">加载中…</div></div>
      </div>
    `;

    let pollTimer = null;
    let tempChart = null;
    let gpuChart = null;

    const KIND_CONFIG = {
      cpu: { p1Label: '线程数', p1Value: 8, p2Label: '—', p2Value: '', p2Disabled: true, hint: '多线程整数+浮点+哈希运算，统计吞吐与温度' },
      memory: { p1Label: '数据量（MB）', p1Value: 256, p2Label: '—', p2Value: '', p2Disabled: true, hint: '顺序读写带宽 + 随机访问延迟' },
      disk: { p1Label: '文件大小（MB）', p1Value: 256, p2Label: '模式', p2Value: 'sequential', p2Disabled: false, hint: '写入 /tmp，结束后自动删除；读取可能命中缓存' },
      network: {
        p1Label: '连接数（1/2/4）',
        p1Value: 1,
        p2Label: '消息大小',
        p2Value: '64',
        p2Disabled: false,
        hint: '本机 loopback 回环吞吐：只测本机 TCP 栈，不代表真实网卡/对端性能',
      },
    };

    function applyKind() {
      const k = $('#bench-kind', root).value;
      const c = KIND_CONFIG[k];
      $('#bench-param1-label', root).textContent = c.p1Label;
      $('#bench-param1', root).value = c.p1Value;
      $('#bench-param2-label', root).textContent = c.p2Label;
      if (k === 'disk') {
        // 模式用 select 更直观
        $('#bench-param2', root).outerHTML = `
          <select id="bench-param2" style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text)">
            <option value="sequential">顺序读写</option>
            <option value="random">随机读写</option>
          </select>`;
      } else if (k === 'network') {
        $('#bench-param2', root).outerHTML = `
          <select id="bench-param2" style="padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text)">
            <option value="16">16 KB</option>
            <option value="64" selected>64 KB</option>
            <option value="256">256 KB</option>
            <option value="1024">1 MB</option>
          </select>`;
      } else {
        const el = $('#bench-param2', root);
        if (el.tagName === 'SELECT') {
          el.outerHTML = `<input type="text" id="bench-param2" value="" disabled>`;
        }
      }
      // 只有磁盘测试需要第二个参数（模式），其余隐藏整列避免视觉噪音
      const p2wrap = $('#bench-param2-wrap', root);
      if (p2wrap) p2wrap.style.display = k === 'disk' || k === 'network' ? '' : 'none';
      const dur = $('#bench-duration', root);
      if (dur) {
        dur.max = k === 'network' ? '60' : '300';
        if (k === 'network' && Number(dur.value) > 60) dur.value = 60;
      }
      $('#bench-hint', root).textContent = c.hint;
    }

    function buildPayload() {
      const kind = $('#bench-kind', root).value;
      const p1 = Number($('#bench-param1', root).value) || 0;
      const durationSec = Number($('#bench-duration', root).value) || 20;
      if (kind === 'cpu') return { kind, threads: p1, durationSec };
      if (kind === 'memory') return { kind, sizeMb: p1, durationSec };
      if (kind === 'network') {
        return {
          kind: 'network',
          connected: p1,
          durationSec,
          msgSize: (Number($('#bench-param2', root)?.value) || 64) * 1024,
        };
      }
      return {
        kind,
        sizeMb: p1,
        durationSec,
        mode: $('#bench-param2', root)?.value || 'sequential',
        dir: '/tmp',
      };
    }

    function renderResult(r) {
      if (!r) return;
      $('#bench-result-card', root).classList.remove('hidden');
      $('#bench-result-kind', root).textContent =
        { cpu: 'CPU', memory: '内存', disk: '磁盘', network: '网络（loopback）' }[r.kind] + ' · ' + new Date(r.at).toLocaleString('zh-CN');

      const rows = [];
      const add = (k, v) => rows.push(`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`);

      if (r.kind === 'cpu') {
        add('线程数', r.threads);
        add('时长', (r.durationMs / 1000).toFixed(1) + ' 秒');
        add('总迭代次数', r.totalIterations.toLocaleString());
        add('吞吐', `<b>${r.opsPerSec.toLocaleString()}</b> ops/s`);
        add('评分', `<span class="chip info">${r.score.toLocaleString()}</span>`);
      } else if (r.kind === 'network') {
        add('模式', '<span class="chip warn">loopback 本机回环</span>');
        add('连接数', r.connected);
        add('消息大小', fmtBytes(r.msgSize));
        add('上行', `<b>${(r.upload && r.upload.mbps) ?? '—'}</b> MB/s`);
        add('下行', `<b>${(r.download && r.download.mbps) ?? '—'}</b> MB/s`);
        add('压测 CPU', `${r.cpuPercent ?? '—'}%`);
        if (r.note) add('说明', `<span class="muted" style="font-size:11.5px">${escapeHtml(r.note)}</span>`);
        if (r.aborted) add('状态', `<span class="chip warn">已中止${r.abortReason ? '：' + escapeHtml(r.abortReason) : ''}</span>`);
      } else if (r.kind === 'memory') {
        add('数据量', r.sizeMb + ' MB');
        add('顺序写', `<b>${r.sequential.writeMbs}</b> MB/s（${r.sequential.writeMs} ms）`);
        add('顺序读', `<b>${r.sequential.readMbs}</b> MB/s（${r.sequential.readMs} ms）`);
        add('随机访问延迟', `<b>${r.random.latencyNs}</b> ns/次`);
        add('随机访问', (r.random.opsPerSec / 1e6).toFixed(1) + 'M ops/s');
        add('评分', `<span class="chip info">${r.score} MB/s</span>`);
      } else {
        add('模式', r.mode === 'random' ? '随机' : '顺序');
        add('块大小', fmtBytes(r.blockSize));
        add('写入', `<b>${r.write.mbps}</b> MB/s · ${r.write.iops.toLocaleString()} IOPS`);
        add('读取', `<b>${r.read.mbps}</b> MB/s · ${r.read.iops.toLocaleString()} IOPS`);
        if (r.cacheNotice) add('提示', `<span class="muted" style="font-size:11.5px">${escapeHtml(r.cacheNotice)}</span>`);
      }

      if (r.temp) {
        add('温度', `起始 ${r.baseTemp ?? '—'}°C · 最高 <b>${r.temp.max}°C</b> · 平均 ${r.temp.avg}°C`);
        if (r.temp.freqMax) add('频率', `最高 ${r.temp.freqMax} MHz · 最低 ${r.temp.freqMin} MHz`);
      }
      if (r.gpu) {
        if (r.gpu.busyMax !== null && r.gpu.busyMax !== undefined) add('GPU 占用峰值', `${r.gpu.busyMax}%`);
        if (r.gpu.tempMax !== null && r.gpu.tempMax !== undefined) add('GPU 温度峰值', `${r.gpu.tempMax}°C`);
        if (r.gpu.powerMax !== null && r.gpu.powerMax !== undefined) add('GPU 功耗峰值', `${r.gpu.powerMax} W`);
      }
      if (r.aborted) add('状态', `<span class="chip warn">已中止${r.abortReason ? '：' + escapeHtml(r.abortReason) : ''}</span>`);

      $('#bench-result', root).innerHTML =
        rows.join('') +
        `<div class="bench-gpu-block hidden" id="bench-gpu-block">
          <div class="card-head" style="margin-top:14px"><h3>GPU 曲线</h3><span class="spacer"></span><span class="card-sub">占用 % / 温度 °C / 功耗 W</span></div>
          <div class="chart-wrap" style="height:190px"><canvas id="bench-gpu-chart"></canvas></div>
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#a371f7"></span>GPU 占用 %</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f85149"></span>温度 °C</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#d29922"></span>功耗 W</span>
          </div>
        </div>`;
      renderGpuChart(r);
    }

    function renderGpuChart(result) {
      if (gpuChart) {
        try { gpuChart.destroy && gpuChart.destroy(); } catch (e) { /* ignore */ }
        gpuChart = null;
        delete state.charts.benchGpu;
      }
      const block = $('#bench-gpu-block', root);
      if (!block) return;
      const samples = (result.samples || []).filter(
        (sample) => ['gpuBusy', 'gpuTempC', 'gpuPowerW'].some((key) => typeof sample[key] === 'number')
      );
      if (result.kind !== 'cpu' || samples.length === 0) {
        block.classList.add('hidden');
        return;
      }
      block.classList.remove('hidden');
      const canvas = $('#bench-gpu-chart', root);
      if (!canvas) return;
      gpuChart = new Charts.LineChart(canvas, {
        series: [
          { key: 'busy', name: 'GPU 占用 %', color: '#a371f7' },
          { key: 'temp', name: '温度 °C', color: '#f85149' },
          { key: 'power', name: '功耗 W', color: '#d29922' },
        ],
        maxPoints: 400,
      });
      gpuChart.setData(
        samples.map((sample) => ({
          values: {
            busy: sample.gpuBusy,
            temp: sample.gpuTempC,
            power: sample.gpuPowerW,
          },
        }))
      );
      state.charts.benchGpu = gpuChart;
    }

    async function loadHistory() {
      try {
        const d = await api('/api/bench/history');
        const list = d.results || [];
        if (list.length === 0) {
          $('#bench-history', root).innerHTML = '<div class="muted">还没有压测记录</div>';
          return;
        }
        $('#bench-history', root).innerHTML = `
          <div class="table-wrap scroll-y" style="max-height:40vh;overflow-y:auto">
            <table class="data">
              <thead><tr>
                <th>时间</th><th>类型</th><th class="num">评分</th>
                <th class="num">时长</th><th>参数</th>
              </tr></thead>
              <tbody>
                ${list.map(r => `
                  <tr>
                    <td class="muted" style="font-size:11.5px">${new Date(r.at).toLocaleString('zh-CN')}</td>
                    <td><span class="chip ${r.kind === 'cpu' ? 'info' : r.kind === 'memory' ? 'warn' : r.kind === 'network' ? 'crit' : 'ok'}">${{ cpu: 'CPU', memory: '内存', disk: '磁盘', network: '网络' }[r.kind] || r.kind}</span></td>
                    <td class="num">${r.detail?.aborted ? '<span class="chip warn">中止</span>' : `<b>${(r.score ?? 0).toLocaleString()}</b>`}</td>
                    <td class="num">${((r.durationMs ?? 0) / 1000).toFixed(1)}s</td>
                    <td class="mono muted" style="font-size:11px">${escapeHtml(
                      Object.entries(r.params || {})
                        .filter(([k]) => k !== 'kind')
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ') || '—'
                    )}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      } catch (e) {
        $('#bench-history', root).innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }
    }

    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      const collect = { temps: [], freqs: [] };
      pollTimer = setInterval(async () => {
        try {
          const s = await api('/api/bench/status');
          if (s.running) {
            $('#bench-state', root).textContent = `运行中 · ${s.kind} · ${Math.round(s.elapsedMs / 1000)}s`;
            $('#bench-live', root).classList.remove('hidden');

            // 温度/频率曲线
            const samples = s.tempSamples || [];
            if (tempChart) {
              tempChart.setData(samples.map(p => ({ values: { temp: p.temp, freq: p.freq } })));
            }
            const last = samples[samples.length - 1];
            $('#bench-live-sub', root).textContent =
              last ? `${last.temp ?? '—'}°C · ${last.freq ?? '—'}MHz` : '';

            const prog = s.progress || {};
            const parts = [];
            if (prog.stage) parts.push(`阶段：${prog.stage}`);
            if (prog.opsPerSec) parts.push(`吞吐：${Number(prog.opsPerSec).toLocaleString()} ops/s`);
            if (prog.iterations) parts.push(`累计迭代：${Number(prog.iterations).toLocaleString()}`);
            $('#bench-progress', root).textContent = parts.join(' · ');
          } else {
            $('#bench-state', root).textContent = '未运行';
            $('#bench-start', root).disabled = false;
            $('#bench-abort', root).disabled = true;
            if (s.lastResult) {
              renderResult(s.lastResult);
              $('#bench-live', root).classList.add('hidden');
            }
            clearInterval(pollTimer);
            pollTimer = null;
            loadHistory();
          }
        } catch (e) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 1000);
    }

    // ---- 事件 ----
    $('#bench-kind', root).addEventListener('change', applyKind);

    $('#bench-start', root).addEventListener('click', async () => {
      const payload = buildPayload();
      if (payload.kind === 'cpu' && payload.threads < 1) return toast('线程数无效', 'err');
      if ((payload.kind === 'memory' || payload.kind === 'disk') && payload.sizeMb < 16) {
        return toast('数据量至少 16 MB', 'err');
      }
      if (payload.kind === 'network') {
        if (![1, 2, 4].includes(payload.connected)) return toast('连接数只能是 1 / 2 / 4', 'err');
        if (payload.durationSec < 1 || payload.durationSec > 60) return toast('网络压测时长需为 1–60 秒', 'err');
        if (!(payload.msgSize >= 16 * 1024 && payload.msgSize <= 1024 * 1024)) {
          return toast('消息大小需在 16 KB – 1 MB 之间', 'err');
        }
      }
      if (!confirm(`即将开始 ${payload.kind.toUpperCase()} 压测，持续 ${payload.durationSec} 秒。\n\n压测期间会占满相应资源，CPU 温度过高会自动中止。是否继续？`)) {
        return;
      }

      $('#bench-start', root).disabled = true;
      $('#bench-abort', root).disabled = false;
      $('#bench-result-card', root).classList.add('hidden');

      // 初始化曲线
      const canvas = $('#bench-temp-chart', root);
      if (canvas) {
        tempChart = new Charts.LineChart(canvas, {
          series: [
            { key: 'temp', name: '温度', color: '#f85149' },
            { key: 'freq', name: '频率', color: '#2f81f7' },
          ],
          maxPoints: 300,
        });
        state.charts.benchTemp = tempChart;
      }

      try {
        await api('/api/bench/start', { method: 'POST', body: payload });
        toast('压测已启动', 'ok');
        startPolling();
      } catch (e) {
        toast(e.message, 'err');
        $('#bench-start', root).disabled = false;
        $('#bench-abort', root).disabled = true;
      }
    });

    $('#bench-abort', root).addEventListener('click', async () => {
      try {
        await api('/api/bench/abort', { method: 'POST', body: {} });
        toast('已中止', 'warn');
      } catch (e) {
        toast(e.message, 'err');
      }
    });

    $('#bench-reload-history', root).addEventListener('click', loadHistory);

    state.cleanups.push(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (gpuChart) {
        try { gpuChart.destroy && gpuChart.destroy(); } catch (e) { /* ignore */ }
      }
    });

    applyKind();
    await loadHistory();

    // 若已有任务在跑（比如刷新了页面），恢复监控
    try {
      const s = await api('/api/bench/status');
      if (s.running) {
        const canvas = $('#bench-temp-chart', root);
        if (canvas) {
          tempChart = new Charts.LineChart(canvas, {
            series: [
              { key: 'temp', name: '温度', color: '#f85149' },
              { key: 'freq', name: '频率', color: '#2f81f7' },
            ],
            maxPoints: 300,
          });
          state.charts.benchTemp = tempChart;
        }
        $('#bench-start', root).disabled = true;
        $('#bench-abort', root).disabled = false;
        startPolling();
      } else if (s.lastResult) {
        renderResult(s.lastResult);
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ======================================================================
     页面：告警（占位）
     ====================================================================== */
  /* ======================================================================
     B1：告警（状态机 / 规则 / 记录）
     ====================================================================== */
  const ALERT_METRIC_OPTIONS = [
    { value: 'cpuPercent', label: 'CPU 使用率 (%)' },
    { value: 'memPercent', label: '内存使用率 (%)' },
    { value: 'swapPercent', label: 'Swap 使用率 (%)' },
    { value: 'diskPercent', label: '磁盘使用率 (%)' },
    { value: 'cpuTempC', label: 'CPU 温度 (°C)' },
    { value: 'gpuTempC', label: 'GPU 温度 (°C)' },
    { value: 'load1', label: '1 分钟负载' },
    { value: 'loadPerCore', label: '每核负载' },
    { value: 'netRxKBs', label: '网络接收 (KB/s)' },
    { value: 'netTxKBs', label: '网络发送 (KB/s)' },
  ];
  const ALERT_METRIC_LABELS = Object.fromEntries(ALERT_METRIC_OPTIONS.map((m) => [m.value, m.label]));
  const ALERT_OPS = ['>', '>=', '<', '<='];
  const ALERT_SEVERITIES = ['warn', 'crit'];

  function alertMetricLabel(metric) {
    return ALERT_METRIC_LABELS[metric] || metric || '—';
  }

  function alertSeverityChip(severity) {
    if (severity === 'crit') return '<span class="chip crit">严重</span>';
    if (severity === 'warn') return '<span class="chip warn">警告</span>';
    return '<span class="chip">—</span>';
  }

  function fmtSpan(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分 ${sec % 60} 秒`;
    const h = Math.floor(min / 60);
    return `${h} 小时 ${min % 60} 分`;
  }

  /** B1 通用：把后端错误转成可读文案（接口未就绪时明确提示） */
  function featureErrorText(err, feature) {
    const msg = (err && err.message) || String(err || '');
    if (/接口不存在|not_found|404/i.test(msg)) return `${feature}接口尚不可用（后端未就绪）：需要更新并重启面板后端。`;
    if (/响应解析失败|Unexpected token|not valid JSON/i.test(msg)) return `${feature}接口暂不可用（后端返回了非 JSON 响应）。`;
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '无法连接面板服务，请检查网络后重试。';
    return msg || '未知错误';
  }

  function featureErrorHtml(title, err, feature) {
    const detail = (err && err.message) || String(err || '');
    return `<div class="dl-error"><strong>${escapeHtml(title)}</strong>${escapeHtml(featureErrorText(err, feature))}
      <details><summary>技术细节</summary><pre>${escapeHtml(detail)}</pre></details></div>`;
  }

  async function renderAlerts(root) {
    let rulesData = null; // { enabled, cooldownMinutes, notifyOnRecover, rules: [] }
    let globals = { enabled: true, cooldownMinutes: 10, notifyOnRecover: false };

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>当前告警</h3><span class="spacer"></span>
          <span class="card-sub" id="al-state-meta"></span>
          <button class="btn btn-sm" id="al-state-refresh" type="button">刷新</button>
        </div>
        <div id="al-state-body"><div class="placeholder"><div class="skeleton" style="width:60%;height:12px"></div></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>告警规则</h3><span class="spacer"></span>
          <button class="btn btn-sm" id="al-rules-add" type="button">+ 添加规则</button>
          <button class="btn btn-primary btn-sm" id="al-rules-save" type="button" disabled>保存规则</button>
        </div>
        <div id="al-rules-config"></div>
        <div id="al-rules-body"><div class="placeholder"><div class="skeleton" style="width:70%;height:12px"></div></div></div>
        <div class="form-error hidden" id="al-rules-error"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>告警记录</h3><span class="spacer"></span>
          <span class="card-sub" id="al-records-count"></span>
          <label class="remember-row al-filter"><input type="checkbox" id="al-unacked"><span>仅未确认</span></label>
          <button class="btn btn-sm" id="al-ack-all" type="button">全部确认</button>
          <button class="btn btn-sm" id="al-refresh" type="button">刷新</button>
        </div>
        <div id="al-records-body"><div class="placeholder"><div class="skeleton" style="width:65%;height:12px"></div></div></div>
      </div>`;

    const stateBody = $('#al-state-body', root);
    const rulesBody = $('#al-rules-body', root);
    const rulesError = $('#al-rules-error', root);
    const recordsBody = $('#al-records-body', root);

    function showRulesError(message) {
      rulesError.textContent = message;
      rulesError.classList.remove('hidden');
    }
    function hideRulesError() {
      rulesError.textContent = '';
      rulesError.classList.add('hidden');
    }

    /* ---------- 当前告警 ---------- */
    async function loadState() {
      stateBody.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:60%;height:12px"></div></div>';
      try {
        const data = await api('/api/alerts/state');
        const firing = Array.isArray(data.firing) ? data.firing : [];
        const lastEval = Number(data.lastEvalAt);
        $('#al-state-meta', root).textContent = Number.isFinite(lastEval) && lastEval > 0
          ? `最近评估 ${fmtDateTime(lastEval)}`
          : '';
        if (!firing.length) {
          stateBody.innerHTML = `<div class="al-ok">
            <span class="dot live"></span>
            <div><strong>一切正常</strong><p class="muted">当前没有触发中的告警。</p></div>
          </div>`;
          return;
        }
        stateBody.innerHTML = `<div class="al-firing">${firing
          .map((f) => {
            const since = Number(f.since);
            const span = Number.isFinite(since) ? fmtSpan(Date.now() - since) : '—';
            return `<div class="al-firing-row">
              ${alertSeverityChip(f.severity)}
              <div class="al-firing-main">
                <div class="al-firing-title">${escapeHtml(alertMetricLabel(f.metric))}</div>
                <div class="al-firing-meta">当前值 <b>${escapeHtml(String(f.value ?? '—'))}</b>
                  · 已持续 ${escapeHtml(span)}${Number.isFinite(since) ? ` · 开始于 ${escapeHtml(fmtDateTime(since))}` : ''}</div>
              </div>
            </div>`;
          })
          .join('')}</div>`;
      } catch (err) {
        stateBody.innerHTML = featureErrorHtml('当前告警状态加载失败', err, '告警状态');
      }
    }

    /* ---------- 规则 ---------- */
    function ruleRowHtml(rule, index) {
      const metricOpts = ALERT_METRIC_OPTIONS.map(
        (m) => `<option value="${m.value}"${m.value === rule.metric ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
      ).join('');
      const opOpts = ALERT_OPS.map(
        (op) => `<option value="${escapeHtml(op)}"${op === rule.op ? ' selected' : ''}>${escapeHtml(op)}</option>`
      ).join('');
      const sevOpts = ALERT_SEVERITIES.map(
        (s) =>
          `<option value="${s}"${s === rule.severity ? ' selected' : ''}>${s === 'crit' ? '严重' : '警告'}</option>`
      ).join('');
      return `<div class="al-rule-row" data-index="${index}" data-id="${escapeHtml(String(rule.id ?? ''))}">
        <label class="al-field"><span>指标</span><select data-f="metric">${metricOpts}</select></label>
        <label class="al-field"><span>条件</span><select data-f="op">${opOpts}</select></label>
        <label class="al-field"><span>阈值</span><input type="number" step="any" data-f="value" value="${escapeHtml(String(rule.value ?? ''))}"></label>
        <label class="al-field"><span>持续(秒)</span><input type="number" min="5" max="3600" step="1" data-f="durationSec" value="${escapeHtml(String(rule.durationSec ?? 60))}"></label>
        <label class="al-field"><span>级别</span><select data-f="severity">${sevOpts}</select></label>
        <label class="al-check"><input type="checkbox" data-f="enabled"${rule.enabled !== false ? ' checked' : ''}><span>启用</span></label>
        <button class="btn btn-sm btn-danger al-rule-del" type="button" data-remove-rule="${index}">删除</button>
      </div>`;
    }

    function configHtml() {
      return `<div class="al-global">
        <label class="remember-row"><input type="checkbox" id="al-enabled"${globals.enabled ? ' checked' : ''}><span>启用告警引擎</span></label>
        <label class="al-inline"><span>重复提醒冷却</span><input type="number" id="al-cooldown" min="0" max="1440" step="1" value="${Number(globals.cooldownMinutes) || 0}"><em>分钟</em></label>
        <label class="remember-row"><input type="checkbox" id="al-notify-recover"${globals.notifyOnRecover ? ' checked' : ''}><span>恢复时发送通知</span></label>
      </div>`;
    }

    function readGlobals() {
      const en = $('#al-enabled', root);
      if (en) {
        globals = {
          enabled: en.checked,
          cooldownMinutes: Number($('#al-cooldown', root).value),
          notifyOnRecover: $('#al-notify-recover', root).checked,
        };
      }
      return globals;
    }

    function collectRules() {
      return $$('.al-rule-row', root).map((row) => {
        const get = (sel) => row.querySelector(sel);
        return {
          id: row.dataset.id || undefined,
          metric: get('[data-f="metric"]').value,
          op: get('[data-f="op"]').value,
          value: get('[data-f="value"]').value,
          durationSec: get('[data-f="durationSec"]').value,
          severity: get('[data-f="severity"]').value,
          enabled: get('[data-f="enabled"]').checked,
        };
      });
    }

    function renderRules() {
      if (!rulesData) return;
      $('#al-rules-config', root).innerHTML = configHtml();
      if (!rulesData.rules.length) {
        rulesBody.innerHTML = '<div class="placeholder"><p>还没有规则，点击「添加规则」创建第一条。</p></div>';
        return;
      }
      rulesBody.innerHTML = `<div class="al-rules">${rulesData.rules.map((r, i) => ruleRowHtml(r, i)).join('')}</div>`;
    }

    async function loadRules() {
      rulesBody.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:70%;height:12px"></div></div>';
      $('#al-rules-save', root).disabled = true;
      try {
        const data = await api('/api/alerts/rules');
        rulesData = {
          enabled: data.enabled !== false,
          cooldownMinutes: Number(data.cooldownMinutes) || 0,
          notifyOnRecover: data.notifyOnRecover === true,
          rules: (Array.isArray(data.rules) ? data.rules : []).map((r) => ({ ...r })),
        };
        globals = {
          enabled: rulesData.enabled,
          cooldownMinutes: rulesData.cooldownMinutes,
          notifyOnRecover: rulesData.notifyOnRecover,
        };
        hideRulesError();
        renderRules();
        $('#al-rules-save', root).disabled = false;
      } catch (err) {
        rulesData = null;
        $('#al-rules-config', root).innerHTML = '';
        rulesBody.innerHTML =
          featureErrorHtml('告警规则加载失败', err, '告警规则') +
          '<button class="btn btn-sm" id="al-rules-retry" type="button">重试</button>';
        $('#al-rules-retry', root)?.addEventListener('click', loadRules);
      }
    }

    async function saveRules() {
      if (!rulesData) return;
      readGlobals();
      const rows = collectRules();
      const errors = [];
      rows.forEach((r, idx) => {
        const n = idx + 1;
        if (!ALERT_METRIC_LABELS[r.metric]) errors.push(`第 ${n} 行：指标无效`);
        if (!ALERT_OPS.includes(r.op)) errors.push(`第 ${n} 行：条件无效`);
        const v = Number(r.value);
        if (String(r.value).trim() === '' || !Number.isFinite(v)) errors.push(`第 ${n} 行：阈值必须是数字`);
        const d = Number(r.durationSec);
        if (!Number.isInteger(d) || d < 5 || d > 3600) errors.push(`第 ${n} 行：持续秒数需为 5–3600 的整数`);
        if (!ALERT_SEVERITIES.includes(r.severity)) errors.push(`第 ${n} 行：级别无效`);
      });
      if (rows.length > 30) errors.push('规则最多 30 条');
      const cooldown = Number(globals.cooldownMinutes);
      if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) {
        errors.push('重复提醒冷却需为 0–1440 分钟的整数');
      }
      if (errors.length) {
        showRulesError(errors.join('；'));
        return;
      }
      hideRulesError();
      const btn = $('#al-rules-save', root);
      if (btn) {
        btn.disabled = true;
        btn.textContent = '保存中…';
      }
      try {
        const payload = {
          enabled: globals.enabled,
          cooldownMinutes: cooldown,
          notifyOnRecover: globals.notifyOnRecover,
          rules: rows.map((r) => {
            const rule = {
              metric: r.metric,
              op: r.op,
              value: Number(r.value),
              durationSec: Number(r.durationSec),
              severity: r.severity,
              enabled: r.enabled,
            };
            if (r.id !== undefined && r.id !== '') rule.id = r.id;
            return rule;
          }),
        };
        const data = await api('/api/alerts/rules', { method: 'PUT', body: payload });
        const saved = Array.isArray(data.rules) ? data.rules : payload.rules;
        rulesData = {
          enabled: data.enabled !== undefined ? data.enabled !== false : globals.enabled,
          cooldownMinutes: data.cooldownMinutes !== undefined ? Number(data.cooldownMinutes) : cooldown,
          notifyOnRecover: data.notifyOnRecover !== undefined ? data.notifyOnRecover === true : globals.notifyOnRecover,
          rules: saved.map((r) => ({ ...r })),
        };
        globals = {
          enabled: rulesData.enabled,
          cooldownMinutes: rulesData.cooldownMinutes,
          notifyOnRecover: rulesData.notifyOnRecover,
        };
        renderRules();
        toast('告警规则已保存', 'ok');
        loadState();
      } catch (err) {
        showRulesError(featureErrorText(err, '告警规则'));
        toast('保存失败：' + featureErrorText(err, '告警规则'), 'err', 5000);
      } finally {
        if (btn) {
          btn.disabled = !rulesData;
          btn.textContent = '保存规则';
        }
      }
    }

    /* ---------- 告警记录 ---------- */
    function recordRowHtml(a) {
      const acknowledged = a.acknowledged === true;
      return `<div class="al-record-row">
        <div class="al-record-main">
          <div class="al-record-title">
            ${alertSeverityChip(a.severity)}
            <span class="al-record-metric">${escapeHtml(alertMetricLabel(a.metric))}</span>
            <span class="mono muted">${escapeHtml(String(a.value ?? '—'))}</span>
            <span class="muted">/ 阈值 ${escapeHtml(String(a.threshold ?? '—'))}</span>
          </div>
          <div class="al-record-msg">${escapeHtml(a.message || '')}</div>
          <div class="al-record-meta">${escapeHtml(fmtDateTime(Number(a.ts)))} ·
            ${acknowledged ? '<span class="chip ok">已确认</span>' : '<span class="chip warn">未确认</span>'}
          </div>
        </div>
        ${acknowledged ? '' : `<button class="btn btn-sm" type="button" data-ack="${escapeHtml(String(a.id ?? ''))}">确认</button>`}
      </div>`;
    }

    async function loadRecords() {
      recordsBody.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:65%;height:12px"></div></div>';
      try {
        const qs = new URLSearchParams({ limit: '200' });
        const unacked = $('#al-unacked', root);
        if (unacked && unacked.checked) qs.set('unacked', '1');
        const data = await api('/api/alerts?' + qs.toString());
        const alerts = Array.isArray(data.alerts) ? data.alerts : [];
        $('#al-records-count', root).textContent = `共 ${alerts.length} 条`;
        if (!alerts.length) {
          recordsBody.innerHTML = '<div class="placeholder"><h3>暂无告警记录</h3><p>触发告警后会在这里显示，可在此确认处理。</p></div>';
          return;
        }
        recordsBody.innerHTML = `<div class="al-records">${alerts.map(recordRowHtml).join('')}</div>`;
      } catch (err) {
        recordsBody.innerHTML = featureErrorHtml('告警记录加载失败', err, '告警记录');
      }
    }

    /* ---------- 事件 ---------- */
    $('#al-state-refresh', root).addEventListener('click', loadState);
    $('#al-refresh', root).addEventListener('click', loadRecords);
    $('#al-unacked', root).addEventListener('change', loadRecords);
    $('#al-rules-add', root).addEventListener('click', () => {
      if (!rulesData) return;
      readGlobals();
      rulesData.rules = collectRules();
      if (rulesData.rules.length >= 30) {
        toast('规则最多 30 条', 'warn');
        return;
      }
      rulesData.rules.push({ metric: 'cpuPercent', op: '>', value: 90, durationSec: 60, severity: 'warn', enabled: true });
      renderRules();
    });
    rulesBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-rule]');
      if (!btn || !rulesData) return;
      readGlobals();
      rulesData.rules = collectRules();
      rulesData.rules.splice(Number(btn.dataset.removeRule), 1);
      renderRules();
    });
    $('#al-rules-save', root).addEventListener('click', saveRules);

    recordsBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-ack]');
      if (!btn) return;
      btn.disabled = true;
      try {
        await api('/api/alerts/ack', { method: 'POST', body: { id: btn.dataset.ack } });
        toast('已确认该告警', 'ok');
        loadRecords();
        loadState();
      } catch (err) {
        toast(featureErrorText(err, '告警确认'), 'err', 5000);
        btn.disabled = false;
      }
    });
    $('#al-ack-all', root).addEventListener('click', async () => {
      try {
        const data = await api('/api/alerts/ack_all', { method: 'POST', body: {} });
        toast(Number(data.count) > 0 ? `已确认 ${data.count} 条告警` : '没有未确认的告警', 'ok');
        loadRecords();
        loadState();
      } catch (err) {
        toast(featureErrorText(err, '告警确认'), 'err', 5000);
      }
    });

    loadState();
    loadRules();
    loadRecords();
  }

  /* ======================================================================
     页面：审计日志
     ====================================================================== */
  /**
   * 兼容后端旧解析：audit.log 中不带 IP 的日志行可能被误解析成
   * ip=消息首词、action=后续片段。这里仅在 ip 明显不是 IP 时做一次还原，
   * 后端修复 parseAuditLine 后此函数不会改变正常数据。
   */
  function normalizeAuditEntry(entry) {
    let ip = String(entry.ip || '');
    let action = String(entry.action || '');
    let detail = String(entry.detail || '');
    const ipLike = !ip || /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+|\[[0-9a-fA-F:]+\]|-)$/.test(ip);
    if (!ipLike) {
      const combined = [ip, action, detail].map((x) => x.trim()).filter(Boolean).join(' ');
      const sp = combined.search(/\s/);
      action = sp > 0 ? combined.slice(0, sp) : combined;
      detail = sp > 0 ? combined.slice(sp + 1).trim() : '';
      ip = '—';
    }
    return { ts: entry.ts, ip, action, detail };
  }

  function auditRowHtml(entry) {
    entry = normalizeAuditEntry(entry);
    return `<div class="audit-row">
      <div class="audit-time mono">${escapeHtml(fmtAnyTime(entry.ts))}</div>
      <div class="audit-main">
        <div class="audit-action">
          <span class="chip info">${escapeHtml(entry.action || '—')}</span>
          <span class="audit-ip mono">${escapeHtml(entry.ip || '—')}</span>
        </div>
        <div class="audit-detail">${escapeHtml(entry.detail || '')}</div>
      </div>
    </div>`;
  }

  async function renderAudit(root) {
    const a = state.audit || (state.audit = { q: '', offset: 0, limit: 200, total: 0 });
    const bodyLimit = a.limit;

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>审计日志</h3><span class="spacer"></span>
          <input type="search" class="au-search" id="au-q" placeholder="搜索动作 / 详情 / IP" value="${escapeHtml(a.q)}">
          <button class="btn btn-sm" id="au-search" type="button">搜索</button>
          <button class="btn btn-sm" id="au-refresh" type="button">刷新</button>
        </div>
        <div id="au-body"><div class="placeholder"><div class="skeleton" style="width:70%;height:12px"></div></div></div>
        <div class="au-pager" id="au-pager"></div>
      </div>`;

    const body = $('#au-body', root);
    const pager = $('#au-pager', root);

    function renderPager(count, truncated) {
      const from = a.total ? a.offset + 1 : 0;
      const to = a.offset + count;
      const total = Number.isFinite(a.total) ? a.total : 0;
      const capped = truncated && to >= total;
      pager.innerHTML = `
        <span class="muted">${total ? `第 ${from}–${to} 条 / 共 ${total} 条` : '共 0 条'}${capped ? '（日志文件较大，仅展示末尾部分）' : ''}</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="au-prev" type="button"${a.offset <= 0 ? ' disabled' : ''}>上一页</button>
        <button class="btn btn-sm" id="au-next" type="button"${to >= total ? ' disabled' : ''}>下一页</button>`;
      $('#au-prev', root)?.addEventListener('click', () => {
        a.offset = Math.max(0, a.offset - bodyLimit);
        load();
      });
      $('#au-next', root)?.addEventListener('click', () => {
        a.offset += bodyLimit;
        load();
      });
    }

    async function load() {
      body.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:70%;height:12px"></div></div>';
      pager.innerHTML = '';
      try {
        const qs = new URLSearchParams({ limit: String(bodyLimit), offset: String(a.offset) });
        if (a.q) qs.set('q', a.q);
        const data = await api('/api/audit?' + qs.toString());
        const entries = Array.isArray(data.entries) ? data.entries : [];
        a.total = Number.isFinite(Number(data.total)) ? Number(data.total) : entries.length;
        if (!entries.length) {
          body.innerHTML = '<div class="placeholder"><h3>没有审计记录</h3><p>登录、危险操作等会记录在这里。</p></div>';
          renderPager(0, false);
          return;
        }
        body.innerHTML = `<div class="audit-list">${entries.map(auditRowHtml).join('')}</div>`;
        renderPager(entries.length, data.truncated === true);
      } catch (err) {
        body.innerHTML =
          featureErrorHtml('审计日志加载失败', err, '审计') +
          '<button class="btn btn-sm" id="au-retry" type="button">重试</button>';
        $('#au-retry', root)?.addEventListener('click', load);
      }
    }

    $('#au-search', root).addEventListener('click', () => {
      a.q = $('#au-q', root).value.trim();
      a.offset = 0;
      load();
    });
    $('#au-q', root).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#au-search', root).click();
      }
    });
    $('#au-refresh', root).addEventListener('click', load);
    load();
  }

  /* ======================================================================
     页面：文件管理
     ====================================================================== */
  /** 目录选择弹层（批量移动/复制用；仅选择目录） */
  function openDirPicker(startPath, onPick) {
    let currentPath = startPath || '/';
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.id = 'fm-dirpicker';
    wrap.innerHTML = `
      <div class="modal" style="max-width:720px">
        <div class="modal-head">
          <h3>选择目标目录</h3>
          <button class="icon-btn" type="button" data-close aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="fb-toolbar">
            <button class="btn btn-sm" type="button" id="dp-up">↑ 上级</button>
            <button class="btn btn-sm" type="button" id="dp-refresh">刷新</button>
            <span class="mono muted fb-path" id="dp-path" style="margin-left:auto"></span>
          </div>
          <div class="fb-list" id="dp-list"><div class="fb-empty">加载中…</div></div>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" data-close>取消</button>
          <button class="btn btn-primary" id="dp-pick" type="button">选择当前目录</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);

    async function load(dir) {
      const list = $('#dp-list');
      if (!list) return;
      list.innerHTML = '<div class="fb-empty">加载中…</div>';
      try {
        const d = await api('/api/files/list?path=' + encodeURIComponent(dir));
        currentPath = d.path || dir;
        const pathEl = $('#dp-path');
        if (pathEl) pathEl.textContent = currentPath;
        const upBtn = $('#dp-up');
        if (upBtn) upBtn.disabled = !d.parent;
        const dirs = (d.entries || []).filter((e) => e.isDir);
        if (!dirs.length) {
          list.innerHTML = '<div class="fb-empty">没有子目录</div>';
          return;
        }
        list.innerHTML = dirs
          .map(
            (e) => `<div class="fb-row" data-dir="${escapeHtml(e.path)}">
              <span class="fb-icon">📁</span>
              <span class="fb-name">${escapeHtml(e.name)}</span>
            </div>`
          )
          .join('');
        list.querySelectorAll('[data-dir]').forEach((row) => {
          row.addEventListener('click', () => load(row.dataset.dir));
        });
      } catch (err) {
        list.innerHTML = `<div class="fb-empty">${escapeHtml(err.message)}</div>`;
      }
    }
    $('#dp-up').addEventListener('click', () => {
      const parts = currentPath.split('/').filter(Boolean);
      if (!parts.length) return;
      parts.pop();
      load('/' + parts.join('/'));
    });
    $('#dp-refresh').addEventListener('click', () => load(currentPath));
    $('#dp-pick').addEventListener('click', () => {
      const target = currentPath;
      close();
      onPick(target);
    });
    load(currentPath);
  }

  async function renderFiles(root) {
    let currentPath = '/';
    let showHidden = false;
    const selected = new Set();

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>文件管理</h3>
          <span class="spacer"></span>
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-dim);cursor:pointer">
            <input type="checkbox" id="fm-hidden"> 显示隐藏
          </label>
          <button class="btn btn-sm" id="fm-refresh">刷新</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <button class="btn btn-sm" id="fm-up">↑ 上级</button>
          <button class="btn btn-sm" id="fm-mkdir">新建目录</button>
          <button class="btn btn-sm" id="fm-touch">新建文件</button>
          <button class="btn btn-sm" id="fm-upload">上传</button>
          <input type="file" id="fm-file-input" multiple style="display:none">
          <span class="mono muted" id="fm-path" style="font-size:12.5px;margin-left:auto"></span>
        </div>
        <div id="fm-usage" class="muted" style="font-size:12px;margin-bottom:10px"></div>
        <div id="fm-batch-bar" class="fm-batch hidden">
          <span id="fm-sel-count">已选 0 项</span>
          <span class="spacer"></span>
          <button class="btn btn-sm btn-danger" id="fm-batch-delete" type="button">移入回收站</button>
          <button class="btn btn-sm" id="fm-batch-move" type="button">移动到…</button>
          <button class="btn btn-sm" id="fm-batch-copy" type="button">复制到…</button>
          <button class="btn btn-sm" id="fm-batch-clear" type="button">取消选择</button>
        </div>
        <div id="fm-body"><div class="muted">加载中…</div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <h3>回收站</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="fm-trash-count"></span>
          <button class="btn btn-sm" id="fm-trash-refresh" type="button">刷新</button>
          <button class="btn btn-sm btn-danger" id="fm-trash-clear" type="button" disabled>清空回收站</button>
        </div>
        <div id="fm-trash-body"><div class="muted">加载中…</div></div>
      </div>
    `;

    async function load(dir) {
      try {
        const qs = new URLSearchParams({ path: dir });
        if (showHidden) qs.set('hidden', '1');
        const d = await api('/api/files/list?' + qs.toString());
        currentPath = d.path;

        $('#fm-path', root).textContent = d.path;
        $('#fm-up', root).disabled = !d.parent;

        if (d.usage) {
          const pct = ((d.usage.used / d.usage.total) * 100).toFixed(1);
          $('#fm-usage', root).innerHTML =
            `磁盘用量 <b>${fmtBytes(d.usage.used)}</b> / ${fmtBytes(d.usage.total)}（${pct}%）` +
            ` · 可用 ${fmtBytes(d.usage.free)}` +
            (d.writable ? '' : ' · <span class="chip warn">只读</span>');
        }

        if (d.entries.length === 0) {
          $('#fm-body', root).innerHTML = '<div class="placeholder"><p>空目录</p></div>';
          return;
        }

        $('#fm-body', root).innerHTML = `
          <div class="table-wrap scroll-y" style="max-height:60vh;overflow-y:auto">
            <table class="data">
              <thead><tr>
                <th style="width:34px"><input type="checkbox" id="fm-select-all" class="fm-check" title="全选当前目录"></th>
                <th>名称</th><th class="num">大小</th><th>权限</th>
                <th>修改时间</th><th style="text-align:right">操作</th>
              </tr></thead>
              <tbody>
                ${d.entries.map((e) => {
                  const icon = e.isDir ? '📁' : ({ image: '🖼️', video: '🎬', audio: '🎵', archive: '📦', code: '📜' }[e.kind] || '📄');
                  const isText = ['file', 'code', 'unknown'].includes(e.kind);
                  const isArchive = e.kind === 'archive';
                  return `
                  <tr>
                    <td><input type="checkbox" class="fm-check fm-sel" data-sel="${escapeHtml(e.path)}"></td>
                    <td>
                      <span style="cursor:${e.isDir ? 'pointer' : 'default'}">${icon}</span>
                      <span class="mono" style="${e.isDir ? 'cursor:pointer;color:var(--accent)' : ''}"
                            ${e.isDir ? `data-nav="${escapeHtml(e.path)}"` : ''}>${escapeHtml(e.name)}</span>
                      ${e.linkTarget ? `<span class="muted" style="font-size:11px">→ ${escapeHtml(e.linkTarget)}</span>` : ''}
                    </td>
                    <td class="num">${e.sizeText}</td>
                    <td class="mono muted" style="font-size:11.5px">${e.mode}</td>
                    <td class="muted" style="font-size:11.5px">${e.mtime ? new Date(e.mtime).toLocaleString('zh-CN') : '—'}</td>
                    <td style="text-align:right;white-space:nowrap">
                      ${e.isDir ? '' : `<button class="btn btn-sm" data-dl="${escapeHtml(e.path)}">下载</button>`}
                      ${isText && !e.isDir ? `<button class="btn btn-sm" data-edit="${escapeHtml(e.path)}">编辑</button>` : ''}
                      ${isArchive ? `<button class="btn btn-sm" data-extract="${escapeHtml(e.path)}">解压</button>` : ''}
                      <button class="btn btn-sm" data-rename="${escapeHtml(e.path)}" data-name="${escapeHtml(e.name)}">重命名</button>
                      <button class="btn btn-sm btn-danger" data-del="${escapeHtml(e.path)}" data-name="${escapeHtml(e.name)}" data-isdir="${e.isDir}">移入回收站</button>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:10px;font-size:12px">
            ${d.total} 项${d.truncated ? `（仅显示前 ${d.entries.length} 项）` : ''}
          </div>
        `;

        // 多选
        selected.clear();
        updateBatchBar();
        const selAll = $('#fm-select-all', root);
        const boxes = $$('.fm-sel', root);
        boxes.forEach((cb) => {
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(cb.dataset.sel);
            else selected.delete(cb.dataset.sel);
            updateBatchBar();
          });
        });
        if (selAll) {
          selAll.addEventListener('change', () => {
            boxes.forEach((cb) => {
              cb.checked = selAll.checked;
              if (selAll.checked) selected.add(cb.dataset.sel);
              else selected.delete(cb.dataset.sel);
            });
            updateBatchBar();
          });
        }

        // 绑定事件
        $('#fm-body', root).querySelectorAll('[data-nav]').forEach((el) => {
          el.addEventListener('click', () => load(el.dataset.nav));
        });

        $('#fm-body', root).querySelectorAll('[data-dl]').forEach((btn) => {
          btn.addEventListener('click', () => {
            window.open('/api/files/download?path=' + encodeURIComponent(btn.dataset.dl), '_blank');
          });
        });

        $('#fm-body', root).querySelectorAll('[data-edit]').forEach((btn) => {
          btn.addEventListener('click', () => openEditor(btn.dataset.edit));
        });

        $('#fm-body', root).querySelectorAll('[data-extract]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const dest = prompt('解压到哪个目录？', currentPath + '/' + btn.dataset.extract.split('/').pop().replace(/\.(zip|tar\.gz|tgz|tar|tar\.xz|tar\.bz2|gz)$/i, ''));
            if (!dest) return;
            try {
              await api('/api/files/extract', { method: 'POST', body: { archive: btn.dataset.extract, dest } });
              toast('解压完成', 'ok');
              load(currentPath);
            } catch (e) { toast(e.message, 'err'); }
          });
        });

        $('#fm-body', root).querySelectorAll('[data-rename]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const newName = prompt('新名称：', btn.dataset.name);
            if (!newName || newName === btn.dataset.name) return;
            const dir = btn.dataset.rename.slice(0, btn.dataset.rename.length - btn.dataset.name.length);
            try {
              await api('/api/files/rename', { method: 'POST', body: { from: btn.dataset.rename, to: dir + newName } });
              toast('已重命名', 'ok');
              load(currentPath);
            } catch (e) { toast(e.message, 'err'); }
          });
        });

        $('#fm-body', root).querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const isDir = btn.dataset.isdir === 'true';
            const msg = isDir
              ? `确定将目录「${btn.dataset.name}」及其全部内容移入回收站？\n\n可在页面下方「回收站」中恢复。`
              : `确定将「${btn.dataset.name}」移入回收站？`;
            if (!confirm(msg)) return;
            try {
              await api('/api/files/delete', { method: 'POST', body: { path: btn.dataset.del } });
              toast('已移入回收站', 'ok');
              load(currentPath);
              loadTrash();
            } catch (e) { toast(e.message, 'err'); }
          });
        });
      } catch (e) {
        $('#fm-body', root).innerHTML = `<div class="placeholder"><p>${escapeHtml(e.message)}</p></div>`;
      }
    }

    function updateBatchBar() {
      const bar = $('#fm-batch-bar', root);
      if (!bar) return;
      bar.classList.toggle('hidden', selected.size === 0);
      const count = $('#fm-sel-count', root);
      if (count) count.textContent = `已选 ${selected.size} 项`;
      const boxes = $$('.fm-sel', root);
      const selAll = $('#fm-select-all', root);
      if (selAll && boxes.length) {
        selAll.checked = selected.size === boxes.length;
        selAll.indeterminate = selected.size > 0 && selected.size < boxes.length;
      }
    }

    function showBatchConflicts(err, op) {
      const conflicts = err && err.data && Array.isArray(err.data.conflicts) ? err.data.conflicts : [];
      if (!conflicts.length) {
        toast(err && err.message ? err.message : '批量操作失败', 'err', 6000);
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.id = 'fm-conflict-modal';
      wrap.innerHTML = `
        <div class="modal" style="max-width:640px">
          <div class="modal-head">
            <h3>批量${op === 'copy' ? '复制' : '移动'}冲突</h3>
            <button class="icon-btn" type="button" data-close aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="notice">目标目录中存在同名项，本次未执行任何操作。</div>
            <div class="host-list">${conflicts
              .map(
                (c) => `<div class="host-row"><div class="host-row-main">
                  <div class="host-row-title mono">${escapeHtml(String(c.path || ''))}</div>
                  <div class="host-row-meta">${escapeHtml(String(c.dest || ''))} · ${escapeHtml(String(c.reason || ''))}</div>
                </div></div>`
              )
              .join('')}</div>
          </div>
          <div class="modal-foot"><button class="btn" type="button" data-close>关闭</button></div>
        </div>`;
      document.body.appendChild(wrap);
      const close = () => wrap.remove();
      wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
      state.cleanups.push(close);
    }

    async function batchDelete() {
      const paths = [...selected];
      if (!paths.length) return;
      if (!confirm(`确定将选中的 ${paths.length} 项移入回收站？`)) return;
      try {
        const d = await api('/api/files/delete', { method: 'POST', body: { paths } });
        toast(`已移入回收站 ${(d.trashed || paths).length} 项`, 'ok');
        selected.clear();
        updateBatchBar();
        await load(currentPath);
        loadTrash();
      } catch (e) {
        toast(e.message, 'err', 6000);
      }
    }

    function batchTransfer(op) {
      const paths = [...selected];
      if (!paths.length) return;
      openDirPicker(currentPath, async (target) => {
        if (!target) return;
        try {
          const d = await api('/api/files/batch', { method: 'POST', body: { op, paths, target } });
          toast(`已${op === 'copy' ? '复制' : '移动'} ${(d.done || []).length} 项到 ${target}`, 'ok');
          selected.clear();
          updateBatchBar();
          load(currentPath);
        } catch (e) {
          showBatchConflicts(e, op);
        }
      });
    }

    async function loadTrash() {
      const body = $('#fm-trash-body', root);
      if (!body) return;
      body.innerHTML = '<div class="muted">加载中…</div>';
      try {
        const d = await api('/api/trash/list');
        const entries = Array.isArray(d.entries) ? d.entries : [];
        const countEl = $('#fm-trash-count', root);
        if (countEl) countEl.textContent = entries.length ? `${entries.length} 项` : '空';
        const clearBtn = $('#fm-trash-clear', root);
        if (clearBtn) clearBtn.disabled = entries.length === 0;
        if (!entries.length) {
          body.innerHTML = '<div class="placeholder"><p>回收站为空</p></div>';
          return;
        }
        body.innerHTML = `<div class="host-list">${entries
          .map(
            (e) => `<div class="host-row">
              <div class="host-row-main">
                <div class="host-row-title">${escapeHtml(e.name || '—')}</div>
                <div class="host-row-meta">${escapeHtml(e.path || '')} · ${Number.isFinite(Number(e.size)) ? fmtBytes(Number(e.size)) : '—'} · ${escapeHtml(fmtDateTime(Number(e.deletedAt)))}${e.type === 'dir' ? ' · 目录' : ''}</div>
              </div>
              <div class="svc-actions">
                <button class="btn btn-sm" type="button" data-trash-restore="${escapeHtml(String(e.id))}">恢复</button>
                <button class="btn btn-sm btn-danger" type="button" data-trash-purge="${escapeHtml(String(e.id))}">彻底删除</button>
              </div>
            </div>`
          )
          .join('')}</div>`;
        body.querySelectorAll('[data-trash-restore]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const r = await api('/api/trash/restore', { method: 'POST', body: { id: btn.dataset.trashRestore } });
              toast(`已恢复到 ${r.path}`, 'ok');
              load(currentPath);
              loadTrash();
            } catch (e) {
              toast(e.message, 'err', 6000);
              btn.disabled = false;
            }
          });
        });
        body.querySelectorAll('[data-trash-purge]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            if (!confirm('彻底删除后不可恢复，确定继续？')) return;
            btn.disabled = true;
            try {
              await api('/api/trash/purge', { method: 'POST', body: { id: btn.dataset.trashPurge } });
              toast('已彻底删除', 'ok');
              loadTrash();
            } catch (e) {
              toast(e.message, 'err', 6000);
              btn.disabled = false;
            }
          });
        });
      } catch (e) {
        body.innerHTML = `<div class="muted">${escapeHtml(e.message)}</div>`;
      }
    }

    /** 文件编辑器弹窗 */
    async function openEditor(path) {
      let data;
      try {
        data = await api('/api/files/read?path=' + encodeURIComponent(path));
      } catch (e) {
        return toast(e.message, 'err');
      }

      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = `
        <div class="modal" style="max-width:1000px;width:100%">
          <div class="modal-head">
            <h3 style="font-size:14px">编辑 · <span class="mono">${escapeHtml(data.name)}</span></h3>
            <button class="icon-btn" data-close aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body" style="padding:0">
            <textarea id="fm-editor" spellcheck="false"
              style="width:100%;height:60vh;padding:14px;background:var(--bg);border:none;color:var(--text);font-family:ui-monospace,monospace;font-size:12.5px;line-height:1.6;resize:vertical;outline:none">${escapeHtml(data.content)}</textarea>
          </div>
          <div class="modal-foot">
            <span class="muted" style="margin-right:auto;font-size:12px">
              ${fmtBytes(data.size)} · ${data.mode} · 上限 2MB
            </span>
            <button class="btn" data-close>取消</button>
            <button class="btn btn-primary" id="fm-save">保存</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const close = () => wrap.remove();
      wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

      wrap.querySelector('#fm-save').addEventListener('click', async () => {
        const content = wrap.querySelector('#fm-editor').value;
        try {
          await api('/api/files/write', { method: 'POST', body: { path, content } });
          toast('已保存', 'ok');
          close();
          load(currentPath);
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    }

    // ---- 工具栏事件 ----
    $('#fm-up', root).addEventListener('click', async () => {
      const parts = currentPath.split('/').filter(Boolean);
      if (parts.length === 0) return;
      parts.pop();
      load('/' + parts.join('/'));
    });

    $('#fm-mkdir', root).addEventListener('click', async () => {
      const name = prompt('新目录名称：');
      if (!name) return;
      try {
        await api('/api/files/mkdir', { method: 'POST', body: { path: currentPath.replace(/\/$/, '') + '/' + name } });
        toast('目录已创建', 'ok');
        load(currentPath);
      } catch (e) { toast(e.message, 'err'); }
    });

    $('#fm-touch', root).addEventListener('click', async () => {
      const name = prompt('新文件名称：');
      if (!name) return;
      try {
        await api('/api/files/touch', { method: 'POST', body: { path: currentPath.replace(/\/$/, '') + '/' + name } });
        toast('文件已创建', 'ok');
        load(currentPath);
      } catch (e) { toast(e.message, 'err'); }
    });

    $('#fm-upload', root).addEventListener('click', () => $('#fm-file-input', root).click());

    $('#fm-file-input', root).addEventListener('change', async (e) => {
      const fileList = Array.from(e.target.files || []);
      if (fileList.length === 0) return;

      for (const file of fileList) {
        try {
          const res = await fetch(
            `/api/files/upload?dir=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(file.name)}`,
            {
              method: 'POST',
              headers: { 'X-CSRF-Token': state.csrf },
              body: file,
            }
          );
          const d = await res.json();
          if (!d.ok) throw new Error(d.error);
          toast(`${file.name} 上传完成（${fmtBytes(d.size)}）`, 'ok');
        } catch (err) {
          toast(`${file.name} 上传失败：${err.message}`, 'err');
        }
      }
      e.target.value = '';
      load(currentPath);
    });

    $('#fm-hidden', root).addEventListener('change', (e) => {
      showHidden = e.target.checked;
      load(currentPath);
    });

    $('#fm-refresh', root).addEventListener('click', () => load(currentPath));

    $('#fm-batch-clear', root).addEventListener('click', () => {
      selected.clear();
      $$('.fm-sel', root).forEach((cb) => { cb.checked = false; });
      updateBatchBar();
    });
    $('#fm-batch-delete', root).addEventListener('click', batchDelete);
    $('#fm-batch-move', root).addEventListener('click', () => batchTransfer('move'));
    $('#fm-batch-copy', root).addEventListener('click', () => batchTransfer('copy'));
    $('#fm-trash-refresh', root).addEventListener('click', loadTrash);
    $('#fm-trash-clear', root).addEventListener('click', async () => {
      if (!confirm('确定清空回收站？所有条目将永久删除，不可恢复。')) return;
      try {
        const d = await api('/api/trash/purge', { method: 'POST', body: { all: true } });
        toast(`已清空回收站（${d.count || 0} 项）`, 'ok');
        loadTrash();
      } catch (e) {
        toast(e.message, 'err', 6000);
      }
    });

    await load(currentPath);
    loadTrash();
  }

  /* ======================================================================
     页面：Web 终端
     ====================================================================== */

  /* ---------------- ANSI / VT100 终端渲染器（网格 + 光标定位 + 备用屏） ---------------- */

  const TERM_ANSI_COLORS = {
    ansi0: '#484f58', ansi1: '#ff7b72', ansi2: '#3fb950', ansi3: '#d29922',
    ansi4: '#58a6ff', ansi5: '#bc8cff', ansi6: '#39c5cf', ansi7: '#b1bac4',
    ansiB0: '#6e7681', ansiB1: '#ffa198', ansiB2: '#56d364', ansiB3: '#e3b341',
    ansiB4: '#79c0ff', ansiB5: '#d2a8ff', ansiB6: '#56d4dd', ansiB7: '#f0f6fc',
  };

  function term256Color(n) {
    const i = Number(n);
    if (!Number.isFinite(i) || i < 0) return '#c9d1d9';
    if (i < 16) return TERM_ANSI_COLORS['ansi' + i] || (i < 8 ? TERM_ANSI_COLORS['ansi' + (i + 8)] : '#c9d1d9');
    if (i < 232) {
      const c = i - 16;
      return `rgb(${Math.floor(c / 36) * 51},${Math.floor((c % 36) / 6) * 51},${(c % 6) * 51})`;
    }
    const v = (i - 232) * 10 + 8;
    return `rgb(${v},${v},${v})`;
  }

  function termColorOf(v) {
    if (!v) return null;
    if (v.startsWith('c256:')) return term256Color(v.slice(5));
    return TERM_ANSI_COLORS[v] || null;
  }

  class TermBuffer {
    constructor(cols = 100, rows = 30) {
      this.cols = Math.max(20, Math.min(400, Number(cols) || 100));
      this.rows = Math.max(5, Math.min(200, Number(rows) || 30));
      this.main = this._newScreen();
      this.alt = null;
      this.screen = this.main;
      this.usingAlt = false;
      this.scrollback = [];
      this.sgr = this._defaultSgr();
      this.pending = '';
      this.responses = [];
      this.cursorVisible = true;
      this.appCursor = false;
      this.wrapMode = true;
    }

    _defaultSgr() {
      return { color: null, bg: null, bold: false, dim: false, underline: false, reverse: false };
    }

    _blankLine() {
      return new Array(this.cols).fill(null);
    }

    _newScreen() {
      const lines = [];
      for (let i = 0; i < this.rows; i++) lines.push(this._blankLine());
      return {
        lines,
        cursor: { row: 0, col: 0 },
        saved: null,
        scrollTop: 0,
        scrollBottom: this.rows - 1,
      };
    }

    reset() {
      this.main = this._newScreen();
      this.alt = null;
      this.screen = this.main;
      this.usingAlt = false;
      this.scrollback = [];
      this.sgr = this._defaultSgr();
      this.pending = '';
      this.responses = [];
      this.cursorVisible = true;
      this.appCursor = false;
      this.wrapMode = true;
    }

    resize(cols, rows) {
      cols = Math.max(20, Math.min(400, Number(cols) || this.cols));
      rows = Math.max(5, Math.min(200, Number(rows) || this.rows));
      if (cols === this.cols && rows === this.rows) return;
      const fit = (lines) => {
        const out = lines.slice(0, rows);
        while (out.length < rows) out.push(new Array(cols).fill(null));
        return out.map((line) => {
          const next = line.slice(0, cols);
          while (next.length < cols) next.push(null);
          return next;
        });
      };
      const fitScreen = (screen) => {
        screen.lines = fit(screen.lines);
        screen.cursor.row = Math.min(screen.cursor.row, rows - 1);
        screen.cursor.col = Math.min(screen.cursor.col, cols - 1);
        screen.scrollTop = 0;
        screen.scrollBottom = rows - 1;
      };
      this.cols = cols;
      this.rows = rows;
      fitScreen(this.main);
      if (this.alt) fitScreen(this.alt);
      this.screen = this.usingAlt && this.alt ? this.alt : this.main;
    }

    _clampCursor() {
      const c = this.screen.cursor;
      c.row = Math.max(0, Math.min(this.rows - 1, c.row));
      c.col = Math.max(0, Math.min(this.cols, c.col));
    }

    _lineFeed() {
      const s = this.screen;
      const c = s.cursor;
      if (c.row === s.scrollBottom) this._scrollUp(1);
      else c.row = Math.min(this.rows - 1, c.row + 1);
    }

    _reverseIndex() {
      const s = this.screen;
      const c = s.cursor;
      if (c.row === s.scrollTop) this._scrollDown(1);
      else c.row = Math.max(0, c.row - 1);
    }

    _scrollUp(n) {
      const s = this.screen;
      const top = s.scrollTop;
      const bottom = s.scrollBottom;
      for (let k = 0; k < n; k++) {
        const removed = s.lines.splice(top, 1)[0];
        s.lines.splice(bottom, 0, this._blankLine());
        if (!this.usingAlt && top === 0) {
          this.scrollback.push(removed || this._blankLine());
          if (this.scrollback.length > 2000) this.scrollback.shift();
        }
      }
    }

    _scrollDown(n) {
      const s = this.screen;
      const top = s.scrollTop;
      const bottom = s.scrollBottom;
      for (let k = 0; k < n; k++) {
        s.lines.splice(bottom, 1);
        s.lines.splice(top, 0, this._blankLine());
      }
    }

    _putChar(ch) {
      const s = this.screen;
      const c = s.cursor;
      if (this.wrapMode && c.col >= this.cols) {
        c.col = 0;
        this._lineFeed();
      }
      if (c.col >= this.cols) c.col = this.cols - 1;
      const line = s.lines[c.row] || (s.lines[c.row] = this._blankLine());
      line[c.col] = { ch, color: this.sgr.color, bg: this.sgr.bg, bold: this.sgr.bold, dim: this.sgr.dim, underline: this.sgr.underline, reverse: this.sgr.reverse };
      c.col += 1;
      if (!this.wrapMode && c.col > this.cols - 1) c.col = this.cols - 1;
    }

    _saveCursor() {
      this.screen.saved = { row: this.screen.cursor.row, col: this.screen.cursor.col };
    }

    _restoreCursor() {
      const saved = this.screen.saved;
      if (saved) {
        this.screen.cursor.row = Math.min(saved.row, this.rows - 1);
        this.screen.cursor.col = Math.min(saved.col, this.cols);
      }
    }

    _enterAlt() {
      if (this.usingAlt) return;
      this.main.saved = { row: this.main.cursor.row, col: this.main.cursor.col };
      this.alt = this._newScreen();
      this.screen = this.alt;
      this.usingAlt = true;
    }

    _exitAlt() {
      if (!this.usingAlt) return;
      this.screen = this.main;
      this.alt = null;
      this.usingAlt = false;
      if (this.main.saved) {
        this.main.cursor.row = this.main.saved.row;
        this.main.cursor.col = this.main.saved.col;
      }
    }

    _handleEscape(str, i) {
      const rest = str.slice(i);
      if (rest.length < 2) return -1;
      // rest[0] 是 ESC，后续解析都相对 ESC 之后的部分
      const body = rest.slice(1);
      const second = body[0];

      if (second === '[') {
        const m = /^\[([0-9;?<>=!]*)([ -/]*)([@-~])/.exec(body);
        if (!m) {
          if (body.length < 64) return -1;
          return 2;
        }
        this._handleCsi(m[1], m[3]);
        return m[0].length + 1;
      }
      if (second === ']') {
        const m = /^\]([^\x07\x1b]*)(\x07|\x1b\\)/.exec(body);
        if (m) return m[0].length + 1;
        if (!body.includes('\x07') && !body.includes('\x1b\\')) return -1;
        return rest.length;
      }
      if (second === 'P' || second === '^' || second === '_') {
        const end = body.indexOf('\x1b\\');
        if (end < 0) return -1;
        return end + 3;
      }
      if (second === '(' || second === ')' || second === '*' || second === '+' || second === '-' || second === '.') {
        return body.length >= 2 ? 3 : -1;
      }
      switch (second) {
        case '7': this._saveCursor(); return 2;
        case '8': this._restoreCursor(); return 2;
        case 'D': this._lineFeed(); return 2;
        case 'M': this._reverseIndex(); return 2;
        case 'E': this._lineFeed(); this.screen.cursor.col = 0; return 2;
        case 'c': this.reset(); return 2;
        case '=':
        case '>':
        case '\\': return 2;
        case 'Z': this.responses.push('\x1b[?1;2c'); return 2;
        case 'H': return 2;
        default: return 2;
      }
    }

    _handleCsi(params, final) {
      const isPrivate = params.startsWith('?');
      const clean = params.replace(/^[?<>=!]+/, '');
      const nums = clean.length ? clean.split(';').map((x) => (x === '' ? 0 : Number(x) || 0)) : [];
      const n = (idx, def) => {
        const v = nums[idx];
        return v === undefined || v === 0 ? def : v;
      };
      const s = this.screen;
      const c = s.cursor;

      switch (final) {
        case 'm':
          this._applySgr(clean);
          return;
        case 'A': c.row = Math.max(0, c.row - n(0, 1)); return;
        case 'B': c.row = Math.min(this.rows - 1, c.row + n(0, 1)); return;
        case 'C': c.col = Math.min(this.cols, c.col + n(0, 1)); return;
        case 'D': c.col = Math.max(0, c.col - n(0, 1)); return;
        case 'E': c.row = Math.min(this.rows - 1, c.row + n(0, 1)); c.col = 0; return;
        case 'F': c.row = Math.max(0, c.row - n(0, 1)); c.col = 0; return;
        case 'G': c.col = Math.max(0, Math.min(this.cols, n(0, 1) - 1)); return;
        case 'd': c.row = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1)); return;
        case 'H':
        case 'f':
          c.row = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1));
          c.col = Math.max(0, Math.min(this.cols, n(1, 1) - 1));
          return;
        case 'J': {
          const mode = nums[0] || 0;
          if (mode === 2 || mode === 3) {
            s.lines = s.lines.map(() => this._blankLine());
            c.row = 0;
            c.col = 0;
            if (mode === 3 && !this.usingAlt) this.scrollback = [];
          } else if (mode === 1) {
            for (let r = 0; r < c.row; r++) s.lines[r] = this._blankLine();
            this._eraseLine(0, c.row, 0, c.col);
          } else {
            this._eraseLine(0, c.row, c.col, this.cols - 1);
            for (let r = c.row + 1; r < this.rows; r++) s.lines[r] = this._blankLine();
          }
          return;
        }
        case 'K': {
          const mode = nums[0] || 0;
          if (mode === 2) s.lines[c.row] = this._blankLine();
          else if (mode === 1) this._eraseLine(0, c.row, 0, c.col);
          else this._eraseLine(0, c.row, c.col, this.cols - 1);
          return;
        }
        case 'L': {
          const count = n(0, 1);
          const bottom = s.scrollBottom;
          const row = Math.min(c.row, bottom);
          for (let k = 0; k < count; k++) {
            s.lines.splice(bottom, 1);
            s.lines.splice(row, 0, this._blankLine());
          }
          return;
        }
        case 'M': {
          const count = n(0, 1);
          const bottom = s.scrollBottom;
          const row = Math.min(c.row, bottom);
          for (let k = 0; k < count; k++) {
            s.lines.splice(row, 1);
            s.lines.splice(bottom, 0, this._blankLine());
          }
          return;
        }
        case 'P': {
          const count = n(0, 1);
          const line = s.lines[c.row];
          if (!line) return;
          line.splice(c.col, count);
          while (line.length < this.cols) line.push(null);
          return;
        }
        case '@': {
          const count = n(0, 1);
          const line = s.lines[c.row];
          if (!line) return;
          line.splice(c.col, 0, ...new Array(count).fill(null));
          line.length = this.cols;
          return;
        }
        case 'X': {
          const count = n(0, 1);
          this._eraseLine(0, c.row, c.col, Math.min(this.cols - 1, c.col + count - 1));
          return;
        }
        case 'S': this._scrollUp(n(0, 1)); return;
        case 'T': this._scrollDown(n(0, 1)); return;
        case 'r': {
          const top = Math.max(0, Math.min(this.rows - 2, n(0, 1) - 1));
          const bottom = Math.max(top + 1, Math.min(this.rows - 1, n(1, this.rows) - 1));
          s.scrollTop = top;
          s.scrollBottom = bottom;
          c.row = top;
          c.col = 0;
          return;
        }
        case 's': this._saveCursor(); return;
        case 'u': this._restoreCursor(); return;
        case 'h':
        case 'l': {
          if (!isPrivate) return;
          const on = final === 'h';
          if (nums.includes(25)) this.cursorVisible = on;
          if (nums.includes(1)) this.appCursor = on;
          if (nums.includes(7)) this.wrapMode = on;
          if (nums.includes(1049) || nums.includes(47) || nums.includes(1047)) {
            if (on) this._enterAlt();
            else this._exitAlt();
          }
          return;
        }
        case 'n': {
          if (nums[0] === 6) this.responses.push(`\x1b[${c.row + 1};${Math.min(c.col + 1, this.cols)}R`);
          else if (nums[0] === 5) this.responses.push('\x1b[0n');
          return;
        }
        case 'c': this.responses.push('\x1b[?1;2c'); return;
        case 'q': return;
        case 't': return;
        default: return;
      }
    }

    _eraseLine(mode, row, start, end) {
      const line = this.screen.lines[row];
      if (!line) return;
      const from = Math.max(0, Math.min(this.cols - 1, start));
      const to = Math.max(from, Math.min(this.cols - 1, end));
      for (let i = from; i <= to; i++) line[i] = null;
    }

    _applySgr(params) {
      const parts = (params || '0').split(';').map((x) => (x === '' ? 0 : Number(x) || 0));
      if (!parts.length) parts.push(0);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === 0) this.sgr = this._defaultSgr();
        else if (p === 1) this.sgr.bold = true;
        else if (p === 2) this.sgr.dim = true;
        else if (p === 4) this.sgr.underline = true;
        else if (p === 7) this.sgr.reverse = true;
        else if (p === 22) { this.sgr.bold = false; this.sgr.dim = false; }
        else if (p === 24) this.sgr.underline = false;
        else if (p === 27) this.sgr.reverse = false;
        else if (p >= 30 && p <= 37) this.sgr.color = `ansi${p - 30}`;
        else if (p === 39) this.sgr.color = null;
        else if (p >= 40 && p <= 47) this.sgr.bg = `ansi${p - 40}`;
        else if (p === 49) this.sgr.bg = null;
        else if (p >= 90 && p <= 97) this.sgr.color = `ansiB${p - 90}`;
        else if (p >= 100 && p <= 107) this.sgr.bg = `ansiB${p - 100}`;
        else if (p === 38 || p === 48) {
          const isFg = p === 38;
          let color = null;
          if (parts[i + 1] === 5) {
            color = `c256:${parts[i + 2]}`;
            i += 2;
          } else if (parts[i + 1] === 2) {
            color = `rgb(${parts[i + 2]},${parts[i + 3]},${parts[i + 4]})`;
            i += 4;
          }
          if (color) {
            if (isFg) this.sgr.color = color;
            else this.sgr.bg = color;
          }
        }
      }
    }

    write(raw) {
      const str = this.pending + String(raw == null ? '' : raw);
      this.pending = '';
      let i = 0;
      while (i < str.length) {
        const ch = str[i];
        if (ch === '\x1b') {
          const consumed = this._handleEscape(str, i);
          if (consumed < 0) {
            this.pending = str.slice(i);
            break;
          }
          i += consumed;
          continue;
        }
        if (ch === '\r') { this.screen.cursor.col = 0; i++; continue; }
        if (ch === '\n') { this._lineFeed(); i++; continue; }
        if (ch === '\b') { this.screen.cursor.col = Math.max(0, this.screen.cursor.col - 1); i++; continue; }
        if (ch === '\t') {
          this.screen.cursor.col = Math.min(this.cols - 1, (Math.floor(this.screen.cursor.col / 8) + 1) * 8);
          i++;
          continue;
        }
        if (ch === '\x07' || ch === '\x00' || ch === '\x0e' || ch === '\x0f') { i++; continue; }
        if (ch === '\x9b') {
          const m = /^([0-9;?<>=!]*)([ -/]*)([@-~])/.exec(str.slice(i + 1));
          if (!m) {
            this.pending = str.slice(i);
            break;
          }
          this._handleCsi(m[1], m[3]);
          i += 1 + m[0].length;
          continue;
        }
        let j = i;
        while (j < str.length && !/[\x1b\r\n\b\t\x07\x00\x0e\x0f\x9b]/.test(str[j])) j++;
        for (let k = i; k < j; k++) this._putChar(str[k]);
        i = j;
      }
    }

    takeResponses() {
      if (!this.responses.length) return '';
      const out = this.responses.join('');
      this.responses = [];
      return out;
    }

    toHtml() {
      const attrOf = (cell) => {
        const styles = [];
        const fg = cell.reverse ? termColorOf(cell.bg) || '#0d1117' : termColorOf(cell.color);
        const bg = cell.reverse ? termColorOf(cell.color) || '#c9d1d9' : termColorOf(cell.bg);
        if (fg) styles.push(`color:${fg}`);
        if (bg) styles.push(`background:${bg}`);
        if (cell.bold) styles.push('font-weight:600');
        if (cell.dim) styles.push('opacity:.65');
        if (cell.underline) styles.push('text-decoration:underline');
        return styles.join(';');
      };
      const cursor = this.screen.cursor;
      const rowsTotal = this.usingAlt ? this.screen.lines.length : this.scrollback.length + this.screen.lines.length;
      const cursorRow = this.usingAlt ? cursor.row : this.scrollback.length + cursor.row;
      const start = Math.max(0, rowsTotal - 600);
      const lines = [];
      for (let idx = start; idx < rowsTotal; idx++) {
        const isAlt = this.usingAlt;
        const line = isAlt
          ? this.screen.lines[idx]
          : idx < this.scrollback.length
            ? this.scrollback[idx]
            : this.screen.lines[idx - this.scrollback.length];
        if (!line) { lines.push(''); continue; }
        let last = -1;
        for (let i = 0; i < line.length; i++) if (line[i]) last = i;
        if (idx === cursorRow) last = Math.max(last, Math.min(cursor.col, this.cols - 1));
        let html = '';
        let runText = '';
        let runStyle = null;
        let runCursor = false;
        const flush = () => {
          if (!runText && !runCursor) return;
          const style = runStyle ? ` style="${runStyle}"` : '';
          const cls = runCursor ? ' class="term-cursor"' : '';
          html += `<span${cls}${style}>${escapeHtml(runText || ' ')}</span>`;
          runText = '';
        };
        for (let i = 0; i <= last; i++) {
          const cell = line[i] || { ch: ' ' };
          const isCursor = idx === cursorRow && i === cursor.col && this.cursorVisible;
          const style = attrOf(cell);
          const text = cell.ch || ' ';
          if ((runStyle !== style && runStyle !== null) || runCursor !== isCursor) flush();
          if (runStyle === null || runStyle !== style) runStyle = style;
          runCursor = isCursor;
          runText += text;
        }
        flush();
        lines.push(html);
      }
      return lines.join('\n');
    }

    textRows() {
      const lines = this.usingAlt ? this.screen.lines : this.scrollback.concat(this.screen.lines);
      return lines.map((line) => line.map((cell) => (cell && cell.ch) || ' ').join('').replace(/\s+$/, ''));
    }
  }

  async function renderTerminal(root) {
    root.innerHTML = `
      <div class="card term-card" id="term-card">
        <div class="card-head">
          <h3>Web 终端</h3>
          <span class="spacer"></span>
          <span class="card-sub" id="term-target"></span>
          <span class="card-sub" id="term-state">未连接</span>
          <span class="chip" id="term-size">—</span>
          <button class="btn btn-sm" id="term-fullscreen" type="button">全屏</button>
          <button class="btn btn-sm" id="term-clear" type="button">清屏</button>
          <button class="btn btn-sm" id="term-reconnect" type="button">重连</button>
          <button class="btn btn-sm btn-danger" id="term-close" type="button">关闭</button>
        </div>
        <div id="term-host" class="term-screen" tabindex="0">
          <div class="muted">正在连接…</div>
        </div>
        <div class="muted term-hint">
          已支持基础全屏程序：vim / htop / less 等的光标定位、清屏、备用屏与方向/功能键可用；极复杂 TUI 或需要鼠标的程序仍建议使用 SSH。
          快捷键：Ctrl+C 中断 · Ctrl+D 结束 · Ctrl+L 清屏 · 方向键/Home/End/PgUp/PgDn/F1-F12 已转发
        </div>
      </div>
    `;

    const host = $('#term-host', root);
    const card = $('#term-card', root);
    const buf = new TermBuffer(100, 30);
    let sessionId = null;
    let es = null;
    let cols = 100;
    let rows = 30;
    let renderQueued = false;
    let autoScroll = true;
    let attached = state.terminalAttach || null;
    state.terminalAttach = null;

    function setState(text) {
      const el = $('#term-state', root);
      if (el) el.textContent = text;
    }

    function setTarget(text) {
      const el = $('#term-target', root);
      if (el) el.textContent = text || '';
    }

    function render() {
      renderQueued = false;
      host.innerHTML = buf.toHtml();
      if (autoScroll) host.scrollTop = host.scrollHeight;
    }

    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(render);
    }

    function estimateSize() {
      // 用隐藏的字符样本测量真实字符宽高（中文字体/缩放更准确）
      let charW = 7.8;
      let lineH = 19.5;
      try {
        const probe = document.createElement('span');
        probe.textContent = 'M'.repeat(20);
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;line-height:inherit';
        host.appendChild(probe);
        const rect = probe.getBoundingClientRect();
        if (rect.width > 0) charW = rect.width / 20;
        const lh = parseFloat(getComputedStyle(host).lineHeight);
        if (Number.isFinite(lh) && lh > 0) lineH = lh;
        probe.remove();
      } catch (e) {
        /* 使用默认值 */
      }
      cols = Math.max(30, Math.floor((host.clientWidth - 20) / Math.max(4, charW)));
      rows = Math.max(8, Math.floor((host.clientHeight - 16) / Math.max(10, lineH)));
      buf.resize(cols, rows);
      const sizeEl = $('#term-size', root);
      if (sizeEl) sizeEl.textContent = `${cols}×${rows}`;
    }

    async function sendInput(data, silent) {
      if (!sessionId || !data) return;
      try {
        await api('/api/terminal/input', { method: 'POST', body: { id: sessionId, data } });
      } catch (e) {
        if (!silent) toast(e.message, 'err');
      }
    }

    function subscribe() {
      if (es) es.close();
      es = new EventSource(`/api/terminal/stream?id=${encodeURIComponent(sessionId)}`);
      es.onmessage = (ev) => {
        try {
          const text = JSON.parse(ev.data);
          buf.write(text);
          const responses = buf.takeResponses();
          if (responses) sendInput(responses, true);
          scheduleRender();
        } catch (e) {
          /* ignore */
        }
      };
      es.addEventListener('exit', () => {
        setState('会话已结束');
        if (es) es.close();
        es = null;
      });
      es.onerror = () => {
        setState('连接断开');
      };
    }

    async function connect() {
      setState('连接中…');
      buf.reset();
      autoScroll = true;
      scheduleRender();

      try {
        estimateSize();
        if (attached && attached.id) {
          sessionId = attached.id;
          const name = attached.container && (attached.container.name || attached.container.id);
          setTarget(name ? `容器 ${name}` : '已有会话');
          setState('已连接');
          attached = null;
          subscribe();
          api('/api/terminal/resize', { method: 'POST', body: { id: sessionId, cols, rows } }).catch(() => {});
        } else {
          const s = await api('/api/terminal/create', {
            method: 'POST',
            body: { cols, rows },
          });
          sessionId = s.id;
          setTarget('本机 shell');
          setState('已连接');
          subscribe();
        }
        host.focus();
        scheduleRender();
      } catch (e) {
        setState('连接失败');
        host.innerHTML = `<div style="color:var(--red)">${escapeHtml(featureErrorText(e, '终端'))}</div>`;
      }
    }

    async function doResize() {
      if (!sessionId) return;
      const oldCols = cols;
      const oldRows = rows;
      estimateSize();
      if (cols !== oldCols || rows !== oldRows) {
        try {
          await api('/api/terminal/resize', { method: 'POST', body: { id: sessionId, cols, rows } });
        } catch (e) {
          /* ignore */
        }
      }
    }

    async function closeSession() {
      if (es) {
        es.close();
        es = null;
      }
      if (sessionId) {
        try {
          await api('/api/terminal/close', { method: 'POST', body: { id: sessionId } });
        } catch (e) {
          /* ignore */
        }
        sessionId = null;
      }
      setState('已关闭');
    }

    /* ---------------- 键盘 → PTY 转义序列 ---------------- */
    function keySequence(e) {
      const app = buf.appCursor;
      const pick = (normal, appSeq) => (app ? appSeq : normal);
      switch (e.key) {
        case 'ArrowUp': return pick('\x1b[A', '\x1bOA');
        case 'ArrowDown': return pick('\x1b[B', '\x1bOB');
        case 'ArrowRight': return pick('\x1b[C', '\x1bOC');
        case 'ArrowLeft': return pick('\x1b[D', '\x1bOD');
        case 'Home': return pick('\x1b[H', '\x1bOH');
        case 'End': return pick('\x1b[F', '\x1bOF');
        case 'PageUp': return '\x1b[5~';
        case 'PageDown': return '\x1b[6~';
        case 'Insert': return '\x1b[2~';
        case 'Delete': return '\x1b[3~';
        case 'Tab': return e.shiftKey ? '\x1b[Z' : '\t';
        case 'Enter': return '\r';
        case 'Backspace': return '\x7f';
        case 'Escape': return '\x1b';
        case 'F1': return '\x1bOP';
        case 'F2': return '\x1bOQ';
        case 'F3': return '\x1bOR';
        case 'F4': return '\x1bOS';
        case 'F5': return '\x1b[15~';
        case 'F6': return '\x1b[17~';
        case 'F7': return '\x1b[18~';
        case 'F8': return '\x1b[19~';
        case 'F9': return '\x1b[20~';
        case 'F10': return '\x1b[21~';
        case 'F11': return '\x1b[23~';
        case 'F12': return '\x1b[24~';
        default: return null;
      }
    }

    host.addEventListener('keydown', (e) => {
      if (!sessionId || e.isComposing) return;

      // Ctrl 组合：普通 Ctrl+字母按 0x01..0x1a 发送；Ctrl+V 保留浏览器粘贴
      if (e.ctrlKey && !e.altKey && !e.metaKey) {
        if (/^[a-zA-Z]$/.test(e.key)) {
          const lower = e.key.toLowerCase();
          if (lower === 'v') return;
          e.preventDefault();
          sendInput(String.fromCharCode(lower.charCodeAt(0) - 96));
          return;
        }
        if (e.key === '[') { e.preventDefault(); sendInput('\x1b'); return; }
        return;
      }

      // Alt+字符 = ESC 前缀（vim 绑定）
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        e.preventDefault();
        sendInput('\x1b' + e.key);
        return;
      }

      const seq = keySequence(e);
      if (seq !== null) {
        e.preventDefault();
        sendInput(seq);
        return;
      }

      // 普通字符
      if (e.key.length === 1 && !e.metaKey) {
        e.preventDefault();
        sendInput(e.key);
      }
    });

    host.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) sendInput(text.replace(/\r\n/g, '\r'));
    });

    host.addEventListener('click', () => host.focus());
    host.addEventListener('focus', () => scheduleRender());
    host.addEventListener('blur', () => scheduleRender());
    host.addEventListener('scroll', () => {
      autoScroll = host.scrollHeight - host.scrollTop - host.clientHeight < 60;
    });

    /* ---------------- 工具栏 ---------------- */
    $('#term-clear', root).addEventListener('click', () => {
      buf.reset();
      autoScroll = true;
      render();
    });

    $('#term-reconnect', root).addEventListener('click', async () => {
      await closeSession();
      buf.reset();
      await connect();
    });

    $('#term-close', root).addEventListener('click', async () => {
      if (!confirm('确定关闭当前终端会话？')) return;
      await closeSession();
      buf.reset();
      render();
      host.innerHTML = '<div class="muted">终端已关闭，点击「重连」开启新会话</div>';
    });

    function isFullscreen() {
      return document.fullscreenElement === card || card.classList.contains('term-fallback-fullscreen');
    }

    function updateFullscreenLabel() {
      const btn = $('#term-fullscreen', root);
      if (btn) btn.textContent = isFullscreen() ? '退出全屏' : '全屏';
      setTimeout(() => doResize(), 60);
    }

    $('#term-fullscreen', root).addEventListener('click', async () => {
      if (isFullscreen()) {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
        } catch (e) {
          /* ignore */
        }
        card.classList.remove('term-fallback-fullscreen');
        updateFullscreenLabel();
        return;
      }
      try {
        if (card.requestFullscreen) await card.requestFullscreen();
        else card.classList.add('term-fallback-fullscreen');
      } catch (e) {
        card.classList.add('term-fallback-fullscreen');
      }
      updateFullscreenLabel();
      setTimeout(() => doResize(), 120);
    });

    const onFullscreenChange = () => {
      if (!document.fullscreenElement) card.classList.remove('term-fallback-fullscreen');
      updateFullscreenLabel();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    const onResize = debounce(() => doResize(), 300);
    window.addEventListener('resize', onResize);

    // 关闭标签/刷新时尽力关闭 PTY，避免会话泄漏到上限
    const onPageHide = () => {
      if (!sessionId) return;
      try {
        fetch('/api/terminal/close', {
          method: 'POST',
          keepalive: true,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf },
          body: JSON.stringify({ id: sessionId }),
        }).catch(() => {});
      } catch (e) {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);

    state.cleanups.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      card.classList.remove('term-fallback-fullscreen');
      if (es) es.close();
      if (sessionId) {
        api('/api/terminal/close', { method: 'POST', body: { id: sessionId } }).catch(() => {});
      }
    });

    await connect();
  }

  /* ======================================================================
     页面：设置
     ====================================================================== */
  /* ======================================================================
     PWA：Service Worker / 安装到桌面
     ====================================================================== */
  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {
      /* ignore */
    }
    return window.navigator.standalone === true;
  }

  function installStatusText() {
    if (isStandalone()) return '已安装（独立窗口运行）';
    if (!window.isSecureContext) return '不可安装（需 HTTPS 或 localhost 访问）';
    if (state.installPrompt) return '可安装';
    if ('serviceWorker' in navigator) return '浏览器支持 PWA，可从浏览器菜单安装';
    return '当前浏览器不支持安装';
  }

  function updateInstallUI() {
    state.standalone = isStandalone();
    const show = !!state.installPrompt && !state.standalone;
    const sideBtn = $('#install-btn');
    if (sideBtn) sideBtn.classList.toggle('hidden', !show);
    const setBtn = $('#set-install');
    if (setBtn) setBtn.classList.toggle('hidden', !show);
    const statusEl = $('#set-install-status');
    if (statusEl) statusEl.textContent = installStatusText();
    const note = $('#set-install-note');
    if (note) note.classList.toggle('hidden', window.isSecureContext || state.standalone);
  }

  async function promptInstall() {
    if (!state.installPrompt) {
      toast('当前环境无法自动唤起安装，请用浏览器菜单「添加到主屏幕 / 安装应用」', 'info', 5000);
      return;
    }
    const ev = state.installPrompt;
    state.installPrompt = null;
    try {
      if (typeof ev.prompt !== 'function') {
        toast('请使用浏览器菜单「添加到主屏幕 / 安装应用」完成安装', 'info', 5000);
      } else {
        ev.prompt();
        const choice = await (ev.userChoice || Promise.resolve({ outcome: 'unknown' }));
        if (choice && choice.outcome === 'accepted') toast('已添加到桌面', 'ok');
        else if (choice && choice.outcome === 'dismissed') toast('已取消安装', 'info');
      }
    } catch (err) {
      toast(`安装失败：${err.message}`, 'err');
    }
    updateInstallUI();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) {
      // 浏览器要求 HTTPS 或 localhost 才允许 SW 与安装（不影响页面其他功能）
      console.info('[pwa] 非安全上下文，跳过 Service Worker 注册');
      return;
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        state.swRegistration = reg;
        updateInstallUI();
      })
      .catch((err) => {
        console.warn('[pwa] Service Worker 注册失败:', err && err.message);
        updateInstallUI();
      });
  }

  /* ======================================================================
     DSH 控制页
     ====================================================================== */
  const DSH_LOG_LIMIT = 3000;

  const DSH_ERROR_HINTS = {
    dsh_console_unavailable: '无法获取 DSH 控制台地址：服务端未找到带 token 的启动 URL，或读取 journalctl 失败。',
    dsh_task_disabled: '任务提交未开启：需在服务器 config.json 中将 dsh.allowTask 设为 true 并重启面板。',
    dsh_task_busy: '已有 DSH 任务在运行，请等待其结束再提交。',
    dsh_task_not_found: '任务不存在或已过期，请重新提交。',
    dsh_unavailable: 'DSH 不可用：未找到 dsh 可执行文件或 DSH_HOME 目录。',
  };

  function readableDshError(err) {
    const msg = (err && err.message) || String(err || '');
    const hit = Object.keys(DSH_ERROR_HINTS).find((key) => msg.includes(key));
    if (hit) return DSH_ERROR_HINTS[hit];
    if (msg === '响应解析失败' || /Unexpected token|not valid JSON|is not valid JSON/.test(msg)) {
      return 'DSH 接口暂不可用（后端未就绪或返回了非 JSON 响应）。';
    }
    if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
      return '无法连接面板服务，请检查网络后重试。';
    }
    return msg || '未知错误';
  }

  function dshErrorHtml(title, err) {
    const detail = (err && err.message) || String(err || '');
    return `<div class="dsh-error"><strong>${escapeHtml(title)}</strong>${escapeHtml(readableDshError(err))}
      <details><summary>技术细节</summary><pre>${escapeHtml(detail)}</pre></details></div>`;
  }

  function dshStatusHtml(status) {
    const web = (status && status.web) || {};
    const available = !!(status && status.available);
    const running = available && !!web.reachable;

    let stateChip;
    if (running) stateChip = '<span class="chip ok"><span class="dot live"></span>运行中</span>';
    else if (available) stateChip = '<span class="chip warn"><span class="dot warn"></span>未运行</span>';
    else stateChip = '<span class="chip crit"><span class="dot dead"></span>不可用</span>';

    const link = web.url
      ? `<a class="dsh-web-link" href="${escapeHtml(web.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(web.url)}</a>`
      : '—';
    const home = (status && status.home) || '—';

    const rows = [
      ['状态', stateChip],
      ['Web 地址', link],
      ['Profile', escapeHtml(web.profile || '—')],
    ];
    if (Number.isFinite(web.pid)) rows.push(['进程 PID', `<span class="mono">${web.pid}</span>`]);
    rows.push(['运行时长', escapeHtml(fmtDuration(web.uptimeSec))]);
    rows.push([
      'Token',
      status && status.tokenFound === true
        ? '<span class="chip ok">已找到</span>'
        : '<span class="chip warn">未找到</span>',
    ]);
    rows.push([
      'DSH_HOME',
      `<span class="dsh-status-path" title="${escapeHtml(home)}">${escapeHtml(home)}</span>`,
    ]);

    let html = rows
      .map(([k, v]) => `<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');

    const errors = Array.isArray(status && status.errors) ? status.errors.filter(Boolean) : [];
    if (errors.length) {
      html += `<div class="notice dsh-notice" style="margin:12px 0 0">
        <p>检测到 ${errors.length} 条提示：</p>
        ${errors.map((e) => `<p class="mono" style="font-size:11.5px">${escapeHtml(String(e))}</p>`).join('')}
      </div>`;
    }

    if (!available) {
      html += `<div class="notice dsh-notice" style="margin:12px 0 0">
        <p><strong>未检测到 DSH</strong>（可选集成）：未找到 dsh 可执行文件或 DSH_HOME 目录。</p>
        <p>如需要，可在服务器 <span class="mono">config.json</span> 的 <span class="mono">dsh</span> 段配置
          <span class="mono">home</span> / <span class="mono">bin</span> 后刷新本页；不需要可忽略此提示。</p>
      </div>`;
    } else if (!running) {
      html += `<div class="notice dsh-notice" style="margin:12px 0 0">
        <p><strong>DSH Web 未运行</strong>，请在服务器上启动 DSH Web（启动命令与监听端口由你的 DSH 配置决定）。</p>
        <code class="dsh-code">dsh web</code>
        <p>启动后刷新本页即可；若由 systemd 托管，可查看对应服务的运行状态与日志。</p>
      </div>`;
    }

    if (status && status.tokenFound === false) {
      html += `<div class="notice dsh-notice" style="margin:12px 0 0">
        <p><strong>未找到一次性 token</strong>，打开控制台可能失败。可在 DSH 的启动日志中查找带 token 的
          <span class="mono">dsh web</span> 地址，或在 <span class="mono">config.json</span> 配置
          <span class="mono">dsh.consoleUrlCustom</span>。</p>
      </div>`;
    }
    return html;
  }

  function dshConsoleHintHtml(status) {
    if (!status) return '<span class="muted">无法读取 DSH 状态。</span>';
    const web = status.web || {};
    const bits = [];
    if (web.url) bits.push(`当前 Web：<span class="mono">${escapeHtml(web.url)}</span>`);
    if (!status.available) bits.push('未检测到 DSH（可选集成），按钮可能失败。');
    else if (!web.reachable) bits.push('DSH Web 不在运行，按钮可能失败（请先启动 dsh web）。');
    if (status.tokenFound === false) {
      bits.push('未找到一次性 token，可在 config.json 配置 dsh.consoleUrlCustom。');
    }
    return bits.length ? bits.join('<br>') : '点击后将在新标签页打开带一次性 token 的控制台。';
  }

  /* ---------------- DSH 会话目录 / 历史 / 能力 ---------------- */

  /** model 可能是字符串，也可能是 {provider, model} 对象 */
  function dshModelText(model) {
    if (!model) return '';
    if (typeof model === 'string') return model;
    if (typeof model === 'object') {
      const provider = String(model.provider || '').trim();
      const name = String(model.model || model.id || model.name || '').trim();
      if (provider && name) return `${provider}:${name}`;
      return name || provider || '';
    }
    return String(model);
  }

  function dshSessionTitle(s) {
    const title = String((s && s.title) || '').trim();
    if (title) return title;
    const cwd = String((s && s.cwd) || '');
    const tail = cwd.split('/').filter(Boolean).pop();
    if (tail) return tail;
    return String((s && s.id) || '会话');
  }

  function dshSessionBadge(s) {
    const hasPreset = Boolean(s && s.agentPreset);
    const resumable = s && s.resumable !== undefined ? s.resumable === true : !hasPreset;
    if (hasPreset) {
      return {
        text: 'Web 会话',
        cls: 'info',
        title: `agentPreset=${s.agentPreset}，headless 无法续聊，可在 DSH 控制台查看`,
      };
    }
    if (resumable) return { text: '可续聊', cls: 'ok', title: '可用 headless 继续该会话' };
    return { text: '历史会话', cls: '', title: '该会话不可续聊' };
  }

  function dshSessionHistoryOk(s) {
    return !(s && s.historyAvailable === false);
  }

  function dshSessionRowHtml(s) {
    const id = String((s && s.id) || '');
    const title = dshSessionTitle(s);
    const cwd = String((s && s.cwd) || '');
    const badge = dshSessionBadge(s);
    const historyOk = dshSessionHistoryOk(s);
    const time = Number((s && (s.updatedAt || s.createdAt)) || 0);
    const count = Number(s && s.messageCount);
    const model = dshModelText(s && s.model);
    const meta = [];
    if (time) meta.push(`<span title="${escapeHtml(fmtDateTime(time))}">${escapeHtml(fmtAgo(time))}</span>`);
    if (Number.isFinite(count) && count > 0) meta.push(`<span>${count} 条消息</span>`);
    if (model) meta.push(`<span class="mono">${escapeHtml(model)}</span>`);
    if (s && s.sizeBytes) meta.push(`<span>${fmtBytes(s.sizeBytes)}</span>`);
    const last = String((s && s.lastMessage) || '').replace(/\s+/g, ' ').trim();
    return `<div class="dsh-session-row${historyOk ? ' is-clickable' : ''}" data-session-id="${escapeHtml(id)}"${
      historyOk ? '' : ' data-history-unavailable="1"'
    }>
      <div class="dsh-session-main">
        <div class="dsh-session-name">${escapeHtml(title)}
          <span class="chip ${badge.cls}" title="${escapeHtml(badge.title)}">${escapeHtml(badge.text)}</span>
        </div>
        <div class="dsh-session-path" title="${escapeHtml(cwd)}">${escapeHtml(cwd || '—')}</div>
        <div class="dsh-session-meta">${meta.join('')}${
          historyOk ? '' : '<span class="muted">历史不可读（服务端缺少解压能力）</span>'
        }</div>
        ${last ? `<div class="dsh-session-last">${escapeHtml(last.slice(0, 120))}</div>` : ''}
      </div>
      ${
        badge.text === '可续聊'
          ? `<button class="btn btn-sm dsh-continue" type="button" data-session-id="${escapeHtml(
              id
            )}" data-session-label="${escapeHtml(title)}">继续</button>`
          : badge.text === 'Web 会话' && dshSdkAvailable()
            ? `<button class="btn btn-sm dsh-sdk-continue" type="button" data-session-id="${escapeHtml(
                id
              )}" data-session-label="${escapeHtml(title)}" title="通过 SDK 通道续聊该 Web 会话">继续（SDK）</button>`
            : ''
      }
    </div>`;
  }

  function dshSessionsHtml(payload) {
    const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions : [];
    if (!sessions.length) {
      const hasQuery = !!(state.dsh && (state.dsh.sessionsQ || state.dsh.workspace));
      return `<div class="placeholder">
        <h3>${hasQuery ? '没有匹配的会话' : '暂无 DSH 会话'}</h3>
        <p>${hasQuery ? '试试清空搜索或切换 workspace。' : '在 DSH 中开始对话后，会话会显示在这里。'}</p>
      </div>`;
    }
    const groups = new Map();
    for (const s of sessions) {
      const key = String((s && (s.workspace || s.cwd)) || '未分组');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const html = [...groups.entries()]
      .map(
        ([workspace, list]) => `<div class="dsh-workspace">
          <div class="dsh-workspace-head" title="${escapeHtml(workspace)}">
            <span class="dsh-workspace-name">${escapeHtml(workspace)}</span>
            <span class="dsh-workspace-count">${list.length}</span>
          </div>
          ${list.map(dshSessionRowHtml).join('')}
        </div>`
      )
      .join('');
    const total = Number.isFinite(Number(payload && payload.total)) ? Number(payload.total) : sessions.length;
    const foot = `共 ${total} 个会话 · 显示 ${sessions.length} 个${payload && payload.truncated ? '（已截断）' : ''}`;
    return `<div class="dsh-sessions">${html}</div><div class="dsh-sessions-foot">${escapeHtml(foot)}</div>`;
  }

  /** 会话历史弹窗 */
  async function openDshHistory(sessionId, seed) {
    const id = String(sessionId || '');
    if (!id) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.id = 'dsh-history-modal';
    wrap.innerHTML = `
      <div class="modal dsh-history-modal">
        <div class="modal-head">
          <h3>会话历史</h3>
          <button class="icon-btn" type="button" data-close aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body dsh-history-body" id="dsh-history-body">
          <div class="placeholder"><div class="skeleton" style="width:70%;height:12px"></div><div class="skeleton" style="width:50%;height:12px"></div></div>
        </div>
        <div class="modal-foot dsh-history-foot">
          <span class="muted dsh-history-hint" id="dsh-history-hint"></span>
          <span class="spacer"></span>
          <button class="btn" type="button" data-close>关闭</button>
          <button class="btn btn-primary hidden" id="dsh-history-sdk" type="button">继续对话（SDK 通道）</button>
          <button class="btn btn-primary" id="dsh-history-console" type="button">在 DSH 控制台打开</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);
    $('#dsh-history-console', wrap).addEventListener('click', (e) => openDshConsole(e.currentTarget));

    const body = $('#dsh-history-body', wrap);
    try {
      const data = await api(`/api/dsh/sessions/${encodeURIComponent(id)}/messages?limit=200`);
      const session = data.session || seed || {};
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      // 跳过没有正文的 assistant/user 占位（工具调用事件本身会以 tool 行展示）
      const messages = rawMessages.filter((m) => {
        if (!m) return false;
        if (m.role === 'tool') return true;
        return String(m.text || '').trim().length > 0;
      });
      const preset = session.agentPreset || (seed && seed.agentPreset) || '';
      const resumable = session.resumable !== undefined ? session.resumable === true : !preset;
      const rows = [
        ['会话', dshSessionTitle(session)],
        ['cwd', session.cwd || '—'],
        ['模型', dshModelText(session.model) || '—'],
        ['agentPreset', preset || '—'],
        [
          '消息数',
          `${
            Number.isFinite(Number(session.messageCount)) ? session.messageCount : rawMessages.length
          }${rawMessages.length < Number(session.messageCount || 0) ? `（当前显示最近 ${rawMessages.length} 条）` : ''}`,
        ],
      ]
        .map(
          ([k, v]) =>
            `<div class="stat-row"><span class="k">${k}</span><span class="v mono dsh-wrap">${escapeHtml(
              String(v)
            )}</span></div>`
        )
        .join('');
      const hint = $('#dsh-history-hint', wrap);
      const isWebSession = Boolean(preset) || !resumable;
      const sdkBtn = $('#dsh-history-sdk', wrap);
      if (sdkBtn) {
        const canSdk = isWebSession && dshSdkAvailable();
        sdkBtn.classList.toggle('hidden', !canSdk);
        if (canSdk) {
          sdkBtn.addEventListener('click', async () => {
            sdkBtn.disabled = true;
            sdkBtn.textContent = '绑定中…';
            const ok = await dshBindSession(id, dshSessionTitle(session), document);
            if (ok) {
              close();
            } else {
              sdkBtn.disabled = false;
              sdkBtn.textContent = '继续对话（SDK 通道）';
            }
          });
        }
      }
      if (hint && isWebSession) {
        hint.textContent = dshSdkAvailable()
          ? '此会话为 Web 会话（含 agentPreset）：headless 无法续聊，可点击「继续对话（SDK 通道）」在面板内继续。'
          : `此会话为 Web 会话（含 agentPreset），headless 无法续聊；如需面板内续聊，需开启 SDK 通道（${dshSdkUnavailableText()}）。`;
      }
      body.innerHTML = `<div class="dsh-history-head">${rows}</div><div class="dsh-history-list">${
        messages.length ? messages.map(dshMessageHtml).join('') : '<div class="placeholder"><p>没有可显示的消息</p></div>'
      }</div>`;
    } catch (err) {
      if (!body.isConnected) return;
      const msg = Number(err && err.status) === 404
        ? '后端未提供会话历史接口（需重启面板加载新版本）'
        : readableDshError(err);
      body.innerHTML = `<div class="dl-error"><strong>会话历史加载失败</strong>${escapeHtml(msg)}
        <details><summary>技术细节</summary><pre>${escapeHtml((err && err.message) || '')}</pre></details></div>`;
    }
  }

  function dshMessageHtml(m) {
    const role = String((m && m.role) || 'assistant');
    const ts = Number(m && m.ts);
    const time = Number.isFinite(ts) && ts > 0 ? fmtDateTime(ts) : '';
    if (role === 'tool') {
      let toolName = '';
      let params = '';
      if (m.tool && typeof m.tool === 'object') {
        toolName = m.tool.name || m.tool.id || '';
        try {
          params = JSON.stringify(m.tool, null, 2);
        } catch (e) {
          params = String(m.tool);
        }
      } else {
        toolName = String((m && m.tool) || '');
        params = String((m && m.text) || '');
      }
      let summary = params.length > 4000 ? `${params.slice(0, 4000)}\n…` : params;
      if (m.result !== undefined && m.result !== null) {
        let resultText = '';
        try {
          resultText = typeof m.result === 'string' ? m.result : JSON.stringify(m.result, null, 2);
        } catch (e) {
          resultText = String(m.result);
        }
        summary += `\n\n— 结果 —\n${resultText.length > 4000 ? `${resultText.slice(0, 4000)}\n…` : resultText}`;
      }
      return `<details class="dsh-msg dsh-msg-tool">
        <summary>工具 ${escapeHtml(toolName || '调用')}${time ? `<span class="dsh-msg-time">${escapeHtml(time)}</span>` : ''}</summary>
        <pre>${escapeHtml(summary)}</pre>
      </details>`;
    }
    const label = role === 'user' ? '用户' : role === 'assistant' ? 'DSH' : role;
    return `<div class="dsh-msg dsh-msg-${role === 'user' ? 'user' : 'assistant'}">
      <div class="dsh-msg-head"><span class="chip ${role === 'user' ? 'info' : ''}">${escapeHtml(label)}</span>${
        time ? `<span class="dsh-msg-time">${escapeHtml(time)}</span>` : ''
      }</div>
      <div class="dsh-msg-text">${escapeHtml(String((m && m.text) || ''))}</div>
    </div>`;
  }

  function dshCapabilityHtml(cap) {
    if (!cap) return '';
    const rows = [];
    const add = (k, v) => rows.push(`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`);
    if (cap.profile) add('Profile', `<span class="mono">${escapeHtml(cap.profile)}</span>`);
    if (cap.dshVersion) add('DSH 版本', `<span class="mono">${escapeHtml(cap.dshVersion)}</span>`);
    const defaultModel = dshModelText(cap.defaultModel);
    if (defaultModel) add('默认模型', `<span class="mono">${escapeHtml(defaultModel)}</span>`);
    if (cap.allowTask !== undefined) {
      add('允许远程任务', cap.allowTask ? '<span class="chip ok">是</span>' : '<span class="chip warn">否</span>');
    }
    if (cap.taskPatches !== undefined) {
      const patchCount = Array.isArray(cap.taskPatches) ? cap.taskPatches.length : Number(cap.taskPatches) || 0;
      add('Task Patches', String(patchCount));
    }
    if (cap.historyDecode) {
      const decode = String(cap.historyDecode);
      const headerOnly = ['header-only', 'header_only', 'none', 'unavailable'].includes(decode.toLowerCase());
      add(
        '历史解码',
        headerOnly
          ? `<span class="chip warn">${escapeHtml(decode)}</span>
             <span class="muted" style="font-size:11.5px">服务端缺少 zstd，无法读取历史消息</span>`
          : `<span class="chip ok">${escapeHtml(decode)}</span>`
      );
    }
    const providers = Array.isArray(cap.providers) ? cap.providers : [];
    if (providers.length) {
      rows.push(`<details class="dsh-cap-details"><summary>可选模型（${providers.length} 个 provider）</summary>
        <div class="dsh-provider-list">${providers
          .map(
            (p) => `<div class="dsh-provider">
              <div class="dsh-provider-name">${escapeHtml(p.name || '')}</div>
              ${(Array.isArray(p.models) ? p.models : [])
                .map(
                  (m) =>
                    `<div class="dsh-model-row"><span class="mono">${escapeHtml(m.id || '')}</span><span class="muted">${escapeHtml(
                      m.name || ''
                    )}</span></div>`
                )
                .join('')}
            </div>`
          )
          .join('')}</div>
      </details>`);
    }
    const plugins = Array.isArray(cap.plugins) ? cap.plugins : [];
    if (plugins.length) {
      const enabled = plugins.filter((p) => !p.disabled).length;
      rows.push(`<details class="dsh-cap-details"><summary>插件（${plugins.length} 个 · 启用 ${enabled}）</summary>
        <div class="dsh-plugin-list">${plugins
          .map(
            (p) =>
              `<div class="stat-row"><span class="k mono">${escapeHtml(p.id || '')}</span><span class="v" style="max-width:60%;text-align:right;overflow-wrap:anywhere">${escapeHtml(
                p.name || ''
              )}${p.disabled ? ' <span class="chip">已禁用</span>' : ''}</span></div>`
          )
          .join('')}</div>
      </details>`);
    }
    return rows.join('');
  }

  function dshCapabilityErrorHtml(err) {
    const is404 = Number(err && err.status) === 404;
    const msg = is404
      ? '后端未提供该接口（需重启面板加载新版本）'
      : featureErrorText(err, 'DSH 能力');
    return `<div class="muted" style="font-size:12px;line-height:1.7">${escapeHtml(msg)}</div>`;
  }

  function dshModelHintHtml(cap) {
    if (!cap) return '可用模型：暂未获取（后端未提供能力接口）';
    const bits = [];
    const defaultModel = dshModelText(cap.defaultModel);
    if (defaultModel) bits.push(`默认 <span class="mono">${escapeHtml(defaultModel)}</span>`);
    const flat = [];
    for (const p of Array.isArray(cap.providers) ? cap.providers : []) {
      for (const m of Array.isArray(p.models) ? p.models : []) {
        flat.push(`${p.name || ''}:${dshModelText(m)}`);
      }
    }
    if (flat.length) bits.push(`可选 ${flat.slice(0, 8).map(escapeHtml).join('、')}${flat.length > 8 ? ' …' : ''}`);
    return bits.length ? `可用模型：${bits.join(' · ')}` : '可用模型：未配置';
  }

  function dshTaskNoticeHtml() {
    if (state.dsh.allowTask === true) return '';
    if (state.dsh.allowTask === false) {
      return `<div class="notice">任务提交已禁用：需在服务器 <span class="mono">config.json</span> 中设置
        <span class="mono">dsh.allowTask = true</span> 并重启面板服务。</div>`;
    }
    return `<div class="notice">无法获取 DSH 状态，任务提交暂不可用（后端 DSH 接口未就绪或未登录）。</div>`;
  }

  function dshStripAnsi(text) {
    return String(text).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  function dshLogLineEl(kind, text) {
    const el = document.createElement('div');
    el.className = kind ? `dsh-log-line ${kind}` : 'dsh-log-line';
    el.textContent = text;
    return el;
  }

  function dshRenderLogs() {
    const out = $('#dsh-output');
    if (!out) return;
    out.innerHTML = '';
    if (!state.dsh.logs.length) {
      out.innerHTML = '<div class="dsh-output-empty">任务开始后，DSH 的输出会实时显示在这里。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of state.dsh.logs) frag.appendChild(dshLogLineEl(item.kind, item.text));
    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  }

  function dshAppendLog(kind, text) {
    const clean = dshStripAnsi(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!clean) return;
    let chunks = clean.split('\n');
    while (chunks.length > 1 && chunks[chunks.length - 1] === '') chunks.pop();
    for (const chunk of chunks) state.dsh.logs.push({ kind, text: chunk });
    while (state.dsh.logs.length > DSH_LOG_LIMIT) state.dsh.logs.shift();

    const out = $('#dsh-output');
    if (!out) return;
    const placeholder = out.querySelector('.dsh-output-empty');
    if (placeholder) placeholder.remove();
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 80;
    for (const chunk of chunks) out.appendChild(dshLogLineEl(kind, chunk));
    while (out.childElementCount > DSH_LOG_LIMIT) out.removeChild(out.firstElementChild);
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  function dshSetTaskStatus(label, cls) {
    state.dsh.taskStatus = { label, cls: cls || '' };
    const chip = $('#dsh-output-status');
    if (chip) {
      chip.textContent = label;
      chip.className = `chip ${cls || ''}`.trim();
    }
    const head = $('#dsh-task-state');
    if (head) {
      const running = label === '运行中' || label === '重连中…';
      const ok = label === '已完成';
      const bad = label === '失败' || label === '错误';
      head.textContent = running ? '运行中' : ok ? '已完成' : bad ? '失败' : '空闲';
      head.className = `chip ${running ? 'info' : ok ? 'ok' : bad ? 'crit' : ''}`.trim();
    }
  }

  function dshUpdateTaskUI() {
    const allow = state.dsh.allowTask === true;
    const running = state.dsh.running;
    const ta = $('#dsh-prompt');
    if (ta) ta.disabled = !allow;
    const start = $('#dsh-start');
    if (start) {
      start.disabled = !allow || running;
      start.textContent = running ? '运行中…' : '开始';
    }
    const notice = $('#dsh-task-notice');
    if (notice) notice.innerHTML = dshTaskNoticeHtml();
    const modeNew = $('#dsh-mode-new');
    const modeCont = $('#dsh-mode-continue');
    if (modeNew) modeNew.classList.toggle('active', state.dsh.mode === 'new');
    if (modeCont) {
      modeCont.classList.toggle('active', state.dsh.mode === 'continue');
      modeCont.disabled = !allow || !state.dsh.sessionId;
    }
    const sel = $('#dsh-selected');
    if (sel) {
      if (state.dsh.sessionId) {
        const sdkChip = state.dsh.boundChat
          ? ` <span class="chip ok" title="已通过 SDK 通道绑定">SDK 已绑定</span>`
          : state.dsh.selectedIsWeb
            ? ` <span class="chip warn">Web 会话</span>`
            : '';
        sel.innerHTML = `继续会话：<span class="mono">${escapeHtml(state.dsh.sessionLabel || state.dsh.sessionId)}</span>${sdkChip}
          <button type="button" class="btn btn-sm" id="dsh-clear-session">取消选择</button>`;
      } else {
        sel.textContent = '新建会话（不关联历史会话）';
      }
    }
    dshUpdateChannelUI(document);
  }

  function dshSelectSession(id, label) {
    if (!id) return;
    state.dsh.sessionId = id;
    state.dsh.sessionLabel = label || id;
    state.dsh.mode = 'continue';
    state.dsh.boundChat = null;
    state.dsh.selectedIsWeb = false;
    dshUpdateTaskUI();
    const ta = $('#dsh-prompt');
    if (ta) ta.focus();
    if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
      const card = $('#dsh-task-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    toast('已选择会话，提交后将在此会话中继续', 'ok');
  }

  function dshCloseTaskStream() {
    if (state.dsh.taskEs) {
      try {
        state.dsh.taskEs.close();
      } catch (e) {
        /* ignore */
      }
      state.dsh.taskEs = null;
    }
  }

  function dshSubscribeTask(taskId) {
    dshCloseTaskStream();
    if (typeof window.EventSource !== 'function') {
      state.dsh.running = false;
      dshAppendLog('error', '当前浏览器不支持 EventSource，无法接收实时输出。');
      dshSetTaskStatus('错误', 'crit');
      dshUpdateTaskUI();
      return;
    }
    let es;
    try {
      es = new EventSource(`/api/dsh/task/stream?id=${encodeURIComponent(taskId)}`);
    } catch (err) {
      state.dsh.running = false;
      dshAppendLog('error', `SSE 连接创建失败：${err.message}`);
      dshSetTaskStatus('错误', 'crit');
      dshUpdateTaskUI();
      return;
    }
    state.dsh.taskEs = es;
    let finished = false;

    const finish = (label, cls) => {
      if (finished) return;
      finished = true;
      state.dsh.running = false;
      dshSetTaskStatus(label, cls);
      dshCloseTaskStream();
      dshUpdateTaskUI();
    };

    const onMessage = (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const type = msg.type || 'event';
      if (type === 'start') {
        dshSetTaskStatus('运行中', 'info');
        if (msg.sessionId) dshAppendLog('event', `会话：${msg.sessionId}`);
        return;
      }
      if (type === 'done') {
        const code = typeof msg.code === 'number' ? msg.code : null;
        const ok = code === 0 || code === null;
        dshAppendLog(ok ? 'ok' : 'error', `任务结束${code === null ? '' : `（退出码 ${code}）`}`);
        finish(ok ? '已完成' : '失败', ok ? 'ok' : 'crit');
        toast(ok ? 'DSH 任务已完成' : `DSH 任务失败（退出码 ${code}）`, ok ? 'ok' : 'err', 5000);
        return;
      }
      if (type === 'error') {
        const message = msg.message || '任务执行出错';
        dshAppendLog('error', message);
        finish('失败', 'crit');
        toast(readableDshError(message), 'err', 6000);
        return;
      }
      let line;
      if (msg.line !== undefined && msg.line !== null) line = String(msg.line);
      else line = JSON.stringify(msg);
      dshAppendLog(type === 'stderr' ? 'stderr' : type === 'stdout' ? 'stdout' : 'event', line);
    };

    es.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch (e) {
        dshAppendLog('stdout', ev.data);
      }
    };
    ['start', 'event', 'stdout', 'stderr', 'done', 'error'].forEach((name) => {
      es.addEventListener(name, (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          dshAppendLog(name === 'stderr' ? 'stderr' : 'stdout', ev.data);
          return;
        }
        if (!msg.type) msg.type = name;
        onMessage(msg);
      });
    });
    es.onopen = () => {
      if (!finished) dshSetTaskStatus('运行中', 'info');
    };
    es.onerror = () => {
      if (finished) return;
      if (es.readyState === 2) {
        // readyState=CLOSED：服务端关闭了流且未收到结束事件
        finish('连接已关闭', 'warn');
        dshAppendLog('warn', 'SSE 连接已关闭且未收到结束事件；任务可能仍在服务端运行，请稍后刷新查看。');
      } else {
        dshSetTaskStatus('重连中…', 'warn');
      }
    };
  }

  async function openDshConsole(btn) {
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在获取控制台地址…';
    try {
      const data = await api('/api/dsh/console-url');
      const url = data && data.url;
      if (!url) throw new Error('接口未返回 url');
      const win = window.open(url, '_blank');
      if (!win) throw new Error('浏览器拦截了弹出窗口，请允许本站弹窗后重试');
      try {
        win.opener = null;
      } catch (e) {
        /* ignore */
      }
      toast('已打开 DSH 控制台', 'ok');
    } catch (err) {
      toast(readableDshError(err), 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  }

  async function startDshTask() {
    if (state.dsh.allowTask !== true) {
      toast('任务提交已禁用，请先在 config.json 开启 dsh.allowTask', 'warn', 5000);
      return;
    }
    if (state.dsh.running) {
      toast('已有任务在运行，请等待结束', 'warn');
      return;
    }
    const ta = $('#dsh-prompt');
    const prompt = ta ? ta.value.trim() : '';
    if (!prompt) {
      toast('请先填写任务内容', 'warn');
      if (ta) ta.focus();
      return;
    }
    if (state.dsh.mode === 'continue' && !state.dsh.sessionId) {
      toast('请先在会话列表选择要继续的会话', 'warn');
      return;
    }

    const channel = dshEffectiveChannel();
    if (channel === 'sdk' && !dshSdkAvailable()) {
      toast(dshSdkUnavailableText(), 'warn', 6000);
      return;
    }
    if (channel === 'headless' && state.dsh.selectedIsWeb) {
      toast('Web 会话不能通过 headless 续聊，请把通道改为「自动」或「SDK」', 'warn', 6000);
      return;
    }
    if (channel === 'sdk' && !state.dsh.boundChat) {
      toast('SDK 通道需要先绑定一个 DSH 会话：请在 Web 会话行点击「继续（SDK）」后再发送', 'warn', 6500);
      return;
    }

    state.dsh.logs = [];
    dshRenderLogs();
    state.dsh.running = true;
    state.dsh.taskId = null;
    dshSetTaskStatus('运行中', 'info');
    dshAppendLog('event', `正在提交任务…（通道：${dshChannelLabel(channel)}）`);
    dshUpdateTaskUI();

    try {
      const useChat = state.dsh.boundChat && state.dsh.boundChat.id && channel !== 'headless';
      let taskId;
      if (useChat) {
        const chat = state.dsh.boundChat;
        dshAppendLog('event', `通过 SDK 绑定会话提交：${chat.id}`);
        const data = await api(`/api/dsh/chat/sessions/${encodeURIComponent(chat.id)}/messages`, {
          method: 'POST',
          body: { text: prompt, channel },
        });
        taskId = data && (data.taskId || data.id);
        if (!taskId) throw new Error('接口未返回任务 ID');
      } else {
        const data = await api('/api/dsh/task', {
          method: 'POST',
          body: {
            prompt,
            sessionId: state.dsh.mode === 'continue' ? state.dsh.sessionId : null,
            channel,
          },
        });
        taskId = data && data.id;
        if (!taskId) throw new Error('接口未返回任务 ID');
      }
      state.dsh.taskId = taskId;
      dshAppendLog('event', `任务已创建：${taskId}`);
      dshSubscribeTask(taskId);
    } catch (err) {
      state.dsh.running = false;
      const msg = dshBindErrorText(err);
      dshAppendLog('error', msg);
      dshSetTaskStatus('失败', 'crit');
      toast(msg, 'err', 7000);
      dshUpdateTaskUI();
    }
  }


  async function dshLoadSessions(root) {
    const body = $('#dsh-sessions-body', root);
    if (!body) return;
    if (!state.dsh.sessions.length) {
      body.innerHTML = `<div class="placeholder">
        <div class="skeleton" style="width:65%;height:12px"></div>
        <div class="skeleton" style="width:45%;height:12px"></div>
      </div>`;
    }
    const qs = new URLSearchParams({ limit: '50' });
    if (state.dsh.sessionsQ) qs.set('q', state.dsh.sessionsQ);
    if (state.dsh.workspace) qs.set('workspace', state.dsh.workspace);
    try {
      const data = await api('/api/dsh/sessions?' + qs.toString());
      state.dsh.sessionsPayload = data;
      state.dsh.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (!state.dsh.workspace) {
        state.dsh.workspaces = [
          ...new Set(state.dsh.sessions.map((x) => String((x && (x.workspace || x.cwd)) || '未分组'))),
        ];
      }
      const sel = $('#dsh-session-workspace', root);
      if (sel) {
        const current = state.dsh.workspace || '';
        sel.innerHTML =
          '<option value="">全部 workspace</option>' +
          state.dsh.workspaces
            .map((w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`)
            .join('');
        sel.value = state.dsh.workspaces.includes(current) ? current : '';
      }
      body.innerHTML = dshSessionsHtml(data);
      const countEl = $('#dsh-sessions-count', root);
      if (countEl) countEl.textContent = `显示 ${state.dsh.sessions.length} 个`;
      if (!state.dsh.capabilities) dshUpdateModelHintFromSessions(root);
    } catch (err) {
      const is404 = Number(err && err.status) === 404;
      body.innerHTML = is404
        ? `<div class="dl-error"><strong>会话目录不可用</strong>后端未提供该接口（需重启面板加载新版本）。</div>
           <button class="btn btn-sm" id="dsh-sessions-retry" type="button">重试</button>`
        : dshErrorHtml('会话列表加载失败', err);
      const retry = $('#dsh-sessions-retry', root);
      if (retry) retry.addEventListener('click', () => dshLoadSessions(root));
      if (!state.dsh.capabilities) dshUpdateModelHintFromSessions(root);
    }
  }

  /** 能力接口缺失时，用会话里出现过的 model 兜底提示 */
  function dshUpdateModelHintFromSessions(root) {
    const hint = $('#dsh-models-hint', root);
    if (!hint || state.dsh.capabilities) return;
    const models = [
      ...new Set((state.dsh.sessions || []).map((s) => dshModelText(s && s.model)).filter(Boolean)),
    ];
    hint.innerHTML = models.length
      ? `可用模型（来自会话）：${models.slice(0, 8).map(escapeHtml).join('、')}${models.length > 8 ? ' …' : ''}`
      : '可用模型：暂未获取（后端未提供能力接口）';
  }

  async function dshLoadCapabilities(root) {
    const body = $('#dsh-cap-body', root);
    if (!body) return;
    const sub = $('#dsh-cap-sub', root);
    body.innerHTML = '<div class="placeholder"><div class="skeleton" style="width:60%;height:12px"></div></div>';
    try {
      const cap = await api('/api/dsh/capabilities');
      state.dsh.capabilities = cap || {};
      state.dsh.capabilitiesError = null;
      if (sub) {
        const bits = [];
        if (cap && cap.profile) bits.push(`profile ${cap.profile}`);
        if (cap && cap.dshVersion) bits.push(`v${cap.dshVersion}`);
        sub.textContent = bits.join(' · ');
      }
      body.innerHTML =
        (dshCapabilityHtml(cap) || '<div class="muted" style="font-size:12px">能力接口未返回可展示字段</div>') +
        '<div id="dsh-sdk-row"><div class="stat-row"><span class="k">SDK 续聊</span><span class="v"><span class="chip">读取中…</span></span></div></div>';
      const hint = $('#dsh-models-hint', root);
      if (hint) hint.innerHTML = dshModelHintHtml(cap);
      await dshLoadSdkStatus(root);
    } catch (err) {
      state.dsh.capabilities = null;
      state.dsh.capabilitiesError = err;
      if (sub) sub.textContent = '';
      body.innerHTML =
        dshCapabilityErrorHtml(err) +
        '<div id="dsh-sdk-row"><div class="stat-row"><span class="k">SDK 续聊</span><span class="v"><span class="chip">读取中…</span></span></div></div>';
      const hint = $('#dsh-models-hint', root);
      if (hint) hint.innerHTML = dshModelHintHtml(null);
      dshUpdateModelHintFromSessions(root);
      await dshLoadSdkStatus(root);
    }
  }


  /* ---------------- SDK 高级续聊 ---------------- */

  function dshSdkAvailable() {
    return !!(state.dsh && state.dsh.sdk && state.dsh.sdk.available === true);
  }

  function dshSdkUnavailableText() {
    const sdk = state.dsh.sdk;
    if (!sdk) return '正在读取 SDK 续聊状态…';
    if (sdk._404) return '后端未提供 SDK 续聊（需重启面板加载新版本）';
    if (sdk.available) return '';
    return sdk.reason || 'SDK 续聊不可用';
  }

  function dshSdkRowHtml() {
    const sdk = state.dsh.sdk;
    if (!sdk) {
      return `<div class="stat-row"><span class="k">SDK 续聊</span><span class="v"><span class="chip">读取中…</span></span></div>`;
    }
    if (sdk._404) {
      return `<div class="notice dsh-notice" style="margin:12px 0 0">
        <p><strong>SDK 续聊</strong>：后端未提供该接口（需重启面板加载新版本）。</p>
      </div>`;
    }
    const rows = [];
    const add = (k, v) => rows.push(`<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`);
    add('SDK 续聊', sdk.available ? '<span class="chip ok">可用</span>' : '<span class="chip warn">不可用</span>');
    if (sdk.profile) add('SDK Profile', `<span class="mono">${escapeHtml(String(sdk.profile))}</span>`);
    if (Array.isArray(sdk.presets)) {
      add(
        '可用 Presets',
        sdk.presets.length
          ? sdk.presets
              .slice(0, 12)
              .map((p) => {
                const name = typeof p === 'string' ? p : p && (p.name || p.id);
                return `<span class="chip">${escapeHtml(String(name || ''))}</span>`;
              })
              .join(' ')
          : '<span class="muted">无</span>'
      );
    }
    if (sdk.providersPatch !== undefined || sdk.providersPatchExists !== undefined) {
      let patchText;
      if (typeof sdk.providersPatch === 'boolean') patchText = sdk.providersPatch ? '已应用' : '未应用';
      else if (typeof sdk.providersPatch === 'string' && sdk.providersPatch) {
        // 不在 UI 暴露服务器绝对路径，只显示 basename + 是否存在
        const base = sdk.providersPatch.split(/[\\/]/).filter(Boolean).pop();
        patchText = sdk.providersPatchExists === false
          ? '未配置（文件不存在）'
          : `已配置${base ? `（${base}）` : ''}`;
      } else {
        patchText = sdk.providersPatchExists ? '已配置' : '未配置';
      }
      add('providersPatch', `<span class="dsh-wrap">${escapeHtml(String(patchText))}</span>`);
    }
    let html = rows.join('');
    if (!sdk.available) {
      html += `<div class="notice dsh-notice" style="margin:10px 0 0">
        <p><strong>如何开启</strong>：在服务器 <span class="mono">config.json</span> 的 <span class="mono">dsh</span> 段设置
          <span class="mono">allowSdkResume = true</span> 后重启面板；SDK 通道用于续聊带 agent preset 的 Web 会话。</p>
        ${sdk.reason ? `<p class="muted" style="font-size:11.5px">当前原因：${escapeHtml(String(sdk.reason))}</p>` : ''}
      </div>`;
    }
    return html;
  }

  function dshBindErrorText(err) {
    const msg = (err && err.message) || String(err || '');
    const status = Number(err && err.status);
    const has = (code) => msg.includes(code);
    if (has('dsh_session_busy_in_web') || has('busy_in_web')) {
      return '该会话正在 DSH Web 中打开，请先在 DSH Web 中关闭该会话，再回来重试。';
    }
    if (has('sdk_resume_disabled')) {
      return 'SDK 续聊未开启：需在 config.json 设置 dsh.allowSdkResume=true 并重启面板。';
    }
    if (has('dsh_provider_missing')) {
      return '缺少 provider 配置，无法通过 SDK 续聊（请检查 DSH 的 providers 配置）。';
    }
    if (has('dsh_preset_missing')) {
      return '缺少 agent preset，无法通过 SDK 续聊（请检查 DSH 的 preset 配置）。';
    }
    if (has('dsh_session_not_resumable')) {
      return '当前后端仍按 headless 拒绝该会话；需更新并重启面板以启用 SDK 续聊。';
    }
    if (has('dsh_session_not_found')) return 'DSH 会话不存在或已被删除。';
    if (has('dsh_task_busy')) return '已有 DSH 任务在运行，请等待结束后重试。';
    if (status === 404 || /接口不存在|not_found/.test(msg)) {
      return '后端未提供 SDK 续聊（需重启面板加载新版本）。';
    }
    return readableDshError(err);
  }

  function dshScrollToTask(root) {
    const card = $('#dsh-task-card', root);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#dsh-prompt', root)?.focus(), 320);
  }

  /** 通过 SDK 绑定一个 DSH 会话为面板聊天会话 */
  async function dshBindSession(dshSessionId, title, root) {
    const id = String(dshSessionId || '');
    if (!id) return false;
    if (!dshSdkAvailable()) {
      toast(dshSdkUnavailableText(), 'warn', 6000);
      return false;
    }
    try {
      const res = await api('/api/dsh/chat/sessions', {
        method: 'POST',
        body: { dshSessionId: id, force: true },
      });
      const chatId = res && (res.id || res.sessionId || (res.session && res.session.id));
      state.dsh.boundChat = {
        id: chatId || null,
        dshSessionId: id,
        title: (res && res.title) || title || id,
      };
      state.dsh.sessionId = id;
      state.dsh.sessionLabel = state.dsh.boundChat.title;
      state.dsh.mode = 'continue';
      state.dsh.selectedIsWeb = true;
      // Web 会话自动走 SDK：绑定后通道回到「自动」
      state.dsh.channel = 'auto';
      dshUpdateTaskUI();
      toast('已通过 SDK 通道绑定会话，可在下方输入任务继续对话', 'ok', 4500);
      dshScrollToTask(root || document);
      return true;
    } catch (err) {
      toast(dshBindErrorText(err), 'err', 7000);
      return false;
    }
  }

  function dshEffectiveChannel() {
    const ch = state.dsh.channel || 'auto';
    if (ch === 'headless') return 'headless';
    if (state.dsh.boundChat && state.dsh.selectedIsWeb) return 'sdk';
    if (ch === 'sdk') return 'sdk';
    return 'auto';
  }

  function dshChannelLabel(ch) {
    return { auto: '自动', headless: 'headless', sdk: 'SDK' }[ch] || ch;
  }

  function dshUpdateChannelUI(root) {
    const sel = $('#dsh-channel', root);
    if (sel) {
      const sdkOpt = sel.querySelector('option[value="sdk"]');
      const available = dshSdkAvailable();
      if (sdkOpt) {
        sdkOpt.disabled = !available;
        sdkOpt.title = available ? '' : dshSdkUnavailableText();
      }
      if (!available && sel.value === 'sdk') {
        sel.value = 'auto';
        state.dsh.channel = 'auto';
      }
      sel.value = state.dsh.channel || 'auto';
    }
    const hint = $('#dsh-channel-hint', root);
    if (hint) {
      const eff = dshEffectiveChannel();
      const bits = [`发送通道：${dshChannelLabel(eff)}`];
      if (state.dsh.boundChat) bits.push(`SDK 已绑定（${state.dsh.boundChat.id || 'chat'}）`);
      if (!dshSdkAvailable() && (state.dsh.channel === 'sdk' || state.dsh.selectedIsWeb)) {
        bits.push(dshSdkUnavailableText());
      }
      hint.textContent = bits.join(' · ');
    }
  }


  async function dshLoadSdkStatus(root) {
    try {
      const sdk = await api('/api/dsh/sdk/status');
      state.dsh.sdk = sdk || { available: false };
      state.dsh.sdkError = null;
    } catch (err) {
      state.dsh.sdkError = err;
      state.dsh.sdk =
        Number(err && err.status) === 404
          ? { _404: true, available: false, reason: '后端未提供 SDK 续聊（需重启面板）' }
          : { available: false, reason: featureErrorText(err, 'SDK 续聊') };
    }
    const row = $('#dsh-sdk-row', root);
    if (row) row.innerHTML = dshSdkRowHtml();
    dshUpdateChannelUI(root);
    // SDK 可用性影响会话行按钮：用缓存数据重绘，不重复请求
    const sessionsBody = $('#dsh-sessions-body', root);
    if (sessionsBody && state.dsh.sessionsPayload) {
      sessionsBody.innerHTML = dshSessionsHtml(state.dsh.sessionsPayload);
    }
  }

  async function renderDsh(root) {
    state.dsh.renderToken = (state.dsh.renderToken || 0) + 1;
    const token = state.dsh.renderToken;

    root.innerHTML = `
      <div class="grid dsh-grid">
        <div class="card dsh-status-card">
          <div class="card-head">
            <h3>DSH 状态</h3><span class="spacer"></span>
            <button class="btn btn-sm" id="dsh-refresh" type="button">刷新</button>
          </div>
          <div id="dsh-status-body">
            <div class="placeholder">
              <div class="skeleton" style="width:70%;height:12px"></div>
              <div class="skeleton" style="width:90%;height:12px"></div>
              <div class="skeleton" style="width:50%;height:12px"></div>
            </div>
          </div>
        </div>
        <div class="card dsh-console-card">
          <div class="card-head"><h3>DSH 控制台</h3></div>
          <p class="muted dsh-console-desc">使用服务端生成的一次性 token URL 打开 DSH Web（新标签页）。token 会随 DSH 重启变化。</p>
          <button class="btn btn-primary btn-block" id="dsh-open" type="button">${ICONS.dsh} 打开 DSH 控制台</button>
          <div class="dsh-console-hint" id="dsh-console-hint">正在读取 DSH 状态…</div>
        </div>
      </div>
      <div class="grid dsh-grid-main">
        <div class="card dsh-sessions-card">
          <div class="card-head">
            <h3>最近会话</h3><span class="spacer"></span>
            <input type="search" class="dsh-session-search" id="dsh-session-q" placeholder="搜索标题 / cwd / 模型" value="${escapeHtml(state.dsh.sessionsQ || '')}">
            <select id="dsh-session-workspace" class="dsh-session-ws"><option value="">全部 workspace</option></select>
            <span class="card-sub" id="dsh-sessions-count"></span>
            <button class="btn btn-sm" id="dsh-sessions-refresh" type="button">刷新</button>
          </div>
          <div id="dsh-sessions-body"><div class="placeholder"><p>正在加载会话…</p></div></div>
        </div>
        <div class="card dsh-task-card" id="dsh-task-card">
          <div class="card-head">
            <h3>运行任务</h3><span class="spacer"></span>
            <span class="chip" id="dsh-task-state">空闲</span>
          </div>
          <div class="dsh-models-hint" id="dsh-models-hint">可用模型：正在读取…</div>
          <div class="dsh-channel-row">
            <label class="dsh-inline"><span>通道</span>
              <select id="dsh-channel">
                <option value="auto">自动</option>
                <option value="headless">headless</option>
                <option value="sdk">SDK</option>
              </select>
            </label>
            <span class="muted dsh-channel-hint" id="dsh-channel-hint">发送通道：自动</span>
          </div>
          <div class="dsh-mode">
            <button class="btn btn-sm dsh-mode-btn" id="dsh-mode-new" type="button">新建会话</button>
            <button class="btn btn-sm dsh-mode-btn" id="dsh-mode-continue" type="button" disabled>继续所选会话</button>
          </div>
          <div class="dsh-selected" id="dsh-selected">新建会话（不关联历史会话）</div>
          <label class="field">
            <span>任务内容</span>
            <textarea id="dsh-prompt" rows="4" placeholder="描述要交给 DSH 的任务，例如：检查磁盘占用并列出最大的 10 个目录"></textarea>
          </label>
          <div id="dsh-task-notice"></div>
          <div class="dsh-task-actions">
            <button class="btn btn-primary" id="dsh-start" type="button">开始</button>
            <button class="btn" id="dsh-clear-output" type="button">清空输出</button>
          </div>
          <div class="dsh-output-wrap">
            <div class="dsh-output-head"><span>实时输出</span><span class="chip" id="dsh-output-status">空闲</span></div>
            <div class="dsh-output" id="dsh-output" role="log" aria-live="polite"></div>
          </div>
        </div>
      </div>
      <div class="card dsh-cap-card" id="dsh-cap-card">
        <div class="card-head">
          <h3>DSH 能力</h3><span class="spacer"></span>
          <span class="card-sub" id="dsh-cap-sub"></span>
          <button class="btn btn-sm" id="dsh-cap-refresh" type="button">刷新</button>
        </div>
        <div id="dsh-cap-body"><div class="placeholder"><div class="skeleton" style="width:60%;height:12px"></div></div></div>
      </div>
    `;

    // 事件绑定
    $('#dsh-refresh', root).addEventListener('click', () => navigate('dsh'));
    $('#dsh-open', root).addEventListener('click', (e) => openDshConsole(e.currentTarget));
    $('#dsh-sessions-body', root).addEventListener('click', (e) => {
      const sdkBtn = e.target.closest('.dsh-sdk-continue');
      if (sdkBtn) {
        e.stopPropagation();
        dshBindSession(sdkBtn.dataset.sessionId, sdkBtn.dataset.sessionLabel, root);
        return;
      }
      const btn = e.target.closest('.dsh-continue');
      if (btn) {
        e.stopPropagation();
        dshSelectSession(btn.dataset.sessionId, btn.dataset.sessionLabel);
        return;
      }
      const row = e.target.closest('.dsh-session-row');
      if (!row) return;
      if (row.dataset.historyUnavailable) {
        toast('该会话历史不可读（服务端缺少解压能力）', 'warn', 5000);
        return;
      }
      openDshHistory(row.dataset.sessionId, (state.dsh.sessions || []).find((x) => x.id === row.dataset.sessionId));
    });
    $('#dsh-sessions-refresh', root).addEventListener('click', () => dshLoadSessions(root));
    $('#dsh-session-q', root).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      state.dsh.sessionsQ = e.currentTarget.value.trim();
      dshLoadSessions(root);
    });
    $('#dsh-session-q', root).addEventListener('search', (e) => {
      state.dsh.sessionsQ = String(e.currentTarget.value || '').trim();
      dshLoadSessions(root);
    });
    $('#dsh-session-workspace', root).addEventListener('change', (e) => {
      state.dsh.workspace = e.currentTarget.value || '';
      dshLoadSessions(root);
    });
    $('#dsh-cap-refresh', root).addEventListener('click', () => dshLoadCapabilities(root));
    $('#dsh-channel', root).addEventListener('change', (e) => {
      state.dsh.channel = e.currentTarget.value || 'auto';
      dshUpdateTaskUI();
    });
    $('#dsh-mode-new', root).addEventListener('click', () => {
      state.dsh.sessionId = null;
      state.dsh.sessionLabel = '';
      state.dsh.mode = 'new';
      state.dsh.boundChat = null;
      state.dsh.selectedIsWeb = false;
      dshUpdateTaskUI();
    });
    $('#dsh-mode-continue', root).addEventListener('click', () => {
      if (!state.dsh.sessionId) {
        toast('请先在下方会话列表点击「继续」选择会话', 'info');
        return;
      }
      state.dsh.mode = 'continue';
      dshUpdateTaskUI();
    });
    $('#dsh-selected', root).addEventListener('click', (e) => {
      if (!e.target.closest('#dsh-clear-session')) return;
      state.dsh.sessionId = null;
      state.dsh.sessionLabel = '';
      state.dsh.mode = 'new';
      state.dsh.boundChat = null;
      state.dsh.selectedIsWeb = false;
      dshUpdateTaskUI();
    });
    $('#dsh-start', root).addEventListener('click', startDshTask);
    $('#dsh-clear-output', root).addEventListener('click', () => {
      state.dsh.logs = [];
      dshRenderLogs();
      toast('输出已清空', 'info');
    });
    $('#dsh-prompt', root).addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        startDshTask();
      }
    });

    // 恢复上一次的日志与任务状态（跨页面切换不丢输出）
    dshRenderLogs();
    if (state.dsh.taskStatus) dshSetTaskStatus(state.dsh.taskStatus.label, state.dsh.taskStatus.cls);
    dshUpdateTaskUI();

    if (state.dsh.running && state.dsh.taskId && !state.dsh.taskEs) {
      dshSubscribeTask(state.dsh.taskId);
    }

    // 先按契约并发拉取；后端未就绪时分别降级为可读错误
    const [statusRes] = await Promise.allSettled([api('/api/dsh/status')]);

    if (state.route !== 'dsh' || token !== state.dsh.renderToken) return;

    const statusBody = $('#dsh-status-body', root);
    const consoleHint = $('#dsh-console-hint', root);
    if (statusRes.status === 'fulfilled') {
      const status = statusRes.value || {};
      state.dsh.allowTask = status.allowTask === true;
      if (statusBody) statusBody.innerHTML = dshStatusHtml(status);
      if (consoleHint) consoleHint.innerHTML = dshConsoleHintHtml(status);
    } else {
      state.dsh.allowTask = null;
      if (statusBody) statusBody.innerHTML = dshErrorHtml('DSH 状态不可用', statusRes.reason);
      if (consoleHint) {
        consoleHint.innerHTML = '<span class="muted">无法读取 DSH 状态，控制台按钮仍会尝试获取地址。</span>';
      }
    }

    await Promise.all([dshLoadSessions(root), dshLoadCapabilities(root)]);

    dshUpdateTaskUI();
  }

  async function loadSettingsDsh(root) {
    const body = $('#set-dsh-body', root);
    if (!body) return;
    body.innerHTML = '<div class="muted" style="font-size:12.5px">加载中…</div>';
    try {
      const status = await api('/api/dsh/status');
      if (!body.isConnected) return;
      const web = status.web || {};
      const available = !!status.available;
      const running = available && !!web.reachable;
      const allowTask = status.allowTask === true;
      const chip = (label, cls) => `<span class="chip ${cls}">${label}</span>`;
      // 开源版不在 UI 暴露服务器绝对路径：只显示 basename / 已配置
      const maskPath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return '未配置';
        const base = raw.split(/[\\/]/).filter(Boolean).pop();
        return base ? `已配置（${base}）` : '已配置';
      };
      const home = maskPath(status.home);
      const bin = maskPath(status.bin);
      body.innerHTML = `
        <div class="stat-row"><span class="k">可用</span><span class="v">${available ? chip('是', 'ok') : chip('否', 'crit')}</span></div>
        <div class="stat-row"><span class="k">Web 运行</span><span class="v">${running ? chip('运行中', 'ok') : available ? chip('未运行', 'warn') : chip('未知', '')}</span></div>
        <div class="stat-row"><span class="k">allowTask</span><span class="v">${allowTask ? chip('已开启', 'ok') : chip('已禁用', 'warn')}</span></div>
        <div class="stat-row"><span class="k">home</span><span class="v dsh-config-val">${escapeHtml(home)}</span></div>
        <div class="stat-row"><span class="k">bin</span><span class="v dsh-config-val">${escapeHtml(bin)}</span></div>
        <div class="stat-row"><span class="k">profile</span><span class="v">${escapeHtml(web.profile || '—')}</span></div>
      `;
    } catch (err) {
      if (!body.isConnected) return;
      body.innerHTML = `<div class="muted" style="font-size:12.5px;line-height:1.6">DSH 状态不可用：${escapeHtml(readableDshError(err))}</div>`;
    }
  }

  /* ---------------- 设置页：登录与安全 ---------------- */

  function securityBlockHtml() {
    const remember = state.remember;
    const rows = [
      `<div class="stat-row"><span class="k">当前登录用户</span><span class="v mono">${escapeHtml(state.username || '—')}</span></div>`,
    ];
    if (remember) {
      rows.push(
        `<div class="stat-row" id="sec-remember-row"><span class="k">本设备记住登录</span><span class="v security-remember-val">${escapeHtml(rememberText(remember))}</span></div>`
      );
    }
    rows.push('<div class="stat-row"><span class="k">免登录有效期</span><span class="v">30 天</span></div>');
    const note = remember
      ? '关闭浏览器后再次打开面板会直接进入主界面，无需再次输入密码。'
      : '当前未检测到本设备的记住登录状态；如需 30 天免登录，请在登录时勾选「记住我」。';
    return `${rows.join('')}
      <p class="install-status-note">${note}</p>
      <div class="security-actions">
        ${remember ? '<button class="btn btn-sm" id="set-forget" type="button">忘记本设备登录</button>' : ''}
        <button class="btn btn-sm btn-danger" id="set-logout" type="button">退出登录</button>
      </div>
      <div class="sec-divider"></div>
      <div class="sec-sessions-head">
        <span class="card-sub">登录会话</span><span class="spacer"></span>
        <button class="btn btn-sm" id="set-sessions-refresh" type="button">刷新</button>
      </div>
      <div id="set-sessions-body"><div class="muted" style="font-size:12px">加载中…</div></div>`;
  }

  async function forgetRememberDevice(root) {
    const btn = $('#set-forget', root);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中…';
    }
    try {
      await api('/api/remember/forget', { method: 'POST' });
      state.remember = null;
      clearRememberCache();
      toast('已忘记本设备登录，下次打开需要重新输入密码', 'ok', 4500);
      const body = $('#set-security-body', root);
      if (body) body.innerHTML = securityBlockHtml();
      loadSettingsSessions(root);
    } catch (err) {
      const msg = (err && err.message) || '';
      if (/接口不存在|not_found|404/i.test(msg)) {
        toast('当前面板后端不支持「忘记本设备登录」，请升级后端后重试', 'warn', 5000);
      } else {
        toast(`操作失败：${msg || '未知错误'}`, 'err', 5000);
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = '忘记本设备登录';
      }
    }
  }

  /* ======================================================================
     下载页：任意文件二维码分享
     ====================================================================== */
  const DOWNLOAD_TTL_OPTIONS = [5, 10, 30, 60, 240]; // 分钟

  function fmtCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function readableDownloadError(err) {
    const msg = (err && err.message) || String(err || '');
    if (/file_not_found|文件不存在|ENOENT|no such file/i.test(msg)) return '文件不存在或不可访问，请检查路径。';
    if (/not_a_regular_file|dir_not_found|目录不存在|not_a_file|is a directory/i.test(msg))
      return '该路径不是可下载的普通文件。';
    if (/not_readable|forbidden|无权限|EACCES|permission/i.test(msg)) return '没有权限读取该文件。';
    if (/share_limit_reached/i.test(msg)) return '活动分享数量已达上限，请先撤销部分分享后重试。';
    if (/invalid_ttl/i.test(msg)) return '有效期参数无效。';
    if (/invalid_path/i.test(msg)) return '路径无效，请输入服务器上的绝对路径。';
    if (/接口不存在|not_found|404/i.test(msg)) return '下载接口尚不可用（后端未就绪）：需要更新并重启面板后端。';
    if (/响应解析失败|Unexpected token|not valid JSON/i.test(msg)) return '下载接口暂不可用（后端返回了非 JSON 响应）。';
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '无法连接面板服务，请检查网络后重试。';
    return msg || '未知错误';
  }

  function downloadErrorHtml(title, err) {
    const detail = (err && err.message) || String(err || '');
    return `<div class="dl-error"><strong>${escapeHtml(title)}</strong>${escapeHtml(readableDownloadError(err))}
      <details><summary>技术细节</summary><pre>${escapeHtml(detail)}</pre></details></div>`;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* 回退到 execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function clearDownloadTimer() {
    if (state.download.timer) {
      clearInterval(state.download.timer);
      state.download.timer = null;
    }
  }

  function dlQrUrl(share, size = 320) {
    if (!share) return '';
    const base = share.qrUrl || `/d/${encodeURIComponent(share.token)}/qr.svg`;
    if (/[?&]size=\d+/.test(base)) return base.replace(/([?&])size=\d+/, `$1size=${size}`);
    return base + (base.includes('?') ? '&' : '?') + `size=${size}`;
  }

  function dlShareUrl(share) {
    if (!share) return '';
    if (share.url) return share.url;
    return `/d/${encodeURIComponent(share.token)}`;
  }

  function startDownloadCountdown(share) {
    clearDownloadTimer();
    const tick = () => {
      const el = $('#dl-countdown');
      if (!el) return;
      const expiresAt = Number(share.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        el.textContent = '—';
        return;
      }
      const left = expiresAt - Date.now();
      if (left <= 0) {
        el.innerHTML = '<span class="chip crit">已过期</span>';
        clearDownloadTimer();
        return;
      }
      el.textContent = `剩余 ${fmtCountdown(left)} · ${fmtDateTime(expiresAt)} 到期`;
    };
    tick();
    state.download.timer = setInterval(tick, 1000);
  }

  function openQrModal(share) {
    if (!share) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap dl-qr-modal';
    wrap.innerHTML = `
      <div class="dl-qr-modal-body">
        <img src="${escapeHtml(dlQrUrl(share, 640))}" alt="下载二维码">
        <div class="muted" style="font-size:12px;line-height:1.6;margin-bottom:12px">
          ${escapeHtml(share.filename || '文件')}<br>手机扫码即可下载
        </div>
        <button class="btn" type="button" data-close>关闭</button>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);
  }

  function renderDownloadResult(share) {
    const box = $('#dl-result');
    if (!box) return;
    if (!share) {
      box.innerHTML = `<div class="placeholder">
        <h3>还没有生成分享</h3>
        <p>选择服务器上的文件并设置有效期，生成二维码后即可用手机扫码下载。</p>
      </div>`;
      return;
    }
    const url = dlShareUrl(share);
    const onceChip = share.once ? '<span class="chip warn">单次</span>' : '<span class="chip">多次</span>';
    box.innerHTML = `
      <div class="dl-result">
        <div class="dl-qr-wrap">
          <img class="dl-qr" id="dl-qr" src="${escapeHtml(dlQrUrl(share, 320))}" alt="下载二维码" width="200" height="200">
          <div class="dl-qr-caption">点二维码放大 · 扫码下载</div>
        </div>
        <div class="dl-share-info">
          <div class="stat-row"><span class="k">文件</span><span class="v mono dl-wrap">${escapeHtml(share.filename || '—')}</span></div>
          <div class="stat-row"><span class="k">大小</span><span class="v">${Number.isFinite(share.size) ? fmtBytes(share.size) : '—'}</span></div>
          <div class="stat-row"><span class="k">类型</span><span class="v">${onceChip}</span></div>
          <div class="stat-row"><span class="k">有效期</span><span class="v" id="dl-countdown">—</span></div>
          <label class="field" style="margin-top:10px">
            <span>下载链接</span>
            <div class="dl-link-row">
              <input type="text" id="dl-link" readonly value="${escapeHtml(url)}">
              <button class="btn btn-sm" id="dl-copy" type="button">复制</button>
            </div>
          </label>
          <div class="dl-result-actions">
            <a class="btn btn-primary" id="dl-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">在本机下载</a>
            <button class="btn btn-danger" id="dl-revoke-current" type="button">撤销分享</button>
          </div>
        </div>
      </div>`;

    const img = $('#dl-qr');
    if (img) {
      img.addEventListener('click', () => openQrModal(share));
      img.addEventListener('error', () => {
        const cap = $('.dl-qr-caption');
        if (cap) cap.textContent = '二维码加载失败：后端 /d/ 路由可能未就绪，可直接使用下方链接';
      });
    }
    $('#dl-copy')?.addEventListener('click', async () => {
      const ok = await copyText(url);
      toast(ok ? '下载链接已复制' : '复制失败，请手动选择链接复制', ok ? 'ok' : 'warn');
      if (!ok) {
        const input = $('#dl-link');
        if (input) {
          input.focus();
          input.select();
        }
      }
    });
    $('#dl-link')?.addEventListener('click', (e) => e.currentTarget.select());
    $('#dl-revoke-current')?.addEventListener('click', () => dlRevokeShare(share.token));
    startDownloadCountdown(share);
  }

  async function dlRevokeShare(token) {
    if (!token) return;
    try {
      await api('/api/download/revoke', { method: 'POST', body: { token } });
      if (state.download.current && state.download.current.token === token) {
        state.download.current = null;
        clearDownloadTimer();
        renderDownloadResult(null);
      }
      toast('已撤销该分享', 'ok');
      loadDownloadShares();
    } catch (err) {
      toast(readableDownloadError(err), 'err', 5000);
    }
  }

  function dlSharesHtml(shares) {
    if (!shares.length) {
      return `<div class="placeholder"><h3>暂无活动分享</h3><p>生成二维码后，未过期/未撤销的分享会显示在这里。</p></div>`;
    }
    const now = Date.now();
    return `<div class="dl-shares">${shares
      .map((s) => {
        const expiresAt = Number(s.expiresAt);
        const expired = Number.isFinite(expiresAt) && expiresAt <= now;
        const usedOnce = s.once && Number(s.hits) > 0;
        const chips = [];
        chips.push(s.once ? '<span class="chip warn">单次</span>' : '<span class="chip">多次</span>');
        if (expired) chips.push('<span class="chip crit">已过期</span>');
        else if (usedOnce) chips.push('<span class="chip crit">已使用</span>');
        const left = Number.isFinite(expiresAt) ? `${fmtDateTime(expiresAt)} 到期` : '—';
        return `<div class="dl-share-row">
          <div class="dl-share-main">
            <div class="dl-share-name" title="${escapeHtml(s.path || '')}">${escapeHtml(s.filename || '—')}</div>
            <div class="dl-share-meta">
              <span>${Number.isFinite(s.size) ? fmtBytes(s.size) : '—'}</span>
              <span>${escapeHtml(left)}</span>
              <span>下载 ${Number(s.hits) || 0} 次</span>
              ${chips.join('')}
            </div>
            <div class="dl-share-path">${escapeHtml(s.path || '')}</div>
          </div>
          <button class="btn btn-sm btn-danger" type="button" data-dl-revoke="${escapeHtml(s.token || '')}">撤销</button>
        </div>`;
      })
      .join('')}</div>`;
  }

  async function loadDownloadShares() {
    const body = $('#dl-shares-body');
    if (!body) return;
    if (!state.download.sharesLoaded) {
      body.innerHTML = `<div class="placeholder">
        <div class="skeleton" style="width:70%;height:12px"></div>
        <div class="skeleton" style="width:50%;height:12px"></div>
      </div>`;
    }
    try {
      const data = await api('/api/download/shares');
      const shares = Array.isArray(data && data.shares) ? data.shares : [];
      state.download.shares = shares;
      state.download.sharesLoaded = true;
      const freshBody = $('#dl-shares-body');
      if (!freshBody) return;
      freshBody.innerHTML = dlSharesHtml(shares);
      const count = $('#dl-shares-count');
      if (count) count.textContent = `共 ${shares.length} 个`;
    } catch (err) {
      state.download.sharesLoaded = false;
      const freshBody = $('#dl-shares-body');
      if (!freshBody) return;
      freshBody.innerHTML =
        downloadErrorHtml('活动分享加载失败', err) +
        '<button class="btn btn-sm" id="dl-shares-retry" type="button">重试</button>';
      $('#dl-shares-retry')?.addEventListener('click', () => loadDownloadShares());
    }
  }

  function setDownloadFileHint(text, kind) {
    const el = $('#dl-file-hint');
    if (!el) return;
    el.textContent = text || '';
    el.className = `dl-file-hint ${kind || ''}`.trim();
  }

  async function refreshDownloadFileHint(path) {
    if (!path) {
      setDownloadFileHint('输入服务器上的文件绝对路径，或点击「浏览」选择。', '');
      return;
    }
    if (!path.startsWith('/')) {
      setDownloadFileHint('请输入以 / 开头的绝对路径。', 'warn');
      return;
    }
    const idx = path.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : path.slice(0, idx);
    const name = path.slice(idx + 1);
    if (!name) {
      setDownloadFileHint('请选择具体文件，而不是目录。', 'warn');
      return;
    }
    try {
      const d = await api('/api/files/list?path=' + encodeURIComponent(parent));
      const entry = (d.entries || []).find((e) => e.name === name);
      if (!entry) {
        setDownloadFileHint('文件不存在或不可访问，请检查路径。', 'warn');
        return;
      }
      if (entry.isDir) {
        setDownloadFileHint('这是目录，不能直接分享，请选择具体文件。', 'warn');
        return;
      }
      setDownloadFileHint(
        `${entry.name} · ${entry.sizeText || fmtBytes(entry.size)} · ${entry.mtime ? fmtDateTime(entry.mtime) : ''}`,
        'ok'
      );
    } catch (err) {
      setDownloadFileHint(readableDownloadError(err), 'warn');
    }
  }

  /** 最新 APK：走后端 /api/app/update（不依赖任何本机目录/路径），展示直链下载 */
  async function pickLatestApk() {
    try {
      const info = await api('/api/app/update');
      if (!info || !info.version || !info.downloadUrl) {
        setDownloadFileHint('服务器上暂无可用 APK（dist 目录为空或未构建）。', 'warn');
        toast('暂无可用 APK', 'warn');
        return;
      }
      const url = new URL(info.downloadUrl, window.location.origin).href;
      clearDownloadTimer();
      const box = $('#dl-result');
      if (box) {
        box.innerHTML = `<div class="dl-result">
          <div class="dl-share-info">
            <div class="stat-row"><span class="k">最新 APK</span><span class="v mono">v${escapeHtml(info.version)}</span></div>
            ${info.size ? `<div class="stat-row"><span class="k">大小</span><span class="v">${fmtBytes(info.size)}</span></div>` : ''}
            ${info.sha256 ? `<div class="stat-row"><span class="k">SHA-256</span><span class="v mono dl-wrap">${escapeHtml(String(info.sha256).slice(0, 24))}…</span></div>` : ''}
            <label class="field" style="margin-top:10px">
              <span>下载链接</span>
              <div class="dl-link-row">
                <input type="text" id="dl-apk-link" readonly value="${escapeHtml(url)}">
                <button class="btn btn-sm" id="dl-apk-copy" type="button">复制</button>
              </div>
            </label>
            <div class="dl-result-actions">
              <a class="btn btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">在本机下载</a>
            </div>
            <p class="muted" style="font-size:11.5px;line-height:1.6;margin:10px 0 0">
              这是后端提供的最新版本直链。若需要通过二维码分享 APK，请用「浏览…」选择服务器上的 APK 文件后再生成二维码。
            </p>
          </div>
        </div>`;
        $('#dl-apk-copy')?.addEventListener('click', async () => {
          const ok = await copyText(url);
          toast(ok ? '下载链接已复制' : '复制失败，请手动复制', ok ? 'ok' : 'warn');
        });
      }
      setDownloadFileHint(`已找到最新 APK v${info.version}${info.size ? `（${fmtBytes(info.size)}）` : ''}：可直接下载。`, 'ok');
    } catch (err) {
      const msg = featureErrorText(err, '应用更新');
      setDownloadFileHint(msg, 'warn');
      toast(msg, 'err', 5000);
    }
  }

  async function generateDownloadShare() {
    const input = $('#dl-path');
    const path = input ? input.value.trim() : '';
    if (!path) {
      toast('请先填写文件绝对路径或浏览选择', 'warn');
      input?.focus();
      return;
    }
    if (!path.startsWith('/')) {
      toast('请输入以 / 开头的绝对路径', 'warn');
      input.focus();
      return;
    }
    const ttlEl = $('#dl-ttl');
    const ttlMinutes = Number(ttlEl?.value) || 60;
    const onceEl = $('#dl-once');
    const once = !!(onceEl && onceEl.checked);
    const btn = $('#dl-generate');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '生成中…';
    }
    try {
      const data = await api('/api/download/share', { method: 'POST', body: { path, ttlMinutes, once } });
      if (!data || !data.token) throw new Error('接口未返回 token');
      state.download.current = data;
      renderDownloadResult(data);
      toast('二维码已生成，手机扫码即可下载', 'ok', 4000);
      loadDownloadShares();
    } catch (err) {
      const box = $('#dl-result');
      if (box) box.innerHTML = downloadErrorHtml('生成分享失败', err);
      toast(readableDownloadError(err), 'err', 5000);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '生成二维码';
      }
    }
  }

  function openFileBrowser(startPath) {
    let currentPath = startPath || '/';
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal" style="max-width:760px">
        <div class="modal-head">
          <h3>选择服务器文件</h3>
          <button class="icon-btn" type="button" data-close aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="fb-toolbar">
            <button class="btn btn-sm" type="button" id="fb-up">↑ 上级</button>
            <button class="btn btn-sm" type="button" id="fb-refresh">刷新</button>
            <span class="mono muted fb-path" id="fb-path" style="margin-left:auto"></span>
          </div>
          <div class="fb-list" id="fb-list"><div class="fb-empty">加载中…</div></div>
          <div class="muted" style="font-size:11.5px;margin-top:10px;line-height:1.6">
            点击目录进入，点击文件选择；仅可下载普通文件（目录不可分享）。
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);

    async function load(dir) {
      const list = $('#fb-list');
      if (!list) return;
      list.innerHTML = '<div class="fb-empty">加载中…</div>';
      try {
        const data = await api('/api/files/list?path=' + encodeURIComponent(dir));
        currentPath = data.path || dir;
        const pathEl = $('#fb-path');
        if (pathEl) pathEl.textContent = currentPath;
        const upBtn = $('#fb-up');
        if (upBtn) upBtn.disabled = !data.parent;
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (!entries.length) {
          list.innerHTML = '<div class="fb-empty">空目录</div>';
          return;
        }
        const dirs = entries
          .filter((e) => e.isDir)
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
        const files = entries.filter((e) => !e.isDir);
        list.innerHTML =
          dirs
            .map(
              (e) => `<div class="fb-row" data-dir="${escapeHtml(e.path)}">
                <span class="fb-icon">📁</span>
                <span class="fb-name">${escapeHtml(e.name)}</span>
                <span class="fb-meta">${escapeHtml(e.mtime ? fmtDateTime(e.mtime) : '')}</span>
              </div>`
            )
            .join('') +
          files
            .map((e) => {
              const icon = { image: '🖼️', video: '🎬', audio: '🎵', archive: '📦', code: '📜' }[e.kind] || '📄';
              return `<div class="fb-row" data-file="${escapeHtml(e.path)}" data-name="${escapeHtml(e.name)}">
                <span class="fb-icon">${icon}</span>
                <span class="fb-name">${escapeHtml(e.name)}</span>
                <span class="fb-meta">${escapeHtml(e.sizeText || fmtBytes(e.size))} · ${escapeHtml(e.mtime ? fmtDateTime(e.mtime) : '')}</span>
              </div>`;
            })
            .join('');
        list.querySelectorAll('[data-dir]').forEach((row) => {
          row.addEventListener('click', () => load(row.dataset.dir));
        });
        list.querySelectorAll('[data-file]').forEach((row) => {
          row.addEventListener('click', () => {
            const input = $('#dl-path');
            if (input) input.value = row.dataset.file;
            setDownloadFileHint(`已选择：${row.dataset.name}`, 'ok');
            close();
          });
        });
      } catch (err) {
        list.innerHTML = `<div class="fb-empty">${escapeHtml(readableDownloadError(err))}</div>`;
      }
    }

    $('#fb-up').addEventListener('click', () => {
      const parts = currentPath.split('/').filter(Boolean);
      if (!parts.length) return;
      parts.pop();
      load('/' + parts.join('/'));
    });
    $('#fb-refresh').addEventListener('click', () => load(currentPath));
    load(currentPath);
  }

  async function renderDownload(root) {
    root.innerHTML = `
      <div class="grid dl-grid">
        <div class="card">
          <div class="card-head"><h3>选择文件</h3></div>
          <label class="field">
            <span>服务器文件绝对路径</span>
            <div class="dl-path-row">
              <input type="text" id="dl-path" spellcheck="false" placeholder="服务器上的绝对路径，例如 /srv/app/release.apk">
              <button class="btn" id="dl-browse" type="button">浏览…</button>
            </div>
          </label>
          <div class="dl-quick">
            <button class="btn btn-sm" id="dl-quick-apk" type="button">最新 APK</button>
            <button class="btn btn-sm" id="dl-quick-home" type="button">浏览目录</button>
          </div>
          <div class="dl-file-hint" id="dl-file-hint">输入服务器上的文件绝对路径，或点击「浏览」选择。</div>
          <div class="dl-params">
            <label class="field"><span>有效期</span>
              <select id="dl-ttl">${DOWNLOAD_TTL_OPTIONS.map((m) => `<option value="${m}"${m === 60 ? ' selected' : ''}>${m} 分钟</option>`).join('')}</select>
            </label>
            <label class="remember-row dl-once-row" for="dl-once">
              <input type="checkbox" id="dl-once">
              <span>单次下载后失效</span>
            </label>
          </div>
          <button class="btn btn-primary btn-block" id="dl-generate" type="button">生成二维码</button>
        </div>
        <div class="card">
          <div class="card-head"><h3>分享二维码</h3></div>
          <div id="dl-result"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>活动分享</h3><span class="spacer"></span><span class="card-sub" id="dl-shares-count"></span><button class="btn btn-sm" id="dl-shares-refresh" type="button">刷新</button></div>
        <div id="dl-shares-body"></div>
      </div>
      <div class="card dl-help">
        <div class="card-head"><h3>使用说明</h3></div>
        <p>手机需要与服务器处于同一可达网络（同一局域网，或已配置 VPN / 内网穿透），扫码才能打开下载链接。</p>
        <p>在 Android App 内点击下载会交给系统下载器，文件保存到「下载」目录；浏览器中则使用浏览器自己的下载方式。</p>
        <p>分享链接免登录即可下载，但只能访问被分享的这一个文件，到期或撤销后立即失效；「单次」分享在第一次下载成功后失效。</p>
        <p>「活动分享」已持久化在服务器上，<b>面板重启后仍然有效</b>；到期时间与下载次数仍会保留。</p>
      </div>`;

    state.cleanups.push(clearDownloadTimer);
    $('#dl-browse', root).addEventListener('click', () => {
      const path = $('#dl-path', root).value.trim();
      const idx = path && path.startsWith('/') ? path.lastIndexOf('/') : -1;
      const start = idx > 0 ? path.slice(0, idx) : '/';
      openFileBrowser(start);
    });
    $('#dl-quick-apk', root).addEventListener('click', pickLatestApk);
    $('#dl-quick-home', root).addEventListener('click', () => openFileBrowser('/'));
    $('#dl-path', root).addEventListener('blur', () =>
      refreshDownloadFileHint($('#dl-path', root).value.trim())
    );
    $('#dl-path', root).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        refreshDownloadFileHint($('#dl-path', root).value.trim());
      }
    });
    $('#dl-generate', root).addEventListener('click', generateDownloadShare);
    $('#dl-shares-refresh', root).addEventListener('click', () => loadDownloadShares());
    $('#dl-shares-body', root).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dl-revoke]');
      if (btn) dlRevokeShare(btn.dataset.dlRevoke);
    });

    // 跨页面返回时恢复上一次生成结果（仍受到期时间约束）
    if (state.download.current) renderDownloadResult(state.download.current);
    else renderDownloadResult(null);
    loadDownloadShares();
  }

  /* ======================================================================
     B1：设置页扩展（登录会话 / 通知 / 备份）
     ====================================================================== */
  function summarizeUa(ua) {
    const s = String(ua || '');
    if (!s.trim()) return '未知设备';
    const browser = /Edg\//.test(s)
      ? 'Edge'
      : /OPR\//.test(s)
        ? 'Opera'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Firefox\//.test(s)
            ? 'Firefox'
            : /Safari\//.test(s)
              ? 'Safari'
              : /okhttp|Dart|curl|Wget|python/i.test(s)
                ? 'App / CLI'
                : '未知浏览器';
    const os = /Windows/.test(s)
      ? 'Windows'
      : /Android/.test(s)
        ? 'Android'
        : /iPhone|iPad|iOS/.test(s)
          ? 'iOS'
          : /Mac OS X|Macintosh/.test(s)
            ? 'macOS'
            : /Linux|X11/.test(s)
              ? 'Linux'
              : '未知系统';
    return `${browser} · ${os}`;
  }

  async function loadSettingsSessions(root) {
    const body = $('#set-sessions-body', root);
    if (!body) return;
    body.innerHTML = '<div class="muted" style="font-size:12px">加载中…</div>';
    try {
      const data = await api('/api/sessions');
      if (!body.isConnected) return;
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (!sessions.length) {
        body.innerHTML = '<div class="muted" style="font-size:12px">暂无登录会话</div>';
        return;
      }
      body.innerHTML = `<div class="sessions-list">${sessions
        .map((s) => {
          const created = Number(s.createdAt);
          const seen = Number(s.lastSeenAt);
          return `<div class="session-row">
            <div class="session-main">
              <div class="session-ua">${escapeHtml(summarizeUa(s.ua))}${s.current ? ' <span class="chip info">当前</span>' : ''}</div>
              <div class="session-meta">${escapeHtml(s.ip || '—')} · 登录 ${escapeHtml(fmtDateTime(created))}${
                Number.isFinite(seen) && seen > 0 ? ` · 最近活跃 ${escapeHtml(fmtAgo(seen))}` : ''
              }</div>
            </div>
            <button class="btn btn-sm btn-danger" type="button" data-revoke-session="${escapeHtml(
              String(s.id ?? '')
            )}" data-current="${s.current ? '1' : ''}">退出该设备</button>
          </div>`;
        })
        .join('')}</div>`;
    } catch (err) {
      if (!body.isConnected) return;
      body.innerHTML = `<div class="muted" style="font-size:12px;line-height:1.6">会话列表不可用：${escapeHtml(
        featureErrorText(err, '会话')
      )}</div>`;
    }
  }

  async function revokeSession(root, id, isCurrent, btn) {
    if (!id) return;
    if (isCurrent && !window.confirm('退出当前设备会立即结束本会话并返回登录页，确定继续？')) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '退出中…';
    }
    try {
      const data = await api('/api/sessions/revoke', { method: 'POST', body: { id } });
      if (isCurrent) {
        toast('当前会话已退出，请重新登录', 'info', 3500);
        showLogin();
        return;
      }
      toast(data && data.revoked === false ? '该会话已失效' : '已退出该设备', data && data.revoked === false ? 'info' : 'ok');
      loadSettingsSessions(root);
    } catch (err) {
      toast(featureErrorText(err, '会话管理'), 'err', 5000);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '退出该设备';
      }
    }
  }

  /* ---------------- 通知 ---------------- */
  const NOTIFY_TYPES = [
    ['auto', '自动识别'],
    ['wecom', '企业微信'],
    ['dingtalk', '钉钉'],
    ['feishu', '飞书'],
    ['generic', '通用'],
  ];

  async function loadSettingsNotify(root) {
    const body = $('#set-notify-body', root);
    if (!body) return;
    body.innerHTML = '<div class="muted" style="font-size:12.5px">加载中…</div>';
    try {
      const data = await api('/api/notify');
      if (!body.isConnected) return;
      renderNotifyForm(root, data || {});
    } catch (err) {
      if (!body.isConnected) return;
      body.innerHTML =
        featureErrorHtml('通知设置加载失败', err, '通知') +
        '<button class="btn btn-sm" id="set-notify-retry" type="button">重试</button>';
      $('#set-notify-retry', root)?.addEventListener('click', () => loadSettingsNotify(root));
    }
  }

  function renderNotifyForm(root, data) {
    const webhook = data.webhook || {};
    const email = data.email || {};
    const ntfy = data.ntfy || {};
    const meta = [];
    if (data.lastSentAt) meta.push(`最近发送 ${fmtDateTime(Number(data.lastSentAt))}`);
    if (data.lastError) meta.push(`最近错误：${String(data.lastError).slice(0, 90)}`);
    const metaEl = $('#set-notify-meta', root);
    if (metaEl) metaEl.textContent = meta.join(' · ');

    const body = $('#set-notify-body', root);
    if (!body) return;
    body.innerHTML = `
      <form id="notify-form" autocomplete="off">
        <div class="notify-grid">
          <fieldset class="notify-channel">
            <legend>Webhook</legend>
            <label class="remember-row"><input type="checkbox" id="n-webhook-enabled"${webhook.enabled ? ' checked' : ''}><span>启用</span></label>
            <label class="field"><span>类型</span>
              <select id="n-webhook-type">${NOTIFY_TYPES.map(
                ([v, l]) => `<option value="${v}"${(webhook.type || 'auto') === v ? ' selected' : ''}>${l}</option>`
              ).join('')}</select>
            </label>
            <label class="field"><span>URL</span>
              <input type="password" id="n-webhook-url" autocomplete="new-password" placeholder="${
                webhook.urlSet ? '已设置（留空保持不变）' : 'https://example.com/webhook'
              }">
            </label>
            <button class="btn btn-sm" type="button" data-test-channel="webhook">测试发送</button>
          </fieldset>
          <fieldset class="notify-channel">
            <legend>邮件（SMTP）</legend>
            <label class="remember-row"><input type="checkbox" id="n-email-enabled"${email.enabled ? ' checked' : ''}><span>启用</span></label>
            <div class="notify-two">
              <label class="field"><span>SMTP 主机</span><input type="text" id="n-email-host" value="${escapeHtml(email.host || '')}" placeholder="smtp.example.com"></label>
              <label class="field"><span>端口</span><input type="number" id="n-email-port" min="1" max="65535" value="${Number(email.port) || 465}"></label>
            </div>
            <label class="remember-row"><input type="checkbox" id="n-email-secure"${email.secure ? ' checked' : ''}><span>使用 SSL/TLS</span></label>
            <label class="field"><span>用户名</span><input type="text" id="n-email-user" autocomplete="off" placeholder="${
              email.userSet ? '已设置（留空保持不变）' : 'SMTP 用户名'
            }"></label>
            <label class="field"><span>密码</span><input type="password" id="n-email-pass" autocomplete="new-password" placeholder="留空保持原值（不回显）"></label>
            <div class="notify-pair">
              <label class="field"><span>发件人</span><input type="text" id="n-email-from" value="${escapeHtml(
                email.from || ''
              )}" placeholder="panel@example.com"></label>
              <label class="field"><span>收件人</span><input type="text" id="n-email-to" autocomplete="off" placeholder="${
                email.toSet ? '已设置（留空保持不变）' : 'admin@example.com'
              }"></label>
            </div>
            <button class="btn btn-sm" type="button" data-test-channel="email">测试发送</button>
          </fieldset>
          <fieldset class="notify-channel">
            <legend>ntfy</legend>
            <label class="remember-row"><input type="checkbox" id="n-ntfy-enabled"${ntfy.enabled ? ' checked' : ''}><span>启用</span></label>
            <label class="field"><span>服务器</span><input type="text" id="n-ntfy-url" value="${escapeHtml(
              ntfy.url || ''
            )}" placeholder="https://ntfy.sh"></label>
            <label class="field"><span>Topic</span><input type="text" id="n-ntfy-topic" value="${escapeHtml(
              ntfy.topic || ''
            )}" placeholder="server-panel-alerts"></label>
            <button class="btn btn-sm" type="button" data-test-channel="ntfy">测试发送</button>
          </fieldset>
        </div>
        <div class="notify-actions">
          <button class="btn btn-primary" id="n-save" type="submit">保存通知设置</button>
          <span class="muted n-test-result" id="n-test-result"></span>
        </div>
      </form>`;

    $('#notify-form', root).addEventListener('submit', (e) => {
      e.preventDefault();
      saveNotify(root);
    });
    $$('[data-test-channel]', root).forEach((btn) => {
      btn.addEventListener('click', () => testNotify(root, btn.dataset.testChannel, btn));
    });
  }

  async function saveNotify(root) {
    const val = (id) => {
      const el = $('#' + id, root);
      return el ? String(el.value).trim() : '';
    };
    const checked = (id) => {
      const el = $('#' + id, root);
      return !!(el && el.checked);
    };
    const portRaw = val('n-email-port');
    const payload = {
      webhook: {
        enabled: checked('n-webhook-enabled'),
        type: val('n-webhook-type') || 'auto',
        url: val('n-webhook-url'),
      },
      email: {
        enabled: checked('n-email-enabled'),
        host: val('n-email-host'),
        secure: checked('n-email-secure'),
        user: val('n-email-user'),
        pass: val('n-email-pass'),
        from: val('n-email-from'),
        to: val('n-email-to'),
      },
      ntfy: {
        enabled: checked('n-ntfy-enabled'),
        url: val('n-ntfy-url'),
        topic: val('n-ntfy-topic'),
      },
    };
    if (portRaw && Number.isFinite(Number(portRaw))) payload.email.port = Number(portRaw);

    const btn = $('#n-save', root);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '保存中…';
    }
    try {
      await api('/api/notify', { method: 'PUT', body: payload });
      toast('通知设置已保存', 'ok');
      loadSettingsNotify(root);
    } catch (err) {
      toast('保存失败：' + featureErrorText(err, '通知'), 'err', 5500);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '保存通知设置';
      }
    }
  }

  async function testNotify(root, channel, btn) {
    if (!channel) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '发送中…';
    const result = $('#n-test-result', root);
    if (result) {
      result.className = 'muted n-test-result';
      result.textContent = `正在测试 ${channel}…`;
    }
    try {
      const data = await api('/api/notify/test', { method: 'POST', body: { channel } });
      const detail = data && data.detail ? `：${data.detail}` : '';
      const elapsed = data && Number.isFinite(Number(data.elapsedMs)) ? `（${data.elapsedMs} ms）` : '';
      if (result) {
        result.className = 'n-test-ok n-test-result';
        result.textContent = `${channel} 测试成功${detail}${elapsed}`;
      }
      toast(`${channel} 测试发送成功`, 'ok');
    } catch (err) {
      const msg = featureErrorText(err, '通知测试');
      if (result) {
        result.className = 'n-test-err n-test-result';
        result.textContent = `${channel} 测试失败：${msg}`;
      }
      toast(`${channel} 测试失败：${msg}`, 'err', 5500);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  /* ---------------- 备份 ---------------- */
  function setBackupNotice(text) {
    const wrap = $('#set-backup-note-wrap');
    const note = $('#set-backup-note');
    if (!wrap || !note) return;
    if (text) {
      note.textContent = text;
      wrap.classList.remove('hidden');
    } else {
      note.textContent = '';
      wrap.classList.add('hidden');
    }
  }

  function backupRowHtml(b) {
    const id = escapeHtml(String(b.id ?? ''));
    const filename = escapeHtml(String(b.filename || b.id || '备份'));
    const size = Number.isFinite(Number(b.size)) ? fmtBytes(Number(b.size)) : '—';
    const created = Number(b.createdAt);
    return `<div class="backup-row">
      <div class="backup-main">
        <div class="backup-name">${filename}</div>
        <div class="backup-meta">${escapeHtml(size)} · ${escapeHtml(fmtDateTime(created))}</div>
      </div>
      <div class="backup-actions">
        <a class="btn btn-sm" href="/api/backup/download?id=${encodeURIComponent(
          String(b.id ?? '')
        )}" target="_blank" rel="noopener noreferrer">下载</a>
        <button class="btn btn-sm" type="button" data-restore-backup="${id}" data-backup-name="${filename}">恢复</button>
        <button class="btn btn-sm btn-danger" type="button" data-delete-backup="${id}" data-backup-name="${filename}">删除</button>
      </div>
    </div>`;
  }

  async function loadSettingsBackups(root) {
    const body = $('#set-backup-body', root);
    if (!body) return;
    body.innerHTML = '<div class="muted" style="font-size:12.5px;padding:0 16px 14px">加载中…</div>';
    try {
      const data = await api('/api/backup/list');
      if (!body.isConnected) return;
      const backups = Array.isArray(data.backups) ? data.backups : [];
      const auto = data.auto || {};
      const autoHtml = `<div class="backup-auto">
        <label class="remember-row" style="margin:0"><input type="checkbox" id="set-backup-auto"${auto.enabled ? ' checked' : ''}><span>启用自动备份</span></label>
        <label class="al-inline"><span>保留份数</span><input type="number" id="set-backup-keep" min="1" max="30" step="1" value="${Number(auto.keep) || 7}"><em>份</em></label>
        <button class="btn btn-sm" id="set-backup-auto-save" type="button">保存自动设置</button>
        <span class="muted" id="set-backup-auto-msg"></span>
      </div>`;
      body.innerHTML =
        autoHtml +
        (backups.length
          ? `<div class="backup-list">${backups.map(backupRowHtml).join('')}</div>`
          : '<div class="placeholder"><h3>还没有备份</h3><p>点击「立即备份」创建第一份完整备份。</p></div>');
      $('#set-backup-auto-save', root)?.addEventListener('click', async () => {
        const enabledEl = $('#set-backup-auto', root);
        const keepEl = $('#set-backup-keep', root);
        const keep = Number(keepEl && keepEl.value);
        if (!Number.isInteger(keep) || keep < 1 || keep > 30) {
          toast('保留份数需为 1–30 的整数', 'warn');
          return;
        }
        const btn = $('#set-backup-auto-save', root);
        if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
        try {
          await api('/api/backup/settings', {
            method: 'PUT',
            body: { auto: !!(enabledEl && enabledEl.checked), keep },
          });
          toast('自动备份设置已保存', 'ok');
          loadSettingsBackups(root);
        } catch (err) {
          toast('保存失败：' + featureErrorText(err, '备份设置'), 'err', 5500);
          if (btn) { btn.disabled = false; btn.textContent = '保存自动设置'; }
        }
      });
    } catch (err) {
      if (!body.isConnected) return;
      body.innerHTML =
        featureErrorHtml('备份列表加载失败', err, '备份') +
        '<div style="padding:0 16px 14px"><button class="btn btn-sm" id="set-backup-retry" type="button">重试</button></div>';
      $('#set-backup-retry', root)?.addEventListener('click', () => loadSettingsBackups(root));
    }
  }

  async function createBackup(root) {
    const btn = $('#set-backup-create', root);
    if (btn) {
      btn.disabled = true;
      btn.textContent = '备份中…';
    }
    try {
      const data = await api('/api/backup/create', { method: 'POST', body: {} });
      toast(`备份已创建${data && data.filename ? '：' + data.filename : ''}`, 'ok', 4500);
      loadSettingsBackups(root);
    } catch (err) {
      toast('备份失败：' + featureErrorText(err, '备份'), 'err', 5500);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '立即备份';
      }
    }
  }

  async function deleteBackup(root, id) {
    if (!id) return;
    if (!window.confirm('确定删除该备份文件？删除后不可恢复。')) return;
    try {
      await api('/api/backup/delete', { method: 'POST', body: { id } });
      toast('备份已删除', 'ok');
      loadSettingsBackups(root);
    } catch (err) {
      toast('删除失败：' + featureErrorText(err, '备份'), 'err', 5500);
    }
  }

  function openRestoreBackupModal(root, backup) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h3>恢复备份</h3>
          <button class="icon-btn" type="button" data-close aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="notice">恢复会用备份覆盖当前 config.json、metrics.db、remember.json 与 audit.log；原文件会自动备份为 .bak。恢复完成后需要重启面板才能生效。</div>
          <p class="mono" style="font-size:12px;overflow-wrap:anywhere;margin:0 0 14px">${escapeHtml(
            String(backup.filename || backup.id || '')
          )}</p>
          <label class="field"><span>输入 RESTORE 以确认</span>
            <input type="text" id="restore-confirm" placeholder="RESTORE" autocomplete="off" spellcheck="false">
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" data-close>取消</button>
          <button class="btn btn-danger" id="restore-do" type="button" disabled>确认恢复</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) close();
    });
    state.cleanups.push(close);

    const input = wrap.querySelector('#restore-confirm');
    const doBtn = wrap.querySelector('#restore-do');
    input.addEventListener('input', () => {
      doBtn.disabled = input.value.trim() !== 'RESTORE';
    });
    doBtn.addEventListener('click', async () => {
      if (input.value.trim() !== 'RESTORE') return;
      doBtn.disabled = true;
      doBtn.textContent = '恢复中…';
      try {
        const data = await api('/api/backup/restore', {
          method: 'POST',
          body: { id: backup.id, confirm: 'RESTORE' },
        });
        close();
        const restart = data && data.restartRequired !== false;
        setBackupNotice(
          restart
            ? '备份已恢复，需重启面板（systemctl restart server-panel）后生效。'
            : '备份已恢复。'
        );
        toast(restart ? '恢复完成，需重启面板生效' : '恢复完成', 'ok', 6000);
        loadSettingsBackups(root);
      } catch (err) {
        toast('恢复失败：' + featureErrorText(err, '备份恢复'), 'err', 6000);
        doBtn.disabled = false;
        doBtn.textContent = '确认恢复';
      }
    });
    setTimeout(() => input.focus(), 50);
  }

  async function renderSettings(root) {
    const app = state.appInfo || {};
    const appName = app.name || '服务器控制面板';
    const version = app.version || '—';
    const origin = window.location.origin;
    const insecure = !window.isSecureContext;

    root.innerHTML = `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>外观</h3></div>
          <div class="stat-row">
            <span class="k">主题</span>
            <span class="v">
              <button class="btn btn-sm" id="set-theme">切换为${state.theme === 'dark' ? '浅色' : '深色'}</button>
            </span>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>账号</h3></div>
          <div class="stat-row">
            <span class="k">用户名</span><span class="v mono">${escapeHtml(state.username)}</span>
          </div>
          <div class="stat-row">
            <span class="k">密码</span>
            <span class="v"><button class="btn btn-sm" id="set-pwd">修改密码</button></span>
          </div>
        </div>
      </div>
      <div class="card" id="set-security-card">
        <div class="card-head"><h3>登录与安全</h3></div>
        <div id="set-security-body">${securityBlockHtml()}</div>
      </div>
      <div class="card" id="set-notify-card">
        <div class="card-head">
          <h3>通知</h3><span class="spacer"></span>
          <span class="card-sub" id="set-notify-meta"></span>
          <button class="btn btn-sm" id="set-notify-refresh" type="button">刷新</button>
        </div>
        <div id="set-notify-body"><div class="muted" style="font-size:12.5px;padding:0 16px 14px">加载中…</div></div>
      </div>
      <div class="card" id="set-backup-card">
        <div class="card-head">
          <h3>备份</h3><span class="spacer"></span>
          <button class="btn btn-sm" id="set-backup-create" type="button">立即备份</button>
          <button class="btn btn-sm" id="set-backup-refresh" type="button">刷新</button>
        </div>
        <div id="set-backup-note-wrap" class="hidden" style="padding:0 16px"><div class="notice" id="set-backup-note"></div></div>
        <div id="set-backup-body"><div class="muted" style="font-size:12.5px;padding:0 16px 14px">加载中…</div></div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>应用信息</h3></div>
          <div class="stat-row"><span class="k">应用</span><span class="v">${escapeHtml(appName)}</span></div>
          <div class="stat-row"><span class="k">版本</span><span class="v mono">${escapeHtml(version)}</span></div>
          <div class="stat-row"><span class="k">运行方式</span><span class="v">${state.standalone ? '已安装（独立窗口）' : '浏览器页面'}</span></div>
          <div class="stat-row"><span class="k">服务地址</span><span class="v mono" style="font-size:11.5px;max-width:24ch;text-align:right;overflow-wrap:anywhere">${escapeHtml(origin)}</span></div>
          <div class="stat-row"><span class="k">PWA 安装状态</span><span class="v" id="set-install-status">${escapeHtml(installStatusText())}</span></div>
          <div class="stat-row"><span class="k">安装桌面</span><span class="v"><button class="btn btn-sm ${state.installPrompt && !state.standalone ? '' : 'hidden'}" id="set-install" type="button">安装到桌面</button></span></div>
          <p class="install-status-note ${insecure && !state.standalone ? '' : 'hidden'}" id="set-install-note">浏览器要求 HTTPS 或 localhost 访问才允许安装与离线缓存；当前通过 HTTP 访问。</p>
        </div>
        <div class="card">
          <div class="card-head"><h3>DSH 配置</h3><span class="spacer"></span><button class="btn btn-sm" id="set-dsh-refresh" type="button">刷新</button></div>
          <div id="set-dsh-body"><div class="muted" style="font-size:12.5px">加载中…</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>关于</h3></div>
        <div class="stat-row"><span class="k">数据采集间隔</span><span class="v">${state.system?.config?.sampleIntervalMs || 1000} ms</span></div>
        <div class="stat-row"><span class="k">历史保留</span><span class="v">30 天</span></div>
        <div class="stat-row"><span class="k">后端</span><span class="v">Node.js ${escapeHtml(state.system?.nodeVersion || '—')}</span></div>
        <div class="stat-row"><span class="k">主机名</span><span class="v mono">${escapeHtml(state.system?.hostname || '—')}</span></div>
        <div class="stat-row"><span class="k">操作系统</span><span class="v">${escapeHtml(state.system?.osName || '—')}</span></div>
        <div class="stat-row"><span class="k">内核</span><span class="v mono" style="font-size:12px">${escapeHtml((state.system?.kernel || '').split(' ').slice(0, 3).join(' '))}</span></div>
      </div>
    `;

    $('#set-theme', root).addEventListener('click', () => {
      toggleTheme();
      $('#set-theme', root).textContent = `切换为${state.theme === 'dark' ? '浅色' : '深色'}`;
    });
    $('#set-pwd', root).addEventListener('click', openPasswordModal);
    $('#set-install', root)?.addEventListener('click', promptInstall);
    $('#set-dsh-refresh', root)?.addEventListener('click', () => loadSettingsDsh(root));
    $('#set-notify-refresh', root)?.addEventListener('click', () => loadSettingsNotify(root));
    $('#set-backup-create', root)?.addEventListener('click', () => createBackup(root));
    $('#set-backup-refresh', root)?.addEventListener('click', () => loadSettingsBackups(root));
    $('#set-security-card', root)?.addEventListener('click', (e) => {
      if (e.target.closest('#set-forget')) {
        forgetRememberDevice(root);
      } else if (e.target.closest('#set-logout')) {
        doLogout();
      } else if (e.target.closest('#set-sessions-refresh')) {
        loadSettingsSessions(root);
      } else {
        const revokeBtn = e.target.closest('[data-revoke-session]');
        if (revokeBtn) {
          revokeSession(root, revokeBtn.dataset.revokeSession, revokeBtn.dataset.current === '1', revokeBtn);
        }
      }
    });
    $('#set-backup-body', root)?.addEventListener('click', (e) => {
      const restoreBtn = e.target.closest('[data-restore-backup]');
      if (restoreBtn) {
        openRestoreBackupModal(root, {
          id: restoreBtn.dataset.restoreBackup,
          filename: restoreBtn.dataset.backupName,
        });
        return;
      }
      const delBtn = e.target.closest('[data-delete-backup]');
      if (delBtn) deleteBackup(root, delBtn.dataset.deleteBackup);
    });
    updateInstallUI();
    loadSettingsDsh(root);
    loadSettingsSessions(root);
    loadSettingsNotify(root);
    loadSettingsBackups(root);
  }

  /* ======================================================================
     修改密码弹窗
     ====================================================================== */
  function openPasswordModal() {
    $('#pwd-modal').classList.remove('hidden');
    $('#pwd-error').classList.add('hidden');
    $('#pwd-current').value = '';
    $('#pwd-new').value = '';
    $('#pwd-confirm').value = '';
    setTimeout(() => $('#pwd-current')?.focus(), 50);
  }

  function closePasswordModal() {
    $('#pwd-modal').classList.add('hidden');
  }

  async function savePassword() {
    const current = $('#pwd-current').value;
    const next = $('#pwd-new').value;
    const confirm = $('#pwd-confirm').value;
    const err = $('#pwd-error');

    err.classList.add('hidden');
    if (next.length < 8) {
      err.textContent = '新密码至少 8 位';
      err.classList.remove('hidden');
      return;
    }
    if (next !== confirm) {
      err.textContent = '两次输入的新密码不一致';
      err.classList.remove('hidden');
      return;
    }

    try {
      await api('/api/password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      state.mustChangePassword = false;
      closePasswordModal();
      toast('密码已修改', 'ok');
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }

  /* ======================================================================
     侧栏（移动端）
     ====================================================================== */
  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#backdrop').classList.add('show');
    state.sidebarOpen = true;
  }
  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('show');
    state.sidebarOpen = false;
  }

  /* ======================================================================
     工具
     ====================================================================== */
  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /* ======================================================================
     启动
     ====================================================================== */
  /** 从 URL ?page=<route> 解析初始页面（App 底栏「下载」直达用） */
  function pageFromUrl() {
    try {
      const page = new URLSearchParams(window.location.search).get('page');
      return page && ROUTES[page] ? page : null;
    } catch (e) {
      return null;
    }
  }

  async function boot() {
    try {
      const data = await api('/api/system');
      state.system = data.static
        ? { ...data.static, config: data.config }
        : { config: data.config };
      $('#host-name').textContent = data.static?.hostname || '主机';
      $('#login-host').textContent = `${data.static?.hostname || ''} · ${data.static?.osName || ''}`;
      $('#user-name').textContent = state.username || 'admin';
      $('#user-avatar').textContent = (state.username || 'a').slice(0, 1).toUpperCase();
    } catch (e) {
      console.error('系统信息加载失败', e);
    }

    buildNav();
    updateInstallUI();
    await navigate(pageFromUrl() || 'overview');
  }

  /** 公开的应用信息（版本 / 特性开关），后端未就绪时静默降级 */
  async function loadAppInfo() {
    try {
      state.appInfo = await api('/api/app/info');
    } catch (e) {
      state.appInfo = null;
    }
  }

  /** 登录页主机信息（公开接口，不含敏感数据） */
  async function loadPublicInfo() {
    try {
      const info = await api('/api/public-info');
      const host = [info.hostname, info.osName].filter(Boolean).join(' · ');
      if (host && $('#login-host')) $('#login-host').textContent = host;
      if (info.title) document.title = info.title;
    } catch (e) {
      /* 忽略 */
    }
  }

  async function init() {
    applyTheme(state.theme);

    // PWA：安装入口 + Service Worker
    state.standalone = isStandalone();
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installPrompt = e;
      updateInstallUI();
      toast('可安装到桌面：在设置页或侧栏底部点击「安装到桌面」', 'info', 5000);
    });
    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      updateInstallUI();
      toast('已安装到桌面', 'ok');
    });
    try {
      const mq = window.matchMedia('(display-mode: standalone)');
      if (mq && mq.addEventListener) mq.addEventListener('change', updateInstallUI);
    } catch (e) {
      /* ignore */
    }
    registerServiceWorker();

    // 事件绑定
    $('#login-form').addEventListener('submit', doLogin);
    $('#logout-btn').addEventListener('click', doLogout);
    $('#theme-btn').addEventListener('click', toggleTheme);
    $('#install-btn')?.addEventListener('click', promptInstall);
    $('#refresh-btn').addEventListener('click', () => navigate(state.route));
    $('#menu-btn').addEventListener('click', openSidebar);
    $('#sidebar-close').addEventListener('click', closeSidebar);
    $('#backdrop').addEventListener('click', closeSidebar);
    $('#pwd-cancel').addEventListener('click', closePasswordModal);
    $('#pwd-cancel-x').addEventListener('click', closePasswordModal);
    $('#pwd-save').addEventListener('click', savePassword);
    $('#pwd-modal').addEventListener('click', (e) => {
      if (e.target.id === 'pwd-modal') closePasswordModal();
    });

    // 键盘：Esc 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePasswordModal();
        closeSidebar();
      }
    });

    // 登录页回填上次登录的用户名（只回填用户名，绝不保存密码）
    const userInput = $('#login-username');
    const lastUser = getLastUser();
    if (userInput && lastUser) userInput.value = lastUser;

    // 公开信息并行加载，不阻塞自动登录/登录页展示
    loadAppInfo();
    loadPublicInfo();

    // 先恢复会话：有有效会话或记住登录时直接进主界面，不闪现登录页
    try {
      const data = await api('/api/session');
      if (data && data.authenticated) {
        state.username = data.username;
        state.csrf = data.csrf;
        state.mustChangePassword = data.mustChangePassword;
        state.resumed = Boolean(data.resumed);
        const remember = normalizeRemember(data.remember);
        // 普通会话下后端可能不返回 remember，用本地缓存补足展示
        state.remember = remember || getCachedRemember();
        if (remember) saveRememberCache(remember);
        if (data.username) saveLastUser(data.username);
        await boot();
        showApp();
        if (state.resumed) toast('已自动登录', 'ok', 2400);
        if (state.mustChangePassword) {
          toast('请尽快修改默认密码', 'warn', 5000);
          setTimeout(openPasswordModal, 900);
        }
        return;
      }
      // 后端明确返回未登录：记住令牌不存在/已过期/已撤销
      if (data && data.authenticated === false) {
        state.remember = null;
        clearRememberCache();
      }
    } catch (e) {
      /* 未登录 / 后端旧版本：继续走登录页 */
    }
    showLogin();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
