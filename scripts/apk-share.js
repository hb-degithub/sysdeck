#!/usr/bin/env node
'use strict';

/**
 * apk-share.js — 把 dist/ 里最新的 APK 通过局域网/外网（Tailscale Funnel）分发
 *
 *   GET /           落地页（含二维码，按访问 Host 自动生成）
 *   GET /qr.png     二维码 PNG（局域网= http://<host>/，外网= https://<host>/）
 *   GET /app.apk    最新 APK（attachment）
 *   GET /healthz    ok
 *
 * 用法：node scripts/apk-share.js [port]（默认 3082，监听 0.0.0.0）
 * 零依赖：二维码用 lib/vendor/qrcode.js，PNG 用 node:zlib 手写。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { qrPng } = require(path.join(__dirname, '..', 'lib', 'qr-png.js'));


const PORT = Number(process.argv[2] || process.env.APK_SHARE_PORT || 3082);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* ---------------- 找最新 APK ---------------- */

function apkVersion(name) {
  const m = name.match(/^server-panel-app-(\d+)\.(\d+)\.(\d+)\.apk$/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

function latestApk() {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(DIST);
  } catch (e) {
    return null;
  }
  for (const name of names) {
    const v = apkVersion(name);
    if (!v) continue;
    const file = path.join(DIST, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      if (!best || cmp(v, best.v) > 0) best = { file, name, v, size: st.size };
    } catch (e) {
      /* ignore */
    }
  }
  return best;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/* ---------------- 页面 ---------------- */

function isPublicHost(host) {
  return /\.ts\.net$/i.test(host || '');
}

function baseUrl(req) {
  const host = String(req.headers.host || `127.0.0.1:${PORT}`);
  const https = isPublicHost(host) || req.headers['x-forwarded-proto'] === 'https';
  return `${https ? 'https' : 'http'}://${host}`;
}

function page(apk, base) {
  const mb = apk ? (apk.size / 1048576).toFixed(1) : '0';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117"><title>服务器面板 · App 下载</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:radial-gradient(1200px 600px at 50% -10%,#132030 0%,#0d1117 60%);color:#e6edf3;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC",sans-serif;padding:24px}
.card{width:100%;max-width:420px;background:#161b22;border:1px solid #30363d;border-radius:16px;
padding:26px 22px 22px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.logo{width:56px;height:56px;border-radius:15px;margin:0 auto 14px;display:block}
h1{font-size:19px;margin:0 0 6px}.sub{color:#8b949e;font-size:13px;margin:0 0 18px}
.qr{background:#fff;border-radius:12px;padding:10px;width:210px;height:210px;margin:0 auto 16px;display:block}
.qr img{width:100%;height:100%;display:block}
.btn{display:block;width:100%;padding:14px 16px;border-radius:11px;border:0;
background:linear-gradient(135deg,#2f81f7,#39c5cf);color:#fff;font-size:15.5px;font-weight:600;
text-decoration:none;letter-spacing:.02em}.btn:active{transform:translateY(1px)}
.meta{color:#8b949e;font-size:12px;margin:12px 0 0;line-height:1.7}.meta b{color:#c9d1d9;font-weight:500}
.steps{text-align:left;margin:18px 0 0;padding:14px 16px;background:#0d1117;border:1px solid #21262d;
border-radius:10px;font-size:12.5px;color:#9da7b3;line-height:1.75}.steps b{color:#e6edf3}
code{background:#1f2630;padding:1px 5px;border-radius:4px;font-size:11.5px;color:#79c0ff;word-break:break-all}
.foot{color:#6e7681;font-size:11px;margin-top:16px}
</style></head><body><main class="card">
<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32">
<stop offset="0" stop-color="#2f81f7"/><stop offset="1" stop-color="#39c5cf"/></linearGradient></defs>
<rect width="32" height="32" rx="9" fill="url(#g)"/><path d="M9 21h4v-7H9zm6 0h4V9h-4zm6 0h3v-5h-3z" fill="#fff"/></svg>
<h1>服务器面板 · Android App</h1>
<p class="sub">扫码或点按钮直接下载安装（局域网 / 外网均可）</p>
<a class="qr" href="/app.apk"><img src="/qr.png" alt="下载二维码"></a>
<a class="btn" href="/app.apk" download>下载 APK（${mb} MB）</a>
<p class="meta"><b>${apk ? apk.name : '暂无 APK'}</b><br>包名 <code>net.hbmin.serverpanel</code> · Android 8.0+</p>
<div class="steps"><b>安装步骤</b><br>
1. 手机扫码打开本页（任意网络）<br>
2. 点上方按钮下载 APK（如提示「无法下载」，用浏览器打开而非微信/QQ 内置浏览器）<br>
3. 打开文件 → 允许「安装未知应用」→ 安装<br>
4. 首启填面板地址（如 <code>http://&lt;服务器地址&gt;:3081</code>）</div>
<p class="foot">外网地址：${base}/ · 由 Tailscale Funnel 提供<br>更新 APK 只需把新包放进 dist/ 并重启本服务</p>
</main></body></html>`;
}

/* ---------------- 服务器 ---------------- */

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache', ...extra });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '-';
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');

  const apk = latestApk();
  const base = baseUrl(req);

  if (u.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok');
  if (u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page(apk, base));
  if (u.pathname === '/qr.png') {
    try {
      return send(res, 200, 'image/png', qrPng(base + '/'));
    } catch (e) {
      return send(res, 500, 'text/plain', 'qr failed');
    }
  }
  if (u.pathname === '/app.apk' || (apk && u.pathname === `/${apk.name}`)) {
    if (!apk) return send(res, 404, 'text/plain; charset=utf-8', 'dist/ 中没有 APK');
    const st = fs.statSync(apk.file);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${apk.name}"`,
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(apk.file).pipe(res);
  }
  console.log(`${new Date().toISOString()} ${ip} ${req.method} ${u.pathname}`);
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const apk = latestApk();
  console.log(`APK 分发服务: http://0.0.0.0:${PORT}/ (latest: ${apk ? apk.name : 'none'})`);
});
server.on('error', (e) => {
  console.error('启动失败:', e.message);
  process.exit(1);
});
