# 服务器面板 v2 计划（三批全做）

> 依据 2026-10-27 的功能盘点（20 页 / 73 接口）。目标：把「看起来有、实际没有」的补齐，
> 并把需要 root 的运维能力做成最小授权 helper。本文件是三条线（backend / frontend / android）的唯一契约。

## 批次与状态

| 批次 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **B1 监控告警** | 告警引擎 + 阈值 UI + 通知渠道（webhook/邮件/ntfy）+ 审计日志页 + 会话管理 + 备份/恢复 | 无 root | 🔄 |
| **B2 运维控制** | `panel-helper`（root，Unix Socket + 白名单）→ 服务启停/自启、进程结束、cron 增删改、电源、磁盘挂载、防火墙、系统更新 | 用户执行一次 `sudo install-helper.sh` | ⏳ |
| **B3 体验补全** | App：多服务器 / 自动更新 / 生物识别 / 小组件 / 下载列表 / 告警通知；面板：Docker compose+exec、网络与 GPU 压测、文件批量/回收站、终端全屏、分享持久化 | B1 部分接口 | ⏳ |

## B1 契约

### 告警

- 引擎：每次采集快照（1s）评估，**评估节流 10s**；规则 `{id, metric, op, value, durationSec, severity, enabled}`
- metric 取值：`cpuPercent` `memPercent` `swapPercent` `diskPercent` `cpuTempC` `gpuTempC` `load1` `loadPerCore` `netRxKBs` `netTxKBs`
- op：`>` `>=` `<` `<=`；severity：`warn` `crit`
- 状态机：连续 `durationSec` 秒满足 → 触发一次；连续 3 个评估周期不满足 → 恢复（可选发「恢复」通知）
- 去重：同规则触发后 `cooldownMinutes` 内不再重复；触发时写 `alerts` 表（已有 `addAlert`）
- `GET /api/alerts?limit=200&severity=&unacked=1` → `{alerts:[{id,ts,metric,value,threshold,message,severity,acknowledged}]}`
- `POST /api/alerts/ack` `{id}` / `POST /api/alerts/ack_all` → `{ok,count?}`
- `GET /api/alerts/rules` → `{enabled,cooldownMinutes,notifyOnRecover,rules:[...]}`
- `PUT /api/alerts/rules` `{enabled,cooldownMinutes,notifyOnRecover,rules}` → 校验（metric/op/severity 白名单、value 数值、durationSec 5..3600、最多 30 条）→ `{ok,rules}`
- `GET /api/alerts/state` → `{firing:[{id,metric,value,since,severity}], lastEvalAt}`

### 通知

- `GET /api/notify` → `{webhook:{enabled,type,urlSet}, email:{enabled,host,port,secure,userSet,toSet}, ntfy:{enabled,url,topic}, lastSentAt, lastError}`（**不回显密钥**）
- `PUT /api/notify` `{webhook:{enabled,type,url}, email:{enabled,host,port,secure,user,pass,from,to}, ntfy:{enabled,url,topic}}`；空字符串=保持原值，`null`=清空
- `POST /api/notify/test` `{channel:'webhook'|'email'|'ntfy'}` → `{ok,detail,elapsedMs}`
- 发送：告警触发/恢复时异步发送（fire-and-forget，带 8s 超时、失败只记录不发散）；webhook 自动适配：URL 含 `qyapi.weixin.qq.com`→企业微信、`oapi.dingtalk.com`→钉钉、`open.feishu.cn`→飞书，否则通用 `{text,...}`

### 审计与会话

- `GET /api/audit?limit=200&offset=0&q=` → `{entries:[{ts,ip,action,detail}], total, truncated}`（读 `data/audit.log` 尾部，最大 2MB）
- 会话元数据：`auth.sessions` 增加 `createdAt/lastSeenAt/ip/ua`
- `GET /api/sessions` → `{sessions:[{id,username,ip,ua,createdAt,lastSeenAt,current}]}`（id 为 sid 前 12 位）
- `POST /api/sessions/revoke` `{id}` → `{ok,revoked}`（可踢包括自己，踢自己后前端回登录页）

### 备份

- 内容：`config.json`、`data/metrics.db`（含 WAL checkpoint）、`data/remember.json`、`data/audit.log`
- 格式：`.tar.gz`，存 `data/backups/`，文件名 `server-panel-backup-YYYYMMDD-HHmmss.tar.gz`
- `POST /api/backup/create` → `{id,filename,size,createdAt}`
- `GET /api/backup/list` → `{backups:[{id,filename,size,createdAt}], auto:{enabled,keep}}`
- `GET /api/backup/download?id=` → 流式附件下载
- `POST /api/backup/delete` `{id}` → `{ok}`
- `POST /api/backup/restore` `{id, confirm:'RESTORE'}` → 先校验 tar、再落盘（原文件自动 .bak），返回 `{ok,restartRequired:true}`
- 自动备份：`backup: {auto:true, keep:7, hour:4}`，每天一次，保留最近 7 个

## B2 契约（helper）

- `helper/panel-helper.js`（root 守护，systemd `server-panel-helper.service`），Unix Socket `/run/server-panel/helper.sock`（0700 root:hb）
- 协议：JSON 行，`{nonce,hmac,op,args}`；密钥 `/etc/server-panel/helper.secret`（0600 root）；时间戳 ±60s 防重放
- 白名单 op：`service.{status,start,stop,restart,enable,disable}`、`process.kill`（pid+signal TERM/KILL）、`cron.{list,write}`（仅 hb 用户 crontab，逐行校验）、`power.{reboot,shutdown}`（延迟 60s，可 cancel）、`mount.{list,mount,umount}`（仅真实块设备 + 已存在挂载点）、`firewall.{status,allow,deny,delete,enable}`（仅 ufw，规则校验）、`packages.{upgradable,update,upgrade}`（apt，升级需二次确认）
- 所有 op 写 `/var/log/server-panel-helper.log`（或 data/helper-audit.log），并同步面板侧审计
- 面板侧：`lib/helper.js` 客户端（连接失败 → 503 `helper_unavailable`，UI 显示「需安装 helper」）
- `scripts/install-helper.sh` / `uninstall-helper.sh`（用户执行一次 `sudo`）

## B3 细节

- **App**：多服务器（列表+切换+启动页选择）、自动更新（检查 `/api/app/info` 版本 + 下载 APK + `PackageInstaller`/FileProvider）、生物识别解锁（`BiometricPrompt`，可选开关）、桌面小组件（CPU/内存/温度，`AppWidgetProvider` 15 分钟刷新）、下载列表页（`DownloadManager` 查询）、告警本地通知（WorkManager 15 分钟轮询 `/api/alerts?unacked=1`）
- **面板**：Docker compose 项目（`GET /api/docker/compose` 用 `docker compose ls`？容器 exec 需 pty → 复用终端机制）、网络吞吐压测（需对端，做 loopback/单机模式标注）、GPU 压测（OpenCL 不可用 → 用 amdgpu 负载探测/Vulkan? 简化为「GPU 占用+温度+功耗」持续满载测试，用 `/sys` 无法施加负载 → 改做「显存分配压测」worker）、文件批量操作 + 回收站（`data/trash`，删除先进回收站 7 天）、终端全屏（补齐 ANSI 光标定位 + 方向键 + `ESC[?25l/h`）、分享持久化（`data/shares.json`，0600）
