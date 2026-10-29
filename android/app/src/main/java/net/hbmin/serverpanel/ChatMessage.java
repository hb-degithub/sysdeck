package net.hbmin.serverpanel;

/** 聊天消息模型（服务端 /api/dsh/chat/sessions/:id 返回）。 */
final class ChatMessage {

    final String role;   // user | assistant | system
    final String text;
    final long ts;
    final String status; // ok | error | running

    ChatMessage(String role, String text, long ts, String status) {
        this.role = role == null ? "assistant" : role;
        this.text = text == null ? "" : text;
        this.ts = ts;
        this.status = status == null ? "ok" : status;
    }

    boolean isUser() {
        return "user".equals(role);
    }
}
