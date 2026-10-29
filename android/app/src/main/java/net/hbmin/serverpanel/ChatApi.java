package net.hbmin.serverpanel;

import android.content.Context;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * 原生聊天页的 HTTP 客户端：复用 WebView Cookie，POST/DELETE 带 X-CSRF-Token，
 * SSE 事件流用 HttpURLConnection 流式读取。
 */
final class ChatApi {

    static final class ChatException extends Exception {
        final int code;
        final String body;

        ChatException(int code, String body) {
            super("HTTP " + code);
            this.code = code;
            this.body = body == null ? "" : body;
        }
    }

    interface StreamListener {
        void onSseEvent(String type, String text);

        boolean cancelled();
    }

    private ChatApi() {
    }

    /** GET /api/session 取 csrf；未登录抛 401。 */
    static String fetchCsrf(Context context, String base) throws Exception {
        HttpURLConnection conn = open(base + "/api/session", "GET", null, null);
        try {
            int code = conn.getResponseCode();
            String body = readBody(conn);
            if (code != 200) throw new ChatException(code, body);
            JSONObject json = new JSONObject(body);
            if (!json.optBoolean("authenticated", false)) {
                throw new ChatException(401, body);
            }
            return json.optString("csrf", "");
        } finally {
            conn.disconnect();
        }
    }

    static JSONObject getJson(String base, String path) throws Exception {
        HttpURLConnection conn = open(base + path, "GET", null, null);
        try {
            int code = conn.getResponseCode();
            String body = readBody(conn);
            if (code != 200) throw new ChatException(code, body);
            return new JSONObject(body);
        } finally {
            conn.disconnect();
        }
    }

    static JSONObject postJson(String base, String path, JSONObject payload, String csrf) throws Exception {
        byte[] bytes = payload == null ? new byte[0]
                : payload.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection conn = open(base + path, "POST", bytes, csrf);
        try {
            int code = conn.getResponseCode();
            String body = readBody(conn);
            if (code < 200 || code >= 300) throw new ChatException(code, body);
            return body.isEmpty() ? new JSONObject() : new JSONObject(body);
        } finally {
            conn.disconnect();
        }
    }

    static void delete(String base, String path, String csrf) throws Exception {
        HttpURLConnection conn = open(base + path, "DELETE", new byte[0], csrf);
        try {
            int code = conn.getResponseCode();
            String body = readBody(conn);
            if (code < 200 || code >= 300) throw new ChatException(code, body);
        } finally {
            conn.disconnect();
        }
    }

