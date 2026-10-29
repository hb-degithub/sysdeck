package net.hbmin.serverpanel;

/** SSE 事件 → 界面动作映射（SDK 通道新增 assistant/message、tool/call、turn/end；纯逻辑可单测）。 */
final class SseEventMapper {

    enum Kind {
        ASSISTANT_MESSAGE,
        TOOL_CALL,
        TURN_END,
        STATUS,
        IGNORE
    }

    private SseEventMapper() {
    }

    static Kind kindOf(String type) {
        if (type == null || type.isEmpty()) return Kind.IGNORE;
        switch (type) {
            case "assistant/message":
            case "assistant/message/delta":
            case "assistant":
                return Kind.ASSISTANT_MESSAGE;
            case "tool/call":
            case "tool_call":
            case "tool":
                return Kind.TOOL_CALL;
            case "turn/end":
            case "turn_end":
                return Kind.TURN_END;
            case "start":
            case "status":
            case "event":
            case "stdout":
            case "stderr":
            case "done":
            case "error":
                return Kind.STATUS;
            default:
                return Kind.STATUS;
        }
    }

    /** 是否是终止事件（关闭状态机/拉取持久化消息）。 */
    static boolean isTerminal(String type) {
        return "turn/end".equals(type) || "turn_end".equals(type)
                || "done".equals(type) || "error".equals(type);
    }

    /** tool/call 事件的行内文本（用于聊天页工具行）。 */
    static String toolLine(String name, String args) {
        return HistoryMapper.toolSummary(name, args, "");
    }
}
