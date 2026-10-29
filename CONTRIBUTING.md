# 参与贡献

欢迎 issue / PR。这个项目的原则很少，但都比较硬：

## 设计约束

1. **零 npm 依赖**：运行时只允许 Node 22 内置模块（`http`、`node:sqlite`、`crypto`、`worker_threads`…）。
   确实需要的小库用 vendored 源码放进 `lib/vendor/`（保留原许可证）。
2. **不做单机适配**：任何采集都要「拿到就显示、拿不到就隐藏」，不要为某一台机器写死
   GPU 型号、传感器芯片名、网卡名、路径或 IP。CPU 拓扑一律走自动识别（物理核/线程/超线程）。
3. **面板不以 root 运行**：需要 root 的能力只能通过 `helper/` 白名单扩展，并同步更新
   `helper/validate.js`、面板侧参数校验与测试。
4. **前端无构建步骤**：`public/` 是原生 HTML/CSS/JS，改完刷新即生效，不引入打包器。
5. **隐私默认安全**：日志、接口、备份里不出现密钥/令牌；新增配置项要给出「默认关闭」的
   安全默认值，并写进 `config.example.json` 与 README。

## 开发

```bash
node server.js              # 首次启动生成 config.json 并打印随机密码
node --watch server.js      # 开发模式
```

面板按 `PANEL_CONFIG` / `PANEL_DATA_DIR` / `PANEL_PORT` 支持隔离实例，测试脚本都依赖这一点：

```bash
PANEL_CONFIG=/tmp/t/config.json PANEL_DATA_DIR=/tmp/t/data PANEL_PORT=3099 node server.js
```

## 测试

自包含套件（每个脚本自己在 `/tmp` 起隔离实例，不碰正在跑的面板）：

```bash
node tests/collector-test.mjs
node tests/alerts-test.mjs
node tests/backup-test.mjs
node tests/chat-test.mjs
node tests/dsh-sessions-test.mjs
node tests/dsh-sdk-test.mjs
node tests/helper-test.mjs
node tests/download-test.mjs
node tests/remember-test.mjs
node tests/b3-extras-test.mjs
node tests/share-once-test.mjs
node tests/console-url-test.mjs
```

实例级（需要先起一个实例并知道密码）：

```bash
PANEL_BASE=http://127.0.0.1:3099 node tests/api-test.mjs '<密码>'
PANEL_BASE=http://127.0.0.1:3099 node tests/feature-test.mjs '<密码>'
PANEL_BASE=http://127.0.0.1:3099 node tests/ui-test.mjs '<密码>'   # 需要 playwright-core + Chromium
```

CI 会跑上面这些（见 `.github/workflows/ci.yml`）。提交 PR 前请至少跑一遍受影响模块的测试。

## 提交信息

用 `<type>(<scope>): <简述>`，type 取 `feat|fix|perf|docs|test|chore|refactor`，正文写清
「现象 / 根因 / 做法 / 验证」。涉及安全默认值变更的，在 PR 描述里单独说明。

## 许可

提交即表示同意以 GPL-3.0 授权你的贡献。
