package net.hbmin.serverpanel;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** 每 15 分钟轮询 /api/alerts?unacked=1，对新告警发本地通知（按告警 id 去重）。 */
public class AlertWorker extends Worker {

    private static final int MAX_SEEN = 200;

    public AlertWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = AppPrefs.get(ctx);
        if (!prefs.getBoolean(AppPrefs.KEY_ALERTS_ENABLED, true)) {
            return Result.success();
        }
        String base = ServerStore.activeUrl(ctx);
        if (base.isEmpty()) {
            return Result.success();
        }
        try {
            Api.Response response = Api.get(base + "/api/alerts?unacked=1", 6000, 8000);
            if (!response.ok()) {
                return Result.success();
            }
            JSONObject root = new JSONObject(response.body);
            JSONArray alerts = root.optJSONArray("alerts");
            if (alerts == null) {
                return Result.success();
            }
            Set<String> seen = readSeen(prefs);
            int posted = 0;
            for (int i = 0; i < alerts.length(); i++) {
                JSONObject alert = alerts.optJSONObject(i);
                if (alert == null) continue;
                if (alert.optBoolean("acknowledged", false)) continue;
                String id = alertId(alert);
                if (id.isEmpty() || seen.contains(id)) continue;
                seen.add(id);
                String message = alert.optString("message", "");
                if (message.isEmpty()) {
                    message = buildMessage(alert);
                }
                String severity = alert.optString("severity", "");
                NotificationHelper.postAlert(ctx, id,
                        ("crit".equals(severity) ? "【严重】" : "") + message);
                posted++;
                if (posted >= 5) break; // 一次最多 5 条，避免刷屏
            }
            if (posted > 0) {
                saveSeen(prefs, seen);
            }
        } catch (Exception ignored) {
            // 网络/解析失败下一次轮询再试
        }
        return Result.success();
    }

    private static String alertId(JSONObject alert) {
        long id = alert.optLong("id", 0);
        if (id > 0) return String.valueOf(id);
        String ts = alert.optString("ts", "");
        String metric = alert.optString("metric", "");
        if (ts.isEmpty() && metric.isEmpty()) return "";
        return (ts + "-" + metric).hashCode() + "";
    }

    private static String buildMessage(JSONObject alert) {
        String metric = alert.optString("metric", "alert");
        String value = alert.optString("value", "?");
        String threshold = alert.optString("threshold", "?");
        return metric + " = " + value + "（阈值 " + threshold + "）";
    }

    private static Set<String> readSeen(SharedPreferences prefs) {
        Set<String> seen = new HashSet<>();
        String raw = prefs.getString(AppPrefs.KEY_ALERT_SEEN, "");
        if (raw == null || raw.isEmpty()) return seen;
        for (String part : raw.split(",")) {
            if (!part.isEmpty()) seen.add(part);
        }
        return seen;
    }

    private static void saveSeen(SharedPreferences prefs, Set<String> seen) {
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (String id : seen) {
            if (count >= MAX_SEEN) break;
            if (sb.length() > 0) sb.append(',');
            sb.append(id);
            count++;
        }
        prefs.edit().putString(AppPrefs.KEY_ALERT_SEEN, sb.toString()).apply();
    }
}
