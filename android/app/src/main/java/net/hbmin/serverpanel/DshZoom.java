package net.hbmin.serverpanel;

import android.content.Context;

/** DSH 缩放 / 双指缩放 / DSH 按钮打开方式的偏好读写（默认 100%、双指开、完整控制台）。 */
final class DshZoom {

    static final String MODE_CONSOLE = "console";
    static final String MODE_PANEL = "panel";

    private DshZoom() {
    }

    static int get(Context context) {
        return DshZoomMath.clamp(
                AppPrefs.get(context).getInt(AppPrefs.KEY_DSH_ZOOM, DshZoomMath.DEFAULT));
    }

    static void set(Context context, int value) {
        AppPrefs.get(context).edit()
                .putInt(AppPrefs.KEY_DSH_ZOOM, DshZoomMath.clamp(value)).apply();
    }

    /** 长按 DSH 循环到下一档，返回新值。 */
    static int cycleNext(Context context) {
        int next = DshZoomMath.cycleNext(get(context));
        set(context, next);
        return next;
    }

    /** 浮动按钮点按（-10%，50% 以下跳 200%），返回新值。 */
    static int stepDown(Context context) {
        int next = DshZoomMath.stepDown(get(context));
        set(context, next);
        return next;
    }

    static void reset(Context context) {
        set(context, DshZoomMath.DEFAULT);
    }

    static boolean pinchEnabled(Context context) {
        return AppPrefs.get(context).getBoolean(AppPrefs.KEY_DSH_PINCH, true);
    }

    static void setPinchEnabled(Context context, boolean enabled) {
        AppPrefs.get(context).edit().putBoolean(AppPrefs.KEY_DSH_PINCH, enabled).apply();
    }

    static String openMode(Context context) {
        String mode = AppPrefs.get(context).getString(AppPrefs.KEY_DSH_OPEN_MODE, MODE_CONSOLE);
        return MODE_PANEL.equals(mode) ? MODE_PANEL : MODE_CONSOLE;
    }

    static void setOpenMode(Context context, String mode) {
        String value = MODE_PANEL.equals(mode) ? MODE_PANEL : MODE_CONSOLE;
        AppPrefs.get(context).edit().putString(AppPrefs.KEY_DSH_OPEN_MODE, value).apply();
    }
}
