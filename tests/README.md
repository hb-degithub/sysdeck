# 测试套件

全部为 Node 原生脚本（`.mjs`），无需安装依赖。UI 测试需要 `playwright-core` 与 Chromium。

## 前置条件

面板服务需在运行：

```bash
cd <项目目录>
setsid node server.js > /tmp/panel.log 2>&1 < /dev/null &
```

从 `config.json` 读取密码，或首次启动时控制台输出的随机密码。

## 测试脚本

| 脚本 | 覆盖范围 | 依赖 | 耗时 |
|---|---|---|---|
| `api-test.mjs` | 98 项：全部 40 个 API 路由 + 鉴权 + CSRF + 边界 + 显存/分核/磁盘/SMART/Docker | 无 | ~8s |
| `ui-test.mjs` | 70 项：登录、SSE 实时、19 页面、显存/分核/磁盘/SMART、主题、进程交互、图表、移动端、登出 | playwright-core | ~2min |
| `sse-leak-test.mjs` | SSE 连接释放与多轮无累积泄漏 | 无 | ~15s |
| `stability-test.mjs` | 内存/线程/FD 稳定性 + 会话压力 + 200 次接口压测 | 无 | ~40s |
| `memory-test.mjs` | 4 轮 × 200 请求的内存线性增长检测 | 无 | ~30s |
| `feature-test.mjs` | 23 项：文件管理 / 性能压测 / Web 终端 全链路 | 无 | ~15s |
| `dsh-test.mjs` | 95 项：DSH 状态/控制台 URL 改写/会话列表/任务与 SSE（自包含 fake dsh）/`--patch` 与 credentials refs 注入/并发与超时/审计与密钥不泄露/PWA 静态/`/api/*` 不回退/可选 TLS | 无（openssl 可选） | ~18s |
| `remember-test.mjs` | 52 项：「记住密码」cookie 属性/自动登录与令牌轮换/重启持久化/过期清理/退出与 forget 幂等/`remember.json` 0600 与上限淘汰/配置覆盖/明文不泄漏（自包含隔离实例） | 无 | ~15s |
| `download-test.mjs` | 85 项：文件下载器（分享创建/Host 拼 URL/免登录下载/中文文件名/Range/一次性/撤销/二维码 SVG/参数校验/审计/重启持久化，自包含隔离实例） | 无 | ~12s |
| `alerts-test.mjs` | 90 项：告警引擎（节流/持续时间/冷却/恢复滞回/指标映射）、规则 API 校验与持久化、alerts 过滤与 ack、通知配置脱敏、webhook 三格式识别、ntfy、SMTP 明文投递与失败降级（自包含隔离实例 + 假 webhook/SMTP） | 无 | ~15s |
| `backup-test.mjs` | 60 项：审计日志分页/过滤、会话列表与踢出（含踢自己）、备份创建/下载（gzip+tar 校验）/恢复（恶意 tar 拒绝、.bak、内容一致）/删除、自动备份保留策略、App 更新元信息与 APK 下载/Range（自包含隔离实例） | 无 | ~15s |
| `helper-test.mjs` | 85 项：panel-helper 协议（HMAC/时间戳/nonce 重放/未知 op）、白名单参数校验、降权 helper 端到端、面板侧 /api/host/* 路由与 helper_unavailable、真实 TERM/KILL 结束进程、面板 kill 链路、install/uninstall 脚本参数安全（自包含，不要求 root） | 无 | ~15s |
| `console-url-test.mjs` | 16 项：DSH 控制台地址推导（tailnet IP 绝不拼 https、ts.net 反代、publicUrl、局域网回退） | 无 | ~1s |
| `share-once-test.mjs` | 9 项：一次性分享 + Range 分段（DownloadManager 分多次 Range 时不能提前消耗额度；覆盖合并/空文件/持久化） | 无 | ~1s |
| `b3-extras-test.mjs` | 65 项：回收站（删除/列表/恢复/冲突/purge/7 天清理）、批量 move/copy/delete 与冲突、分享持久化（重启/损坏容忍）、网络 loopback 压测与中止、CPU 采样含 GPU 字段、Docker compose 聚合、容器终端参数校验、备份设置（自包含） | 无 | ~30s |
| `collector-test.mjs` | 27 项：CPU 拓扑通用解析（sysfs/cpuinfo/threads_per_core/回退、8C16T/8C8T/双路、estimated 标记）、实时检测与快照字段、loadPerCore 按线程数、传感器空态、config.example 通用性检查 | 无 | ~5s |
| `chat-test.mjs` | 47 项：App 原生聊天 API（会话 CRUD、消息落库、fake dsh final/error+stderr 摘要、--session-id 续聊、403/409、持久化重启、0600、损坏容忍、存储上限） | 无 | ~30s |
| `dsh-sessions-test.mjs` | 48 项：DSH 会话目录（多帧 zstd 解码 / header-only 回退）、元信息与 resumable 判定、历史消息映射（user/assistant/tool 合并）、q/workspace/limit、mtime 缓存、dump-config 能力解析（plugins/providers/defaultModel、脱敏）、chat 导入绑定/不可续 400/cwd 校验 | 无（zstd 可选） | ~10s |
| `dsh-sdk-test.mjs` | 32 项：SDK 高级续聊（dsh --profile sdk）——status/preset 探测、force 绑定带 agentPreset 的 Web 会话、JSON-RPC 正常流与 SSE 复用、busy/provider/preset 错误映射、超时 kill、并发 409、allowSdkResume=false 降级、headless 不受影响 | 无（fake SDK） | ~15s |
| `reset-password.cjs` | 重置面板登录密码（非测试，运维工具） | 无 | - |

## 运行

```bash
# API 全量测试
node tests/api-test.mjs "<密码>"

# 浏览器 UI 测试（需先安装 playwright-core 并下载 Chromium）
node tests/ui-test.mjs "<密码>"

# 连接泄漏测试
node tests/sse-leak-test.mjs "<密码>"

# DSH 集成 / PWA / TLS 测试（自包含：自动在 /tmp 起隔离实例 + fake dsh，不碰正式实例）
node tests/dsh-test.mjs

# 如需附着到已运行实例仅测只读接口
PANEL_BASE=http://127.0.0.1:3099 node tests/dsh-test.mjs "<密码>"

# 记住密码 / 30 天免登录（自包含：/tmp 隔离实例 + 独立 DATA_DIR，不碰正式实例）
node tests/remember-test.mjs

# 文件下载器（分享链接 + 二维码；自包含隔离实例）
node tests/download-test.mjs
node tests/share-once-test.mjs
node tests/console-url-test.mjs

# 告警引擎 + 规则 + 通知渠道（自包含隔离实例 + 假 webhook/SMTP，不碰正式实例）
node tests/alerts-test.mjs

# 审计 / 会话管理 / 备份恢复 / App 更新（自包含隔离实例 + 临时 dist，不碰正式实例）
node tests/backup-test.mjs

# B2 panel-helper 协议 + 面板调用链（自包含、以当前用户降权运行，不需要 root）
node tests/helper-test.mjs

# B3 扩展能力（回收站/批量/分享持久化/网络与 GPU 压测/compose/容器终端/备份设置）
node tests/b3-extras-test.mjs

# CPU 拓扑 / 通用硬件采集（无需实例，直接读本机 /sys 与 /proc）
node tests/collector-test.mjs

# App 原生聊天 API（自包含隔离实例 + fake dsh）
node tests/chat-test.mjs

# DSH 会话目录 / 历史 / 能力（自包含 fixture；多帧 zstd 需系统 zstd）
node tests/dsh-sessions-test.mjs

# SDK 高级续聊（dsh --profile sdk，fake SDK 子进程）
node tests/dsh-sdk-test.mjs

# 功能测试（文件管理 / 性能压测 / Web 终端）
node tests/feature-test.mjs "<密码>"

# 稳定性与压测
node tests/stability-test.mjs "<密码>"
node tests/memory-test.mjs "<密码>"

# 重置登录密码（改完需重启服务）
node tests/reset-password.cjs            # 交互式输入
node tests/reset-password.cjs --random   # 生成随机密码
systemctl --user restart server-panel
```

UI 测试的 Chromium 路径在脚本内硬编码，若更换环境需修改 `executablePath`。安装方式：

```bash
mkdir -p /tmp/shotenv && cd /tmp/shotenv
npm init -y && npm i playwright-core
npx playwright-core install chromium
```

## 判定标准

- 所有脚本以退出码 `0` 表示通过，非 `0` 表示存在失败项
- UI 测试中的「预期内 401」来自两处故意触发的场景：用错密码登录、登出后探测接口，属正常
- 内存测试关注是否**线性增长**；V8 堆在压测后小幅上升属正常，稳定在 120–130MB

## 最近一次结果（2026-10-19）

| 套件 | 结果 |
|---|---|
| API | 98/98 ✅ |
| 功能（文件/压测/终端） | 23/23 ✅ |
| UI | 75/75 ✅（非预期控制台错误 0） |
| SSE 泄漏 | 无泄漏 ✅ |
| 稳定性 | 内存/线程/FD 平稳，200 请求平均 6.8ms，P99 25ms ✅ |
| 内存 | 800 请求后稳定在 120–129MB，无线性增长 ✅ |

## 隔离测试实例

为避免动到正式实例（及其密码），可用环境变量起独立实例：

```bash
PANEL_CONFIG=/tmp/paneltest/config.json \
PANEL_DATA_DIR=/tmp/paneltest/data \
PANEL_PORT=3099 \
node server.js

# 测试时指向该实例
PANEL_BASE=http://127.0.0.1:3099 node tests/api-test.mjs "<临时密码>"
```

## 功能测试覆盖

`feature-test.mjs` 覆盖：

**文件管理**
目录列表、读文件、写文件、回读校验、新建目录、移动、改权限、
压缩、解压、删除、路径穿越防护

**性能压测**
状态查询、启动 CPU 任务、运行中状态、完成判定、历史查询、中止

**Web 终端**
创建会话、SSE 流连接、执行命令并校验输出、调整尺寸、关闭

> 终端测试需注意：SSE 的 `reader.read()` 只能单线程消费，
> 并发调用会导致数据丢失。测试中使用单一后台读取循环。

## 本轮发现并修复的缺陷

1. `listProcesses()` 忽略 `sort`/`limit`/`filter` 参数 → `sort=mem` 无效
2. `createSession()` 未返回 `username`，被 `JSON.stringify` 丢弃 → 设置页显示「undefined」
3. SSE 清理依赖 Node 隐式回收 → 改为显式 `res.end()` + `socket.destroy()`，并同时监听 `req`/`res` 的 close
4. 会话表与失败计数表无上限 → 增加 `maxSessions`/`maxFailureRecords` 淘汰策略
