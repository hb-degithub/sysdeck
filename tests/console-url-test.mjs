#!/usr/bin/env node
'use strict';

/**
 * 控制台地址推导回归测试（零依赖）
 *
 * 背景：外网（tailnet）访问面板时，早期实现会把控制台地址拼成 https://<tailnet IP>/，
 * 而 DSH Web 在该 IP 上是明文 HTTP → 手机 WebView 报 ERR_SSL_PROTOCOL_ERROR。
 *
 * 用法：node tests/console-url-test.mjs
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyHost, deriveConsoleBase, withToken } = require('../lib/dsh.js');

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
}

/* 1. classifyHost */
check('classifyHost: tailnet IP 100.64.0.5', classifyHost('100.64.0.5:3081'), 'public');
check('classifyHost: tailnet IP 100.64.0.1', classifyHost('100.64.0.1'), 'public');
check('classifyHost: ts.net 主机名', classifyHost('myhost.example.ts.net'), 'public');
check('classifyHost: 局域网 IP', classifyHost('192.168.1.10:3081'), 'lan');
check('classifyHost: 127.0.0.1', classifyHost('127.0.0.1:3081'), 'lan');
check('classifyHost: localhost', classifyHost('localhost:3081'), 'lan');
check('classifyHost: 公网 IP 不是 tailnet', classifyHost('8.8.8.8:3081'), 'lan');

/* 2. public 模式：绝不能出现 https://<裸 IP> */
check(
  'public + 配置 publicUrl',
  deriveConsoleBase({ mode: 'public', cfg: { publicUrl: 'https://example.ts.net/', webPort: 3080 }, reqHost: '100.64.0.5', tailnetHost: null }),
  { base: 'https://example.ts.net/', mode: 'public' }
);
check(
  'public + 请求 Host 是 ts.net（反代 443）',
  deriveConsoleBase({ mode: 'public', cfg: { webPort: 3080 }, reqHost: 'myhost.tailabc.ts.net', tailnetHost: null }),
  { base: 'https://myhost.tailabc.ts.net/', mode: 'public' }
);
check(
  'public + 自动探测到的 tailnet 主机名',
  deriveConsoleBase({ mode: 'public', cfg: { webPort: 3080 }, reqHost: '100.64.0.5', tailnetHost: 'auto.ts.net' }),
  { base: 'https://auto.ts.net/', mode: 'public' }
);
check(
  'public + 无 publicUrl/ts.net/tailnet：回退局域网地址（不返回 https://IP）',
  deriveConsoleBase({ mode: 'public', cfg: { lanHost: '192.168.1.10', webPort: 3080 }, reqHost: '100.64.0.5', tailnetHost: null }),
  { base: 'http://192.168.1.10:3080/', mode: 'lan' }
);
check(
  'public + 无任何可用来源 → 空（上层报 public_url_unknown）',
  deriveConsoleBase({ mode: 'public', cfg: { webPort: 3080 }, reqHost: '100.64.0.5', tailnetHost: null }),
  { base: '', mode: 'public' }
);

/* 3. lan 模式 */
check(
  'lan + lanHost',
  deriveConsoleBase({ mode: 'lan', cfg: { lanHost: '192.168.1.10', webPort: 3080 }, reqHost: '192.168.1.10', tailnetHost: null }),
  { base: 'http://192.168.1.10:3080/', mode: 'lan' }
);
check(
  'lan + 无 lanHost 用请求 Host',
  deriveConsoleBase({ mode: 'lan', cfg: { webPort: 3080 }, reqHost: '10.0.0.5', tailnetHost: null }),
  { base: 'http://10.0.0.5:3080/', mode: 'lan' }
);
check(
  'lan + 自定义端口',
  deriveConsoleBase({ mode: 'lan', cfg: { lanHost: '10.0.0.5', webPort: 3999 }, reqHost: '10.0.0.5', tailnetHost: null }),
  { base: 'http://10.0.0.5:3999/', mode: 'lan' }
);

/* 4. token 追加 */
check(
  'withToken 附加 token 且保留 path',
  withToken('https://hb.ts.net/', 'abc123'),
  'https://hb.ts.net/?token=abc123'
);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('──────────────────────────────');
console.log(`结果：${results.length - failed.length}/${results.length} 通过 · ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
