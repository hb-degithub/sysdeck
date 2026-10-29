# 服务器面板 Android App（原生 WebView 壳）

把 Web 面板封装成 Android APK（本仓库 `android/` 工程开箱即用，无任何本机专属预设/路径）。原生 Java WebView 壳，
v1.1.0 起引入 AndroidX（WorkManager 后台任务 + FileProvider 安装更新），无 npm / 无 Capacitor。

- 包名：`net.hbmin.serverpanel`
- 应用名：**服务器面板**
- versionName `1.4.1` / versionCode `9`
  - 1.0.x：WebView 壳、下载入口、Cookie 持久化、清除登录状态
  - **1.1.0（B3）**：多服务器管理、自动更新、生物识别解锁、桌面小组件、下载列表页、告警本地通知
  - **1.1.1**：DSH 控制台缩放（设置页 / 长按 DSH / 页面浮动按钮）+ 面板 DSH 跳转修复
  - **1.2.0**：原生聊天页（不加载 DSH 网页，走 `/api/dsh/chat/*` + SSE）+ 开源化（去掉本机预设地址）+ CPU 超线程标注（`8C/16T`）
  - **1.3.0**：聊天接入 DSH 真实会话目录 / 历史（按 workspace 分组）+ 可续聊绑定 / Web 会话跳控制台 + 能力/插件面板 + 新建聊天可选工作目录与模型
  - **1.4.0**：SDK 高级续聊（DSH Web 带 preset 会话可续）+ 会话 channel（sdk/headless/auto）发送 + SDK SSE 事件映射（assistant/message、tool/call、turn/end）+ busy_in_web 等错误提示 + 能力面板 SDK 状态
  - **1.4.1**：DSH 控制台 SSL/连接错误兜底（专用错误页 + 重新获取地址/面板 DSH 页/复制地址）+ 打开前 URL 预检查降级（https 裸 IP / http 100.64/10）+ token 全程脱敏 + 设置页「控制台地址检测」
- `compileSdk 35`、`minSdk 26`（Android 8.0+）、`targetSdk 35`
- 权限：`INTERNET`、`ACCESS_NETWORK_STATE`、`POST_NOTIFICATIONS`、`REQUEST_INSTALL_PACKAGES`、`USE_BIOMETRIC`
  （另 `WRITE_EXTERNAL_STORAGE` / `USE_FINGERPRINT` 仅 ≤28；WorkManager 会自动合并 `WAKE_LOCK`、`RECEIVE_BOOT_COMPLETED`、`FOREGROUND_SERVICE`）
- 签名：release keystore（本地生成，见「签名」）

契约依据：`docs/app-contract.md` 第 3 节、`docs/plan-v2.md`「B3 细节 / App」。

---

## 1. 功能（对照契约 3.2）

