#!/usr/bin/env node
'use strict';

/**
 * 一次性分享 + Range 分段的回归测试（零依赖，Node 22+）
 *
 * 背景：Android DownloadManager 会分多次 Range 请求同一 URL。
 * 旧实现「响应结束即消耗一次性额度」导致第二个分段 404、下载失败。
 * 现在只有整个文件被完整送达（0..size-1 的区间被覆盖）才计一次完整下载。
 *
 * 用法：node tests/share-once-test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ShareStore } = require('../lib/share.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-once-test-'));
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

function newStore(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'store-'));
  return new ShareStore({ dataDir, warn: () => {}, ...overrides });
}

const SIZE = 1000;
const filePath = path.join(tmp, 'dummy.bin');
fs.writeFileSync(filePath, Buffer.alloc(SIZE));

/* 1. once：分段下载不消耗，完整覆盖后才失效 */
{
  const store = newStore();
  const share = store.create({ filePath, filename: 'dummy.bin', size: SIZE, once: true });
  store.registerHit(share.token);
  store.noteDelivery(share.token, SIZE, 0, 499);
  check('once + 首个分段后仍有效', store.get(share.token) !== null);

  store.registerHit(share.token);
  store.noteDelivery(share.token, SIZE, 500, 999);
  check('once + 完整覆盖后失效', store.get(share.token) === null);
  store.close();
}

/* 2. once：单个完整 GET 立即失效 */
{
  const store = newStore();
  const share = store.create({ filePath, filename: 'dummy.bin', size: SIZE, once: true });
  store.registerHit(share.token);
  store.noteDelivery(share.token, SIZE, 0, SIZE - 1);
  check('once + 单次完整下载后失效', store.get(share.token) === null);
  store.close();
}

/* 3. 多次上限（maxHits=2）：分段不计数，完整下载才计数 */
{
  const store = newStore({ maxHits: 2 });
  const share = store.create({ filePath, filename: 'dummy.bin', size: SIZE });
  store.registerHit(share.token);
  store.noteDelivery(share.token, SIZE, 0, 499); // 半段
  check('maxHits=2：半段后仍有效', store.get(share.token) !== null);
  store.noteDelivery(share.token, SIZE, 500, 999); // 补齐 => 1 次完整
  check('maxHits=2：第 1 次完整后仍有效', store.get(share.token) !== null);
  store.noteDelivery(share.token, SIZE, 0, SIZE - 1); // 第 2 次完整
  check('maxHits=2：第 2 次完整后失效', store.get(share.token) === null);
  store.close();
}

/* 4. 空文件 */
{
  const store = newStore();
  const empty = path.join(tmp, 'empty.bin');
  fs.writeFileSync(empty, Buffer.alloc(0));
  const share = store.create({ filePath: empty, filename: 'empty.bin', size: 0, once: true });
  store.registerHit(share.token);
  store.noteDelivery(share.token, 0, 0, 0);
  check('空文件 once 下载后失效', store.get(share.token) === null);
  store.close();
}

/* 5. 持久化：coverage/completed 能落盘并在重启后继续累计 */
{
  const dataDir = fs.mkdtempSync(path.join(tmp, 'persist-'));
  const store = new ShareStore({ dataDir, warn: () => {} });
  const share = store.create({ filePath, filename: 'dummy.bin', size: SIZE, once: true });
  store.registerHit(share.token);
  store.noteDelivery(share.token, SIZE, 0, 499);
  store.flush();
  store.close();

  const store2 = new ShareStore({ dataDir, warn: () => {} });
  check('重启后未完成的一次性分享仍存在', store2.get(share.token) !== null);
  store2.noteDelivery(share.token, SIZE, 500, 999);
  check('重启后补齐区间即失效', store2.get(share.token) === null);
  store2.close();
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('──────────────────────────────');
console.log(`结果：${results.length - failed.length}/${results.length} 通过 · ${failed.length} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
