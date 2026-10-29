package net.hbmin.serverpanel;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** 下载列表：查询 DownloadManager 的下载（文件名/进度/状态/大小），可打开或删除。 */
public class DownloadsActivity extends Activity {

    private static final int REQ_NOTIFICATIONS = 401;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ListView listView;
    private TextView emptyView;
    private DownloadManager downloadManager;
    private final List<Item> items = new ArrayList<>();
    private DownloadsAdapter adapter;
    private boolean loading = false;

    private final Runnable refreshTask = new Runnable() {
        @Override
        public void run() {
            load();
            handler.postDelayed(this, 1500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_downloads);
        listView = findViewById(R.id.downloads_list);
        emptyView = findViewById(R.id.downloads_empty);
        downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        adapter = new DownloadsAdapter();
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> open(items.get(position)));
        listView.setOnItemLongClickListener((parent, view, position, id) -> {
            confirmDelete(items.get(position));
            return true;
        });

        // Android 13+：进入下载页时请求通知权限（下载完成通知需要）
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(refreshTask);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(refreshTask);
    }

    private void load() {
        if (downloadManager == null || loading) return;
        loading = true;
        new Thread(() -> {
            List<Item> result = new ArrayList<>();
            Cursor cursor = downloadManager.query(new DownloadManager.Query());
            if (cursor != null) {
                try {
                    while (cursor.moveToNext()) {
                        Item item = new Item();
                        item.id = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID));
                        item.title = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE));
                        item.mime = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_MEDIA_TYPE));
                        item.status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        item.soFar = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        item.total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        if (item.title == null || item.title.isEmpty()) item.title = "下载 #" + item.id;
                        result.add(item);
                    }
                } finally {
                    cursor.close();
                }
            }
            runOnUiThread(() -> {
                loading = false;
                items.clear();
                items.addAll(result);
                adapter.notifyDataSetChanged();
                emptyView.setVisibility(items.isEmpty() ? View.VISIBLE : View.GONE);
            });
        }, "downloads-query").start();
    }

    private void open(Item item) {
        try {
            if (item.status != DownloadManager.STATUS_SUCCESSFUL) {
                Toast.makeText(this, "文件尚未下载完成", Toast.LENGTH_SHORT).show();
                return;
            }
            Uri uri = downloadManager.getUriForDownloadedFile(item.id);
            if (uri == null) {
                Toast.makeText(this, "找不到已下载的文件", Toast.LENGTH_SHORT).show();
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, item.mime == null ? "*/*" : item.mime);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开文件：" + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private void confirmDelete(Item item) {
        new AlertDialog.Builder(this)
                .setTitle("移除下载记录？")
                .setMessage(item.title)
                .setNegativeButton(R.string.action_cancel, null)
                .setPositiveButton(R.string.action_delete, (dialog, which) -> {
                    try {
                        downloadManager.remove(item.id);
                    } catch (Exception ignored) {
                        // 记录可能已被系统清理
                    }
                    load();
                })
                .show();
    }

    private static final class Item {
        long id;
        String title;
        String mime;
        int status;
        long soFar;
        long total;
    }

    private final class DownloadsAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public Item getItem(int position) {
            return items.get(position);
        }

        @Override
        public long getItemId(int position) {
            return items.get(position).id;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Item item = getItem(position);
            LinearLayout row = new LinearLayout(DownloadsActivity.this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(14), dp(12), dp(14), dp(12));

            TextView title = new TextView(DownloadsActivity.this);
            title.setText(item.title);
            title.setTextColor(getColor(R.color.text_primary));
            title.setTextSize(14);
            row.addView(title);

            TextView status = new TextView(DownloadsActivity.this);
            status.setText(statusText(item));
            status.setTextColor(getColor(R.color.text_secondary));
            status.setTextSize(12);
            status.setPadding(0, dp(3), 0, 0);
            row.addView(status);
            return row;
        }
    }

    private String statusText(Item item) {
        String size = sizeText(item);
        switch (item.status) {
            case DownloadManager.STATUS_PENDING:
                return "等待中 · " + size;
            case DownloadManager.STATUS_RUNNING:
                int percent = item.total > 0
                        ? (int) (item.soFar * 100 / item.total)
                        : 0;
                return "下载中 " + percent + "% · " + size;
            case DownloadManager.STATUS_PAUSED:
                return "已暂停 · " + size;
            case DownloadManager.STATUS_SUCCESSFUL:
                return "已完成 · " + size;
            case DownloadManager.STATUS_FAILED:
                return "失败 · 长按可删除记录";
            default:
                return "未知状态 · " + size;
        }
    }

    private String sizeText(Item item) {
        if (item.total > 0) {
            return human(item.total);
        }
        if (item.soFar > 0) {
            return "已下载 " + human(item.soFar);
        }
        return "大小未知";
    }

    private static String human(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024 * 1024) {
            return String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0);
        }
        return String.format(Locale.US, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