| 契约要求 | 实现 |
|---|---|
| 首启/设置页：输入面板地址 + 最近使用列表 + 测试连接 | 开源化：**不内置任何服务器预设**；首启引导「添加服务器」输入地址（设置页/选择页维护名称+URL 列表，点选切换、长按编辑/删除）；「测试连接」原生 `GET /api/app/info`，校验 `app == server-panel` 后显示名称/版本 |
| WebView：JS / DOM storage / 第三方 cookie / file chooser / DownloadManager / 明文 / 混合内容 | `WebSettings` 全开（`setJavaScriptEnabled`、`setDomStorageEnabled`、`setDatabaseEnabled`）；`CookieManager.setAcceptThirdPartyCookies(true)`；`onShowFileChooser` → 系统文件选择器；`DownloadListener` → 系统 `DownloadManager`（带 cookie，保存到公共 `Downloads/`）；`usesCleartextTraffic=true` + `network_security_config` 允许明文；`MIXED_CONTENT_ALWAYS_ALLOW` |
| Cookie 持久化（「30 天免登录」） | `MainActivity` 在 `onPause` / `onStop` / `onDestroy` 都调用 `CookieManager.flush()`，覆盖切后台、最近任务划走、进程回收前等所有后台路径，登录 cookie 及时落盘 |
| 清除登录状态（1.0.1 新增） | 设置页二次确认 → `CookieManager.removeAllCookies` + `WebStorage.deleteAllData()` + `flush()`，toast「已清除登录状态，下次打开需重新登录」；返回主界面自动重新加载面板走登录流程（登录异常自救） |
| 多服务器管理（1.1.0） | `ServerStore` 用 SharedPreferences JSON 存 `[{name,url}]` + `active_url`（首次启动从 1.0.x 的 `base_url` 迁移，并保留局域网/Tailnet 预设）；设置页可添加/编辑/删除/设为当前；配置 >1 台时冷启动先进入 `ServerPickerActivity` 选择（当前高亮 = 记住上次选择）；工具条「面板」长按随时切换 |
| 自动更新（1.1.0） | 启动时静默 / 设置页手动 `GET <base>/api/app/update`（`{version,downloadUrl,size,sha256,notes}`）；语义化版本比较 → 弹窗展示 notes → `DownloadManager` 下载 APK（带 cookie，存 App 私有 `updates/`）→ 下载完成广播触发 `FileProvider` + `ACTION_VIEW` 拉起系统安装器（`REQUEST_INSTALL_PACKAGES`）；接口缺失（404/异常）时降级为「自动更新不可用 → 打开发布页 / 浏览器下载」 |
| 生物识别解锁（1.1.0） | 设置开关默认关；开启后冷启动 / 后台 >60 秒回来显示锁屏覆盖层并验证：API 28+ 用平台 `BiometricPrompt`，26/27 或仅设锁屏密码时用 `KeyguardManager.createConfirmDeviceCredentialIntent`；无锁屏/生物识别的设备禁止开启 |
| 桌面小组件（1.1.0） | `MetricsWidgetProvider`（AppWidgetProvider，自适应大小）显示 CPU% / 内存% / 温度 / 负载 / 更新时间；`MetricsWorker`（WorkManager 周期 15 分钟）带 Cookie 调 `<base>/api/metrics/latest`；点击打开 App；未登录显示「点击登录 / 打开 App」 |
| 下载列表页（1.1.0） | `DownloadsActivity` 查询 `DownloadManager`（文件名/进度/状态/大小），点击打开文件、长按删除记录；进入页面请求 Android 13+ 通知权限；入口：设置 →「下载列表」 |
| 告警本地通知（1.1.0） | `AlertWorker`（WorkManager 周期 15 分钟）`GET <base>/api/alerts?unacked=1`，按告警 id 去重（本地 seen 集合）发本地通知，一次最多 5 条；点击通知打开 App 并跳到 `?page=alerts`；设置页可开关，开启时请求通知权限 |
| 工具条：刷新、后退、面板、下载、DSH、聊天、设置 | 底部工具条 7 个按钮（12sp，等宽）；「刷新」长按强制重载、「面板」长按切换服务器、「DSH」长按循环缩放；「聊天」进入原生聊天页 |
| 下载入口（1.0.2 新增） | 底栏「下载」加载 `<面板地址>/?page=download`（用设置里保存的基础地址，自动兼容带/不带尾斜杠与 http/https）；页面里的下载链接（含 `/d/<token>` 分享链接）由 `DownloadListener` → 系统 `DownloadManager` 接住 |
| 下载文件名解析 | 优先 `Content-Disposition`（支持 RFC 5987 `filename*=UTF-8''…`，中文名/扩展名不丢），其次 `URLUtil.guessFileName` 兜底；cookie 与 UA 透传，文件保存到公共 `Downloads/`，完成通知可点击打开 |
| DSH：原生 GET `/api/dsh/console-url` 带 cookie → `loadUrl`；失败 toast | 后台线程 `HttpURLConnection`（连接/读取 8s 超时），`Cookie` 取自 `CookieManager.getCookie(base)`；解析 `{"url","mode"}` 后**原样** `webView.loadUrl(url)`（不拼 token、不改 host）；成功按 `mode` 提示「局域网直连 / 公网·Tailnet / 自定义地址」；401/403（未登录）、502（`dsh_console_unavailable` → 「DSH 未运行」）、其它失败均 toast + 顶部可点击提示条「点此重试」 |
| DSH 显示缩放（1.1.1） | 设置页「DSH 显示」：70/80/90/100/110/125/150% 预设 + ±5% 微调（50–200%）+ 恢复 100%；双指缩放开关（默认开）；「DSH 按钮打开」= 完整控制台（默认，走 `/api/dsh/console-url`）/ 面板 DSH 页（`<base>/?page=dsh`）；长按底栏「DSH」循环 70→80→90→100→110→125→150→70 并 toast；DSH 页面右上角注入浮动「100%」按钮（点按 -10%，50% 后跳 200%，长按恢复），缩放通过 `document.documentElement.style.zoom` 注入，改缩放只 evaluateJavascript 不刷新页面；设置持久化到 SharedPreferences（默认 100%） |
| 面板 DSH 跳转修复（1.1.1） | 面板页面（3081/8443/内网 IP）加载完成后注入 `window.open` 补丁（同窗口跳转，含 target=_blank），让面板 DSH 页的「打开 DSH 控制台」在 App 内可用；DSH 控制台页面不注入该补丁，只注入缩放；请求 UA 追加 ` ServerPanelApp/<versionName>` |
| 原生聊天页（1.2.0） | 底栏「聊天」→ `ChatActivity`（不加载 DSH 网页）：会话列表弹层（切换/新建/删除）、消息 RecyclerView（用户右/助手左气泡，` ``` ` 代码块等宽字体，长按可选中复制）、输入框 + 发送；发送走 `POST /api/dsh/chat/sessions/:id/messages`，随后读 `GET /api/dsh/task/stream?id=<taskId>` SSE 更新状态行（start→「思考中…」/event/status/stderr/done/error），done/error 后重新拉取消息；403 `dsh_task_disabled`、409 busy、401 未登录、404 接口未上线均有可读提示 |
| CPU 超线程标注（1.2.0） | 小组件 CPU 行在有规格时显示 `CPU 12% · 8C/16T`，无超线程 `8C/8T`；设置页「CPU：8 核 16 线程（超线程）」；数据全部来自接口（`/api/metrics/latest` 的 `cpu.threads`/`threadsPerCore`/`coreCount`，缺字段回退 `/api/system` 的 `cpuCores`/`cpuPhysicalCores`），字段缺失只显示 CPU% |
| 开源化（1.2.0） | 删除全部本机预设地址与主机名文案；首启无默认服务器，由用户输入；示例地址统一为 `http://<server>:3081` |
| DSH 会话目录（1.3.0） | 聊天页 Tab「DSH 会话」：`GET /api/dsh/sessions?limit=50` 只读浏览 DSH 真实会话，按 workspace（cwd 尾段）分组、组内按 updatedAt 倒序；每行显示标题/相对时间/消息数/模型/大小/标签（可续聊 / Web 会话 / 仅浏览） |
| DSH 会话详情（1.3.0） | `DshSessionActivity`：`GET /api/dsh/sessions/:id/messages?limit=200` 读历史，user 右/assistant 左、tool 折叠一行灰色「工具 read_file · …」点击展开参数/结果；顶部显示 cwd、模型、agent preset、消息数 |
| 续聊 / 跳控制台（1.3.0） | resumable 且无 preset：「继续对话」→ `POST /api/dsh/chat/sessions {dshSessionId,cwd}` 绑定后进入应用聊天；Web 会话（有 preset）：提示「该会话由 DSH Web 创建，headless 无法续聊」+「在 DSH 控制台打开」（原生 GET `/api/dsh/console-url` 后 Intent 打开浏览器） |
| 能力面板（1.3.0） | 聊天页「能力」：`GET /api/dsh/capabilities` → profile、DSH 版本、allowTask、taskPatches、historyDecode（header-only 时提示「服务端缺少 zstd，无法读取历史」）、默认模型、可选模型、插件列表（id/name）；接口 404 显示可读降级 |
| 新建聊天 cwd/模型（1.3.0） | 「新建」弹窗可选工作目录（从最近 DSH 会话 cwd 自动补全，或手输，默认面板根）+ 模型（来自 capabilities.providers）；发送时带 `model: 'provider/model'`；400 `cwd_invalid` / `dsh_session_not_resumable` 有可读提示 |
| SDK 高级续聊（1.4.0） | DSH 会话详情页对 Web 会话（agentPreset 非空）读取 `GET /api/dsh/sdk/status`：`available && allowSdkResume` 时显示「继续对话（SDK）」→ `POST /api/dsh/chat/sessions {dshSessionId, force:true}` 绑定 → 进入聊天页并以 `channel=sdk` 发送；不可用时保留「headless 无法续聊」并显示原因（接口未就绪 / allowSdkResume 未开 / preset·provider 缺失） |
| 按 channel 发送（1.4.0） | 会话绑定 SDK 时 POST messages 带 `channel:'sdk'`，否则 `channel:'auto'`（服务端可自行 headless/auto）；发送仍带可选 `model:'provider/model'` |
| SDK SSE 映射（1.4.0） | 事件流新增映射：`assistant/message` → 助手气泡、`tool/call` → 工具行（灰色小字）、`turn/end` → 结束并回填持久化消息；原有 start/event/stdout/stderr/done/error 仍兼容 |
| SDK 错误提示（1.4.0） | `dsh_session_busy_in_web`/`busy_in_web` →「该会话正在 DSH Web 中打开，请先在 DSH 里关闭后重试」；`sdk_resume_disabled` →「服务端未开启 SDK 续聊」；`dsh_provider_missing` / `dsh_preset_missing` / `dsh_session_not_resumable` / `cwd_invalid` 均有具体提示；能力面板新增「SDK 续聊」行（可用/不可用 + profile + presets 数） |
| DSH 控制台 SSL 错误页（1.4.1） | `onReceivedError` / `onReceivedSslError` 命中 DSH 控制台地址时显示专用页：标题「DSH 控制台打不开」、SSL/连接原因说明、尝试过的 URL（`?token=***` 脱敏）、三个按钮「重新获取地址」（重新 GET `/api/dsh/console-url`，失败自动重试 1 次）/「打开面板 DSH 页」（`<base>/?page=dsh`）/「复制地址」 |
| DSH 地址预检查降级（1.4.1） | 打开前校验 URL：`https://<纯IP>` 或 `http://100.64.0.0/10`（tailnet CGNAT）→ 不发 WebView，直接 toast「服务端控制台地址异常，已改用面板 DSH 页」并加载面板 DSH 页；`https://<*.ts.net>`、局域网 `http://<lan>:3080` 正常保留 |
| token 脱敏（1.4.1） | 错误页、Toast/Banner、通用错误页、剪贴板中的 `token=…` 一律替换为 `token=***`（纯逻辑 `DshUrlGuard.maskToken`） |
| 控制台地址检测（1.4.1） | 设置 →「DSH 显示」→「控制台地址检测」：调用 `/api/dsh/console-url` 显示 mode + 脱敏 URL，异常地址给出升级服务端提示（便于用户自查） |
| 返回键：可后退则后退；长按刷新 | `onBackPressed` 优先 `webView.goBack()`；`onKeyLongPress(BACK)` 触发 `reload()` |
| 加载失败页含「重试」 | `onReceivedError`（主框架）显示错误覆盖层 + 重试按钮 |
| 自适应图标 + 深色启动背景 #0d1117 | 自适应图标 `mipmap-anydpi-v26/ic_launcher[_round].xml`：蓝渐变背景 + **复用 frontend-dev 的 `public/icons/icon-512.png`**（构建脚本自动同步到 `res/drawable-nodpi/ic_launcher_art.png`）；`Theme.ServerPanel.Launch` 的 `windowBackground` 为 `#0d1117` |
| 产物 + README | `dist/server-panel-app-1.1.1.apk` + 本文件 |

