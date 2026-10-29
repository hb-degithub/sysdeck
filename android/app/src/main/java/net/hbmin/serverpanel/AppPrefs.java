package net.hbmin.serverpanel;

import android.content.Context;
import android.content.SharedPreferences;

/** SharedPreferences 键与工具（v1.1.0 多服务器 / 解锁 / 告警 / 更新）。 */
final class AppPrefs {

    static final String FILE = "server_panel";

    // 旧版单地址（1.0.x），仅用于迁移
    static final String KEY_LEGACY_BASE_URL = "base_url";

    // 多服务器
    static final String KEY_SERVERS = "servers";           // JSON [{name,url}]
    static final String KEY_ACTIVE_URL = "active_url";

    // 生物识别
    static final String KEY_LOCK_ENABLED = "lock_enabled";
    static final String KEY_LAST_BACKGROUND_AT = "last_background_at";

    // 告警通知
    static final String KEY_ALERTS_ENABLED = "alerts_enabled";
    static final String KEY_ALERT_SEEN = "alert_seen_ids";      // 逗号分隔，最多 200 个

    // 自动更新
    static final String KEY_UPDATE_DOWNLOAD_ID = "update_download_id";
    static final String KEY_UPDATE_FILE = "update_file_name";
    static final String KEY_UPDATE_VERSION = "update_version";

    // DSH 显示
    static final String KEY_DSH_ZOOM = "dsh_zoom";             // 百分比 50..200，默认 100
    static final String KEY_DSH_PINCH = "dsh_pinch";           // 双指缩放，默认 true
    static final String KEY_DSH_OPEN_MODE = "dsh_open_mode";   // console | panel

    // 小组件快照
    static final String KEY_WIDGET_STATE = "widget_state";      // ok / unauthorized / error / http-xxx
    static final String KEY_WIDGET_CPU = "widget_cpu";
    static final String KEY_WIDGET_MEM = "widget_mem";
    static final String KEY_WIDGET_TEMP = "widget_temp";
    static final String KEY_WIDGET_LOAD = "widget_load";
    static final String KEY_WIDGET_AT = "widget_at";
    static final String KEY_WIDGET_NAME = "widget_name";
    static final String KEY_WIDGET_CPU_SPEC = "widget_cpu_spec"; // 如 8C/16T，未知为空

    private AppPrefs() {
    }

    static SharedPreferences get(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
