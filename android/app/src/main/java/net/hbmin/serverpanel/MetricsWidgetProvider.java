package net.hbmin.serverpanel;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;

/** 桌面小组件入口：系统事件到来时排一次立即刷新，并确保 15 分钟周期任务在跑。 */
public class MetricsWidgetProvider extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        super.onUpdate(context, appWidgetManager, appWidgetIds);
        WorkScheduler.scheduleMetrics(context);
        WorkScheduler.refreshWidgetNow(context);
        WidgetUpdater.updateAll(context);
    }

    @Override
    public void onEnabled(Context context) {
        super.onEnabled(context);
        WorkScheduler.scheduleMetrics(context);
        WorkScheduler.refreshWidgetNow(context);
    }
}
