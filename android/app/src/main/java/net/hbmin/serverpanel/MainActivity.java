package net.hbmin.serverpanel;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.biometrics.BiometricPrompt;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.SslErrorHandler;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executor;

/**
 * 主界面：原生 WebView 壳。
 *
 * 功能（契约 3.2）：
 *  - 首启无地址时进入设置页；主界面加载面板
 *  - JS / DOM storage / 第三方 cookie / file chooser / DownloadManager / 明文 / 混合内容
 *  - 底部工具条：刷新、后退、面板、DSH、设置
 *  - DSH：原生 GET /api/dsh/console-url（带 CookieManager 里的 cookie）后 loadUrl
 *  - 返回键：WebView 可后退则后退；长按刷新
 *  - 加载失败页 + 重试
 */
public class MainActivity extends Activity {

    public static final String PREFS = "server_panel";
    public static final String KEY_BASE_URL = "base_url";
    /** 通知 / 快捷入口带过来的目标页，如 alerts → <base>/?page=alerts。 */
    public static final String EXTRA_PAGE = "page";

    private static final int REQ_SETTINGS = 100;
    private static final int REQ_PICKER = 101;
    private static final int REQ_UNLOCK = 102;
    private static final int REQ_FILE_CHOOSER = 200;
    private static final int REQ_NOTIFICATIONS = 300;
    private static final int REQ_STORAGE = 301;