    /** 阻塞读取 SSE 事件流，直到 done/error、流结束或 listener 取消。 */
    static void stream(String base, String taskId, StreamListener listener) throws Exception {
        HttpURLConnection conn = open(base + "/api/dsh/task/stream?id=" + taskId, "GET", null, null);
        conn.setReadTimeout(0);
        try {
            int code = conn.getResponseCode();
            if (code != 200) {
                throw new ChatException(code, readBody(conn));
            }
            SseParser parser = new SseParser();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            char[] buf = new char[1024];
            int read;
            boolean finished = false;
            while (!finished && (read = reader.read(buf)) >= 0) {
                if (listener.cancelled()) break;
                List<String> events = parser.feed(new String(buf, 0, read));
                for (String data : events) {
                    String type = dispatch(data, listener);
                    if ("done".equals(type) || "error".equals(type)) {
                        finished = true;
                        break;
                    }
                }
            }
            if (!finished) {
                for (String data : parser.finish()) {
                    dispatch(data, listener);
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    /** 解析一条 SSE data JSON，回调 listener，返回事件 type。 */
    private static String dispatch(String data, StreamListener listener) {
        String type = "";
        String text = "";
        try {
            JSONObject json = new JSONObject(data);
            type = json.optString("type", "");
            if ("tool/call".equals(type) || "tool_call".equals(type)) {
                String name = json.optString("name", json.optString("tool", ""));
                String args = stringify(json.opt("args"));
                text = (name + (args.isEmpty() ? "" : " " + args)).trim();
            } else {
                text = json.optString("text", json.optString("message",
                        json.optString("line", json.optString("detail", ""))));
            }
        } catch (Exception ignored) {
            // 非 JSON 事件：当 stdout 文本处理
            type = "stdout";
            text = data;
        }
        if (!type.isEmpty()) {
            listener.onSseEvent(type, text);
        }
        return type;
    }


    // ------------------------------------------------------------ DSH 会话目录 / 历史 / 能力

    static JSONObject listDshSessions(String base, int limit, String q, String workspace)
            throws Exception {
        StringBuilder path = new StringBuilder("/api/dsh/sessions?limit=").append(limit);
        if (q != null && !q.isEmpty()) {
            path.append("&q=").append(URLEncoder.encode(q, "UTF-8"));
        }
        if (workspace != null && !workspace.isEmpty()) {
            path.append("&workspace=").append(URLEncoder.encode(workspace, "UTF-8"));
        }
        return getJson(base, path.toString());
    }

    static JSONObject dshMessages(String base, String sessionId, int limit) throws Exception {
        return getJson(base, "/api/dsh/sessions/" + sessionId + "/messages?limit=" + limit);
    }

    static JSONObject capabilities(String base) throws Exception {
        return getJson(base, "/api/dsh/capabilities");
    }

    static JSONObject createChatSession(String base, String csrf, String title, String cwd,
                                        String dshSessionId) throws Exception {
        return createChatSession(base, csrf, title, cwd, dshSessionId, false);
    }

    /** force=true 时绑定 DSH Web 会话（SDK 通道续聊）。 */
    static JSONObject createChatSession(String base, String csrf, String title, String cwd,
                                        String dshSessionId, boolean force) throws Exception {
        JSONObject body = new JSONObject();
        if (title != null && !title.isEmpty()) body.put("title", title);
        if (cwd != null && !cwd.isEmpty()) body.put("cwd", cwd);
        if (dshSessionId != null && !dshSessionId.isEmpty()) body.put("dshSessionId", dshSessionId);
        if (force) body.put("force", true);
        return postJson(base, "/api/dsh/chat/sessions", body, csrf);
    }

    static JSONObject sendChatMessage(String base, String csrf, String chatSessionId,
                                      String text, String model, String channel) throws Exception {
        JSONObject body = new JSONObject();
        body.put("text", text);
        if (model != null && !model.isEmpty()) body.put("model", model);
        if (channel != null && !channel.isEmpty()) body.put("channel", channel);
        return postJson(base, "/api/dsh/chat/sessions/" + chatSessionId + "/messages", body, csrf);
    }

    static JSONObject sdkStatus(String base) throws Exception {
        return getJson(base, "/api/dsh/sdk/status");
    }

    static SdkStatus parseSdkStatus(JSONObject root) {
        SdkStatus status = new SdkStatus();
        status.available = root.optBoolean("available", false);
        status.allowSdkResume = root.optBoolean("allowSdkResume", false);
        status.profile = root.optString("profile", "");
        status.providersPatch = stringify(root.opt("providersPatch"));
        status.reason = root.optString("reason", "");
        JSONArray presets = root.optJSONArray("presets");
        if (presets != null) {
            for (int i = 0; i < presets.length(); i++) {
                Object preset = presets.opt(i);
                String value = preset instanceof JSONObject
                        ? ((JSONObject) preset).optString("name", ((JSONObject) preset).optString("id", ""))
                        : stringify(preset);
                if (!value.isEmpty()) status.presets.add(value);
            }
        }
        return status;
    }

    /** 从错误响应体里取 error code（如 dsh_session_busy_in_web）。 */
    static String errorCode(ChatException e) {
        if (e == null || e.body.isEmpty()) return "";
        try {
            return new JSONObject(e.body).optString("error", "");
        } catch (Exception ignored) {
            return "";
        }
    }

    static String consoleUrl(String base) throws Exception {
        return getJson(base, "/api/dsh/console-url").optString("url", "");
    }

    // ------------------------------------------------------------ JSON → 展示模型

    static List<DshSessionInfo> parseDshSessions(JSONObject root) {
        List<DshSessionInfo> list = new java.util.ArrayList<>();
        JSONArray array = root.optJSONArray("sessions");
        if (array == null) return list;
        for (int i = 0; i < array.length(); i++) {
            JSONObject obj = array.optJSONObject(i);
            if (obj == null) continue;
            DshSessionInfo info = parseDshSession(obj);
            if (!info.id.isEmpty()) list.add(info);
        }
        return list;
    }

    static DshSessionInfo parseDshSession(JSONObject obj) {
        DshSessionInfo info = new DshSessionInfo();
        info.id = obj.optString("id", "");
        info.cwd = obj.optString("cwd", "");
        info.workspace = obj.optString("workspace", "");
        info.title = obj.optString("title", "");
        JSONObject model = obj.optJSONObject("model");
        if (model != null) {
            info.provider = model.optString("provider", "");
            info.model = model.optString("model", "");
        } else {
            info.provider = obj.optString("provider", "");
            info.model = obj.optString("model", "");
        }
        info.messageCount = obj.has("messageCount") ? obj.optInt("messageCount", -1) : -1;
        info.lastMessage = obj.optString("lastMessage", "");
        info.createdAt = obj.optLong("createdAt", 0);
        info.updatedAt = obj.optLong("updatedAt", 0);
        info.sizeBytes = obj.optLong("sizeBytes", 0);
        info.agentPreset = obj.optString("agentPreset", "");
        if (obj.has("resumable")) {
            info.resumable = obj.optBoolean("resumable", false);
        } else {
            // 旧接口没有 resumable 字段：没有 agentPreset 就先按可续聊展示，真正绑定失败时再提示
            info.resumable = info.agentPreset.isEmpty();
        }
        info.historyAvailable = obj.optBoolean("historyAvailable", true);
        return info;
    }

    static List<DshMessage> parseDshMessages(JSONObject root) {
        List<DshMessage> list = new java.util.ArrayList<>();
        JSONArray array = root.optJSONArray("messages");
        if (array == null) return list;
        for (int i = 0; i < array.length(); i++) {
            JSONObject obj = array.optJSONObject(i);
            if (obj == null) continue;
            String role = obj.optString("role", "assistant");
            String text = obj.optString("text", "");
            long ts = obj.optLong("ts", 0);
            String toolName = "";
            String toolArgs = "";
            String toolResult = "";
            JSONObject tool = obj.optJSONObject("tool");
            if (tool != null) {
                toolName = tool.optString("name", tool.optString("tool", ""));
                toolArgs = stringify(tool.opt("args"));
                toolResult = stringify(tool.opt("result"));
            } else {
                toolName = obj.optString("toolName", "");
                toolArgs = stringify(obj.opt("toolArgs"));
                toolResult = stringify(obj.opt("toolResult"));
            }
            list.add(HistoryMapper.map(role, text, ts, toolName, toolArgs, toolResult));
        }
        return list;
    }

    static CapabilitiesText.Data parseCapabilities(JSONObject root) {
        CapabilitiesText.Data data = new CapabilitiesText.Data();
        data.profile = root.optString("profile", "");
        data.dshVersion = root.optString("dshVersion", "");
        data.allowTask = root.optBoolean("allowTask", false);
        data.taskPatches = stringify(root.opt("taskPatches"));
        data.historyDecode = stringify(root.opt("historyDecode"));
        JSONObject defaultModel = root.optJSONObject("defaultModel");
        if (defaultModel != null) {
            data.defaultModel = ModelParam.join(defaultModel.optString("provider", ""),
                    defaultModel.optString("model", ""));
        }
        JSONArray plugins = root.optJSONArray("plugins");
        if (plugins != null) {
            for (int i = 0; i < plugins.length(); i++) {
                JSONObject plugin = plugins.optJSONObject(i);
                if (plugin == null) continue;
                String id = plugin.optString("id", "");
                String name = plugin.optString("name", id);
                if (name.isEmpty()) name = id;
                data.plugins.add(id.isEmpty() || id.equals(name) ? name : name + "（" + id + "）");
            }
        }
        JSONArray providers = root.optJSONArray("providers");
        if (providers != null) {
            for (int i = 0; i < providers.length(); i++) {
                JSONObject provider = providers.optJSONObject(i);
                if (provider == null) continue;
                String providerName = provider.optString("name", "");
                JSONArray models = provider.optJSONArray("models");
                if (models == null) continue;
                for (int j = 0; j < models.length(); j++) {
                    JSONObject model = models.optJSONObject(j);
                    if (model == null) continue;
                    String modelId = model.optString("id", model.optString("name", ""));
                    String value = ModelParam.join(providerName, modelId);
                    if (ModelParam.valid(value) && !data.models.contains(value)) {
                        data.models.add(value);
                    }
                }
            }
        }
        return data;
    }

    static String stringify(Object value) {
        if (value == null) return "";
        if (value instanceof String) return (String) value;
        return String.valueOf(value);
    }

    private static HttpURLConnection open(String url, String method, byte[] body, String csrf)
            throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(15000);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", "application/json, text/event-stream");
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null && !cookie.isEmpty()) {
            conn.setRequestProperty("Cookie", cookie);
        }
        if (csrf != null && !csrf.isEmpty()) {
            conn.setRequestProperty("X-CSRF-Token", csrf);
        }
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body);
            }
        }
        return conn;
    }

    private static String readBody(HttpURLConnection conn) throws Exception {
        int code = conn.getResponseCode();
        InputStream in = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        return Util.readAll(in);
    }
}