其他细节：

- 网页里的 `mailto:` / `tel:` 等非 http(s) scheme 交给系统应用打开
- `WebView` 状态在 `configChanges` 中自行处理（旋转不重建）
- Debug 构建自动开启 `chrome://inspect` 调试；release 关闭
- 下载目录：面板下载保存到系统「下载」目录（`Download/<文件名>`），通知栏可点开
- 桌面小组件：CPU / 内存 / 温度 / 负载，15 分钟（WorkManager）刷新；点击打开 App
- 下载列表页：设置 →「下载列表」，显示 DownloadManager 记录（含自动更新下载的 APK），点击打开、长按删除
- 告警通知：WorkManager 每 15 分钟轮询 `/api/alerts?unacked=1`（按告警 id 去重），点击通知打开 `?page=alerts`
- 自动更新：`GET <base>/api/app/update`，下载后经 FileProvider 拉起系统安装器；接口缺失时降级为手动更新
- DSH 缩放：设置页 / 长按 DSH / DSH 页浮动按钮三种入口，缩放值持久化；面板页面不缩放，保持响应式布局
- 原生聊天：底栏「聊天」进入，SSE 实时状态；接口 404 时提示「后端未提供聊天接口」
- CPU 规格：小组件 `8C/16T` / 设置页「CPU：8 核 16 线程（超线程）」，全部取自接口，不硬编码
- 开源化：无本机预设地址，首启录入；示例地址统一为 `http://<server>:3081`
- DSH 会话：只读浏览（不伪造/修改 DSH 会话文件），能续的绑定面板聊天续聊，不能续的跳 DSH 控制台
- 能力面板 + 新建聊天：可从接口读取插件/模型/workspace，选择工作目录与模型后发送
- SDK 续聊：仅对「DSH Web 创建的带 preset 会话」生效，需服务端开启 SDK 通道（`/api/dsh/sdk/status`）；不可用时明确提示原因
- DSH 控制台 SSL 兜底：外网访问推荐 tailnet 主机名（`https://*.ts.net`）；遇到 https 裸 IP / CGNAT 地址自动降级到面板 DSH 页

## 2. 目录结构

