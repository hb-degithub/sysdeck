package net.hbmin.serverpanel;

import java.util.ArrayList;
import java.util.List;

/**
 * GET /api/dsh/sdk/status 的结果（SDK 高级续聊能力）。纯逻辑可 JDK 单测。
 * {available, allowSdkResume, profile, presets:[], providersPatch, reason?}
 */
final class SdkStatus {

    boolean available;
    boolean allowSdkResume;
    String profile = "";
    String providersPatch = "";
    String reason = "";
    final List<String> presets = new ArrayList<>();

    static SdkStatus unavailable(String reason) {
        SdkStatus status = new SdkStatus();
        status.reason = reason == null ? "" : reason;
        return status;
    }

    /** Web 会话（带 preset）能否用 SDK 续聊。 */
    boolean canResumeWebSession() {
        return available && allowSdkResume;
    }

    /** 能力面板/详情页展示用一行摘要。 */
    String summary() {
        if (canResumeWebSession()) {
            StringBuilder sb = new StringBuilder("可用");
            if (!profile.isEmpty()) sb.append("（profile=").append(profile);
            if (!presets.isEmpty()) sb.append("，presets=").append(presets.size());
            if (!profile.isEmpty() || !presets.isEmpty()) sb.append("）");
            return sb.toString();
        }
        if (!available) {
            return "不可用" + (reason.isEmpty() ? "（后端未提供 /api/dsh/sdk/status）" : "：" + reason);
        }
        if (!allowSdkResume) {
            return "不可用：服务端未开启 allowSdkResume";
        }
        return "不可用" + (reason.isEmpty() ? "" : "：" + reason);
    }
}
