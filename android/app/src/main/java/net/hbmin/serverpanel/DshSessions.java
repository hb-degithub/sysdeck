package net.hbmin.serverpanel;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** DSH 会话分组 / 排序 / 相对时间（纯逻辑，可 JDK 单测）。 */
final class DshSessions {

    static final String UNKNOWN_WORKSPACE = "未知工作目录";

    static final class Group {
        final String workspace;
        final List<DshSessionInfo> sessions = new ArrayList<>();

        Group(String workspace) {
            this.workspace = workspace;
        }

        long newest() {
            long max = Long.MIN_VALUE;
            for (DshSessionInfo session : sessions) {
                if (session.updatedAt > max) max = session.updatedAt;
            }
            return max == Long.MIN_VALUE ? 0 : max;
        }
    }

    private DshSessions() {
    }

    /** cwd 的尾段作为 workspace 组名；根目录/空路径有专门文案。 */
    static String workspaceOf(String cwd) {
        if (cwd == null) return UNKNOWN_WORKSPACE;
        String value = cwd.trim();
        if (value.isEmpty()) return UNKNOWN_WORKSPACE;
        while (value.length() > 1 && value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        if ("/".equals(value)|| "~".equals(value)) return value;
        int slash = value.lastIndexOf('/');
        String tail = slash >= 0 ? value.substring(slash + 1) : value;
        return tail.isEmpty() ? UNKNOWN_WORKSPACE : tail;
    }

    /** 按 workspace 分组；组内按 updatedAt 倒序，组间按组内最新 updatedAt 倒序。 */
    static List<Group> group(List<DshSessionInfo> sessions) {
        List<Group> groups = new ArrayList<>();
        if (sessions == null || sessions.isEmpty()) return groups;
        List<DshSessionInfo> sorted = new ArrayList<>(sessions);
        sorted.sort((a, b) -> Long.compare(b.updatedAt, a.updatedAt));
        Map<String, Group> map = new LinkedHashMap<>();
        for (DshSessionInfo session : sorted) {
            String name = session.workspaceName();
            Group group = map.get(name);
            if (group == null) {
                group = new Group(name);
                map.put(name, group);
                groups.add(group);
            }
            group.sessions.add(session);
        }
        groups.sort((a, b) -> Long.compare(b.newest(), a.newest()));
        return groups;
    }

    /** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
    static String relativeTime(long ts, long now) {
        if (ts <= 0) return "—";
        long diff = now - ts;
        if (diff < 0) diff = 0;
        long minutes = diff / 60_000L;
        if (minutes < 1) return "刚刚";
        if (minutes < 60) return minutes + " 分钟前";
        long hours = minutes / 60;
        if (hours < 24) return hours + " 小时前";
        long days = hours / 24;
        if (days < 30) return days + " 天前";
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(ts));
    }

    /** 会话行副标题：相对时间 · N 条 · provider/model · 大小。 */
    static String rowMeta(DshSessionInfo session, long now) {
        StringBuilder sb = new StringBuilder();
        sb.append(relativeTime(session.updatedAt, now));
        if (session.messageCount >= 0) {
            sb.append(" · ").append(session.messageCount).append(" 条");
        } else {
            sb.append(" · 消息数未知");
        }
        String model = session.modelLabel();
        if (!model.isEmpty()) sb.append(" · ").append(model);
        if (session.sizeBytes > 0) sb.append(" · ").append(sizeLabel(session.sizeBytes));
        return sb.toString();
    }

    static String sizeLabel(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024L * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0);
    }
}
