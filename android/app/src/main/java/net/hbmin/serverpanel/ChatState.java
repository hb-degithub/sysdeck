package net.hbmin.serverpanel;

/**
 * 聊天运行状态机（纯逻辑，可 JDK 单测）。
 * 事件来源：SSE 的 type = start | event | status | stdout | stderr | done | error。
 */
final class ChatState {

    enum Phase { IDLE, RUNNING, DONE, ERROR }

    private Phase phase = Phase.IDLE;
    private String status = "";
    private String error = "";

    void reset() {
        phase = Phase.IDLE;
        status = "";
        error = "";
    }

    void start() {
        phase = Phase.RUNNING;
        status = "思考中…";
        error = "";
    }

    void onEventType(String type, String text) {
        if (type == null) return;
        switch (type) {
            case "start":
                phase = Phase.RUNNING;
                status = (text == null || text.isEmpty()) ? "思考中…" : text;
                break;
            case "event":
            case "status":
                if (text != null && !text.isEmpty()) status = text;
                break;
            case "stdout":
                if (text != null && !text.isEmpty()) status = text;
                break;
            case "stderr":
                if (text != null && !text.isEmpty()) status = "stderr: " + text;
                break;
            case "done":
                phase = Phase.DONE;
                status = "已完成";
                break;
            case "error":
                phase = Phase.ERROR;
                error = (text == null || text.isEmpty()) ? "出错了" : text;
                status = error;
                break;
            default:
                break;
        }
    }

    void fail(String message) {
        phase = Phase.ERROR;
        error = (message == null || message.isEmpty()) ? "出错了" : message;
        status = error;
    }

    Phase phase() {
        return phase;
    }

    String status() {
        return status;
    }

    String error() {
        return error;
    }

    boolean canSend() {
        return phase != Phase.RUNNING;
    }

    boolean running() {
        return phase == Phase.RUNNING;
    }
}
