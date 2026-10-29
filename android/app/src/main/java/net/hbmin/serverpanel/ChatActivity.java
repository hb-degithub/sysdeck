package net.hbmin.serverpanel;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.AutoCompleteTextView;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 聊天页（1.3.0）：
 *  - Tab「应用聊天」：面板 chat 会话，可多轮续聊（SSE）
 *  - Tab「DSH 会话」：只读浏览 DSH 真实会话（按 workspace 分组），点进详情看历史 / 续聊 / 跳控制台
 *  - 「能力」：profile / DSH 版本 / 插件 / 默认与可选模型 / allowTask / historyDecode
 *  - 新建聊天可选工作目录 + 模型（发送时带 model）
 */
public class ChatActivity extends Activity {

    public static final String EXTRA_SESSION_ID = "chat_session_id";
    public static final String EXTRA_CHANNEL = "chat_channel";

    private static final int TAB_APP = 0;
    private static final int TAB_DSH = 1;

    private String base = "";
    private String csrf = "";
    private String sessionId = "";
    private String sessionTitle = "";
    private String currentModel = "";
    private String pendingSessionId = "";
    private String pendingChannel = "";
    private String sessionChannel = ChatChannel.AUTO;

    private int tab = TAB_APP;
    private boolean dshLoaded = false;

    private RecyclerView chatList;
    private RecyclerView dshList;
    private View inputBar;
    private TextView titleView;
    private TextView statusView;
    private TextView tabAppView;
    private TextView tabDshView;
    private EditText input;
    private Button send;

    private ChatAdapter chatAdapter;
    private DshSessionsAdapter dshAdapter;

    private final ChatState state = new ChatState();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final List<SessionItem> sessions = new ArrayList<>();
    private final Set<String> cwdOptions = new LinkedHashSet<>();
    private final List<String> modelOptions = new ArrayList<>();
    private CapabilitiesText.Data capabilities;
    private SdkStatus sdkStatus;
    private boolean sdkStatusLoaded = false;
    private volatile boolean sseCancelled = false;
    private Thread sseThread;

