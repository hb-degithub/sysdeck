package net.hbmin.serverpanel;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;

/**
 * 设置页（v1.1.0）：
 *  - 多服务器（增删改 / 设为当前 / 测试连接）
 *  - 生物识别解锁开关
 *  - 告警本地通知开关
 *  - 检查更新 / 下载列表
 *  - 清除登录状态
 */
public class SettingsActivity extends Activity {

    /** 结果 extra：是否清除了登录状态（MainActivity 收到后重新加载面板走登录）。 */
    public static final String EXTRA_SESSION_CLEARED = "session_cleared";

    private LinearLayout serverContainer;
    private TextView tvCurrent;
    private TextView tvCpuInfo;
    private TextView tvTestResult;
    private TextView tvLockHint;
    private Switch switchLock;
    private Switch switchAlerts;
    private TextView tvDshZoom;
    private LinearLayout dshPresets;
    private Switch switchDshPinch;
    private RadioButton rbDshConsole;
    private RadioButton rbDshPanel;
    private boolean sessionCleared = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.Theme_ServerPanel);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        serverContainer = findViewById(R.id.server_container);
        tvCurrent = findViewById(R.id.tv_current);
        tvCpuInfo = findViewById(R.id.tv_cpu_info);
        tvTestResult = findViewById(R.id.tv_test_result);
        tvLockHint = findViewById(R.id.tv_lock_hint);
        switchLock = findViewById(R.id.switch_lock);
        switchAlerts = findViewById(R.id.switch_alerts);

        findViewById(R.id.btn_add_server).setOnClickListener(v -> showServerDialog(null));
        findViewById(R.id.btn_test).setOnClickListener(v -> testConnection());
        findViewById(R.id.btn_check_update).setOnClickListener(v -> UpdateChecker.check(this, true));
        findViewById(R.id.btn_downloads).setOnClickListener(
                v -> startActivity(new Intent(this, DownloadsActivity.class)));
        findViewById(R.id.btn_dsh_diag).setOnClickListener(v -> checkDshConsoleUrl());
        findViewById(R.id.btn_clear_session).setOnClickListener(v -> confirmClearSession());
        findViewById(R.id.btn_done).setOnClickListener(v -> {
            setResult(RESULT_OK, resultIntent());
            finish();
        });

        switchLock.setChecked(AppPrefs.get(this).getBoolean(AppPrefs.KEY_LOCK_ENABLED, false));
        switchLock.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (isChecked && !deviceHasSecurity()) {
                switchLock.setChecked(false);
                tvLockHint.setVisibility(View.VISIBLE);
                tvLockHint.setText(R.string.biometric_unavailable);
                Toast.makeText(this, R.string.biometric_unavailable, Toast.LENGTH_LONG).show();
                return;
            }
            AppPrefs.get(this).edit().putBoolean(AppPrefs.KEY_LOCK_ENABLED, isChecked).apply();
            tvLockHint.setVisibility(View.GONE);
        });

        switchAlerts.setChecked(AppPrefs.get(this).getBoolean(AppPrefs.KEY_ALERTS_ENABLED, true));
        switchAlerts.setOnCheckedChangeListener((buttonView, isChecked) -> {
            AppPrefs.get(this).edit().putBoolean(AppPrefs.KEY_ALERTS_ENABLED, isChecked).apply();
            if (isChecked) {
                requestNotificationPermissionIfNeeded();
                WorkScheduler.scheduleAlerts(this);
                WorkScheduler.pollAlertsNow(this);
            } else {
                WorkScheduler.cancelAlerts(this);
            }
        });

        // DSH 显示：缩放预设 / ±5% / 恢复 100% / 双指缩放 / 打开方式
        tvDshZoom = findViewById(R.id.tv_dsh_zoom);
        dshPresets = findViewById(R.id.dsh_zoom_presets);
        switchDshPinch = findViewById(R.id.switch_dsh_pinch);
        rbDshConsole = findViewById(R.id.rb_dsh_console);
        rbDshPanel = findViewById(R.id.rb_dsh_panel);

        buildZoomPresets();
        findViewById(R.id.btn_zoom_minus).setOnClickListener(v -> {
            DshZoom.set(this, DshZoomMath.clamp(DshZoom.get(this) - DshZoomMath.STEP));
            renderDshZoom();
        });
        findViewById(R.id.btn_zoom_plus).setOnClickListener(v -> {
            DshZoom.set(this, DshZoomMath.clamp(DshZoom.get(this) + DshZoomMath.STEP));
            renderDshZoom();
        });
        findViewById(R.id.btn_zoom_reset).setOnClickListener(v -> {
            DshZoom.reset(this);
            renderDshZoom();
        });
        switchDshPinch.setOnCheckedChangeListener((buttonView, isChecked) ->
                DshZoom.setPinchEnabled(this, isChecked));
        rbDshConsole.setOnClickListener(v ->
                DshZoom.setOpenMode(this, DshZoom.MODE_CONSOLE));
        rbDshPanel.setOnClickListener(v ->
                DshZoom.setOpenMode(this, DshZoom.MODE_PANEL));
        renderDshZoom();
        fetchCpuInfo();
    }

    @Override
    protected void onResume() {
        super.onResume();
        renderServers();
        renderDshZoom();
        fetchCpuInfo();
    }

    /** 读取 /api/system 的 CPU 规格，显示「CPU：8 核 16 线程（超线程）」；字段缺失则不显示。 */
    private void fetchCpuInfo() {
        final String base = ServerStore.activeUrl(this);
        if (base.isEmpty()) {
            tvCpuInfo.setVisibility(View.GONE);
            return;
        }
        new Thread(() -> {
            String text = null;
            try {
                Api.Response response = Api.get(base + "/api/system", 5000, 6000);
                if (response.ok()) {
                    JSONObject root = new JSONObject(response.body);
                    JSONObject st = root.optJSONObject("static");
                    if (st != null) {
                        CpuSpec spec = CpuSpec.of(st.optInt("cpuPhysicalCores", 0),
                                st.optInt("cpuCores", 0));
                        if (spec != null) {
                            text = getString(spec.hyperThreading()
                                            ? R.string.cpu_info_ht : R.string.cpu_info_no_ht,
                                    spec.physical, spec.threads);
                        }
                    }
                }
            } catch (Exception ignored) {
                // 面板不可达/未登录：不显示 CPU 行
            }
            final String result = text;
            runOnUiThread(() -> {
                if (result == null || result.isEmpty()) {
                    tvCpuInfo.setVisibility(View.GONE);
                } else {
                    tvCpuInfo.setText(result);
                    tvCpuInfo.setVisibility(View.VISIBLE);
                }
            });
        }, "cpu-info").start();
    }

    // ------------------------------------------------------------ DSH 显示

    private void buildZoomPresets() {
        dshPresets.removeAllViews();
        for (int value : DshZoomMath.CYCLE) {
            Button button = new Button(this);
            button.setText(getString(R.string.dsh_zoom_preset, value));
            button.setTextSize(13);
            button.setAllCaps(false);
            button.setTextColor(getColor(R.color.text_primary));
            button.setBackgroundResource(R.drawable.banner_bg);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, dp(38));
            params.rightMargin = dp(6);
            button.setLayoutParams(params);
            button.setOnClickListener(v -> {
                DshZoom.set(this, value);
                renderDshZoom();
            });
            dshPresets.addView(button);
        }
    }

    private void renderDshZoom() {
        int zoom = DshZoom.get(this);
        tvDshZoom.setText(getString(R.string.dsh_zoom_current, zoom));
        switchDshPinch.setChecked(DshZoom.pinchEnabled(this));
        boolean console = DshZoom.MODE_CONSOLE.equals(DshZoom.openMode(this));
        rbDshConsole.setChecked(console);
        rbDshPanel.setChecked(!console);
        for (int i = 0; i < dshPresets.getChildCount(); i++) {
            View child = dshPresets.getChildAt(i);
            if (child instanceof Button) {
                child.setAlpha(DshZoomMath.CYCLE[i] == zoom ? 1f : 0.6f);
            }
        }
    }

    // ------------------------------------------------------------ 服务器列表

    private void renderServers() {
        List<ServerStore.Item> servers = ServerStore.load(this);
        String active = ServerStore.activeUrl(this);
        serverContainer.removeAllViews();
        for (ServerStore.Item server : servers) {
            serverContainer.addView(buildServerRow(server, server.url.equals(active)));
        }
        tvCurrent.setText(getString(R.string.current_server,
                active.isEmpty() ? getString(R.string.not_configured) : active));
    }

    private View buildServerRow(ServerStore.Item server, boolean active) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.banner_bg);
        row.setPadding(dp(14), dp(12), dp(14), dp(12));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        row.setLayoutParams(params);
        row.setClickable(true);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = new TextView(this);
        name.setText(server.name);
        name.setTextColor(getColor(R.color.text_primary));
        name.setTextSize(15);
        name.setTypeface(name.getTypeface(), android.graphics.Typeface.BOLD);
        name.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        head.addView(name);
        if (active) {
            TextView badge = new TextView(this);
            badge.setText(R.string.server_current_badge);
            badge.setTextColor(getColor(R.color.accent));
            badge.setTextSize(11);
            head.addView(badge);
        }
        row.addView(head);

        TextView url = new TextView(this);
        url.setText(server.url);
        url.setTextColor(getColor(R.color.text_secondary));
        url.setTextSize(12);
        url.setPadding(0, dp(3), 0, 0);
        row.addView(url);

        row.setOnClickListener(v -> {
            ServerStore.setActive(this, server.url);
            renderServers();
            Toast.makeText(this, R.string.server_saved, Toast.LENGTH_SHORT).show();
        });
        row.setOnLongClickListener(v -> {
            showServerActions(server);
            return true;
        });
        return row;
    }

    private void showServerDialog(final ServerStore.Item edit) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), dp(8));
        final EditText nameInput = new EditText(this);
        nameInput.setHint(R.string.hint_server_name);
        nameInput.setSingleLine(true);
        if (edit != null) nameInput.setText(edit.name);
        final EditText urlInput = new EditText(this);
        urlInput.setHint(R.string.hint_server_url);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        if (edit != null) urlInput.setText(edit.url);
        box.addView(nameInput);
        box.addView(urlInput);

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(edit == null ? R.string.dialog_add_server : R.string.dialog_edit_server)
                .setView(box)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.action_save, null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String url = Util.normalizeBase(urlInput.getText().toString());
                    if (url.isEmpty() || !Util.hasHost(url)) {
                        Toast.makeText(this, R.string.server_invalid, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    String name = nameInput.getText().toString().trim();
                    if (edit == null) {
                        if (!ServerStore.add(this, name, url)) {
                            Toast.makeText(this, R.string.server_exists, Toast.LENGTH_SHORT).show();
                            return;
                        }
                        Toast.makeText(this, R.string.server_added, Toast.LENGTH_SHORT).show();
                    } else {
                        ServerStore.update(this, edit.url, name, url);
                        Toast.makeText(this, R.string.server_saved, Toast.LENGTH_SHORT).show();
                    }
                    dialog.dismiss();
                    renderServers();
                }));
        dialog.show();
    }

    private void showServerActions(final ServerStore.Item server) {
        String[] actions = {getString(R.string.action_edit), getString(R.string.action_delete)};
        new AlertDialog.Builder(this)
                .setTitle(server.name + "\n" + server.url)
                .setItems(actions, (dialog, which) -> {
                    if (which == 0) {
                        showServerDialog(server);
                    } else {
                        confirmDelete(server);
                    }
                })
                .show();
    }

    private void confirmDelete(final ServerStore.Item server) {
        new AlertDialog.Builder(this)
                .setTitle(R.string.action_delete)
                .setMessage(server.name + "\n" + server.url)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.action_delete, (dialog, which) -> {
                    if (!ServerStore.remove(this, server.url)) {
                        Toast.makeText(this, R.string.server_keep_one, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Toast.makeText(this, R.string.server_deleted, Toast.LENGTH_SHORT).show();
                    renderServers();
                })
                .show();
    }

    // ------------------------------------------------------------ 测试连接

    private void testConnection() {
        final String base = ServerStore.activeUrl(this);
        if (base.isEmpty()) {
            Toast.makeText(this, R.string.server_invalid, Toast.LENGTH_SHORT).show();
            return;
        }
        tvTestResult.setTextColor(getColor(R.color.text_secondary));
        tvTestResult.setText("正在测试 " + base + " …");
        new Thread(() -> {
            String msg;
            boolean ok = false;
            try {
                HttpURLConnection conn = (HttpURLConnection)
                        new URL(base + "/api/app/info").openConnection();
                conn.setConnectTimeout(6000);
                conn.setReadTimeout(8000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/json");
                int code = conn.getResponseCode();
                InputStream in = (code >= 200 && code < 300)
                        ? conn.getInputStream() : conn.getErrorStream();
                String body = Util.readAll(in);
                conn.disconnect();
                if (code == 200) {
                    JSONObject json = new JSONObject(body);
                    String app = json.optString("app", "?");
                    String name = json.optString("name", "");
                    String version = json.optString("version", "");
                    if ("server-panel".equals(app)) {
                        ok = true;
                        msg = "✔ 连接成功\n" + name + " " + version + "\n" + base;
                    } else {
                        msg = "⚠ 响应不是服务器面板（app=" + app + "）\n" + base;
                    }
                } else {
                    msg = "✘ HTTP " + code + "\n" + trim(body);
                }
            } catch (Exception e) {
                msg = "✘ 连接失败：" + e.getClass().getSimpleName() + "\n" + e.getMessage();
            }
            final boolean testOk = ok;
            final String result = msg;
            runOnUiThread(() -> {
                tvTestResult.setText(result);
                tvTestResult.setTextColor(getColor(testOk ? R.color.ok : R.color.err));
            });
        }, "panel-test-connection").start();
    }

    // ------------------------------------------------------------ 生物识别 / 通知权限

    private boolean deviceHasSecurity() {
        KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard == null) return false;
        if (keyguard.isDeviceSecure()) return true;
        PackageManager pm = getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT)
                || pm.hasSystemFeature(PackageManager.FEATURE_FACE)
                || pm.hasSystemFeature(PackageManager.FEATURE_IRIS);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 402);
        }
    }

    // ------------------------------------------------------------ 控制台地址检测（诊断）

    private void checkDshConsoleUrl() {
        final String base = ServerStore.activeUrl(this);
        if (base.isEmpty()) {
            Toast.makeText(this, R.string.server_invalid, Toast.LENGTH_SHORT).show();
            return;
        }
        new Thread(() -> {
            String message;
            try {
                Api.Response response = Api.get(base + "/api/dsh/console-url", 6000, 8000);
                if (response.ok()) {
                    JSONObject json = new JSONObject(response.body);
                    String mode = json.optString("mode", "");
                    String rawUrl = json.optString("url", "");
                    message = getString(R.string.dsh_diag_result, mode, DshUrlGuard.maskToken(rawUrl));
                    if (!DshUrlGuard.degradeReason(rawUrl).isEmpty()) {
                        message += "\n⚠ " + getString(R.string.dsh_url_degraded_hint);
                    }
                } else {
                    message = getString(R.string.dsh_diag_failed, "HTTP " + response.code);
                }
            } catch (Exception e) {
                message = getString(R.string.dsh_diag_failed, e.getClass().getSimpleName());
            }
            final String text = message;
            runOnUiThread(() -> new AlertDialog.Builder(this)
                    .setTitle(R.string.dsh_diag_title)
                    .setMessage(text)
                    .setPositiveButton(R.string.action_cancel, null)
                    .show());
        }, "dsh-console-diag").start();
    }

    // ------------------------------------------------------------ 清除登录状态

    private void confirmClearSession() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.clear_session_title)
                .setMessage(R.string.clear_session_message)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.clear_session_confirm,
                        (dialog, which) -> clearLoginState())
                .show();
    }

    private void clearLoginState() {
        final CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(removed -> runOnUiThread(() -> {
            try {
                WebStorage.getInstance().deleteAllData();
            } catch (Exception ignored) {
                // WebStorage 不可用时不影响 cookie 清理
            }
            cookies.flush();
            sessionCleared = true;
            setResult(RESULT_OK, resultIntent());
            Toast.makeText(SettingsActivity.this, R.string.clear_session_done,
                    Toast.LENGTH_LONG).show();
        }));
    }

    private Intent resultIntent() {
        Intent intent = new Intent();
        if (sessionCleared) {
            intent.putExtra(EXTRA_SESSION_CLEARED, true);
        }
        return intent;
    }

    private static String trim(String body) {
        if (body == null) return "";
        String s = body.trim();
        return s.length() > 200 ? s.substring(0, 200) + "…" : s;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
