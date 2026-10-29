package net.hbmin.serverpanel;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONObject;

import java.util.List;

/**
 * DSH 真实会话详情：只读历史（user/assistant/tool 折叠）+ 可续聊时绑定面板聊天 / 不可续时跳 DSH 控制台。
 */
public class DshSessionActivity extends Activity {

    public static final String EXTRA_ID = "dsh_session_id";
    public static final String EXTRA_TITLE = "dsh_session_title";
    public static final String EXTRA_CWD = "dsh_session_cwd";
    public static final String EXTRA_MODEL = "dsh_session_model";
    public static final String EXTRA_PRESET = "dsh_session_preset";
    public static final String EXTRA_RESUMABLE = "dsh_session_resumable";
    public static final String EXTRA_COUNT = "dsh_session_count";

    private String base = "";
    private String sessionId = "";
    private String cwd = "";
    private String model = "";
    private String preset = "";
    private boolean resumable = false;
    private boolean useSdk = false;
    private SdkStatus sdkStatus;
    private boolean sdkStatusLoaded = false;
    private int headerCount = -1;

    private TextView titleView;
    private TextView infoView;
    private TextView statusView;
    private TextView hintView;
    private Button continueButton;
    private Button consoleButton;
    private DshMessageAdapter adapter;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.Theme_ServerPanel);
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_dsh_session);

        base = ServerStore.activeUrl(this);
        Intent intent = getIntent();
        sessionId = intent.getStringExtra(EXTRA_ID);
        if (base.isEmpty() || TextUtils.isEmpty(sessionId)) {
            Toast.makeText(this, R.string.chat_backend_missing, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        cwd = safe(intent.getStringExtra(EXTRA_CWD));
        model = safe(intent.getStringExtra(EXTRA_MODEL));
        preset = safe(intent.getStringExtra(EXTRA_PRESET));
        resumable = intent.getBooleanExtra(EXTRA_RESUMABLE, false);

        titleView = findViewById(R.id.dsh_detail_title);
        infoView = findViewById(R.id.dsh_detail_info);
        statusView = findViewById(R.id.dsh_detail_status);
        hintView = findViewById(R.id.dsh_detail_hint);
        continueButton = findViewById(R.id.btn_dsh_continue);
        consoleButton = findViewById(R.id.btn_dsh_console);

        adapter = new DshMessageAdapter();
        RecyclerView list = findViewById(R.id.dsh_detail_list);
        list.setLayoutManager(new LinearLayoutManager(this));
        list.setAdapter(adapter);

        titleView.setText(TextUtils.isEmpty(intent.getStringExtra(EXTRA_TITLE))
                ? getString(R.string.chat_dsh_session_title)
                : intent.getStringExtra(EXTRA_TITLE));
        renderHeader(intent.getIntExtra(EXTRA_COUNT, -1));
        applyResumableState(resumable);
        findViewById(R.id.btn_dsh_detail_close).setOnClickListener(v -> finish());
        continueButton.setOnClickListener(v -> continueChat());
        consoleButton.setOnClickListener(v -> openConsole());
        loadSdkStatus();
        loadHistory();
    }

    private void renderHeader(int messageCount) {
        headerCount = messageCount;
        StringBuilder sb = new StringBuilder();
        if (!cwd.isEmpty()) sb.append("cwd：").append(cwd).append('\n');
        if (!model.isEmpty()) sb.append("模型：").append(model).append('\n');
        if (!preset.isEmpty()) {
            sb.append("agent preset：").append(preset).append('\n');
        } else {
            sb.append("agent preset：无（可续聊）").append('\n');
        }
        if (messageCount >= 0) sb.append("消息数：").append(messageCount);
        if (sdkStatusLoaded) {
            sb.append("\nSDK 续聊：").append(sdkStatus == null
                    ? getString(R.string.chat_sdk_unavailable) : sdkStatus.summary());
        }
        infoView.setText(sb.toString().trim());
    }

    /** 基础可续状态（历史里读到的 resumable）。 */
    private void applyResumableState(boolean canContinue) {
        resumable = canContinue;
        renderActionButtons();
    }

    private void loadSdkStatus() {
        new Thread(() -> {
            SdkStatus status;
            try {
                status = ChatApi.parseSdkStatus(ChatApi.sdkStatus(base));
            } catch (Exception e) {
                status = SdkStatus.unavailable(getString(R.string.chat_sdk_unavailable));
            }
            final SdkStatus result = status;
            runOnUiThread(() -> {
                sdkStatus = result;
                sdkStatusLoaded = true;
                renderActionButtons();
                renderHeader(headerCount);
            });
        }, "dsh-sdk-status").start();
    }

    /** Web 会话（有 preset）有 SDK 续聊时给「继续对话（SDK）」，否则保留 headless 不可续说明。 */
    private void renderActionButtons() {
        boolean webSession = !preset.isEmpty();
        if (!webSession) {
            useSdk = false;
            continueButton.setText(R.string.chat_continue);
            if (resumable) {
                continueButton.setVisibility(View.VISIBLE);
                hintView.setVisibility(View.GONE);
            } else {
                continueButton.setVisibility(View.GONE);
                hintView.setVisibility(View.VISIBLE);
                hintView.setText(R.string.chat_continue_web);
            }
            return;
        }
        boolean sdkReady = sdkStatus != null && sdkStatus.canResumeWebSession();
        useSdk = sdkReady;
        continueButton.setText(sdkReady ? R.string.chat_continue_sdk : R.string.chat_continue);
        continueButton.setVisibility(sdkReady ? View.VISIBLE : View.GONE);
        hintView.setVisibility(View.VISIBLE);
        StringBuilder hint = new StringBuilder(getString(R.string.chat_continue_web));
        if (sdkStatus != null) {
            hint.append("\nSDK 续聊：").append(sdkStatus.summary());
        } else {
            hint.append("\n").append(getString(R.string.chat_sdk_unavailable));
        }
        hintView.setText(hint);
    }

    // ------------------------------------------------------------ 历史加载

    private void loadHistory() {
        statusView.setVisibility(View.VISIBLE);
        statusView.setText(R.string.chat_history_loading);
        new Thread(() -> {
            try {
                JSONObject root = ChatApi.dshMessages(base, sessionId, 200);
                List<DshMessage> messages = ChatApi.parseDshMessages(root);
                JSONObject session = root.optJSONObject("session");
                runOnUiThread(() -> {
                    DshSessionInfo info = session == null
                            ? null : ChatApi.parseDshSession(session);
                    if (info != null) {
                        cwd = info.cwd;
                        model = info.modelLabel();
                        preset = info.agentPreset;
                        resumable = info.canContinue();
                        renderHeader(info.messageCount >= 0 ? info.messageCount : messages.size());
                        applyResumableState(resumable);
                    } else {
                        renderHeader(messages.size());
                    }
                    adapter.submit(messages);
                    statusView.setVisibility(View.GONE);
                    if (messages.isEmpty()) {
                        statusView.setVisibility(View.VISIBLE);
                        statusView.setText(R.string.chat_empty_messages);
                    }
                });
            } catch (ChatApi.ChatException e) {
                runOnUiThread(() -> onHistoryError(e));
            } catch (Exception e) {
                runOnUiThread(() -> {
                    statusView.setText(R.string.chat_history_failed);
                });
            }
        }, "dsh-history").start();
    }

    private void onHistoryError(ChatApi.ChatException e) {
        if (e.code == 404) {
            statusView.setText(R.string.chat_backend_missing);
        } else if (e.code == 401) {
            statusView.setText(R.string.chat_unauthorized);
        } else {
            statusView.setText(getString(R.string.chat_history_failed) + "（HTTP " + e.code + "）");
        }
    }

    // ------------------------------------------------------------ 继续对话 / 打开控制台

    private void continueChat() {
        continueButton.setEnabled(false);
        statusView.setVisibility(View.VISIBLE);
        statusView.setText(R.string.chat_thinking);
        new Thread(() -> {
            try {
                String csrf = ChatApi.fetchCsrf(this, base);
                JSONObject resp = ChatApi.createChatSession(base, csrf,
                        titleView.getText().toString(), cwd, sessionId, useSdk);
                String chatId = resp.optString("id", "");
                runOnUiThread(() -> {
                    statusView.setVisibility(View.GONE);
                    if (chatId.isEmpty()) {
                        continueButton.setEnabled(true);
                        Toast.makeText(this, R.string.chat_create_failed, Toast.LENGTH_SHORT).show();
                        return;
                    }
                    Intent intent = new Intent(this, ChatActivity.class);
                    intent.putExtra(ChatActivity.EXTRA_SESSION_ID, chatId);
                    intent.putExtra(ChatActivity.EXTRA_CHANNEL,
                            useSdk ? ChatChannel.SDK : ChatChannel.AUTO);
                    startActivity(intent);
                    finish();
                });
            } catch (ChatApi.ChatException e) {
                runOnUiThread(() -> {
                    continueButton.setEnabled(true);
                    statusView.setVisibility(View.GONE);
                    String sdkMessage = SdkErrors.messageForCode(ChatApi.errorCode(e));
                    if (sdkMessage != null) {
                        Toast.makeText(this, sdkMessage, Toast.LENGTH_LONG).show();
                        hintView.setVisibility(View.VISIBLE);
                        hintView.setText(sdkMessage);
                        if (SdkErrors.kindOf(ChatApi.errorCode(e))
                                == SdkErrors.Kind.BUSY_IN_WEB) {
                            // busy：会话可稍后重试，保留 SDK 按钮
                            continueButton.setEnabled(true);
                        } else {
                            continueButton.setVisibility(View.GONE);
                        }
                    } else if (e.code == 400) {
                        hintView.setVisibility(View.VISIBLE);
                        hintView.setText(R.string.chat_continue_web);
                        continueButton.setVisibility(View.GONE);
                        Toast.makeText(this, R.string.chat_continue_web, Toast.LENGTH_LONG).show();
                    } else {
                        Toast.makeText(this,
                                getString(R.string.chat_create_failed) + "（HTTP " + e.code + "）",
                                Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    continueButton.setEnabled(true);
                    statusView.setVisibility(View.GONE);
                    Toast.makeText(this, R.string.chat_create_failed, Toast.LENGTH_SHORT).show();
                });
            }
        }, "dsh-continue").start();
    }

    private void openConsole() {
        consoleButton.setEnabled(false);
        new Thread(() -> {
            try {
                String url = ChatApi.consoleUrl(base);
                runOnUiThread(() -> {
                    consoleButton.setEnabled(true);
                    if (url.isEmpty()) {
                        Toast.makeText(this, R.string.chat_console_failed, Toast.LENGTH_LONG).show();
                        return;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception e) {
                        Toast.makeText(this, R.string.chat_console_failed, Toast.LENGTH_LONG).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    consoleButton.setEnabled(true);
                    Toast.makeText(this, R.string.chat_console_failed, Toast.LENGTH_LONG).show();
                });
            }
        }, "dsh-console").start();
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
