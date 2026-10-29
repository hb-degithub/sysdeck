package net.hbmin.serverpanel;

import java.net.URI;
import java.util.Locale;

/**
 * DSH 控制台 URL 守卫（纯逻辑可 JDK 单测）：
 *  - 识别 DSH 控制台地址（3080 端口 / *.ts.net 根路径 / 根路径带 token）
 *  - 预检查降级：https://<纯IP>、http://100.64.0.0/10（tailnet CGNAT）
 *  - token 脱敏（错误页 / 日志 / 剪贴板一律替换为 ***）
 */
final class DshUrlGuard {

    private DshUrlGuard() {
    }

    static boolean isIpLiteral(String host) {
        if (host == null || host.isEmpty()) return false;
        String value = host;
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        if (value.contains(":")) return true; // IPv6
        return value.matches("\\d{1,3}(\\.\\d{1,3}){3}");
    }

    /** IPv4 是否在 100.64.0.0/10（tailscale CGNAT 段）。 */
    static boolean isTailnetCgnat(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == 100 && second >= 64 && second <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    static boolean hasTokenQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) return false;
        String lower = rawQuery.toLowerCase(Locale.ROOT);
        return lower.contains("token=");
    }

    /** 是否 DSH 控制台地址（用于决定走专用错误页）。 */
    static boolean isDshConsoleUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
            String host = uri.getHost();
            int port = uri.getPort();
            String path = uri.getPath() == null ? "" : uri.getPath();
            boolean root = path.isEmpty() || "/".equals(path);
            if (port == 3080) return true;
            if (host != null && host.toLowerCase(Locale.ROOT).endsWith(".ts.net") && root) return true;
            return root && hasTokenQuery(uri.getRawQuery());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 需要降级到「面板 DSH 页」的地址：
     *  - https://<纯 IP>（历史服务端 bug 会拼出这种地址，DSH Web 在该 IP 是明文 HTTP）
     *  - http://100.64.0.0/10（tailnet CGNAT 裸 IP）
     *  - 另外 *不* 降级 https://<*.ts.net>
     */
    static boolean shouldDegrade(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost();
            if (host == null || host.isEmpty()) return false;
            if ("https".equals(scheme) && isIpLiteral(host)) return true;
            if ("http".equals(scheme) && isTailnetCgnat(host)) return true;
        } catch (Exception ignored) {
            // 非法 URL：不降级（交给 WebView 报错页）
        }
        return false;
    }

    /** 降级原因：https_ip / http_cgnat / ""。 */
    static String degradeReason(String url) {
        if (url == null || url.isEmpty()) return "";
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost();
            if (host == null) return "";
            if ("https".equals(scheme) && isIpLiteral(host)) return "https_ip";
            if ("http".equals(scheme) && isTailnetCgnat(host)) return "http_cgnat";
        } catch (Exception ignored) {
            // 忽略
        }
        return "";
    }

    /** token 脱敏：所有 token=xxx 一律替换为 token=***。 */
    static String maskToken(String text) {
        if (text == null || text.isEmpty()) return "";
        return text.replaceAll("(?i)token=[^&#\\s]*", "token=***");
    }

    /** 错误描述是否属于 SSL 类（用于错误页文案）。 */
    static boolean isSslErrorText(String description) {
        if (description == null) return false;
        String upper = description.toUpperCase(Locale.ROOT);
        return upper.contains("SSL") || upper.contains("CERT") || upper.contains("TLS");
    }

    /** 错误描述是否属于任务要求兜底的连接类错误。 */
    static boolean isConnectionErrorText(String description) {
        if (description == null) return false;
        String upper = description.toUpperCase(Locale.ROOT);
        return upper.contains("ERR_SSL_PROTOCOL_ERROR") || upper.contains("ERR_SSL_BAD")
                || upper.contains("ERR_CONNECTION_REFUSED") || upper.contains("ERR_ADDRESS_UNREACHABLE")
                || upper.contains("ERR_CONNECTION")
                || isSslErrorText(description);
    }
}