```
android/
├── build.gradle              # AGP 8.7.3（只声明版本）
├── settings.gradle           # google()/mavenCentral() 仓库 + :app
├── gradle.properties
├── gradlew / gradlew.bat     # Gradle wrapper（8.9，setup 脚本生成）
├── gradle/wrapper/           # wrapper jar + properties（distributionUrl 8.9-bin）
├── keystore/                 # ⚠️ gitignore；release.keystore + keystore.properties
├── README.md                 # 本文件
└── app/
    ├── build.gradle          # applicationId / SDK / 签名配置
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/net/hbmin/serverpanel/
        │   ├── MainActivity.java          # WebView 壳 + 工具条 + DSH + 锁屏 + 更新安装/广播
        │   ├── SettingsActivity.java      # 多服务器 + 开关（生物识别/告警）+ 检查更新 + 下载列表
        │   ├── ServerPickerActivity.java  # 多服务器启动选择页
        │   ├── DownloadsActivity.java     # DownloadManager 下载列表页
        │   ├── UpdateChecker.java         # /api/app/update 检查 + 下载 + 安装器拉起
        │   ├── ChatActivity.java           # 聊天页（双 Tab：应用聊天 / DSH 会话、能力、新建）
        │   ├── DshSessionActivity.java     # DSH 会话详情（历史/续聊/跳控制台）
        │   ├── DshSessionsAdapter.java     # DSH 会话分组列表适配器
        │   ├── DshMessageAdapter.java      # DSH 历史气泡（tool 可折叠）
        │   ├── DshSessionInfo.java         # DSH 会话模型（纯逻辑，JDK 单测）
        │   ├── DshSessions.java            # 分组/排序/相对时间（纯逻辑）
        │   ├── DshMessage.java             # DSH 历史消息模型（纯逻辑）
        │   ├── HistoryMapper.java          # role/tool → 气泡映射（纯逻辑）
        │   ├── ModelParam.java             # 'provider/model' 拼接与校验（纯逻辑）
        │   ├── CapabilitiesText.java       # 能力面板文本映射（纯逻辑）
        │   ├── SdkStatus.java              # SDK 续聊状态（纯逻辑，JDK 单测）
        │   ├── ChatChannel.java            # 发送通道选择 sdk/headless/auto（纯逻辑）
        │   ├── SdkErrors.java              # SDK 错误码 → 中文提示（纯逻辑）
        │   ├── SseEventMapper.java         # SSE 事件 → 气泡/工具行/结束（纯逻辑）
        │   ├── DshUrlGuard.java            # DSH URL 校验/降级/token 脱敏（纯逻辑）
        │   ├── ChatAdapter.java            # 聊天气泡 RecyclerView 适配器
        │   ├── ChatApi.java                # chat/* HTTP + SSE 流读取
        │   ├── ChatMessage.java            # 聊天消息模型
        │   ├── ChatState.java              # 聊天状态机（纯逻辑，JDK 单测）
        │   ├── SseParser.java              # SSE 行解析（纯逻辑，JDK 单测）
        │   ├── CpuSpec.java                # CPU 物理核/线程数（纯逻辑，JDK 单测）
        │   ├── DshZoom.java               # DSH 缩放/双指缩放/打开方式 偏好
        │   ├── DshZoomMath.java           # 缩放步进与 DSH URL 判定（纯逻辑，JDK 可单测）
        │   ├── ServerStore.java           # 多服务器列表 / 当前服务器 / 1.0.x 迁移
        │   ├── AppPrefs.java              # SharedPreferences 键
        │   ├── Api.java                   # 带 Cookie 的 GET
        │   ├── WorkScheduler.java         # WorkManager 周期任务调度
        │   ├── MetricsWorker.java         # /api/metrics/latest → 小组件
        │   ├── AlertWorker.java           # /api/alerts?unacked=1 → 本地通知
        │   ├── MetricsWidgetProvider.java # AppWidgetProvider
        │   ├── WidgetUpdater.java         # RemoteViews 渲染
        │   ├── NotificationHelper.java    # 告警通知渠道/通知
        │   └── Util.java                  # 地址归一化 / 响应读取
        └── res/
            ├── layout/activity_main.xml, activity_settings.xml, activity_server_picker.xml,
            │          activity_downloads.xml, activity_chat.xml, item_chat_message.xml,
            │          activity_dsh_session.xml, item_dsh_group.xml, item_dsh_session.xml, widget_metrics.xml
            ├── values/strings.xml, colors.xml, themes.xml
            ├── drawable/launch_background.xml, ic_launcher_background.xml, banner_bg.xml,
            │          widget_bg.xml, ic_stat_alert.xml, bubble_user.xml, bubble_assistant.xml
            ├── drawable-nodpi/ic_launcher_art.png   # 来自 public/icons/icon-512.png（构建时自动同步）
            ├── mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml
            └── xml/network_security_config.xml, file_paths.xml, widget_info.xml
scripts/
├── setup-android.sh          # 用户态安装 JDK17 + Android SDK + Gradle（可重放）
└── build-android.sh          # 一条命令：签名材料 → assembleRelease → dist/<apk> → 校验
dist/
├── server-panel-app-1.4.1.apk   # 当前版本（DSH 控制台 SSL 兜底 + URL 预检查降级 + token 脱敏）
├── server-panel-app-1.4.0.apk   # 历史版本（SDK 高级续聊）
├── server-panel-app-1.3.0.apk   # 历史版本（DSH 会话目录/历史/能力 + cwd/模型选择）
├── server-panel-app-1.2.0.apk   # 历史版本（原生聊天页 + 开源化 + CPU 超线程标注）
├── server-panel-app-1.1.1.apk   # 历史版本（DSH 缩放）
├── server-panel-app-1.1.0.apk   # 历史版本（B3）
├── server-panel-app-1.0.2.apk   # 历史版本（下载入口）
├── server-panel-app-1.0.1.apk   # 历史版本（Cookie 持久化）
└── server-panel-app-1.0.0.apk   # 历史版本
```

## 3. 工具链（用户态，无 sudo / 无 apt）

全部装在 `~/.cache/server-panel-android/`，不触碰系统包和 root：

| 组件 | 版本 | 路径 |
|---|---|---|
| Temurin JDK | 17.0.21 | `~/.cache/server-panel-android/jdk-17` |
| Gradle | 8.9 | `~/.cache/server-panel-android/gradle-8.9` |
| Android cmdline-tools | 11076708（latest） | `~/.cache/server-panel-android/android-sdk/cmdline-tools/latest` |
| Android platform | android-35 | `~/.cache/server-panel-android/android-sdk/platforms/android-35` |
| Build tools | 35.0.0 | `~/.cache/server-panel-android/android-sdk/build-tools/35.0.0` |
| AGP | 8.7.3 | Gradle 从 google()/mavenCentral() 下载 |
| AndroidX | work-runtime 2.9.1 / core 1.13.1 | Gradle 从 google() 下载（v1.1.0 起） |
| 环境文件 | — | `~/.cache/server-panel-android/env.sh` |

### 安装工具链（只需一次，可重放）

```bash
cd <项目目录>
bash scripts/setup-android.sh          # 断点续跑安全；--force 强制重装
source ~/.cache/server-panel-android/env.sh
```

脚本做的事：下载 Temurin JDK 17（api.adoptium.net）、Gradle 8.9（services.gradle.org）、
Android cmdline-tools（dl.google.com）→ `yes | sdkmanager --licenses` 自动接受 license →
`sdkmanager --install "platform-tools" "platforms;android-35" "build-tools;35.0.0"` →
写 `env.sh` → 在临时空工程里生成 `android/gradlew`（避免提前触发 AGP 配置）。

## 4. 构建（一条命令出 APK）

```bash
cd <项目目录>
bash scripts/build-android.sh           # 增量构建
bash scripts/build-android.sh --clean   # 先 clean
```

流程：检查/生成签名材料 → 同步图标（`public/icons/icon-512.png` → `res/drawable-nodpi/ic_launcher_art.png`）→
写 `android/local.properties`（sdk.dir）→ `gradle assembleRelease` →
复制产物到 `dist/server-panel-app-<versionName>.apk` →
`apksigner verify`、`zipalign -c 4`、`aapt2 dump badging` 静态校验并打印摘要。

首次构建需要从 google()/mavenCentral() 下载 AGP + AndroidX 依赖（约 200–300 MB，视网络 1–5 分钟）；
之后增量构建通常 10–30 秒（v1.1.0 实测 12s）。构建缓存位于 `~/.gradle/`。

## 5. 签名

- keystore：`android/keystore/release.keystore`（PKCS12, RSA 4096, 有效期 30 年，alias `serverpanel`）
- 密码/别名：**`~/.config/server-panel/android-signing.txt`**（权限 600）
- Gradle 读取：`android/keystore/keystore.properties`（权限 600，同样含密码）
- `android/keystore/` 与 `*.keystore` 已在 `.gitignore` 中，不入库

```bash
source ~/.cache/server-panel-android/env.sh   # apksigner/keytool 需要 java 在 PATH

# 查看签名信息
cat ~/.config/server-panel/android-signing.txt
~/.cache/server-panel-android/jdk-17/bin/keytool -list -v \
  -keystore android/keystore/release.keystore -alias serverpanel

# 校验 APK 签名
~/.cache/server-panel-android/android-sdk/build-tools/35.0.0/apksigner verify --verbose \
  dist/server-panel-app-1.1.1.apk
```

**丢失密码的后果**：无法再签出能覆盖安装的新版本（Android 要求升级包签名一致）。
keystore 文件本身仍可用 `keytool` 尝试找回，或删掉 keystore 重新生成一套（旧版本必须先卸载）。
本机 keystore 可整体备份 `android/keystore/` + `~/.config/server-panel/android-signing.txt`。

## 6. 安装 / 卸载

### 方式 A：adb

