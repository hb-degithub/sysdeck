# 安全说明

SysDeck 是一个**单机服务器控制面板**：登录后即可看监控、管文件、开终端、执行压测，
可选安装特权助手后还能启停服务、改防火墙、挂载磁盘、重启关机。请把它当作
**和 SSH root 权限同等级的工具**，只在可信网络中使用。

## 部署建议

- 不要直接暴露到公网。需要远程访问时用 VPN / tailscale / 反向代理 + HTTPS + 额外认证
- 面板默认监听 `0.0.0.0:3081`，只在内网使用时建议改成具体网卡地址或 `127.0.0.1` + 反代
- 启用 HTTPS：在 `config.json` 配 `tls.cert` / `tls.key`（面板自带可选 TLS 监听），
  或让 tailscale serve / nginx 终止 TLS（`panel_session` cookie 在 HTTPS 下自动加 `Secure`）
- 登录账号只有一个（默认 `admin`），首次启动随机密码只打印一次；请立即修改
- 登录失败 5 次锁定 5 分钟；「记住我」令牌只存 SHA-256 摘要，可随时在设置里撤销

## 权限模型

| 组件 | 运行身份 | 能力 |
|---|---|---|
| `server.js`（面板） | 普通用户（如 `hb`） | 读 `/proc` `/sys`、文件操作、PTY、Docker socket（需在 docker 组） |
| `panel-helper`（可选） | root | **仅白名单**：服务启停、结束进程、写 hb 用户 crontab、电源、`/mnt`/`media` 挂载、ufw、apt |
| LSPosed 模块 | 目标 App 进程 | 与本项目无关，见虚拟运动项目 |

- helper 与面板之间走 Unix Socket：目录 `0750 root:<user>`、socket `0660`、
  HMAC-SHA256 + ±60s 时间戳 + nonce 去重；参数全部二次校验，命令一律数组传参（不经 shell）
- 面板被攻破时，攻击面仍限制在 helper 的白名单操作与面板用户的文件权限内 —— 这就是
  不把整个面板跑成 root 的原因

## 高危开关

| 开关 | 默认 | 风险 |
|---|---|---|
| `dsh.allowTask` | `false` | 允许登录用户让 DSH 以面板身份执行任意 prompt（等价于命令执行） |
| `dsh.allowSdkResume` | `false` | 允许用 `dsh --profile sdk` 接管带 agent preset 的会话（同上，且会写入会话历史） |
| `helper.enabled` | 安装后为 `true` | 开放上表 root 白名单操作 |
| `fileManager.allowWrite` | `true` | 全盘文件写入/删除（删除走回收站，但仍可彻底删除） |
| `terminal` | 常驻 | 登录即可拿到交互式 shell |

**默认口令 = 服务器权限**：请使用长密码 + 只在可信网络开放，或干脆不装 helper。

## 数据落盘

| 文件 | 内容 | 权限 |
|---|---|---|
| `config.json` | 密码哈希、会话密钥、通知凭据 | 0600 |
| `data/metrics.db` | 历史指标 | 0600 |
| `data/audit.log` | 操作审计（IP、动作、详情） | 0600 |
| `data/remember.json` | 记住登录令牌的 SHA-256 摘要 | 0600 |
| `data/backups/` | 备份包（含 config/DB） | 0600 |
| `data/dsh-chat.json`、`data/shares.json`、`data/trash/` | 聊天/分享/回收站 | 0600 |

备份包内含 `config.json`，**等同于包含服务器控制权**，请勿上传到公共位置。

## 报告漏洞

请通过 GitHub Security Advisories（仓库 → Security → Report a vulnerability）私下报告，
不要在公开 issue 里贴出可利用细节。请附：版本、复现步骤、影响面。
