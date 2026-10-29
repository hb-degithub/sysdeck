package net.hbmin.serverpanel;

/** SDK 续聊相关错误码 → 可读提示（纯逻辑可 JDK 单测）。 */
final class SdkErrors {

    enum Kind {
        BUSY_IN_WEB,
        SDK_RESUME_DISABLED,
        PROVIDER_MISSING,
        PRESET_MISSING,
        SESSION_NOT_RESUMABLE,
        CWD_INVALID,
        UNKNOWN
    }

    private SdkErrors() {
    }

    static Kind kindOf(String code) {
        if (code == null) return Kind.UNKNOWN;
        switch (code) {
            case "dsh_session_busy_in_web":
                return Kind.BUSY_IN_WEB;
            case "busy_in_web":
                return Kind.BUSY_IN_WEB;
            case "sdk_resume_disabled":
                return Kind.SDK_RESUME_DISABLED;
            case "dsh_provider_missing":
                return Kind.PROVIDER_MISSING;
            case "dsh_preset_missing":
                return Kind.PRESET_MISSING;
            case "dsh_session_not_resumable":
                return Kind.SESSION_NOT_RESUMABLE;
            case "cwd_invalid":
                return Kind.CWD_INVALID;
            default:
                return Kind.UNKNOWN;
        }
    }

    /** 具体提示文案；UNKNOWN 返回 null（调用方用通用兜底）。 */
    static String message(Kind kind) {
        switch (kind) {
            case BUSY_IN_WEB:
                return "该会话正在 DSH Web 中打开，请先在 DSH 里关闭后重试";
            case SDK_RESUME_DISABLED:
                return "服务端未开启 SDK 续聊";
            case PROVIDER_MISSING:
                return "服务端缺少模型 provider 配置，SDK 续聊不可用";
            case PRESET_MISSING:
                return "该会话缺少 agent preset，无法用 SDK 续聊";
            case SESSION_NOT_RESUMABLE:
                return "该会话由 DSH Web 创建，headless 无法续聊";
            case CWD_INVALID:
                return "工作目录无效";
            default:
                return null;
        }
    }

    static String messageForCode(String code) {
        return message(kindOf(code));
    }
}