```bash
adb install -r dist/server-panel-app-1.1.1.apk
# 首次安装也可： adb install dist/server-panel-app-1.1.1.apk
```

### 方式 B：不连电脑

1. 把 `dist/server-panel-app-1.1.1.apk` 拷到手机（微信/网盘/USB/HTTP 皆可）
2. 点击 APK → 允许「安装未知应用」→ 安装
3. 或先起一个临时下载服务：`cd dist && python3 -m http.server 8099`，手机浏览器访问
   `http://<电脑局域网 IP>:8099/server-panel-app-1.1.1.apk`

### 首次启动

1. 打开「服务器面板」→ 首装无预设，进入设置页「添加服务器」
2. 输入面板地址（如 `http://<server>:3081`，局域网/Tailscale 均可）并保存
3. 「测试连接」确认返回 `服务器控制面板 <version>`（`GET /api/app/info`）
4. 之后启动使用上次选择的服务器；工具条「设置」随时改，长按「面板」随时切换

### 卸载

```bash
adb uninstall net.hbmin.serverpanel
```
或在系统「设置 → 应用 → 服务器面板 → 卸载」。
卸载会清除应用内保存的面板地址（SharedPreferences）与 WebView 缓存，不影响服务器数据。

## 7. 验证输出（静态校验）

本机无真机/模拟器，APK 用 Android SDK 自带工具做静态验证，命令可复现：

```bash
source ~/.cache/server-panel-android/env.sh   # apksigner 需要 java 在 PATH
BT=~/.cache/server-panel-android/android-sdk/build-tools/35.0.0

# 1) 签名校验（v1/v2/v3 + 证书指纹）
$BT/apksigner verify --verbose --print-certs dist/server-panel-app-1.1.1.apk

# 2) 4 字节对齐
$BT/zipalign -c -v 4 dist/server-panel-app-1.1.1.apk

# 3) 包名 / 版本 / SDK / 权限 / 图标 / 启动 Activity
$BT/aapt2 dump badging dist/server-panel-app-1.1.1.apk
```

### 7.1 本机实测结果（2026-10-29，v1.4.1）

环境：Ubuntu 26.04 x86_64 / Temurin JDK 17.0.21 / Gradle 8.9 / AGP 8.7.3 / build-tools 35.0.0

```text
APK      : dist/server-panel-app-1.4.1.apk
大小     : 2,206,749 字节（约 2.1 MB，含 AndroidX WorkManager / RecyclerView / Kotlin 标准库）
SHA-256  : 8a25e2123d28bfec6b21c1e2d78909ecfd853d067069391acae035fd647f2e60
构建耗时 : 首次（含下载 AndroidX 依赖）约 1–2 分钟；本次 1.4.1 增量构建 15s
```

> 自洽验证：面板 `GET /api/app/update` 实测返回 `{version:"1.4.1", size:2206749, sha256:"8a25e212…"}`
> 与本地 APK 完全一致（自动更新链路可端到端对上）。

**签名（`apksigner verify --verbose --print-certs`）**

```text
Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
Signer #1 certificate DN: CN=Server Panel, OU=android, O=hbmin, L=Local, ST=Local, C=CN
Signer #1 certificate SHA-256 digest: 48d42824272f271532841d53e9b2d61c186b9e043c6ac2868fb2e0182b65a382
Signer #1 certificate SHA-1 digest: 70a407591212e4fca3baef38b8bb08a75d82e27b
Signer #1 certificate MD5 digest: fc9f43316301c551ee12512d10827fa1
Signer #1 key algorithm: RSA
Signer #1 key size (bits): 4096
Signer #1 public key SHA-256 digest: 44f73bafac9588ef9a9e7aace3874b984a792f04cf02ae97f0748b200e9a2251
```

> 重新构建后 APK 的 SHA-256 会变（zip 元数据/签名块不同），内容与校验结果不变；以下为本次快照。
>
> `v1(false)` / `v3(false)` 是正常的：`minSdk=26`（Android 8.0）从 API 24 起支持 v2 签名，v1 只服务更老的系统；
> 证书 SHA-256 与 `~/.config/server-panel/android-signing.txt` 里的 `sha256:` 一致。

**对齐（`zipalign -c -v 4`）**

```text
2062740 resources.arsc (OK)
Verification succesful
```

**包信息（`aapt2 dump badging` 摘要）**

```text
package: name='net.hbmin.serverpanel' versionCode='9' versionName='1.4.1'
         platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'
minSdkVersion:'26'
targetSdkVersion:'35'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='28'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'
uses-permission: name='android.permission.USE_BIOMETRIC'
uses-permission: name='android.permission.USE_FINGERPRINT' maxSdkVersion='28'
uses-permission: name='android.permission.WAKE_LOCK'
uses-permission: name='android.permission.RECEIVE_BOOT_COMPLETED'
application-label:'服务器面板'
application-icon-160:'res/BW.xml'
application-icon-65534:'res/BW.xml'
launchable-activity: name='net.hbmin.serverpanel.MainActivity'  label='' icon=''
```

> `application-icon-160` 指向编译后的自适应图标 XML（AGP 8 会缩短资源路径）；实际前景图来自 `public/icons/icon-512.png`。
> DEX 共 4438 个类（单 dex，含 AndroidX WorkManager / Kotlin 标准库），含 `MainActivity` / `SettingsActivity` /
> `ServerPickerActivity` / `DownloadsActivity` / `UpdateChecker` / `MetricsWorker` / `AlertWorker` /
> `MetricsWidgetProvider` / `NotificationHelper` 等。
>
> 组件已在合并后的清单中确认：4 个 Activity、`MetricsWidgetProvider`（APPWIDGET_UPDATE）、
> `androidx.core.content.FileProvider`（authority `net.hbmin.serverpanel.fileprovider`）、
> `androidx.startup.InitializationProvider`（WorkManager 自动初始化）。

**结论**：APK 结构、包名、版本、SDK 级别、权限、应用名、启动 Activity、图标、签名与对齐全部通过静态校验。
唯一未覆盖的是「真机实际安装并点击」——本机无 Android 设备/模拟器（见 §9）。

## 8. 常见问题（FAQ）

**Q1. 打开 App 显示「页面加载失败」？**
面板服务没起、地址不对、或手机不在同一网络。检查：
```bash
systemctl status server-panel          # 服务器上
curl -s http://127.0.0.1:3081/api/app/info
```
手机浏览器直接访问同一地址能否打开；能打开但 App 不行 → 到「设置 → 测试连接」看具体错误。

**Q2. 连不上但地址是 `https://`？**
本 App 允许明文 http，也支持 https。面板目前无 HTTPS 入口，请用 `http://`。
走 Tailscale 时手机需登录同一 tailnet；`http://<tailscale-server>:3081` 可直接访问。

**Q3. 点「DSH」提示「请先在面板登录…（HTTP 401/403）」？**
DSH 按钮复用 WebView 的登录 Cookie（`CookieManager`）。先在面板里登录，再点 DSH。
若面板未开启登录鉴权一般不会出现；出现 502 `dsh_console_unavailable` 说明
`dsh web` 未运行或 journalctl 里没有 token（契约 1.3）。

