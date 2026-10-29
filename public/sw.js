/* ==========================================================================
   sw.js — 服务器控制面板 Service Worker
   - App Shell 预缓存，离线可打开外壳
   - /api/* 一律 network-only（含 /api/stream 与 DSH SSE，绝不缓存）
   - 导航请求 network-first，失败回退缓存的 index.html
   - 版本号变化时清理旧缓存
   ========================================================================== */
'use strict';

const CACHE_PREFIX = 'server-panel-';
const CACHE_VERSION = 'v10';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/charts.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

const SHELL_PATHS = new Set(SHELL_ASSETS);

/* ---------------- 安装：预缓存 App Shell ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 单个资源失败不应让整次安装失败（例如后端暂未提供某文件）
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            console.warn('[sw] 预缓存失败:', url, err && err.message);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

/* ---------------- 激活：清理旧版本缓存 ---------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

/* ---------------- 消息：允许页面触发更新 ---------------- */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------------- 工具 ---------------- */

async function cacheFirstShell(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // 后台静默更新，下次刷新即用新版本
    event.waitUntil(
      fetch(request)
        .then((res) => {
          if (res && res.ok) return cache.put(request, res.clone());
          return undefined;
        })
        .catch(() => undefined)
    );
    return cached;
  }
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      event.waitUntil(cache.put(request, copy).catch(() => undefined));
    }
    return res;
  } catch (err) {
    return new Response('离线状态，资源暂不可用', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function networkFirstNavigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      cache.put('/index.html', copy).catch(() => undefined);
    }
    return res;
  } catch (err) {
    const cached = (await cache.match('/index.html')) || (await cache.match('/'));
    if (cached) return cached;
    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>离线 · 服务器控制面板</title>
<style>
  html,body{height:100%;margin:0;background:#0d1117;color:#e6edf3;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}
  h1{font-size:17px;margin:0}
  p{font-size:13px;color:#8b949e;margin:0;max-width:320px;line-height:1.6}
  button{margin-top:8px;padding:9px 18px;border-radius:8px;border:1px solid #30363d;
    background:#161b22;color:#e6edf3;font-size:13.5px;cursor:pointer}
</style></head><body><div class="wrap">
<h1>当前处于离线状态</h1>
<p>无法连接到面板服务。请确认手机/电脑与服务器在同一网络，然后重试。</p>
<button onclick="location.reload()">重试</button>
</div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* ---------------- 请求拦截 ---------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只处理 GET；POST/PUT 等由页面直接发网络
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // 跨域请求不接管
  if (url.origin !== self.location.origin) return;

  // API（含 SSE 流）一律 network-only，绝不缓存
  if (url.pathname.startsWith('/api/')) return;

  // 页面导航：network-first，离线回退外壳
  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigate(request));
    return;
  }

  // App Shell 静态资源：cache-first + 后台更新
  if (SHELL_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirstShell(event, request));
  }
});
