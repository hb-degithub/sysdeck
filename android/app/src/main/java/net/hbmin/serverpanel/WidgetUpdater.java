package net.hbmin.serverpanel;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 把 MetricsWorker 写入的快照渲染到所有小组件实例。 */
final class WidgetUpdater {

    private WidgetUpdater() {
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, MetricsWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        RemoteViews views = build(context);
        for (int id : ids) {
            manager.updateAppWidget(id, views);
        }
    }

    private static RemoteViews build(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_metrics);
        SharedPreferences prefs = AppPrefs.get(context);

        String serverName = prefs.getString(AppPrefs.KEY_WIDGET_NAME, "");
        if (serverName.isEmpty()) serverName = ServerStore.activeName(context);
        if (serverName.isEmpty()) serverName = context.getString(R.string.widget_server_unknown);
        views.setTextViewText(R.id.widget_server, serverName);

        String state = prefs.getString(AppPrefs.KEY_WIDGET_STATE, "");
        if ("ok".equals(state)) {
            String cpuPct = prefs.getString(AppPrefs.KEY_WIDGET_CPU, "--");
            String cpuSpec = prefs.getString(AppPrefs.KEY_WIDGET_CPU_SPEC, "");
            views.setTextViewText(R.id.widget_cpu, cpuSpec.isEmpty()
                    ? context.getString(R.string.widget_cpu, cpuPct)
                    : context.getString(R.string.widget_cpu_with_spec, cpuPct, cpuSpec));
            views.setTextViewText(R.id.widget_mem,
                    context.getString(R.string.widget_mem, prefs.getString(AppPrefs.KEY_WIDGET_MEM, "--")));
            views.setTextViewText(R.id.widget_temp,
                    context.getString(R.string.widget_temp, prefs.getString(AppPrefs.KEY_WIDGET_TEMP, "--")));
            views.setTextViewText(R.id.widget_load,
                    context.getString(R.string.widget_load, prefs.getString(AppPrefs.KEY_WIDGET_LOAD, "--")));
            long at = prefs.getLong(AppPrefs.KEY_WIDGET_AT, 0);
            views.setTextViewText(R.id.widget_status, at > 0
                    ? context.getString(R.string.widget_updated, time(at))
                    : context.getString(R.string.widget_no_data));
        } else if ("unauthorized".equals(state)) {
            views.setTextViewText(R.id.widget_cpu, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_mem, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_temp, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_load, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_status, context.getString(R.string.widget_need_login));
        } else {
            views.setTextViewText(R.id.widget_cpu, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_mem, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_temp, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_load, context.getString(R.string.widget_placeholder));
            views.setTextViewText(R.id.widget_status, context.getString(R.string.widget_no_data));
        }

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        return views;
    }

    private static String time(long millis) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(millis));
    }
}
