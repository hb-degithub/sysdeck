package net.hbmin.serverpanel;

/**
 * DSH 显示缩放的纯逻辑（无 Android 依赖，可被 JDK 单测直接编译验证）。
 *
 * 规则：
 *  - 长按 DSH 按钮循环：70 → 80 → 90 → 100 → 110 → 125 → 150 → 70
 *  - DSH 页面浮动按钮点按：-10%，低于 50% 时跳到 200%
 *  - 设置页微调：步进 5%，范围 50–200%
 */
final class DshZoomMath {

    static final int DEFAULT = 100;
    static final int MIN = 50;
    static final int MAX = 200;
    static final int STEP = 5;
    static final int[] CYCLE = {70, 80, 90, 100, 110, 125, 150};

    private DshZoomMath() {
    }

    static int clamp(int value) {
        return Math.max(MIN, Math.min(MAX, value));
    }

    /** 长按 DSH 的循环；当前值不在循环档位时取下一个更大的档位。 */
    static int cycleNext(int current) {
        for (int i = 0; i < CYCLE.length; i++) {
            if (CYCLE[i] == current) {
                return CYCLE[(i + 1) % CYCLE.length];
            }
        }
        for (int value : CYCLE) {
            if (value > current) return value;
        }
        return CYCLE[0];
    }

    /** 浮动按钮：每次 -10%，低于 50% 跳回 200%。 */
    static int stepDown(int current) {
        int next = current - 10;
        return next < MIN ? MAX : clamp(next);
    }

    /** 设置页 +：步进 5%，超过 200% 回到 50%。 */
    static int stepUp(int current) {
        int next = current + STEP;
        return next > MAX ? MIN : clamp(next);
    }

    /** 设置页 −：步进 5%，低于 50% 回到 200%。 */
    static int stepDownByStep(int current) {
        int next = current - STEP;
        return next < MIN ? MAX : clamp(next);
    }

    /**
     * 判断是否 DSH 控制台页面：
     *  - 端口 3080；或
     *  - host 以 .ts.net 结尾且 path 为 / 或空（缺省根路径）。
     * 面板页面（3081/8443、内网 IP）返回 false。
     */
    static boolean isDshUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            java.net.URI uri = java.net.URI.create(url);
            String host = uri.getHost();
            int port = uri.getPort();
            String path = uri.getPath() == null ? "" : uri.getPath();
            if (port == 3080) return true;
            if (host != null) {
                String lower = host.toLowerCase(java.util.Locale.ROOT);
                if (lower.endsWith(".ts.net") && (path.isEmpty() || "/".equals(path))) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            // 非法 URL 按面板页面处理
        }
        return false;
    }

    static boolean isPanelUrl(String url) {
        return !isDshUrl(url);
    }
}
