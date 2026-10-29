package net.hbmin.serverpanel;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** WorkManager 调度：小组件 15 分钟刷新 + 告警 15 分钟轮询。 */
final class WorkScheduler {

    static final String METRICS_WORK = "metrics-widget-refresh";
    static final String ALERTS_WORK = "alerts-poll";
    private static final String METRICS_NOW = "metrics-widget-now";

    private WorkScheduler() {
    }

    private static Constraints network() {
        return new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
    }

    static void scheduleAll(Context context) {
        scheduleMetrics(context);
        if (AppPrefs.get(context).getBoolean(AppPrefs.KEY_ALERTS_ENABLED, true)) {
            scheduleAlerts(context);
        } else {
            cancelAlerts(context);
        }
    }

    static void scheduleMetrics(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                MetricsWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(network())
                .build();
        WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(METRICS_WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void scheduleAlerts(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                AlertWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(network())
                .build();
        WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(ALERTS_WORK, ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    static void cancelAlerts(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(ALERTS_WORK);
    }

    /** 立即刷新一次小组件数据（添加小组件 / 打开 App 时）。 */
    static void refreshWidgetNow(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(MetricsWorker.class)
                .setConstraints(network())
                .build();
        WorkManager.getInstance(context)
                .enqueueUniqueWork(METRICS_NOW, ExistingWorkPolicy.REPLACE, request);
    }

    /** 立即轮询一次告警（打开 App / 开启开关时）。 */
    static void pollAlertsNow(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AlertWorker.class)
                .setConstraints(network())
                .build();
        WorkManager.getInstance(context)
                .enqueueUniqueWork(ALERTS_WORK + "-now", ExistingWorkPolicy.REPLACE, request);
    }
}