**Q4. 下载的文件去哪了？怎么下载？**
底栏「下载」→ 面板下载页（`<面板地址>/?page=download`），点页面里的文件/分享链接（如 `/d/<token>`）即可下载。
文件保存在系统「下载」目录（`Download/<文件名>`，中文名通过 `Content-Disposition` 的 `filename*=UTF-8''…` 还原），
完成通知点击即可打开；Android 13+ 若拒绝通知权限，下载仍成功但无通知。
若点下载没反应：确认是 http(s) 链接、响应带 `Content-Disposition: attachment`，或面板登录态已失效（先在面板登录）。

**Q5. 页面里选文件没反应？**
`<input type="file">` 会走系统文件选择器；部分页面用自定义 JS 触发下载而非 input，需页面配合。

**Q6. 构建报 `SDK location not found`？**
先 `bash scripts/setup-android.sh`，再用 `bash scripts/build-android.sh`（脚本会写 `android/local.properties`）。

**Q7. 构建卡在下载依赖 / 很慢？**
AGP 依赖从 google()/mavenCentral() 拉取，首次约 100–200 MB；网络受限时可配
`~/.gradle/gradle.properties` 代理/镜像。工具链（JDK/SDK/Gradle）不重复下载。

**Q8. 换图标？**
自适应图标在 `res/mipmap-anydpi-v26/ic_launcher.xml`，前景图是 `res/drawable-nodpi/ic_launcher_art.png`。
`scripts/build-android.sh` 每次构建都会把 `public/icons/icon-512.png` 同步过去：
frontend-dev 更新 `public/icons/` 后直接重新构建即可，无需改 Android 工程。
若要改成矢量/其它素材，替换 `ic_launcher_art.png` 或把两个 XML 的 `foreground` 指向自己的 drawable。

**Q9. 多台服务器怎么管理 / 切换？**
设置 →「服务器」区域可添加/编辑/删除（点条目设为当前，长按编辑或删除）；配置 >1 台时冷启动先进入「选择服务器」页；
工具条「面板」键**长按**可在任意时刻切换。

**Q10. 为什么要用户态装工具链？**
本机没有 passwordless sudo（只有 `panel-smartctl` 白名单），apt 不可用。
`setup-android.sh` 全部解压到 `~/.cache/`，卸载只需 `rm -rf ~/.cache/server-panel-android`。

**Q11. 「30 天免登录」在 App 里为什么还会失效？怎么自救？**
正常切后台/划掉最近任务不会丢：App 在 `onPause` / `onStop` / `onDestroy` 都会 `CookieManager.flush()`。
仍会失效的场景：手动在系统里「清除数据」、WebView 存储被系统清理、cookie 到期、面板重启/更换会话密钥。
登录异常时到「设置 → 清除登录状态」（二次确认）清掉 Cookie 与 localStorage，再重新登录即可。
注意该操作会清除 WebView 的全部 cookie（包括面板以外站点）。

**Q12. 自动更新提示「自动更新不可用」？**
说明当前面板版本还没有 `/api/app/update`（旧版后端）。App 会降级为手动更新：可「打开发布页」或「浏览器下载」。
新版面板已提供该接口（返回 `{version,downloadUrl,size,sha256,notes}`）；实测返回的 size/sha256 与本地 `dist` 中的 APK 一致。

**Q13. 小组件不刷新 / 显示「点击登录」？**
先打开 App 登录面板（cookie 会落盘），小组件由 WorkManager 每 15 分钟刷新一次；系统省电/Doze 可能延后。
显示「点击登录」= cookie 失效或未登录，打开 App 登录后即可恢复。

**Q14. 生物识别解锁打不开 / 开关点不动？**
需要设备已设置锁屏密码或指纹/面容。API 28+ 用系统 BiometricPrompt；Android 8.0/8.1（API 26/27）用锁屏密码验证。
设备没有任何锁屏与生物识别时不允许开启，会提示不可用。

**Q15. 告警通知多久一次？**
WorkManager 周期最小 15 分钟，是「准实时」通知而非推送。首次轮询会把当前未处理告警补发（同 id 只发一次，一次最多 5 条）。
Android 13+ 需要通知权限；设置里关闭开关后不再轮询。

**Q16. 更新包下载后找不到 / 安装没反应？**
更新 APK 下载到 App 私有目录（`Android/data/net.hbmin.serverpanel/files/updates/`）；
下载完成会自动弹系统安装器，需允许本 App「安装未知应用」。若没弹出，授权后再到设置里「检查更新」即可重试。
（该文件也会出现在「下载列表」里，点击同样可触发安装。）

**Q17. App 里 DSH 控制台显示不全怎么办？**
DSH 是桌面型 React 页面，手机屏幕放不下。三种调整方式：
1) 设置 →「DSH 显示」→ 选 70/80/90/100/110/125/150% 预设，或 ±5% 微调（50–200%），或「恢复 100%」；
2) 长按底栏「DSH」按钮循环切换（70→80→90→100→110→125→150→70），当前页立即生效；
3) 打开 DSH 控制台后，右上角有浮动百分比按钮：点按 -10%（50% 后跳到 200%），长按恢复 100%。
缩放值会持久化，杀进程重开仍保持。也可在设置里开关「双指缩放」后用两指捏合。

**Q18. DSH 页面里滚动/按钮位置不对？**
缩放会同时放大整个页面（包括浮动按钮），属预期。若布局仍溢出，先恢复 100% 再用双指缩放；或把设置里「DSH 按钮打开方式」改成「面板 DSH 页」，用面板的响应式 DSH 页（不注入缩放）。

**Q19. 面板 DSH 页里点「打开 DSH 控制台」没反应？**
1.1.1 起已修复：面板页面加载后注入 `window.open → 同窗口跳转` 补丁（含 target=_blank）。
若仍无反应，确认加载的是面板页面（端口 3081/8443），并在设置里把 DSH 打开方式设为「完整控制台」或「面板 DSH 页」后重试。

**Q20. 聊天页怎么用？**
底栏「聊天」→ 首次进入自动加载最近会话（没有则点「新建」）→ 输入消息点「发送」→ 状态行显示「思考中…」及后续阶段，
回答完成后自动刷新消息列表；顶部「会话」切换、长按会话可删除；长按消息可选中复制。接口需要面板后端提供 `/api/dsh/chat/*`
（后端未上线时提示「后端未提供聊天接口」）；发送要求 `/api/session` 已登录且服务端 `dsh.allowTask=true`。

**Q21. 为什么没有预设服务器地址？**
1.2.0 起开源化：App 不内置任何本机地址/主机名。首次打开到「设置 → 添加服务器」输入自己的面板地址（如 `http://<server>:3081`），
之后会出现在「最近使用/服务器列表」里，点选即用。

