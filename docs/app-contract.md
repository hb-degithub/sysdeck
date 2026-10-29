# 「服务器面板」App 集成契约 v1

> 冻结时间：2026-10-26。backend / frontend / android 三条线并行开发的唯一依据。
> 改动契约必须由 Lead 更新本文档并通知各方。

## 0. 环境事实（已实测）

| 项 | 值 |
|---|---|
| 面板目录 | `<项目目录>`，Node 22.22.1，零 npm 依赖 |
| 面板服务 | systemd `server-panel`，`0.0.0.0:3081`，User=hb |
| 局域网地址 | `http://<面板IP>:3081` |
| Tailnet 地址 | `http://<Tailnet IP>:3081`（面板监听 0.0.0.0，可直接访问） |
| HTTPS 入口 | 暂无（`tailscale serve` 需 root，最后由用户执行一次 sudo） |
| DSH web | `dsh web` 绑定 `<面板IP>:3080`，对外 `https://<tailnet主机名>/`（tailscale serve 根路径） |
| DSH 启动 URL | 每次启动生成一次性 token，形如 `https://<tailnet主机名>/?token=...`，记录在 `journalctl -u <dsh-systemd-unit>`，hb 在 adm 组可读 |
| DSH_HOME | `<DSH_HOME>` |
| dsh 可执行 | `<dsh 可执行>` |
| DSH 会话 | `$DSH_HOME/sessions/<workspace编码>/session-<uuid>/session.v4.jsonl.zstd`（zstd；首行 `{"type":"session","version":4,"id","createdAt","cwd","agentPreset"}`） |
| DSH headless | `dsh --profile headless [--json] [--session-id <id>] "<task>"`，`--json` 输出 NDJSON 运行事件 |
| 权限 | 无 passwordless sudo（仅 panel-smartctl 白名单）。JDK/SDK 必须用户态安装 |

## 1. 面板后端（owner: backend-dev；写域：`server.js`、`lib/`、`tests/`）

### 1.1 `GET /api/app/info`（无需登录）

```json
{
  "app": "server-panel",
  "version": "0.2.0",
  "name": "服务器控制面板",
  "features": { "dsh": true, "pwa": true, "dshTask": false },
  "endpoints": { "dshConsole": "/api/dsh/console-url" }
}
```

### 1.2 `GET /api/dsh/status`（需登录）

```json
{
  "available": true,
  "home": "<DSH_HOME>",
  "web": { "reachable": true, "url": "https://<tailnet主机名>/", "pid": 405376, "profile": "web", "uptimeSec": 3600 },
  "tokenFound": true,
  "allowTask": false,
  "errors": []
}
```

- `reachable`：探测 `127.0.0.1:3080` 或进程存在即可，超时 ≤ 800ms。
- `available`：dsh 可执行文件存在 + DSH_HOME 存在。

### 1.3 `GET /api/dsh/console-url`（需登录）

返回 `{ "url": "http://<面板IP>:3080/?token=...", "mode": "lan"|"public" }`；失败为 `502 {"error":"dsh_console_unavailable","detail":"..."}`。

- token 来源优先级：`config.dsh.consoleUrlCustom`（原样返回）→ journalctl 中最新 `dsh web: https://...token=...`
- **按访问方 host 改写 origin**（已实测：DSH 接受绑定 IP 作为 authority，token 跨 authority 可用）：
  - 请求 Host 是局域网（`<面板IP>` / 其他非 tailnet 地址）→ `http://<面板IP>:3080/?token=<tok>`，`mode="lan"`
  - 请求 Host 是 tailnet（`<Tailnet IP>` / `*.ts.net`）→ `https://<tailnet主机名>/?token=<tok>`，`mode="public"`
  - 判断依据 `req.headers.host`，可用 `config.dsh.lanHost` / `publicUrl` 覆盖
- 缓存 token 60s（token 失效后重新读取 journal）；读取命令必须有超时（≤3s）与大小上限。

### 1.4 `GET /api/dsh/sessions?limit=20`（需登录）

```json
{ "sessions": [ { "id": "session-...", "cwd": "<HOME>/xxx", "createdAt": 1792758016906, "updatedAt": 1793000000000, "sizeBytes": 119704 } ],
  "total": 42, "truncated": true }
```

- 直接扫 `$DSH_HOME/sessions/*/session-*/session.v4.jsonl.zstd`；解压只取首行（zstd 全量解压上限 8MB/文件，超限跳过）。
- 按 `updatedAt` 倒序，`limit` 上限 100。

### 1.5 `POST /api/dsh/task`（需登录 + CSRF）

请求 `{ "prompt": "...", "sessionId": "session-..."|null }` → `{ "id": "task-..." }`。

- **仅 `config.dsh.allowTask === true` 才允许**，否则 `403 {"error":"dsh_task_disabled"}`。
- 命令：`<dshBin> --profile headless [--patch <patch>] --json [--session-id <id>] <prompt>`，env 显式设置 `DSH_HOME`、`HOME=<HOME>`，并注入 `$DSH_HOME/.credentials.yaml` 顶层 `refs:` 的键值（以及 `config.dsh.env` 覆盖）。
- 同时只允许 1 个任务，重复提交 `409 {"error":"dsh_task_busy"}`。
- 超时 `config.dsh.taskTimeoutMs`（默认 300000）后 kill，事件 `error: timeout`。
- 审计写 `data/audit.log`（沿用现有 audit 机制，动作 `dsh.task`，含 prompt 前 200 字符）。

### 1.6 `GET /api/dsh/task/stream?id=<id>`（需登录，SSE）

