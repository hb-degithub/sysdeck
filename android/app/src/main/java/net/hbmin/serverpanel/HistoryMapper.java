package net.hbmin.serverpanel;

/** 历史消息 → 气泡映射（role/tool 字段归一化，纯逻辑可 JDK 单测）。 */
final class HistoryMapper {

    private static final int PREVIEW_CHARS = 80;

    private HistoryMapper() {
    }

    static int kindOf(String role) {
        if ("user".equals(role)) return DshMessage.KIND_USER;
        if ("tool".equals(role)) return DshMessage.KIND_TOOL;
        return DshMessage.KIND_ASSISTANT;
    }

    static DshMessage map(String role, String text, long ts,
                          String toolName, String toolArgs, String toolResult) {
        DshMessage message = new DshMessage();
        message.kind = kindOf(role);
        message.ts = ts;
        message.toolName = safe(toolName);
        message.toolArgs = safe(toolArgs);
        message.toolResult = safe(toolResult);
        if (message.kind == DshMessage.KIND_TOOL) {
            message.text = message.toolSummary();
        } else {
            message.text = safe(text);
        }
        return message;
    }

    /** 折叠态一行：「工具 read_file · 参数预览…」。 */
    static String toolSummary(String name, String args, String result) {
        StringBuilder sb = new StringBuilder("工具 ");
        sb.append(safe(name).isEmpty() ? "调用" : safe(name));
        String preview = firstLine(safe(args));
        if (preview.isEmpty()) preview = firstLine(safe(result));
        if (!preview.isEmpty()) {
            if (preview.length() > PREVIEW_CHARS) {
                preview = preview.substring(0, PREVIEW_CHARS) + "…";
            }
            sb.append(" · ").append(preview);
        }
        return sb.toString();
    }

    /** 展开态：参数 + 结果（各自截断到 4000 字符，避免超大输出卡 UI）。 */
    static String toolExpandedText(String name, String args, String result) {
        StringBuilder sb = new StringBuilder();
        sb.append("工具：").append(safe(name).isEmpty() ? "调用" : safe(name));
        sb.append("\n\n参数：\n").append(clip(safe(args), 4000));
        sb.append("\n\n结果：\n").append(clip(safe(result), 4000));
        return sb.toString();
    }

    private static String firstLine(String value) {
        int nl = value.indexOf('\n');
        String line = nl >= 0 ? value.substring(0, nl) : value;
        return line.trim();
    }

    private static String clip(String value, int max) {
        if (value.length() <= max) return value;
        return value.substring(0, max) + "\n…（已截断）";
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