**Q22. CPU 超线程是怎么标的？**
小组件与设置页从接口读取核心/线程数：有超线程显示 `8C/16T`（设置页「CPU：8 核 16 线程（超线程）」），
无超线程显示 `8C/8T`；优先用 `/api/metrics/latest` 的 `cpu.threads`/`threadsPerCore`，缺字段回退 `/api/system` 的
`cpuCores`/`cpuPhysicalCores`，两者都缺失时只显示 CPU%，不做任何硬编码猜测。

**Q23. 聊天页的「DSH 会话」Tab 怎么用？**
底栏「聊天」→ 顶部切到「DSH 会话」→ 只读列出 `dsh` 真实会话（按工作目录分组，显示模型/消息数/大小/标签）；
点一行进入详情看历史（工具调用可点开看参数/结果）；可续聊的按「继续对话」绑定到面板聊天；Web 会话按「在 DSH 控制台打开」。

**Q24. 为什么有的 DSH 会话不能续聊？**
DSH Web 创建的会话带 `agentPreset`，headless 不能续聊（`POST /api/dsh/chat/sessions` 会返回 400 `dsh_session_not_resumable`）。
App 对这类会话只读展示历史，并提供「在 DSH 控制台打开」入口；没有 preset 的会话才能「继续对话」。

**Q25. 能力面板和模型/工作目录怎么用？**
聊天页「能力」展示 profile、DSH 版本、插件、默认/可选模型、allowTask、historyDecode（header-only 表示服务端缺少 zstd，读不了历史）。
「新建」弹窗可选工作目录（最近 DSH 会话 cwd 自动补全或手输）与模型（来自接口 providers），发送时把 `provider/model` 带给服务端。

**Q26. 「继续对话（SDK）」怎么用？**
在「DSH 会话」Tab 打开一个 **Web 会话**（详情页显示 agent preset）→ 若服务端 `GET /api/dsh/sdk/status` 返回
`available && allowSdkResume` 为 true，详情页出现「继续对话（SDK）」→ 点它带 `force:true` 绑定该 DSH 会话并进入聊天页，
之后消息以 `channel:'sdk'` 发送，可以多轮续聊。能力面板可查看 SDK 状态（profile / presets 数）。

**Q27. 提示「该会话正在 DSH Web 中打开」/「服务端未开启 SDK 续聊」/ provider/preset 缺失？**
- busy_in_web：同一个会话正在 DSH Web 里打开，Headless/SDK 无法并发占用；先在 DSH Web 里关闭该会话再重试。
- sdk_resume_disabled：服务端配置未开启 SDK 续聊（allowSdkResume=false），联系管理员开启。
- provider/preset 缺失：服务端缺少模型 provider 配置，或该会话没有 agent preset，无法走 SDK 通道。

**Q28. 为什么有的 Web 会话仍不能续聊？**
SDK 通道要求：服务端有 `dsh --profile sdk` 能力、`allowSdkResume=true`、会话有 agent preset、且当前没在 DSH Web 中打开。
不满足任一条时 App 只读展示历史，并提供「在 DSH 控制台打开」入口。

**Q29. 打开 DSH 控制台报 `ERR_SSL_PROTOCOL_ERROR`（https://裸IP）怎么办？**
说明服务端返回了 `https://<纯IP>/?token=…` 这类无效地址（DSH Web 在该 IP 上是明文 HTTP）。
1.4.1 起 App 会：① 打开前预检查，https+裸 IP / http+100.64/10 直接降级到「面板 DSH 页」并 toast 提示；
② 若已进入 WebView 才失败，显示专用错误页，可「重新获取地址」/「打开面板 DSH 页」/「复制地址」。
根治：升级服务端（已修复为 `https://*.ts.net` 或局域网 `http://<lan>:3080`）；外网访问请确保能用 tailnet 主机名。
排查：设置 →「DSH 显示」→「控制台地址检测」可看当前 mode 与脱敏地址。

## 9. 已知限制 / 遗留风险

1. **未在真机/模拟器上运行验证**：本机无 Android 设备与 emulator，验收为 `apksigner` / `aapt2` 静态校验，
   真机行为（WebView 版本差异、文件选择器、下载通知、DSH token 跳转、小组件/通知/生物识别）需实机点一遍，见 §10 清单。
2. **图标已复用 frontend-dev 素材**：前景使用 `public/icons/icon-512.png`（构建时自动同步），
   背景为蓝渐变兜底；`icon-maskable-512.png` 与 `icon-192.png` 未单独打包（自适应图标一套即可）。
3. **targetSdk 35 的 edge-to-edge**：已用 `fitsSystemWindows` 避免内容压到状态栏/导航栏；
   个别厂商 ROM 可能仍有细微差异。
4. **工具链版本**：AGP 8.7.3 + Gradle 8.9 + JDK 17 + build-tools 35.0.0 为已验证组合；
   升级 AGP 需同步 Gradle，并重新跑一次构建验证。
5. **明文 HTTP**：应用允许 cleartext（面板当前无 HTTPS）。若后续上 HTTPS/tailscale serve，
   建议把 `network_security_config.xml` 收紧为仅信任系统证书、或改写为 https 预设。
6. **DSH 按钮依赖面板登录态**：Cookie 失效时会提示 401/403（顶部提示条可点击重试），需先在面板重新登录。
7. **接口已按定稿契约联调**：`/api/app/info`（免登录）实测返回 `app=server-panel, version=0.2.0`；
   `/api/dsh/console-url` 未登录返回 401（App 文案提示先登录），登录后返回 `{url, mode}`、失败 502 `dsh_console_unavailable`；真机端到端跳转未验证。
8. **Cookie 持久化覆盖范围**：`flush()` 只保证 WebView cookie 落盘；用户手动「清除数据」、WebView 数据被系统清理或 cookie 到期仍会重新登录；
   设置页「清除登录状态」会删除 WebView 的全部 cookie（含面板以外站点）。
9. **下载页/分享链接由前后端并行开发**：构建时 `server.js` 还没有 `/d/<token>` 路由、`public/` 还没有 `?page=download` 页面；
   App 端按钮与 `DownloadListener` 已就绪（对任意 http(s) + `Content-Disposition` 通用，文件名解析已覆盖 `filename*=`），
   后端/前端上线后无需改 App，但需真机点一次确认下载链路。
10. **自动更新接口已上线**：`GET /api/app/update` 实测返回 1.2.0 的 size/sha256（与本地 APK 一致），`/app/latest.apk` 可下载；
    App 端「检查更新 → 下载 → FileProvider 拉起安装器」仍需真机验证（见 §10 第 4 项）。
11. **生物识别未实机验证**：API 28+ 走平台 `BiometricPrompt`，26/27 或仅有锁屏密码时走 `KeyguardManager` 兜底；
    无锁屏/生物识别的设备不允许开启开关。
