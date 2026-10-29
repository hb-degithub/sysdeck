package net.hbmin.serverpanel;

/** 模型参数 'provider/model' 拼接与展示（纯逻辑可 JDK 单测）。 */
final class ModelParam {

    static final String DEFAULT_LABEL = "默认模型";

    private ModelParam() {
    }

    static String join(String provider, String model) {
        String p = safe(provider);
        String m = safe(model);
        if (p.isEmpty() && m.isEmpty()) return "";
        if (p.isEmpty()) return m;
        if (m.isEmpty()) return p;
        return p + "/" + m;
    }

    static String provider(String value) {
        String v = safe(value);
        int slash = v.indexOf('/');
        return slash < 0 ? v : v.substring(0, slash);
    }

    static String model(String value) {
        String v = safe(value);
        int slash = v.indexOf('/');
        return slash < 0 ? "" : v.substring(slash + 1);
    }

    /** 允许空（= 用服务端默认）；非空时必须是 provider/model 形式。 */
    static boolean valid(String value) {
        String v = safe(value);
        if (v.isEmpty()) return true;
        int slash = v.indexOf('/');
        return slash > 0 && slash < v.length() - 1 && v.indexOf('/', slash + 1) < 0;
    }

    static String display(String value) {
        String v = safe(value);
        return v.isEmpty() ? DEFAULT_LABEL : v;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