    private WebView webView;
    private ProgressBar progress;
    private View errorView;
    private TextView errorDetail;
    private View dshErrorView;
    private TextView dshErrorDetail;
    private String lastDshErrorUrl = "";
    private boolean dshAutoRetried = false;
    private boolean dshErrorShowing = false;
    private TextView statusBanner;
    private View lockView;
    private String currentBase = "";
    private String lastFailedUrl = "";
    private boolean pageError = false;
    private boolean backLongPressHandled = false;
    private boolean locked = false;
    private boolean authPrompted = false;
    private boolean updateChecked = false;
    private String pendingPage = "";
    private BroadcastReceiver downloadReceiver;
    private ValueCallback<Uri[]> filePathCallback;
    private String appVersionName = "";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable hideBannerTask = () -> {
        if (statusBanner != null) statusBanner.setVisibility(View.GONE);
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 把清单里的启动主题换成正式主题（启动瞬间仍是 #0d1117 背景）
        setTheme(R.style.Theme_ServerPanel);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        errorView = findViewById(R.id.error_view);
        errorDetail = findViewById(R.id.error_detail);
        statusBanner = findViewById(R.id.status_banner);
        lockView = findViewById(R.id.lock_view);
        dshErrorView = findViewById(R.id.dsh_error_view);
        dshErrorDetail = findViewById(R.id.dsh_error_detail);

        appVersionName = UpdateChecker.currentVersionName(this);

        setupWebView();
        setupToolbar();
        findViewById(R.id.btn_unlock).setOnClickListener(v -> requestAuth());
        findViewById(R.id.btn_dsh_error_retry).setOnClickListener(v -> {
            hideDshError();
            openDsh();
        });
        findViewById(R.id.btn_dsh_error_panel).setOnClickListener(v -> {
            hideDshError();
            if (currentBase.isEmpty()) openSettings();
            else webView.loadUrl(currentBase + "/?page=dsh");
        });
        findViewById(R.id.btn_dsh_error_copy).setOnClickListener(v -> copyDshErrorUrl());

        // 权限：下载完成通知（33+）；旧系统写 Downloads 目录需要存储权限（26-28）
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        REQ_NOTIFICATIONS);
            }
        } else if (Build.VERSION.SDK_INT <= 28) {
            if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                        REQ_STORAGE);
            }
        }

        // 通知渠道 / WorkManager（小组件 + 告警）
        NotificationHelper.ensureChannels(this);
        WorkScheduler.scheduleAll(this);

        // 通知点进来的目标页（如告警页 ?page=alerts）
        if (getIntent() != null && getIntent().getStringExtra(EXTRA_PAGE) != null) {
            pendingPage = getIntent().getStringExtra(EXTRA_PAGE);
        }

        // 生物识别：冷启动先锁（设备没有可用验证方式时 requestAuth 会自动放行）
        if (lockEnabled()) {
            lockNow(false);
        }

        // 多服务器：>1 个时先显示选择页（当前服务器高亮 = 记住上次选择）
        List<ServerStore.Item> servers = ServerStore.load(this);
        if (servers.size() > 1 && savedInstanceState == null) {
            startActivityForResult(new Intent(this, ServerPickerActivity.class), REQ_PICKER);
        } else {
            String active = ServerStore.activeUrl(this);
            if (active.isEmpty()) {
                webView.setVisibility(View.INVISIBLE);
                openSettings();
            } else {
                loadBase(active);
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 双指缩放跟随「DSH 显示」设置（默认开）
        boolean pinch = DshZoom.pinchEnabled(this);
        s.setSupportZoom(pinch);
        s.setBuiltInZoomControls(pinch);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setGeolocationEnabled(false);

        // 可选 UA 后缀，便于面板侧识别 App
        String ua = s.getUserAgentString();
        if (ua != null && !ua.contains("ServerPanelApp/")) {
            s.setUserAgentString(ua + " ServerPanelApp/" + appVersionName);
        }
        // DSH 页面右上角浮动缩放按钮的 JS 桥
        webView.addJavascriptInterface(new DshBridge(), "PanelAndroid");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setBackgroundColor(0xFF0D1117);
        webView.setWebViewClient(new PanelWebViewClient());
        webView.setWebChromeClient(new PanelWebChromeClient());
        webView.setDownloadListener(new PanelDownloadListener());

        // 调试构建下可用 chrome://inspect 审核页面（release 关闭）
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
    }

    private void setupToolbar() {
        View refresh = findViewById(R.id.btn_refresh);
        refresh.setOnClickListener(v -> {
            hideError();
            if (webView.getUrl() == null) {
                loadBase(currentBase);
            } else {
                webView.reload();
            }
        });
        // 长按刷新按钮 = 强制重新加载
        refresh.setOnLongClickListener(v -> {
            webView.reload();
            toast("已刷新");
            return true;
        });

        findViewById(R.id.btn_back).setOnClickListener(v -> goBack());
        View panelButton = findViewById(R.id.btn_panel);
        panelButton.setOnClickListener(v -> loadBase(currentBase));
        // 长按「面板」= 切换服务器（多服务器管理）
        panelButton.setOnLongClickListener(v -> {
            showServerSwitchDialog();
            return true;
        });
        findViewById(R.id.btn_download).setOnClickListener(v -> openDownloadPage());
        View dshButton = findViewById(R.id.btn_dsh);
        dshButton.setOnClickListener(v -> openDsh());
        // 长按 DSH = 循环切换 DSH 页面缩放（70→80→90→100→110→125→150→70）
        dshButton.setOnLongClickListener(v -> {
            int zoom = DshZoom.cycleNext(this);
            applyDshZoomIfNeeded();
            toast(getString(R.string.dsh_zoom_toast, zoom));
            return true;
        });
        findViewById(R.id.btn_chat).setOnClickListener(v -> openChat());
        findViewById(R.id.btn_settings).setOnClickListener(v -> openSettings());
        findViewById(R.id.btn_retry).setOnClickListener(v -> {
            hideError();
            if (!lastFailedUrl.isEmpty()) {
                // 重试刚才失败的页面（可能是 DSH 控制台），而不是固定回面板首页
                webView.loadUrl(lastFailedUrl);
            } else {
                loadBase(currentBase);
            }
        });
    }

    // ------------------------------------------------------------ 页面加载

    private void loadBase(String base) {
        String normalized = Util.normalizeBase(base);
        if (normalized.isEmpty()) {
            openSettings();
            return;
        }
        currentBase = normalized;
        hideError();
        hideBanner();
        hideDshError();
        pageError = false;
        AppPrefs.get(this).edit()
                .putString(AppPrefs.KEY_WIDGET_NAME, ServerStore.activeName(this)).apply();
        webView.setVisibility(View.VISIBLE);
        if (pendingPage != null && !pendingPage.isEmpty()) {
            String page = pendingPage;
            pendingPage = "";
            webView.loadUrl(currentBase + "/?page=" + page);
        } else {
            webView.loadUrl(currentBase);
        }
    }

    private void showError(String detail) {
        pageError = true;
        progress.setVisibility(View.GONE);
        errorDetail.setText(detail);
        errorView.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        pageError = false;
        errorView.setVisibility(View.GONE);
    }

    /** 顶部悬浮提示条：可点击执行重试动作；无动作时约 3.5s 自动消失。 */
    private void showBanner(String message, Runnable retryAction) {
        if (statusBanner == null) return;
        ui.removeCallbacks(hideBannerTask);
        statusBanner.setText(message);
        statusBanner.setVisibility(View.VISIBLE);
        if (retryAction != null) {
            statusBanner.setOnClickListener(v -> {
                statusBanner.setVisibility(View.GONE);
                retryAction.run();
            });
            ui.postDelayed(hideBannerTask, 8000);
        } else {
            statusBanner.setOnClickListener(v -> statusBanner.setVisibility(View.GONE));
            ui.postDelayed(hideBannerTask, 3500);
        }
    }

    private void hideBanner() {
        ui.removeCallbacks(hideBannerTask);
        if (statusBanner != null) statusBanner.setVisibility(View.GONE);
    }

    private void goBack() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            toast("已经是第一页");
        }
    }

    /** 底栏「下载」：加载前端下载页 <面板地址>/?page=download（地址可能带/不带尾斜杠或已是 https）。 */
    private void openDownloadPage() {
        if (currentBase.isEmpty()) {
            openSettings();
            return;
        }
        hideError();
        hideBanner();
        webView.loadUrl(currentBase + "/?page=download");
    }

    private void openSettings() {
        startActivityForResult(new Intent(this, SettingsActivity.class), REQ_SETTINGS);
    }

    /** 原生聊天页：不加载 DSH 网页，直接调面板 /api/dsh/chat/*。 */
    private void openChat() {
        if (currentBase.isEmpty()) {
            toast(getString(R.string.update_no_server));
            openSettings();
            return;
        }
        startActivity(new Intent(this, ChatActivity.class));
    }

    // ------------------------------------------------------------ DSH 控制台错误兜底

    /** 打开 DSH 控制台前的预检查：https+裸 IP / http+100.64/10 → 降级到面板 DSH 页。 */
    private void openDshConsole(String url, String mode) {
        if (url == null || url.isEmpty()) {
            toast("DSH 地址为空，点「DSH」重试");
            showBanner("DSH 返回的地址为空，点此重试", this::openDsh);
            return;
        }
        String reason = DshUrlGuard.degradeReason(url);
        if (DshUrlGuard.shouldDegrade(url)) {
            String masked = DshUrlGuard.maskToken(url);
            toast(getString(R.string.dsh_url_degraded, masked));
            showBanner(getString(R.string.dsh_url_degraded_hint), null);
            hideError();
            hideDshError();
            webView.loadUrl(currentBase + "/?page=dsh");
            return;
        }
        hideDshError();
        showBanner("已打开 DSH 控制台 · " + modeHint(mode), null);
        webView.loadUrl(url);
    }

    /** DSH 控制台专用错误页：说明 + 脱敏 URL + 重新获取/面板 DSH 页/复制地址。 */
    private void showDshError(String description, String url, boolean ssl) {
        if (dshErrorView == null) return;
        progress.setVisibility(View.GONE);
        errorView.setVisibility(View.GONE);
        hideBanner();
        lastDshErrorUrl = DshUrlGuard.maskToken(url);
        StringBuilder text = new StringBuilder();
        text.append(getString(ssl ? R.string.dsh_ssl_error_hint : R.string.dsh_connect_error_hint));
        text.append("\n\n").append(getString(R.string.dsh_error_url_line, lastDshErrorUrl));
        if (!ssl && description != null && !description.isEmpty()) {
            text.append("\n").append(DshUrlGuard.maskToken(description));
        }
        dshErrorDetail.setText(text.toString());
        dshErrorShowing = true;
        dshErrorView.setVisibility(View.VISIBLE);
        // 自动重新获取一次地址（最多 1 次），仍失败则停在本错误页
        if (!dshAutoRetried) {
            dshAutoRetried = true;
            ui.postDelayed(this::openDsh, 900);
        }
    }

    private void hideDshError() {
        dshErrorShowing = false;
        if (dshErrorView != null) dshErrorView.setVisibility(View.GONE);
    }

    private void copyDshErrorUrl() {
        ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager == null) return;
        manager.setPrimaryClip(ClipData.newPlainText("DSH URL", lastDshErrorUrl));
        toast(getString(R.string.dsh_error_copied));
    }

    // ------------------------------------------------------------ DSH

    private void openDsh() {
        if (currentBase.isEmpty()) {
            openSettings();
            return;
        }
        // 「面板 DSH 页」模式：直接打开面板内的 DSH 控制页（不请求 console-url）
        if (DshZoom.MODE_PANEL.equals(DshZoom.openMode(this))) {
            hideError();
            hideBanner();
            webView.loadUrl(currentBase + "/?page=dsh");
            return;
        }
        final String base = currentBase;
        // 复用面板登录态：cookie 在主线程从 CookieManager 取，原生请求带上
        final String cookie = CookieManager.getInstance().getCookie(base);
        toast("正在获取 DSH 控制台地址…");
        new Thread(() -> {
            int code;
            String body;
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(base + "/api/dsh/console-url").openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/json");
                if (cookie != null && !cookie.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookie);
                }
                code = conn.getResponseCode();
                InputStream in = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
                body = Util.readAll(in);
                conn.disconnect();
            } catch (Exception e) {
                final String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
                ui.post(() -> toast("获取 DSH 地址失败：" + msg));
                return;
            }

            final int resultCode = code;
            final String resultBody = body;
            ui.post(() -> {
                if (resultCode == 200) {
                    try {
                        JSONObject json = new JSONObject(resultBody);
                        // 契约 1.3：url 直接透传给 WebView（不自己拼 token / 改 host）
                        String url = json.optString("url", "");
                        String mode = json.optString("mode", "");
                        if (url.isEmpty()) {
                            toast("DSH 地址为空，点「DSH」重试");
                            showBanner("DSH 返回的地址为空，点此重试", this::openDsh);
                            return;
                        }
                        openDshConsole(url, mode);
                    } catch (Exception e) {
                        toast("解析 DSH 响应失败：" + e.getMessage());
                        showBanner("DSH 响应解析失败，点此重试", this::openDsh);
                    }
                } else if (resultCode == 401 || resultCode == 403) {
                    toast("请先在面板登录，再点「DSH」重试（HTTP " + resultCode + "）");
                    showBanner("需要在面板里登录后才能打开 DSH，点此重试", this::openDsh);
                } else if (resultCode == 502) {
                    String detail = extractDetail(resultBody);
                    toast("DSH 未运行：" + detail + "（点「DSH」重试）");
                    showBanner("DSH 未运行：" + detail + "\n点此重试", this::openDsh);
                } else {
                    String detail = extractDetail(resultBody);
                    toast("DSH 打开失败（HTTP " + resultCode + "）：" + detail);
                    showBanner("DSH 打开失败（HTTP " + resultCode + "）\n点此重试", this::openDsh);
                }
            });
        }, "dsh-console-url").start();
    }

    /** mode 只用于文案提示：lan=局域网直连，public=tailnet/公网，custom=自定义配置。 */
    private static String modeHint(String mode) {
        if ("lan".equals(mode)) return "局域网直连";
        if ("public".equals(mode)) return "公网 / Tailnet";
        if ("custom".equals(mode)) return "自定义地址";
        return "DSH 控制台";
    }

    private static String extractDetail(String body) {
        String detail = body;
        try {
            JSONObject json = new JSONObject(body);
            detail = json.optString("detail", json.optString("error", body));
        } catch (Exception ignored) {
            // 非 JSON 响应，原样展示
        }
        if (detail == null) detail = "";
        if (detail.length() > 180) detail = detail.substring(0, 180) + "…";
        return detail;
    }

    // ------------------------------------------------------------ 返回键

    @Override
    public void onBackPressed() {
        if (locked) return; // 锁屏时禁用返回
        if (backLongPressHandled) {
            // 长按已处理为刷新，忽略这次抬起触发的返回
            backLongPressHandled = false;
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            backLongPressHandled = true;
            if (webView != null) {
                webView.reload();
            }
            toast("已刷新");
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    // ------------------------------------------------------------ 文件选择 / 下载

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SETTINGS) {
            String active = ServerStore.activeUrl(this);
            boolean sessionCleared = data != null
                    && data.getBooleanExtra(SettingsActivity.EXTRA_SESSION_CLEARED, false);
            if (active != null && !active.isEmpty() && !active.equals(currentBase)) {
                webView.setVisibility(View.VISIBLE);
                loadBase(active);
            } else if (sessionCleared) {
                // 刚清除了登录态：重新加载面板，走登录流程
                webView.setVisibility(View.VISIBLE);
                loadBase(currentBase);
            }
            return;
        }
        if (requestCode == REQ_PICKER) {
            String active = ServerStore.activeUrl(this);
            if (resultCode == RESULT_OK && data != null
                    && data.getStringExtra(ServerPickerActivity.EXTRA_URL) != null) {
                active = data.getStringExtra(ServerPickerActivity.EXTRA_URL);
            }
            if (active != null && !active.isEmpty()) {
                loadBase(active);
            }
            return;
        }
        if (requestCode == REQ_UNLOCK) {
            if (resultCode == RESULT_OK) {
                unlock();
            } else if (lockEnabled()) {
                toast(getString(R.string.lock_failed));
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 网页里的 <input type="file"> 走系统文件选择器。 */
    private class PanelWebChromeClient extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            if (newProgress < 100) {
                progress.setVisibility(View.VISIBLE);
                progress.setProgress(newProgress);
            } else {
                progress.setVisibility(View.GONE);
            }
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            try {
                Intent intent = params.createIntent();
                startActivityForResult(intent, REQ_FILE_CHOOSER);
                return true;
            } catch (Exception e) {
                filePathCallback = null;
                toast("无法打开文件选择器");
                return false;
            }
        }
    }

    /** 链接点击 / 页面错误处理。 */
    private class PanelWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            pageError = false;
            progress.setVisibility(View.VISIBLE);
            progress.setProgress(5);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
            if (!pageError) {
                errorView.setVisibility(View.GONE);
            }
            // DSH 页面注入缩放 + 浮动按钮；面板页面注入 window.open 同窗跳转补丁
            injectForPage(url);
            if (!dshErrorShowing) hideDshError();
            if (DshUrlGuard.isDshConsoleUrl(url)) dshAutoRetried = false;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (DshZoomMath.isDshUrl(url)) {
                applyDshZoom();          // DSH 页内 SPA 跳转后保持缩放
            } else {
                injectPanelOpenPatch();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request == null || !request.isForMainFrame()) return;
            String desc = error == null ? "" : String.valueOf(error.getDescription());
            String url = request.getUrl() == null ? "" : request.getUrl().toString();
            lastFailedUrl = url;
            if (DshUrlGuard.isDshConsoleUrl(url)) {
                showDshError(desc, url, DshUrlGuard.isSslErrorText(desc));
                return;
            }
            showError("无法连接面板服务器\n" + DshUrlGuard.maskToken(desc)
                    + "\n" + DshUrlGuard.maskToken(url));
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // 绝不忽略证书错误；DSH 控制台给出专用兜底页
            handler.cancel();
            String url = error != null && error.getUrl() != null ? error.getUrl() : view.getUrl();
            if (DshUrlGuard.isDshConsoleUrl(url)) {
                showDshError("SSL 证书/协议错误", url, true);
            } else {
                showError("SSL 错误：无法安全连接\n" + DshUrlGuard.maskToken(url));
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) return false;
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) {
                String target = uri.toString();
                if (DshUrlGuard.isDshConsoleUrl(target) && DshUrlGuard.shouldDegrade(target)) {
                    toast(getString(R.string.dsh_url_degraded, DshUrlGuard.maskToken(target)));
                    if (!currentBase.isEmpty()) {
                        webView.loadUrl(currentBase + "/?page=dsh");
                    }
                    return true;
                }
                return false; // 面板内部链接留在 WebView 里
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // 没有可处理该 scheme 的应用
            }
            return true;
        }
    }

    /** 下载走系统 DownloadManager（保存到公共 Downloads 目录）。 */
    private class PanelDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            try {
                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null && !cookie.isEmpty()) {
                    req.addRequestHeader("Cookie", cookie);
                }
                if (userAgent != null && !userAgent.isEmpty()) {
                    req.addRequestHeader("User-Agent", userAgent);
                }
                String fileName = resolveDownloadFileName(url, contentDisposition, mimeType);
                req.setTitle(fileName);
                req.setDescription("服务器面板下载");
                if (mimeType != null && !mimeType.isEmpty()) {
                    req.setMimeType(mimeType);
                }
                req.allowScanningByMediaScanner();
                req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) {
                    toast("系统下载服务不可用");
                    return;
                }
                dm.enqueue(req);
                toast("开始下载：" + fileName);
            } catch (Exception e) {
                toast("下载失败：" + e.getMessage());
            }
        }
    }

    // ------------------------------------------------------------ 下载文件名

    /**
     * 解析下载文件名：优先 Content-Disposition（支持 RFC 5987 `filename*=UTF-8''…`，
     * 面板 /api/files/download 与 /d/<token> 都用这种形式，中文名也能保住）；
     * 其次用 URLUtil 猜；最后兜底。
     */
    private static String resolveDownloadFileName(String url, String contentDisposition,
                                                  String mimeType) {
        String fromHeader = parseContentDispositionFileName(contentDisposition);
        if (fromHeader != null && !fromHeader.isEmpty()) {
            return sanitizeFileName(fromHeader);
        }
        String guessed = URLUtil.guessFileName(url, contentDisposition, mimeType);
        if (guessed == null || guessed.isEmpty()) {
            guessed = "server-panel-download";
        }
        return sanitizeFileName(guessed);
    }

    private static String parseContentDispositionFileName(String header) {
        if (header == null || header.isEmpty()) return null;
        String lower = header.toLowerCase(Locale.ROOT);
        // RFC 5987: filename*=UTF-8''%E4%B8%AD%E6%96%87.txt
        int star = lower.indexOf("filename*=");
        if (star >= 0) {
            String value = stripDispositionValue(header.substring(star + "filename*=".length()));
            int charsetSep = value.indexOf("''");
            if (charsetSep >= 0) {
                value = value.substring(charsetSep + 2);
            }
            value = urlDecode(value);
            if (!value.isEmpty()) return value;
        }
        // 普通 filename="..."
        int plain = lower.indexOf("filename=");
        if (plain >= 0) {
            String value = stripDispositionValue(header.substring(plain + "filename=".length()));
            value = urlDecode(value);
            if (!value.isEmpty()) return value;
        }
        return null;
    }

    private static String stripDispositionValue(String raw) {
        String value = raw.trim();
        int semicolon = value.indexOf(';');
        if (semicolon >= 0) value = value.substring(0, semicolon).trim();
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1);
        }
        return value;
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (Exception ignored) {
            return value;
        }
    }

    private static String sanitizeFileName(String name) {
        String cleaned = name.replace('/', '_').replace('\\', '_').replace(':', '_').trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            return "server-panel-download";
        }
        return cleaned;
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    protected void onResume() {
        super.onResume();
        applyPinchSetting();
        applyDshZoomIfNeeded();
        registerDownloadReceiver();
        UpdateChecker.installIfReady(this);
        if (lockEnabled() && !locked) {
            long last = AppPrefs.get(this).getLong(AppPrefs.KEY_LAST_BACKGROUND_AT, 0);
            if (last > 0 && System.currentTimeMillis() - last > 60_000L) {
                // 后台超过 60 秒回来：重新要求解锁
                lockNow(true);
            }
        }
        if (locked && !authPrompted) {
            // 冷启动已显示锁屏覆盖层，这里自动拉起生物识别/锁屏验证
            authPrompted = true;
            requestAuth();
        }
        if (!updateChecked && !locked) {
            updateChecked = true;
            UpdateChecker.check(this, false);
        }
        if (AppPrefs.get(this).getBoolean(AppPrefs.KEY_ALERTS_ENABLED, true)) {
            WorkScheduler.pollAlertsNow(this);
        }
        WorkScheduler.refreshWidgetNow(this);
    }

    @Override
    protected void onPause() {
        AppPrefs.get(this).edit()
                .putLong(AppPrefs.KEY_LAST_BACKGROUND_AT, System.currentTimeMillis()).apply();
        unregisterDownloadReceiver();
        super.onPause();
        // 退到后台就落盘一次，保证「30 天免登录」cookie 不丢
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onStop() {
        super.onStop();
        // 覆盖 onStop 路径（切后台、最近任务划走前、锁屏等），再 flush 一次
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent == null) return;
        String page = intent.getStringExtra(EXTRA_PAGE);
        if (page != null && !page.isEmpty()) {
            pendingPage = page;
            if (!currentBase.isEmpty()) {
                loadBase(currentBase);
            }
        }
    }

    @Override
    protected void onDestroy() {
        // 进程销毁前最后一道保险
        CookieManager.getInstance().flush();
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ 生物识别锁

    private boolean lockEnabled() {
        return AppPrefs.get(this).getBoolean(AppPrefs.KEY_LOCK_ENABLED, false);
    }

    private void lockNow(boolean prompt) {
        if (lockView == null) return;
        locked = true;
        lockView.setVisibility(View.VISIBLE);
        if (prompt) {
            authPrompted = true;
            requestAuth();
        }
    }

    private void unlock() {
        locked = false;
        authPrompted = false;
        if (lockView != null) lockView.setVisibility(View.GONE);
        // 解锁后再做启动更新检查（避免更新弹窗盖在锁屏上）
        if (!updateChecked) {
            updateChecked = true;
            UpdateChecker.check(this, false);
        }
    }

    /** API 28+ 用平台 BiometricPrompt；26/27 或没有生物识别时用锁屏密码兜底。 */
    private void requestAuth() {
        if (Build.VERSION.SDK_INT >= 28 && hasBiometricFeature()) {
            promptBiometric();
            return;
        }
        KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isDeviceSecure()) {
            Intent intent = keyguard.createConfirmDeviceCredentialIntent(
                    getString(R.string.lock_title), getString(R.string.lock_hint));
            if (intent != null) {
                try {
                    startActivityForResult(intent, REQ_UNLOCK);
                    return;
                } catch (Exception ignored) {
                    // 落到下面的放行分支
                }
            }
        }
        // 设备没有任何可用验证方式：不要把自己锁死
        unlock();
        toast("设备未设置锁屏/生物识别，已跳过解锁");
    }

    private boolean hasBiometricFeature() {
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
                || pm.hasSystemFeature(PackageManager.FEATURE_FACE)
                || pm.hasSystemFeature(PackageManager.FEATURE_IRIS);
    }

    private void promptBiometric() {
        if (Build.VERSION.SDK_INT < 28) return;
        try {
            Executor executor = getMainExecutor();
            BiometricPrompt prompt = new BiometricPrompt.Builder(this)
                    .setTitle(getString(R.string.lock_title))
                    .setSubtitle(getString(R.string.lock_hint))
                    .setNegativeButton(getString(R.string.action_cancel), executor,
                            (dialog, which) -> {
                                // 取消：保持锁定，用户可点「解锁」重试
                            })
                    .build();
            prompt.authenticate(new CancellationSignal(), executor,
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(
                                BiometricPrompt.AuthenticationResult result) {
                            runOnUiThread(MainActivity.this::unlock);
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            // 保持锁定；用户可点「解锁」重试
                        }

                        @Override
                        public void onAuthenticationFailed() {
                            // 单次不匹配：系统会继续尝试
                        }
                    });
        } catch (Exception e) {
            unlock();
        }
    }

    // ------------------------------------------------------------ 服务器切换 / 下载完成广播

    private void showServerSwitchDialog() {
        final List<ServerStore.Item> servers = ServerStore.load(this);
        if (servers.isEmpty()) {
            openSettings();
            return;
        }
        String[] labels = new String[servers.size()];
        for (int i = 0; i < servers.size(); i++) {
            labels[i] = servers.get(i).name + "\n" + servers.get(i).url;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.server_switch_title)
                .setItems(labels, (dialog, which) -> {
                    ServerStore.setActive(this, servers.get(which).url);
                    loadBase(servers.get(which).url);
                })
                .setNegativeButton(R.string.action_cancel, null)
                .show();
    }

    /** 自动更新：下载完成后自动弹出系统安装器（动态注册，进程活着时生效）。 */
    private void registerDownloadReceiver() {
        if (downloadReceiver != null) return;
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null
                        || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                    return;
                }
                UpdateChecker.installIfReady(MainActivity.this);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(downloadReceiver, filter);
            }
        } catch (Exception e) {
            downloadReceiver = null;
        }
    }

    private void unregisterDownloadReceiver() {
        if (downloadReceiver == null) return;
        try {
            unregisterReceiver(downloadReceiver);
        } catch (Exception ignored) {
            // 已注销
        }
        downloadReceiver = null;
    }

    // ------------------------------------------------------------ DSH 显示缩放

    private void applyPinchSetting() {
        if (webView == null) return;
        boolean pinch = DshZoom.pinchEnabled(this);
        WebSettings settings = webView.getSettings();
        settings.setSupportZoom(pinch);
        settings.setBuiltInZoomControls(pinch);
        settings.setDisplayZoomControls(false);
    }

    private void injectForPage(String url) {
        if (webView == null || url == null) return;
        if (DshZoomMath.isDshUrl(url)) {
            applyDshZoom();
        } else {
            injectPanelOpenPatch();
        }
    }

    private void applyDshZoomIfNeeded() {
        if (webView == null) return;
        if (DshZoomMath.isDshUrl(webView.getUrl())) {
            applyDshZoom();
        }
    }

    /** 对当前 DSH 页面重新注入 zoom（evaluateJavascript，不整页刷新）；失败不影响页面。 */
    private void applyDshZoom() {
        if (webView == null) return;
        int zoom = DshZoom.get(this);
        String js;
        try {
            js = String.format(Locale.ROOT, DSH_ZOOM_JS, zoom);
        } catch (Exception e) {
            return;
        }
        webView.evaluateJavascript(js, null);
    }

    /** 面板页面补丁：window.open / target=_blank 改成同窗口跳转。 */
    private void injectPanelOpenPatch() {
        if (webView == null) return;
        webView.evaluateJavascript(PANEL_OPEN_PATCH_JS, null);
    }

    /** JS 桥：DSH 页面右上角浮动按钮（点按 -10%，长按恢复 100%）。 */
    private class DshBridge {
        @JavascriptInterface
        public void zoomStep() {
            runOnUiThread(() -> {
                int zoom = DshZoom.stepDown(MainActivity.this);
                applyDshZoom();
                toast(getString(R.string.dsh_zoom_toast, zoom));
            });
        }

        @JavascriptInterface
        public void zoomReset() {
            runOnUiThread(() -> {
                DshZoom.reset(MainActivity.this);
                applyDshZoom();
                toast(getString(R.string.dsh_zoom_toast, DshZoomMath.DEFAULT));
            });
        }
    }

    /** DSH 页面注入：documentElement.style.zoom 百分比 + 右上角浮动百分比按钮。 */
    private static final String DSH_ZOOM_JS =
            "(function(){try{"
            + "var pct=%d;"
            + "document.documentElement.style.zoom=pct+'%%';"
            + "document.documentElement.style.transformOrigin='0 0';"
            + "var id='__panel_zoom_btn';var b=document.getElementById(id);"
            + "if(!b){b=document.createElement('div');b.id=id;"
            + "b.style.cssText='position:fixed;top:8px;right:8px;z-index:2147483647;padding:6px 10px;"
            + "border-radius:10px;background:rgba(13,17,23,0.85);color:#58A6FF;border:1px solid #30363D;"
            + "font:600 13px/1.2 sans-serif;opacity:0.92;user-select:none;-webkit-user-select:none;';"
            + "var timer=null,longPressed=false;"
            + "function down(){longPressed=false;timer=setTimeout(function(){timer=null;longPressed=true;"
            + "try{PanelAndroid.zoomReset();}catch(e){}},650);}"
            + "function up(e){if(timer){clearTimeout(timer);timer=null;}"
            + "if(!longPressed){try{PanelAndroid.zoomStep();}catch(e){}}"
            + "if(e&&e.preventDefault)e.preventDefault();}"
            + "b.addEventListener('touchstart',down,true);b.addEventListener('touchend',up,true);"
            + "b.addEventListener('mousedown',down,true);b.addEventListener('mouseup',up,true);"
            + "try{(document.body||document.documentElement).appendChild(b);}catch(e){}"
            + "}"
            + "b.textContent=pct+'%%';"
            + "}catch(e){}})()";

    /** 面板页面补丁：window.open 与 target=_blank 改为当前窗口跳转。 */
    private static final String PANEL_OPEN_PATCH_JS =
            "(function(){try{"
            + "if(window.__panelOpenPatched)return;window.__panelOpenPatched=true;"
            + "var _open=window.open;"
            + "window.open=function(u){try{if(typeof u==='string'&&u){window.location.href=u;return window;}"
            + "if(u&&u.toString){window.location.href=u.toString();return window;}}catch(e){}"
            + "return _open? _open.apply(window,arguments):window;};"
            + "document.addEventListener('click',function(e){var t=e.target;"
            + "while(t&&t.tagName!=='A'){t=t.parentNode;}"
            + "if(t&&t.target==='_blank'&&t.href){e.preventDefault();window.location.href=t.href;}},true);"
            + "}catch(e){}})()";

    // ------------------------------------------------------------ 杂项

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}
