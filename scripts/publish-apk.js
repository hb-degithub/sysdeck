#!/usr/bin/env node
'use strict';

/**
 * publish-apk.js — 把 dist/ 里最新的 APK 传到公网临时文件床，拿到外网直链
 *
 *   node scripts/publish-apk.js            上传到 litterbox（默认保留 72h）
 *   node scripts/publish-apk.js 24h        litterbox 保留时长：1h/12h/24h/72h
 *
 * 输出：公网直链 + sha256 + 本地二维码 PNG（dist/public-apk-<版本>.png）
 * 说明：litterbox 是匿名公共文件床，链接任何拿到的人都能下载；敏感文件不要用这种方式。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { qrPng } = require(path.join(__dirname, '..', 'lib', 'qr-png.js'));

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function latestApk() {
  const names = fs.readdirSync(DIST).filter((n) => /^server-panel-app-\d+\.\d+\.\d+\.apk$/.test(n));
  if (!names.length) return null;
  const ver = (n) => n.match(/(\d+)\.(\d+)\.(\d+)\.apk$/).slice(1, 4).map(Number);
  names.sort((a, b) => {
    const x = ver(a);
    const y = ver(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const name = names[names.length - 1];
  return { file: path.join(DIST, name), name, version: name.replace(/^server-panel-app-|\.apk$/g, '') };
}

async function main() {
  const expire = process.argv[2] || '72h';
  if (!['1h', '12h', '24h', '72h'].includes(expire)) {
    console.error('保留时长只能是 1h / 12h / 24h / 72h');
    process.exit(2);
  }
  const apk = latestApk();
  if (!apk) {
    console.error('dist/ 里没有 server-panel-app-x.y.z.apk');
    process.exit(1);
  }
  const buf = fs.readFileSync(apk.file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`上传 ${apk.name}（${(buf.length / 1048576).toFixed(2)} MB, sha256 ${sha.slice(0, 16)}…）`);

  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', expire);
  fd.append('fileToUpload', new Blob([buf], { type: 'application/vnd.android.package-archive' }), apk.name);

  let url = '';
  try {
    const r = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
      method: 'POST',
      body: fd,
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(120000),
    });
    const text = (await r.text()).trim();
    if (r.status !== 200 || !/^https?:\/\//.test(text)) {
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    url = text;
  } catch (e) {
    console.error(`上传失败：${e.message}`);
    console.error('可用的替代方式：');
    console.error('  1) 局域网/内网：http://<面板IP>:3082/（server-panel-apk-share 服务）');
    console.error('  2) Tailscale Funnel：sudo tailscale funnel --bg --https=8443 http://127.0.0.1:3082');
    process.exit(1);
  }

  // 下载回来校验一次，确保链接真能拿到同样的文件
  let verified = false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
    const got = Buffer.from(await r.arrayBuffer());
    verified = crypto.createHash('sha256').update(got).digest('hex') === sha;
  } catch (e) {
    /* 校验失败不影响 URL 输出 */
  }

  const qrFile = path.join(DIST, `public-apk-${apk.version}.png`);
  fs.writeFileSync(qrFile, qrPng(url, 460));

  console.log('');
  console.log('✅ 公网直链（' + expire + ' 内有效）：');
  console.log('   ' + url);
  console.log(`   大小 ${buf.length} B · sha256 ${sha}`);
  console.log(`   回读校验：${verified ? '通过（内容一致）' : '未通过/未完成'}`);
  console.log(`   二维码：${qrFile}`);
  console.log('');
  console.log('注意：任何拿到链接的人都能下载这个 APK。');
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
