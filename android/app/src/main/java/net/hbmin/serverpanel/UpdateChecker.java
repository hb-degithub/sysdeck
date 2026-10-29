package net.hbmin.serverpanel;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.webkit.CookieManager;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;

/**
 * 自动更新：GET <base>/api/app/update（{version, downloadUrl, size, sha256, notes}）。
 * 面板未提供该接口时降级为「手动更新」提示（打开发布页 / 浏览器下载）。
 */
final class UpdateChecker {

    private UpdateChecker() {
    }

    private static final class Info {
        boolean apiAvailable;
        int httpCode;
        String version = "";
        String downloadUrl = "";
        long size;
        String sha256 = "";
        String notes = "";
        String error;
    }

    static String currentVersionName(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    /** @param manual 设置页手动检查（失败会提示）；false 时启动检查，接口缺失静默降级。 */
    static void check(final Activity activity, final boolean manual) {
        final Context ctx = activity.getApplicationContext();
        final String base = ServerStore.activeUrl(ctx);
        if (base.isEmpty()) {
            if (manual) toast(activity, activity.getString(R.string.update_no_server));
            return;
        }
        if (manual) toast(activity, activity.getString(R.string.update_checking));
        new Thread(() -> {
            final Info info = fetch(base);
            activity.runOnUiThread(() -> onResult(activity, base, info, manual));
        }, "update-check").start();
    }

    private static Info fetch(String base) {
        Info info = new Info();
        try {
            Api.Response response = Api.get(base + "/api/app/update", 6000, 8000);
            info.httpCode = response.code;
            if (response.ok()) {
                JSONObject json = new JSONObject(response.body);
                info.apiAvailable = true;
                info.version = json.optString("version", "");
                info.downloadUrl = json.optString("downloadUrl", "");
                info.size = json.optLong("size", 0);
                info.sha256 = json.optString("sha256", "");
                info.notes = json.optString("notes", "");
            }
        } catch (Exception e) {
            info.error = e.getClass().getSimpleName() + ": " + e.getMessage();
        }
        return info;
    }

    private static void onResult(final Activity activity, final String base,
                                 final Info info, boolean manual) {
        if (activity.isFinishing()) return;
        final String current = currentVersionName(activity);

        if (!info.apiAvailable) {
            // 降级：面板没有 /api/app/update（后端未上线或版本旧）
            if (!manual) return;
            new AlertDialog.Builder(activity)
                    .setTitle(R.string.update_unavailable)
                    .setMessage(R.string.update_unavailable_hint)
                    .setPositiveButton(R.string.update_open_release,
                            (dialog, which) -> openInBrowser(activity, base + "/?page=download"))
                    .setNegativeButton(R.string.action_cancel, null)
                    .show();
            return;
        }

        if (compareVersions(info.version, current) <= 0) {
            if (manual) toast(activity, activity.getString(R.string.update_latest, current));
            return;
        }

        StringBuilder message = new StringBuilder();
        message.append("当前版本 ").append(current)
                .append("\n最新版本 ").append(info.version);
        if (!info.notes.isEmpty()) {
            message.append("\n\n").append(info.notes);
        }
        new AlertDialog.Builder(activity)
                .setTitle(R.string.update_available)
                .setMessage(message.toString())
                .setPositiveButton(R.string.update_download,
                        (dialog, which) -> startDownload(activity, base, info))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private static void startDownload(Activity activity, String base, Info info) {
        try {
            String url = info.downloadUrl == null ? "" : info.downloadUrl.trim();
            if (url.isEmpty()) {
                toast(activity, "更新接口未返回 downloadUrl");
                openInBrowser(activity, base + "/?page=download");
                return;
            }
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = base + (url.startsWith("/") ? url : "/" + url);
            }
            String fileName = "server-panel-" + sanitize(info.version) + ".apk";
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }
            request.setTitle("服务器面板 " + info.version);
            request.setDescription("正在下载更新…");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(activity, null, "updates/" + fileName);

            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                toast(activity, "系统下载服务不可用");
                return;
            }
            long id = dm.enqueue(request);
            AppPrefs.get(activity).edit()
                    .putLong(AppPrefs.KEY_UPDATE_DOWNLOAD_ID, id)
                    .putString(AppPrefs.KEY_UPDATE_FILE, fileName)
                    .putString(AppPrefs.KEY_UPDATE_VERSION, info.version)
                    .apply();
            toast(activity, activity.getString(R.string.update_downloading, info.version));
        } catch (Exception e) {
            toast(activity, activity.getString(R.string.update_download_failed,
                    String.valueOf(e.getMessage())));
            openInBrowser(activity, base + "/?page=download");
        }
    }

    /** App 回到前台时调用：更新包下载完 → 通过 FileProvider 打开系统安装器。 */
    static void installIfReady(Activity activity) {
        SharedPreferences prefs = AppPrefs.get(activity);
        long id = prefs.getLong(AppPrefs.KEY_UPDATE_DOWNLOAD_ID, -1);
        if (id <= 0) return;
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        Cursor cursor = dm.query(new DownloadManager.Query().setFilterById(id));
        if (cursor == null) return;
        try {
            if (!cursor.moveToFirst()) return;
            int status = cursor.getInt(
                    cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                String fileName = prefs.getString(AppPrefs.KEY_UPDATE_FILE, "");
                prefs.edit()
                        .remove(AppPrefs.KEY_UPDATE_DOWNLOAD_ID)
                        .remove(AppPrefs.KEY_UPDATE_FILE)
                        .remove(AppPrefs.KEY_UPDATE_VERSION)
                        .apply();
                installApk(activity, fileName);
            } else if (status == DownloadManager.STATUS_FAILED) {
                prefs.edit().remove(AppPrefs.KEY_UPDATE_DOWNLOAD_ID).apply();
                toast(activity, activity.getString(R.string.update_download_failed, "系统下载失败"));
            }
        } finally {
            cursor.close();
        }
    }

    private static void installApk(Activity activity, String fileName) {
        File file = new File(activity.getExternalFilesDir(null), "updates/" + fileName);
        if (fileName == null || fileName.isEmpty() || !file.exists()) {
            toast(activity, activity.getString(R.string.update_install_failed));
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(activity,
                    activity.getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            toast(activity, activity.getString(R.string.update_install_failed));
        }
    }

    /** 浏览器兜底下载（面板下载页 / 手动更新）。 */
    private static void openInBrowser(Activity activity, String url) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast(activity, "没有可用的浏览器");
        }
    }

    /** 语义化版本比较：>0 表示 a 比 b 新。 */
    static int compareVersions(String a, String b) {
        String[] pa = stripV(a).split("[^0-9A-Za-z]+");
        String[] pb = stripV(b).split("[^0-9A-Za-z]+");
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            String x = i < pa.length && !pa[i].isEmpty() ? pa[i] : "0";
            String y = i < pb.length && !pb[i].isEmpty() ? pb[i] : "0";
            boolean xn = x.matches("\\d+");
            boolean yn = y.matches("\\d+");
            int cmp;
            if (xn && yn) {
                cmp = Long.compare(safeLong(x), safeLong(y));
            } else {
                cmp = x.compareToIgnoreCase(y);
            }
            if (cmp != 0) return cmp > 0 ? 1 : -1;
        }
        return 0;
    }

    /** 去掉可能的 v/V 前缀（面板 version 通常不带，但容错）。 */
    private static String stripV(String version) {
        String value = version == null ? "" : version.trim();
        if (value.startsWith("v") || value.startsWith("V")) {
            value = value.substring(1);
        }
        return value.isEmpty() ? "0" : value;
    }

    private static long safeLong(String value) {
        try {
            return Long.parseLong(value);
        } catch (Exception e) {
            return 0;
        }
    }

    private static String sanitize(String version) {
        return version == null ? "update" : version.replaceAll("[^0-9A-Za-z._-]", "_");
    }

    private static void toast(Activity activity, String message) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
    }
}