    private static final class SessionItem {
        String id;
        String title;
        long updatedAt;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.Theme_ServerPanel);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_chat);

        base = ServerStore.activeUrl(this);
        if (base.isEmpty()) {
            Toast.makeText(this, R.string.update_no_server, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        pendingSessionId = getIntent() == null ? "" : safe(getIntent().getStringExtra(EXTRA_SESSION_ID));
        pendingChannel = getIntent() == null ? "" : safe(getIntent().getStringExtra(EXTRA_CHANNEL));

        chatList = findViewById(R.id.chat_list);
        dshList = findViewById(R.id.dsh_list);
        inputBar = findViewById(R.id.chat_input_bar);
        titleView = findViewById(R.id.chat_title);
        statusView = findViewById(R.id.chat_status);
        tabAppView = findViewById(R.id.tab_app_chat);
        tabDshView = findViewById(R.id.tab_dsh);
        input = findViewById(R.id.chat_input);
        send = findViewById(R.id.btn_chat_send);

        chatAdapter = new ChatAdapter();
        chatList.setLayoutManager(new LinearLayoutManager(this));
        chatList.setAdapter(chatAdapter);

        dshAdapter = new DshSessionsAdapter(this::openDshSession);
        dshList.setLayoutManager(new LinearLayoutManager(this));
        dshList.setAdapter(dshAdapter);

        findViewById(R.id.btn_chat_caps).setOnClickListener(v -> showCapabilitiesDialog());
        findViewById(R.id.btn_chat_sessions).setOnClickListener(v -> showSessionList());
        findViewById(R.id.btn_chat_new).setOnClickListener(v -> showNewChatDialog());
        findViewById(R.id.btn_chat_delete).setOnClickListener(v -> deleteCurrentSession());
        send.setOnClickListener(v -> sendMessage());
        tabAppView.setOnClickListener(v -> switchTab(TAB_APP));
        tabDshView.setOnClickListener(v -> switchTab(TAB_DSH));

        titleView.setText(R.string.chat_title);
        setStatus(getString(R.string.chat_thinking));
        send.setEnabled(false);
        switchTab(TAB_APP);
        loadCsrfAndSessions();
    }

    @Override
    protected void onDestroy() {
        sseCancelled = true;
        if (sseThread != null) sseThread.interrupt();
        super.onDestroy();
    }

    // ------------------------------------------------------------ Tab

    private void switchTab(int newTab) {
        tab = newTab;
        boolean appTab = tab == TAB_APP;
        chatList.setVisibility(appTab ? View.VISIBLE : View.GONE);
        dshList.setVisibility(appTab ? View.GONE : View.VISIBLE);
        inputBar.setVisibility(appTab ? View.VISIBLE : View.GONE);
        tabAppView.setTextColor(getColor(appTab ? R.color.accent : R.color.text_secondary));
        tabAppView.setTypeface(null, appTab ? android.graphics.Typeface.BOLD
                : android.graphics.Typeface.NORMAL);
        tabDshView.setTextColor(getColor(appTab ? R.color.text_secondary : R.color.accent));
        tabDshView.setTypeface(null, appTab ? android.graphics.Typeface.NORMAL
                : android.graphics.Typeface.BOLD);
        setStatus("");
        if (!appTab && !dshLoaded) {
            loadDshSessions();
        }
    }

    // ------------------------------------------------------------ 基础数据

    private void loadCsrfAndSessions() {
        runAsync("chat-csrf", () -> {
            try {
                csrf = ChatApi.fetchCsrf(ChatActivity.this, base);
            } catch (Exception e) {
                ui.post(() -> onApiError(e));
                return;
            }
            ui.post(this::loadSessions);
            ui.post(this::loadCapabilitiesQuiet);
        });
    }

    private void loadSessions() {
        runAsync("chat-sessions", () -> {
            try {
                JSONObject json = ChatApi.getJson(base, "/api/dsh/chat/sessions");
                org.json.JSONArray array = json.optJSONArray("sessions");
                List<SessionItem> loaded = new ArrayList<>();
                if (array != null) {
                    for (int i = 0; i < array.length(); i++) {
                        JSONObject obj = array.optJSONObject(i);
                        if (obj == null) continue;
                        SessionItem item = new SessionItem();
                        item.id = obj.optString("id", "");
                        item.title = obj.optString("title", "");
                        item.updatedAt = obj.optLong("updatedAt", 0);
                        if (!item.id.isEmpty()) loaded.add(item);
                    }
                }
                ui.post(() -> onSessions(loaded));
            } catch (Exception e) {
                ui.post(() -> onApiError(e));
            }
        });
    }

    private void onSessions(List<SessionItem> loaded) {
        sessions.clear();
        sessions.addAll(loaded);
        String desired = pendingSessionId;
        pendingSessionId = "";
        if (!desired.isEmpty()) {
            for (SessionItem item : sessions) {
                if (item.id.equals(desired)) {
                    sessionChannel = ChatChannel.normalize(pendingChannel,
                            ChatChannel.SDK.equals(pendingChannel));
                    pendingChannel = "";
                    openSession(item.id, item.title);
                    return;
                }
            }
        }
        if (sessions.isEmpty()) {
            sessionId = "";
            sessionTitle = "";
            titleView.setText(R.string.chat_title);
            chatAdapter.submit(new ArrayList<>());
            setStatus(getString(R.string.chat_no_sessions));
            send.setEnabled(false);
            return;
        }
        SessionItem latest = sessions.get(0);
        openSession(latest.id, latest.title);
    }

    private void openSession(String id, String title) {
        runAsync("chat-open", () -> {
            try {
                JSONObject json = ChatApi.getJson(base,
                        "/api/dsh/chat/sessions/" + id + "?limit=200");
                List<ChatMessage> messages = parseChatMessages(json);
                JSONObject session = json.optJSONObject("session");
                String resolvedTitle = session == null ? title : session.optString("title", title);
                ui.post(() -> {
                    sessionId = id;
                    sessionTitle = resolvedTitle == null ? "" : resolvedTitle;
                    titleView.setText(TextUtils.isEmpty(sessionTitle)
                            ? getString(R.string.chat_title) : sessionTitle);
                    chatAdapter.submit(messages);
                    if (messages.isEmpty()) setStatus(getString(R.string.chat_empty_messages));
                    else setStatus("");
                    send.setEnabled(state.canSend());
                    if (!messages.isEmpty()) chatList.scrollToPosition(messages.size() - 1);
                });
            } catch (Exception e) {
                ui.post(() -> onApiError(e));
            }
        });
    }

    private static List<ChatMessage> parseChatMessages(JSONObject json) {
        List<ChatMessage> messages = new ArrayList<>();
        org.json.JSONArray array = json.optJSONArray("messages");
        if (array == null) return messages;
        for (int i = 0; i < array.length(); i++) {
            JSONObject obj = array.optJSONObject(i);
            if (obj == null) continue;
            messages.add(new ChatMessage(
                    obj.optString("role", "assistant"),
                    obj.optString("text", ""),
                    obj.optLong("ts", 0),
                    obj.optString("status", "ok")));
        }
        return messages;
    }

    // ------------------------------------------------------------ DSH 会话列表

    private void loadDshSessions() {
        setStatus(getString(R.string.chat_dsh_loading));
        runAsync("dsh-sessions", () -> {
            try {
                JSONObject json = ChatApi.listDshSessions(base, 50, null, null);
                List<DshSessionInfo> list = ChatApi.parseDshSessions(json);
                for (DshSessionInfo info : list) {
                    if (!info.cwd.isEmpty()) cwdOptions.add(info.cwd);
                }
                List<DshSessions.Group> groups = DshSessions.group(list);
                ui.post(() -> {
                    dshLoaded = true;
                    dshAdapter.submit(groups);
                    if (list.isEmpty()) {
                        setStatus(getString(R.string.chat_dsh_empty));
                    } else {
                        setStatus("");
                    }
                });
            } catch (ChatApi.ChatException e) {
                ui.post(() -> onDshError(e));
            } catch (Exception e) {
                ui.post(() -> setStatus(getString(R.string.chat_dsh_empty)));
            }
        });
    }

    private void onDshError(ChatApi.ChatException e) {
        if (e.code == 404) {
            setStatus(getString(R.string.chat_backend_missing));
        } else if (e.code == 401) {
            setStatus(getString(R.string.chat_unauthorized));
        } else {
            setStatus(getString(R.string.chat_dsh_empty) + "（HTTP " + e.code + "）");
        }
    }

    private void openDshSession(DshSessionInfo session) {
        Intent intent = new Intent(this, DshSessionActivity.class);
        intent.putExtra(DshSessionActivity.EXTRA_ID, session.id);
        intent.putExtra(DshSessionActivity.EXTRA_TITLE, session.displayTitle());
        intent.putExtra(DshSessionActivity.EXTRA_CWD, session.cwd);
        intent.putExtra(DshSessionActivity.EXTRA_MODEL, session.modelLabel());
        intent.putExtra(DshSessionActivity.EXTRA_PRESET, session.agentPreset);
        intent.putExtra(DshSessionActivity.EXTRA_RESUMABLE, session.canContinue());
        intent.putExtra(DshSessionActivity.EXTRA_COUNT, session.messageCount);
        startActivity(intent);
    }

    // ------------------------------------------------------------ 能力面板 / 新建聊天

    private void loadCapabilitiesQuiet() {
        runAsync("dsh-caps", () -> {
            CapabilitiesText.Data data = null;
            try {
                JSONObject json = ChatApi.capabilities(base);
                data = ChatApi.parseCapabilities(json);
            } catch (Exception ignored) {
                // 能力接口未就绪：静默降级
            }
            SdkStatus sdk = fetchSdkStatusQuiet();
            final CapabilitiesText.Data caps = data;
            ui.post(() -> {
                if (caps != null) {
                    capabilities = caps;
                    modelOptions.clear();
                    modelOptions.addAll(caps.models);
                }
                if (sdk != null) {
                    sdkStatus = sdk;
                    sdkStatusLoaded = true;
                }
                applySdkToCapabilities();
            });
        });
    }

    private SdkStatus fetchSdkStatusQuiet() {
        try {
            return ChatApi.parseSdkStatus(ChatApi.sdkStatus(base));
        } catch (Exception e) {
            return SdkStatus.unavailable("接口未就绪");
        }
    }

    private void applySdkToCapabilities() {
        if (capabilities == null || !sdkStatusLoaded) return;
        capabilities.sdkStatusKnown = true;
        capabilities.sdkAvailable = sdkStatus.available;
        capabilities.sdkAllowSdkResume = sdkStatus.allowSdkResume;
        capabilities.sdkProfile = sdkStatus.profile;
        capabilities.sdkReason = sdkStatus.reason;
        capabilities.sdkPresets.clear();
        capabilities.sdkPresets.addAll(sdkStatus.presets);
    }

    private void showCapabilitiesDialog() {
        if (capabilities != null && sdkStatusLoaded) {
            renderCapabilitiesDialog(capabilities);
            return;
        }
        setStatus(getString(R.string.chat_caps_loading));
        runAsync("chat-caps-dialog", () -> {
            try {
                JSONObject json = ChatApi.capabilities(base);
                CapabilitiesText.Data data = ChatApi.parseCapabilities(json);
                sdkStatus = fetchSdkStatusQuiet();
                sdkStatusLoaded = true;
                ui.post(() -> {
                    capabilities = data;
                    modelOptions.clear();
                    modelOptions.addAll(data.models);
                    applySdkToCapabilities();
                    setStatus("");
                    renderCapabilitiesDialog(data);
                });
            } catch (ChatApi.ChatException e) {
                ui.post(() -> {
                    setStatus("");
                    new AlertDialog.Builder(this)
                            .setTitle(R.string.chat_caps_title)
                            .setMessage(getString(R.string.chat_caps_unavailable)
                                    + "（HTTP " + e.code + "）")
                            .setPositiveButton(R.string.action_cancel, null)
                            .show();
                });
            } catch (Exception e) {
                ui.post(() -> setStatus(getString(R.string.chat_caps_unavailable)));
            }
        });
    }

    private void renderCapabilitiesDialog(CapabilitiesText.Data data) {
        StringBuilder sb = new StringBuilder();
        for (String line : CapabilitiesText.lines(data)) {
            sb.append(line).append('\n');
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.chat_caps_title)
                .setMessage(sb.toString().trim())
                .setPositiveButton(R.string.action_cancel, null)
                .show();
    }

    private void showNewChatDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), dp(8));

        EditText titleInput = new EditText(this);
        titleInput.setHint(R.string.chat_new_title_hint);
        titleInput.setSingleLine(true);
        box.addView(titleInput);

        AutoCompleteTextView cwdInput = new AutoCompleteTextView(this);
        cwdInput.setHint(R.string.chat_new_cwd_hint);
        cwdInput.setSingleLine(true);
        cwdInput.setAdapter(new ArrayAdapter<>(this,
                android.R.layout.simple_dropdown_item_1line, new ArrayList<>(cwdOptions)));
        box.addView(cwdInput);

        TextView modelLabel = new TextView(this);
        modelLabel.setText(R.string.chat_new_model);
        modelLabel.setTextColor(getColor(R.color.text_secondary));
        modelLabel.setTextSize(12);
        box.addView(modelLabel);

        List<String> labels = new ArrayList<>();
        labels.add(getString(R.string.chat_new_default_model));
        labels.addAll(modelOptions);
        Spinner spinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_spinner_item, labels);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        box.addView(spinner);

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.chat_new_session)
                .setView(box)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.chat_new, null)
                .create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(v -> {
                    String title = titleInput.getText().toString().trim();
                    String cwd = cwdInput.getText().toString().trim();
                    int index = spinner.getSelectedItemPosition();
                    String model = index > 0 && index - 1 < modelOptions.size()
                            ? modelOptions.get(index - 1) : "";
                    createNewChat(title, cwd, model, dialog);
                }));
        dialog.show();
    }

    private void createNewChat(String title, String cwd, String model, AlertDialog dialog) {
        runAsync("chat-create", () -> {
            try {
                JSONObject resp = ChatApi.createChatSession(base, csrf, title, cwd, "");
                String id = resp.optString("id", "");
                ui.post(() -> {
                    dialog.dismiss();
                    if (id.isEmpty()) {
                        Toast.makeText(this, R.string.chat_create_failed, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    currentModel = model;
                    pendingSessionId = id;
                    loadSessions();
                });
            } catch (ChatApi.ChatException e) {
                ui.post(() -> {
                    dialog.dismiss();
                    String message = e.code == 400
                            ? getString(R.string.chat_create_failed) + "：cwd 无效或会话不可续"
                            : getString(R.string.chat_create_failed) + "（HTTP " + e.code + "）";
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                ui.post(() -> {
                    dialog.dismiss();
                    Toast.makeText(this, R.string.chat_create_failed, Toast.LENGTH_SHORT).show();
                });
            }
        });
    }

    // ------------------------------------------------------------ 会话切换 / 删除 / 发送

    private void showSessionList() {
        if (sessions.isEmpty()) {
            Toast.makeText(this, R.string.chat_no_sessions, Toast.LENGTH_SHORT).show();
            return;
        }
        String[] labels = new String[sessions.size()];
        for (int i = 0; i < sessions.size(); i++) {
            SessionItem item = sessions.get(i);
            String name = TextUtils.isEmpty(item.title) ? item.id : item.title;
            if (item.id.equals(sessionId)) name = "✓ " + name;
            labels[i] = name;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.chat_session_list)
                .setItems(labels, (dialog, which) -> {
                    SessionItem item = sessions.get(which);
                    openSession(item.id, item.title);
                })
                .setPositiveButton(R.string.chat_new, (dialog, which) -> showNewChatDialog())
                .setNegativeButton(R.string.action_cancel, null)
                .show();
    }

    private void deleteCurrentSession() {
        if (sessionId.isEmpty()) {
            Toast.makeText(this, R.string.chat_no_sessions, Toast.LENGTH_SHORT).show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.chat_delete)
                .setMessage(R.string.chat_delete_confirm)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.chat_delete, (dialog, which) -> {
                    final String id = sessionId;
                    runAsync("chat-delete", () -> {
                        try {
                            ChatApi.delete(base, "/api/dsh/chat/sessions/" + id, csrf);
                            ui.post(() -> {
                                Toast.makeText(this, R.string.chat_deleted, Toast.LENGTH_SHORT).show();
                                sessionId = "";
                                loadSessions();
                            });
                        } catch (Exception e) {
                            ui.post(() -> onApiError(e));
                        }
                    });
                })
                .show();
    }

    private void sendMessage() {
        if (sessionId.isEmpty()) {
            Toast.makeText(this, R.string.chat_no_sessions, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!state.canSend()) {
            Toast.makeText(this, R.string.chat_busy, Toast.LENGTH_SHORT).show();
            return;
        }
        final String text = input.getText().toString().trim();
        if (text.isEmpty()) return;

        state.start();
        setStatus(state.status());
        send.setEnabled(false);
        input.setText("");

        runAsync("chat-send", () -> {
            try {
                String channel = ChatChannel.forSession(ChatChannel.SDK.equals(sessionChannel));
                JSONObject resp = ChatApi.sendChatMessage(base, csrf, sessionId, text,
                        currentModel, channel);
                String taskId = resp.optString("taskId", "");
                ui.post(() -> {
                    chatAdapter.append(new ChatMessage("user", text,
                            System.currentTimeMillis(), "ok"));
                    chatList.scrollToPosition(chatAdapter.size() - 1);
                });
                if (taskId.isEmpty()) {
                    ui.post(() -> {
                        state.fail(getString(R.string.chat_send_failed));
                        setStatus(state.status());
                        send.setEnabled(true);
                        refreshMessages();
                    });
                    return;
                }
                startSse(taskId);
            } catch (ChatApi.ChatException e) {
                ui.post(() -> onSendError(e));
            } catch (Exception e) {
                ui.post(() -> {
                    state.fail(e.getMessage());
                    setStatus(state.status());
                    send.setEnabled(true);
                });
            }
        });
    }

    private void startSse(String taskId) {
        sseCancelled = false;
        sseThread = new Thread(() -> {
            try {
                ChatApi.stream(base, taskId, new ChatApi.StreamListener() {
                    @Override
                    public void onSseEvent(String type, String text) {
                        ui.post(() -> handleSseEvent(type, text));
                    }

                    @Override
                    public boolean cancelled() {
                        return sseCancelled || isFinishing();
                    }
                });
            } catch (ChatApi.ChatException e) {
                ui.post(() -> onSendError(e));
            } catch (Exception e) {
                ui.post(() -> {
                    if (!state.running()) return;
                    state.fail(e.getMessage());
                    setStatus(state.status());
                });
            } finally {
                ui.post(() -> {
                    send.setEnabled(true);
                    refreshMessages();
                });
            }
        }, "chat-sse");
        sseThread.start();
    }

    private void refreshMessages() {
        if (sessionId.isEmpty()) return;
        final String id = sessionId;
        runAsync("chat-refresh", () -> {
            try {
                JSONObject json = ChatApi.getJson(base,
                        "/api/dsh/chat/sessions/" + id + "?limit=200");
                List<ChatMessage> messages = parseChatMessages(json);
                ui.post(() -> {
                    if (!id.equals(sessionId)) return;
                    chatAdapter.submit(messages);
                    if (!messages.isEmpty()) chatList.scrollToPosition(messages.size() - 1);
                });
            } catch (Exception ignored) {
                // 刷新失败保留当前气泡
            }
        });
    }

    // ------------------------------------------------------------ 错误 / 工具

    private void onApiError(Exception e) {
        if (e instanceof ChatApi.ChatException) {
            onApiError((ChatApi.ChatException) e);
            return;
        }
        state.fail(e.getMessage());
        setStatus(state.status());
    }

    private void onApiError(ChatApi.ChatException e) {
        String sdkMessage = SdkErrors.messageForCode(ChatApi.errorCode(e));
        if (sdkMessage != null) {
            state.fail(sdkMessage);
            setStatus(sdkMessage);
            return;
        }
        int message;
        if (e.code == 404) {
            message = R.string.chat_backend_missing;
        } else if (e.code == 401) {
            message = R.string.chat_unauthorized;
        } else if (e.code == 403) {
            message = R.string.chat_dsh_disabled;
        } else if (e.code == 409) {
            message = R.string.chat_busy;
        } else {
            message = R.string.chat_send_failed;
        }
        state.fail(getString(message));
        setStatus(getString(message) + "（HTTP " + e.code + "）");
    }

    /** SSE 事件映射：assistant/message → 助手气泡、tool/call → 工具行、turn/end → 结束，其余走状态机。 */
    private void handleSseEvent(String type, String text) {
        SseEventMapper.Kind kind = SseEventMapper.kindOf(type);
        if (kind == SseEventMapper.Kind.ASSISTANT_MESSAGE) {
            if (!TextUtils.isEmpty(text)) {
                chatAdapter.append(new ChatMessage("assistant", text,
                        System.currentTimeMillis(), "ok"));
                chatList.scrollToPosition(chatAdapter.size() - 1);
            }
            state.onEventType("status", "正在回答…");
            setStatus(state.status());
            return;
        }
        if (kind == SseEventMapper.Kind.TOOL_CALL) {
            String line = TextUtils.isEmpty(text) ? "工具调用" : "工具 " + text;
            chatAdapter.append(new ChatMessage("tool", line, System.currentTimeMillis(), "ok"));
            chatList.scrollToPosition(chatAdapter.size() - 1);
            state.onEventType("status", "正在调用工具…");
            setStatus(state.status());
            return;
        }
        if (kind == SseEventMapper.Kind.TURN_END) {
            state.onEventType("done", text);
            setStatus(state.status());
            return;
        }
        state.onEventType(type, text);
        if (!state.status().isEmpty()) setStatus(state.status());
    }

    private void onSendError(ChatApi.ChatException e) {
        state.fail(getString(R.string.chat_send_failed));
        onApiError(e);
        send.setEnabled(true);
    }

    private void setStatus(String text) {
        if (TextUtils.isEmpty(text)) {
            statusView.setVisibility(View.GONE);
        } else {
            statusView.setVisibility(View.VISIBLE);
            statusView.setText(text);
        }
    }

    private void runAsync(String name, Runnable task) {
        new Thread(task, name).start();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