`text/event-stream`，每条 `data: {"type":"start|event|stdout|stderr|done|error","line"?:string,"sessionId"?:string,"code"?:number,"message"?:string}`。
任务结束发送 `done`/`error` 后关闭。已完成任务再次订阅时回放缓冲（上限 256KB）。

### 1.7 PWA 静态支持（server.js 小改）

- MIME 增加：`.webmanifest → application/manifest+json`、`.webp`、`.woff2`（已有）
- `/sw.js`：`Cache-Control: no-cache` + `Service-Worker-Allowed: /`
- `/manifest.webmanifest`：`Cache-Control: no-cache`
- 静态文件命中失败时保留现有 SPA 回退；**不得**把 `/api/*` 回退成 HTML。

### 1.8 可选 TLS（默认关闭）

`config.tls = { "cert": "...", "key": "...", "port": 3443 }` 时额外起一个 HTTPS listener，路由与 HTTP 完全一致。证书缺失/不可读时只告警，不影响 HTTP 启动。

### 1.9 配置默认值（代码内默认，不要改用户 `config.json`）

```js
dsh: {
  enabled: true,
  home: process.env.DSH_HOME || "<DSH_HOME>",
  bin: "<dsh 可执行>",
  profile: "headless",
  allowTask: false,
  taskTimeoutMs: 300000,
  consoleUrlCustom: "",
  // 收尾增强（Lead 实测后追加）
  patch: "<repo>/config/dsh-headless.patch.yml",   // 存在则 spawn 时加 --patch
  credentialsFile: "<home>/.credentials.yaml",      // 只读其中 refs: 段并注入 env
  credentialsMaxBytes: 65536,
  env: {},                                          // 额外/覆盖的环境变量
}
```

## 2. 面板前端（owner: frontend-dev；写域：`public/` 全部）

### 2.1 PWA

- `public/manifest.webmanifest`：`name=服务器控制面板`、`short_name=面板`、`display=standalone`、`start_url=/`、`scope=/`、`theme_color=#0d1117`、`background_color=#0d1117`、icons：192/512 + 512 maskable（PNG）
- `public/sw.js`：App Shell 预缓存（`/`、`/index.html`、`/style.css`、`/app.js`、`/charts.js`、icons）；`/api/` 一律 network-only；导航请求 network-first，失败回退 index.html；版本号常量，激活时清理旧缓存
- `public/icons/`：`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`、`apple-touch-icon.png`（180，不透明背景）
- `index.html`：manifest link、apple-touch-icon、`apple-mobile-web-app-capable`、theme-color（深/浅两套 media）
- `app.js`：注册 SW；`beforeinstallprompt` 捕获 → 侧栏/设置页显示「安装到桌面」按钮；`display-mode: standalone` 时隐藏该按钮

### 2.2 DSH 页面（导航新增一项「DSH 控制」）

- 状态卡片：DSH 是否运行、Web 地址、profile、运行时长；不可达时给出「如何启动」提示
- 「打开 DSH 控制台」按钮：`GET /api/dsh/console-url` → `window.open(url, '_blank')`；失败弹 toast 说明
- 会话列表：最近 20 个，显示 cwd 尾段 / 时间 / 大小；每行「继续」按钮把 sessionId 带入表单
- 任务表单：textarea + 「新建会话 / 继续所选会话」 + 「开始」，实时输出（SSE）滚动区，结束显示状态；`allowTask=false` 时表单禁用并显示「需在 config.json 开启 dsh.allowTask」
- 移动端 ≤720px 单列布局

### 2.3 设置页补充

- App 版本、PWA 安装状态、当前服务地址；DSH 配置摘要（home/bin/allowTask）
- **不要**修改 `server.js` / `lib/` / `tests/`

## 3. Android APK（owner: android-dev；写域：`android/`、`scripts/`、`dist/`）

### 3.1 技术选型

- **原生 Java WebView 壳**，不使用 Capacitor（用户已同意「壳」方案，等价效果、零 npm 依赖、APK 更小）
- Gradle 8.x + AGP 8.x，`compileSdk=35`，`minSdk=26`，`targetSdk=35`，`applicationId=net.hbmin.serverpanel`，应用名「服务器面板」
- 工具链**用户态**安装到 `~/.cache/server-panel-android/`（Temurin JDK 17 + Android cmdline-tools + platform 35 + build-tools 35），**禁止 sudo / apt**

### 3.2 功能

- 首启/设置页：地址预设（局域网 `http://<面板IP>:3081`、Tailnet `http://<Tailnet IP>:3081`）+ 自定义 +「测试连接」(`GET /api/app/info`)
- 主界面：WebView 加载面板（JS、DOM storage、第三方 cookie、file chooser、DownloadManager、`usesCleartextTraffic`、`mixedContent=ALWAYS_ALLOW`）
- 顶部/底部工具条：刷新、后退、面板、DSH、设置
- DSH：原生 GET `/api/dsh/console-url`（带 `CookieManager.getCookie(url)`）→ `loadUrl`；失败 toast
- 返回键：WebView 可后退则后退；长按刷新；加载失败页含「重试」
- 图标/启动图：自适应图标（由 `public/icons` 生成），深色启动背景 `#0d1117`
- 结果：`dist/server-panel-app-<versionName>.apk`（signed release）+ `android/README.md`（构建、签名、安装、卸载）

### 3.3 签名

- `android/keystore/release.keystore`（**gitignore**），密码与别名写入 `~/.config/server-panel/android-signing.txt`（600），并在 `android/README.md` 说明如何找回

## 4. Lead（写域：`README.md`、`docs/`、`.gitignore`、`scripts/` 中的发布脚本）

- 契约维护、集成验证、最终 APK 验收、README/部署文档、tailscale 8443 一步命令说明
