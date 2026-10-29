package net.hbmin.serverpanel;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

/** 每 15 分钟拉一次 /api/metrics/latest 写入快照，刷新桌面小组件。 */
public class MetricsWorker extends Worker {

    public MetricsWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        String base = ServerStore.activeUrl(ctx);
        SharedPreferences prefs = AppPrefs.get(ctx);
        if (base.isEmpty()) {
            save(prefs, -1, -1, -1, -1, "no-server", "", null);
            WidgetUpdater.updateAll(ctx);
            return Result.success();
        }
        try {
            Api.Response response = Api.get(base + "/api/metrics/latest", 6000, 8000);
            if (response.ok()) {
                JSONObject root = new JSONObject(response.body);
                JSONObject data = root.optJSONObject("data");
                if (data == null) data = root;
                JSONObject cpu = data.optJSONObject("cpu");
                JSONObject memory = data.optJSONObject("memory");
                JSONObject load = data.optJSONObject("load");
                JSONObject sensors = data.optJSONObject("sensors");
                CpuSpec spec = cpuSpecFromMetrics(cpu);
                if (spec == null) {
                    spec = cpuSpecFromSystem(ctx);
                }
                double cpuPercent = cpu != null ? cpu.optDouble("percent", -1) : -1;
                double memPercent = memory != null ? memory.optDouble("usedPercent", -1) : -1;
                double temp = sensors != null ? sensors.optDouble("cpuTemp", -1) : -1;
                if (temp < 0 && cpu != null) temp = cpu.optDouble("temp", -1);
                double load1 = load != null ? load.optDouble("load1", -1) : -1;
                save(prefs, cpuPercent, memPercent, temp, load1, "ok",
                        ServerStore.activeName(ctx), spec == null ? null : spec.shortLabel());
            } else if (response.code == 401 || response.code == 403) {
                save(prefs, -1, -1, -1, -1, "unauthorized", ServerStore.activeName(ctx), null);
            } else {
                save(prefs, -1, -1, -1, -1, "http-" + response.code,
                        ServerStore.activeName(ctx), null);
            }
        } catch (Exception e) {
            save(prefs, -1, -1, -1, -1, "error", ServerStore.activeName(ctx), null);
        }
        WidgetUpdater.updateAll(ctx);
        return Result.success();
    }

    private static void save(SharedPreferences prefs, double cpu, double mem, double temp,
                             double load, String state, String serverName, String cpuSpec) {
        SharedPreferences.Editor editor = prefs.edit()
                .putString(AppPrefs.KEY_WIDGET_STATE, state)
                .putString(AppPrefs.KEY_WIDGET_CPU, fmt(cpu))
                .putString(AppPrefs.KEY_WIDGET_MEM, fmt(mem))
                .putString(AppPrefs.KEY_WIDGET_TEMP, fmt(temp))
                .putString(AppPrefs.KEY_WIDGET_LOAD, fmt(load))
                .putString(AppPrefs.KEY_WIDGET_NAME, serverName)
                .putLong(AppPrefs.KEY_WIDGET_AT, System.currentTimeMillis());
        if (cpuSpec != null) {
            editor.putString(AppPrefs.KEY_WIDGET_CPU_SPEC, cpuSpec);
        }
        editor.apply();
    }

    /** 从 /api/metrics/latest 的 cpu 对象取规格：threads / threadsPerCore / coreCount / physicalCores。 */
    private static CpuSpec cpuSpecFromMetrics(org.json.JSONObject cpu) {
        if (cpu == null) return null;
        int threads = cpu.optInt("threads", 0);
        if (threads <= 0) threads = cpu.optInt("coreCount", 0);
        if (threads <= 0) {
            org.json.JSONArray perCore = cpu.optJSONArray("perCore");
            if (perCore != null) threads = perCore.length();
        }
        int physical = cpu.optInt("physicalCores", 0);
        int threadsPerCore = cpu.optInt("threadsPerCore", 0);
        CpuSpec spec = CpuSpec.of(physical, threads);
        if (spec == null && threadsPerCore > 0) {
            spec = CpuSpec.fromThreadsPerCore(threads, threadsPerCore);
        }
        return spec;
    }

    /** 指标接口缺字段时回退 /api/system（cpuCores / cpuPhysicalCores）。 */
    private static CpuSpec cpuSpecFromSystem(Context ctx) {
        try {
            Api.Response response = Api.get(ServerStore.activeUrl(ctx) + "/api/system", 5000, 6000);
            if (!response.ok()) return null;
            org.json.JSONObject root = new org.json.JSONObject(response.body);
            org.json.JSONObject st = root.optJSONObject("static");
            if (st == null) return null;
            return CpuSpec.of(st.optInt("cpuPhysicalCores", 0), st.optInt("cpuCores", 0));
        } catch (Exception e) {
            return null;
        }
    }

    private static String fmt(double value) {
        if (value < 0) return "";
        return String.format(java.util.Locale.US, "%.1f", value);
    }
}
