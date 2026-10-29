package net.hbmin.serverpanel;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

/** 启动页：配置了多个服务器时先让用户选择（记住上次选择 = 当前服务器高亮）。 */
public class ServerPickerActivity extends Activity {

    public static final String EXTRA_URL = "server_url";

    private LinearLayout container;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_server_picker);
        container = findViewById(R.id.picker_container);
        Button manage = findViewById(R.id.btn_manage_servers);
        manage.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        container.removeAllViews();
        List<ServerStore.Item> servers = ServerStore.load(this);
        String active = ServerStore.activeUrl(this);
        for (ServerStore.Item server : servers) {
            container.addView(buildRow(server, server.url.equals(active)));
        }
    }

    private View buildRow(ServerStore.Item server, boolean active) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundResource(R.drawable.banner_bg);
        row.setPadding(dp(16), dp(14), dp(16), dp(14));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(10);
        row.setLayoutParams(params);
        row.setClickable(true);
        row.setFocusable(true);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        TextView name = new TextView(this);
        name.setText(server.name);
        name.setTextColor(getColor(R.color.text_primary));
        name.setTextSize(16);
        name.setTypeface(name.getTypeface(), android.graphics.Typeface.BOLD);
        name.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        head.addView(name);
        if (active) {
            TextView badge = new TextView(this);
            badge.setText(R.string.server_current_badge);
            badge.setTextColor(getColor(R.color.accent));
            badge.setTextSize(11);
            head.addView(badge);
        }
        row.addView(head);

        TextView url = new TextView(this);
        url.setText(server.url);
        url.setTextColor(getColor(R.color.text_secondary));
        url.setTextSize(12);
        url.setPadding(0, dp(4), 0, 0);
        row.addView(url);

        row.setOnClickListener(v -> {
            ServerStore.setActive(this, server.url);
            Intent data = new Intent();
            data.putExtra(EXTRA_URL, server.url);
            setResult(RESULT_OK, data);
            finish();
        });
        return row;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
