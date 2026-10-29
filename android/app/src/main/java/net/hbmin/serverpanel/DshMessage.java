package net.hbmin.serverpanel;

/** DSH 会话历史消息（user / assistant / tool），tool 默认折叠，可点击展开。纯逻辑可单测。 */
final class DshMessage {

    static final int KIND_USER = 0;
    static final int KIND_ASSISTANT = 1;
    static final int KIND_TOOL = 2;

    int kind = KIND_ASSISTANT;
    String text = "";
    long ts;
    String toolName = "";
    String toolArgs = "";
    String toolResult = "";
    boolean expanded;

    String toolSummary() {
        return HistoryMapper.toolSummary(toolName, toolArgs, toolResult);
    }

    String toolExpandedText() {
        return HistoryMapper.toolExpandedText(toolName, toolArgs, toolResult);
    }
}
