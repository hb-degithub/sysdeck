package net.hbmin.serverpanel;

/**
 * DSH 真实会话元信息（只读展示）。纯数据模型，无 Android 依赖，可 JDK 单测。
 *
 * 字段来自 GET /api/dsh/sessions（新契约）：
 * {id,cwd,workspace,title,model:{provider,model},messageCount,lastMessage,createdAt,
 *  updatedAt,sizeBytes,agentPreset,resumable,historyAvailable}
 */
final class DshSessionInfo {

    String id = "";
    String cwd = "";
    String workspace = "";
    String title = "";
    String provider = "";
    String model = "";
    int messageCount = -1;
    String lastMessage = "";
    long createdAt;
    long updatedAt;
    long sizeBytes;
    String agentPreset = "";
    boolean resumable;
    boolean historyAvailable = true;

    boolean hasPreset() {
        return agentPreset != null && !agentPreset.isEmpty();
    }

    String workspaceName() {
        if (workspace != null && !workspace.isEmpty()) return workspace;
        return DshSessions.workspaceOf(cwd);
    }

    String displayTitle() {
        if (title != null && !title.isEmpty()) return title;
        String ws = workspaceName();
        String tail = id.length() > 10 ? "…" + id.substring(id.length() - 8) : id;
        return ws.isEmpty() ? tail : ws + " · " + tail;
    }

    String modelLabel() {
        if (provider == null) return model == null ? "" : model;
        if (model == null || model.isEmpty()) return provider;
        return provider + "/" + model;
    }

    /** 可续聊 / Web 会话 / 仅浏览。 */
    String tag() {
        if (hasPreset()) return "Web 会话";
        if (resumable) return "可续聊";
        return "仅浏览";
    }

    boolean canContinue() {
        return resumable && !hasPreset();
    }
}
