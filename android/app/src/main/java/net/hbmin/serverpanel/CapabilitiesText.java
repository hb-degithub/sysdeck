package net.hbmin.serverpanel;

import java.util.ArrayList;
import java.util.List;

/** /api/dsh/capabilities → 能力面板文本行（纯逻辑可 JDK 单测）。 */
final class CapabilitiesText {

    static final class Data {
        String profile = "";
        String dshVersion = "";
        boolean allowTask;
        String taskPatches = "";
        String historyDecode = "";
        String defaultModel = "";
        final List<String> plugins = new ArrayList<>();
        final List<String> models = new ArrayList<>();
        boolean sdkStatusKnown;
        boolean sdkAvailable;
        boolean sdkAllowSdkResume;
        String sdkProfile = "";
        String sdkReason = "";
        final List<String> sdkPresets = new ArrayList<>();
    }

    private CapabilitiesText() {
    }

    static List<String> lines(Data data) {
        List<String> out = new ArrayList<>();
        out.add("profile：" + emptyAs(data.profile, "未知"));
        out.add("DSH 版本：" + emptyAs(data.dshVersion, "未知"));
        out.add("allowTask：" + (data.allowTask ? "已开启" : "未开启"));
        if (!data.taskPatches.isEmpty()) {
            out.add("taskPatches：" + data.taskPatches);
        }
        String history = emptyAs(data.historyDecode, "未知");
        if ("header-only".equalsIgnoreCase(data.historyDecode)) {
            history = "header-only（服务端缺少 zstd，无法读取历史）";
        }
        out.add("historyDecode：" + history);
        out.add("默认模型：" + ModelParam.display(data.defaultModel));
        if (data.models.isEmpty()) {
            out.add("可选模型：未知");
        } else {
            out.add("可选模型（" + data.models.size() + "）：" + String.join("，", data.models));
        }
        if (!data.sdkStatusKnown) {
            out.add("SDK 续聊：未知（/api/dsh/sdk/status 未就绪）");
        } else if (data.sdkAvailable && data.sdkAllowSdkResume) {
            StringBuilder sdk = new StringBuilder("SDK 续聊：可用");
            if (!data.sdkProfile.isEmpty()) sdk.append("（profile=").append(data.sdkProfile);
            if (!data.sdkPresets.isEmpty()) sdk.append("，presets=").append(data.sdkPresets.size());
            if (!data.sdkProfile.isEmpty() || !data.sdkPresets.isEmpty()) sdk.append("）");
            out.add(sdk.toString());
        } else {
            String reason = !data.sdkAvailable ? "后端未提供 SDK 续聊"
                    : !data.sdkAllowSdkResume ? "服务端未开启 allowSdkResume"
                    : (data.sdkReason.isEmpty() ? "不可用" : data.sdkReason);
            out.add("SDK 续聊：不可用（" + reason + "）");
        }
        if (data.plugins.isEmpty()) {
            out.add("插件：无");
        } else {
            out.add("插件（" + data.plugins.size() + "）：");
            for (String plugin : data.plugins) {
                out.add("  · " + plugin);
            }
        }
        return out;
    }

    private static String emptyAs(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }
}
