package net.hbmin.serverpanel;

import android.content.Context;
import android.webkit.CookieManager;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** 极简 HTTP 客户端：GET + 复用 WebView 的 Cookie（面板登录态）。 */
final class Api {

    static final class Response {
        final int code;
        final String body;

        Response(int code, String body) {
            this.code = code;
            this.body = body == null ? "" : body;
        }

        boolean ok() {
            return code >= 200 && code < 300;
        }
    }

    private Api() {
    }

    static String baseUrl(Context context) {
        return ServerStore.activeUrl(context);
    }

    static Response getPath(Context context, String path, int connectMs, int readMs) throws Exception {
        String base = baseUrl(context);
        if (base.isEmpty()) return new Response(0, "");
        return get(base + path, connectMs, readMs);
    }

    static Response get(String url, int connectMs, int readMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setConnectTimeout(connectMs);
            conn.setReadTimeout(readMs);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                conn.setRequestProperty("Cookie", cookie);
            }
            int code = conn.getResponseCode();
            InputStream in = (code >= 200 && code < 300)
                    ? conn.getInputStream() : conn.getErrorStream();
            return new Response(code, Util.readAll(in));
        } finally {
            conn.disconnect();
        }
    }
}