12. **小组件刷新受系统调度影响**：WorkManager 周期下限 15 分钟，Doze/厂商省电策略可能进一步延后。
13. **告警通知为轮询**：15 分钟一次、非实时；首次轮询会对当前未处理告警补发通知（按 id 去重，一次最多 5 条）。
14. **多服务器选择页**：配置 >1 台服务器时每次冷启动先进入选择页（当前高亮）；工具条「面板」长按可随时切换。
15. **DSH 缩放/注入未实机验证**：`documentElement.style.zoom`、浮动按钮、`window.open` 补丁均通过 `evaluateJavascript` 注入，
    静态校验只能确认脚本已打包（DEX 中可见），实际渲染效果、注入时机（onPageFinished/doUpdateVisitedHistory）与 React 页面兼容性需真机确认；
    缩放对 DSH 页面整体生效（浮动按钮也会被缩放）。
16. **原生聊天页依赖后端 `/api/dsh/chat/*`**：后端代码已就绪（`server.js` 路由 + `lib/chat.js`），但**运行中的面板进程尚未重启**，
    实测 `/api/dsh/chat/sessions` 仍返回 404；重启服务后 App 无需改动即可用。SSE 解析与状态机已用 JDK 单测覆盖（36 例），
    会话/发送/SSE 链路仍需真机联调。
17. **CPU 规格字段兼容**：`/api/metrics/latest` 已提供 `cpu.threads` / `cpu.physicalCores` / `cpu.threadsPerCore` / `cpu.smt`，
     App 优先使用；缺字段时回退 `/api/system` 的 `cpuPhysicalCores`/`cpuCores`（另有 `cpuThreadsPerCore`），
     两者都缺失时小组件只显示 CPU%（不猜测、不硬编码）。
18. **DSH 能力/历史接口未上线**：构建时 `GET /api/dsh/capabilities`、`GET /api/dsh/sessions/:id/messages` 实测 404
     （后端并行实现中），App 已按契约实现并降级提示；`/api/dsh/sessions` 当前仍返回旧字段，App 做兼容
     （无 `resumable` 时按「无 preset 可续聊」展示，真正绑定失败会提示）。
19. **绑定 DSH 会话 / 指定 cwd 依赖后端更新**：`POST /api/dsh/chat/sessions` 目前只接受 `title`，后端补齐
     `cwd`/`dshSessionId`/`force` 后「继续对话（SDK）」与新建 cwd 才真正生效；模型与 channel 参数同理需后端支持 `{text,model,channel}`。
20. **SDK 接口未上线**：构建时 `GET /api/dsh/sdk/status` 实测 404（后端 task-26 实现中），App 已按契约实现并降级
     （详情页保留「headless 无法续聊」+ 原因；能力面板显示「未知/不可用」）。
21. **SDK 通道未实机验证**：`channel:'sdk'` 发送、`assistant/message`/`tool/call`/`turn/end` 事件映射、
     busy_in_web 等错误提示均只做静态校验 + JDK 单测；需后端上线后真机联调（见 §10）。
22. **SSL 兜底未实机复现**：错误页触发（onReceivedSslError/onReceivedError）、自动重试 1 次、剪贴板脱敏
     需真机/外网环境验证；预检查只覆盖 https+裸 IP 与 http+100.64/10，其它异常地址交由 WebView 错误页。
23. **「复制地址」复制的是脱敏 URL**（token 替换为 ***），避免 token 泄漏到剪贴板/日志。

## 10. 真机验证清单（本机无设备，待实机执行）

按顺序执行并确认（静态校验只能证明包结构/签名/权限正确，不能证明运行时行为）：

1. **安装与升级**：`adb install -r dist/server-panel-app-1.1.1.apk`；从 1.0.x 覆盖安装应成功（同一签名）
2. **多服务器**：设置 → 添加第二台服务器 → 返回选择页可切换；工具条「面板」长按弹出切换列表并能成功切换
3. **首次启动**：卸载重装 → 出现「选择服务器」页（当前项高亮）→ 选择后进入面板
4. **自动更新**：设置 →「检查更新」→ 后端无 `/api/app/update` 时应弹「自动更新不可用」+「打开发布页」；
   后端上线后应显示版本对比/notes，下载完自动拉起系统安装器（需允许「安装未知应用」）
5. **生物识别**：设置开启 → 冷启动出现锁屏层并弹指纹/面容；取消后停在锁屏、点「解锁」可重试；
   后台 >60 秒回来重新要求解锁；无锁屏设备开关应被拒绝并提示
6. **小组件**：桌面长按 → 小部件 →「服务器状态」；登录后 15 分钟内显示 CPU/内存/温度/负载；点击打开 App；
   清 cookie/退出登录后显示「点击登录」
7. **下载列表**：设置 →「下载列表」；从面板下载一个文件，列表显示进度/状态/大小，点击能打开、长按可删除
8. **告警通知**：面板产生未处理告警后 15 分钟内收到本地通知；点击进入 `?page=alerts`；关闭开关后不再通知；
   Android 13+ 首次开启会请求通知权限
9. **DSH 缩放**：打开 DSH 控制台 → 右上角出现「100%」浮动按钮 → 点按变小（50% 后跳 200%）→ 长按恢复 100%；
   长按底栏「DSH」循环 70→80→90→100→110→125→150→70 并 toast；设置页改缩放/双指缩放/打开方式后返回仍生效；
   杀进程重开后缩放值保持；面板 DSH 页点「打开 DSH 控制台」能在同窗口打开
10. **原生聊天页**：底栏「聊天」→ 新建会话 → 发消息 → 看到「思考中…」/阶段状态 → 收到回答 → 退出重进看到历史 → 删除会话；
    未登录/403/409/后端 404 时有可读提示
11. **CPU 超线程标注**：小组件 CPU 行显示 `8C/16T`（或 `8C/8T`）；设置页显示「CPU：8 核 16 线程（超线程）」；
    面板不可达时不显示该行；接口缺字段时小组件只显示 CPU%
12. **DSH 会话 Tab**：聊天页切「DSH 会话」→ 按工作目录分组展示 → 打开某会话看历史（tool 行点开看参数/结果）
13. **续聊 / 控制台**：可续聊会话「继续对话」→ 能多轮发消息；Web 会话显示提示 +「在 DSH 控制台打开」能跳浏览器
14. **能力与新建**：能力面板显示 profile/版本/插件/模型/allowTask/historyDecode；新建聊天可选 cwd 与模型并发送成功
15. **SDK 高级续聊**：打开 Web 会话（有 preset）→ 若 SDK 可用出现「继续对话（SDK）」→ 绑定后发消息 → 助手/工具/结束事件正常 →
    在 DSH Web 打开该会话时发消息应提示 busy_in_web；关掉 Web 会话后可正常续聊
16. **DSH SSL 兜底**：外网/tailnet 下点「DSH」→ 若服务端返回 https 裸 IP 或 http CGNAT 应直接降级到面板 DSH 页并 toast；
    人为构造 SSL 失败时出现「DSH 控制台打不开」错误页，三个按钮可用、URL 的 token 显示为 `***`；「控制台地址检测」显示 mode 与脱敏地址
17. **回归**：应用聊天、DSH 按钮、面板下载页、清除登录状态、返回键/长按刷新、WebView 文件选择器、明文 http 仍正常
