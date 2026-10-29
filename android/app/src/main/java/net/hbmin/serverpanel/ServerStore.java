package net.hbmin.serverpanel;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 多服务器列表（名称 + 地址）与当前服务器。
 * 列表存在 SharedPreferences 的 JSON 里；1.0.x 的 base_url 首次启动时自动迁移。
 */
final class ServerStore {

    static final class Item {
        String name;
        String url;

        Item(String name, String url) {
            this.name = name;
            this.url = url;
        }
    }

    private ServerStore() {
    }

    static synchronized List<Item> load(Context context) {
        List<Item> out = new ArrayList<>();
        String raw = AppPrefs.get(context).getString(AppPrefs.KEY_SERVERS, "");
        if (raw != null && !raw.isEmpty()) {
            try {
                JSONArray array = new JSONArray(raw);
                for (int i = 0; i < array.length(); i++) {
                    JSONObject obj = array.optJSONObject(i);
                    if (obj == null) continue;
                    String url = Util.normalizeBase(obj.optString("url", ""));
                    if (url.isEmpty()) continue;
                    String name = obj.optString("name", "").trim();
                    if (name.isEmpty()) name = defaultName(url);
                    out.add(new Item(name, url));
                }
            } catch (Exception ignored) {
                // 损坏的 JSON 当作空列表，下面重新引导
            }
        }
        if (out.isEmpty()) {
            out = bootstrap(context);
        }
        return out;
    }

    /**
     * 首次启动 / 从 1.0.x 升级：只迁移旧地址，不再写入任何本机预设（开源化）。
     * 没有旧地址时返回空列表，由设置页引导用户录入。
     */
    private static List<Item> bootstrap(Context context) {
        List<Item> list = new ArrayList<>();
        String legacy = Util.normalizeBase(
                AppPrefs.get(context).getString(AppPrefs.KEY_LEGACY_BASE_URL, ""));
        if (!legacy.isEmpty()) {
            list.add(new Item("当前服务器", legacy));
        }
        save(context, list);
        if (!list.isEmpty()
                && Util.normalizeBase(AppPrefs.get(context).getString(AppPrefs.KEY_ACTIVE_URL, "")).isEmpty()) {
            setActive(context, list.get(0).url);
        }
        return list;
    }

    static String defaultName(String url) {
        try {
            String host = java.net.URI.create(url).getHost();
            return host == null || host.isEmpty() ? url : host;
        } catch (Exception e) {
            return url;
        }
    }

    private static void addIfMissing(List<Item> list, String name, String url) {
        for (Item item : list) {
            if (item.url.equals(url)) return;
        }
        list.add(new Item(name, url));
    }

    static synchronized void save(Context context, List<Item> list) {
        JSONArray array = new JSONArray();
        for (Item item : list) {
            JSONObject obj = new JSONObject();
            try {
                obj.put("name", item.name);
                obj.put("url", item.url);
            } catch (Exception ignored) {
                // put 不会失败，忽略
            }
            array.put(obj);
        }
        AppPrefs.get(context).edit().putString(AppPrefs.KEY_SERVERS, array.toString()).apply();
    }

    static synchronized String activeUrl(Context context) {
        String active = Util.normalizeBase(
                AppPrefs.get(context).getString(AppPrefs.KEY_ACTIVE_URL, ""));
        if (!active.isEmpty()) return active;
        List<Item> list = load(context);
        if (list.isEmpty()) return "";
        setActive(context, list.get(0).url);
        return list.get(0).url;
    }

    static synchronized String activeName(Context context) {
        String url = activeUrl(context);
        for (Item item : load(context)) {
            if (item.url.equals(url)) return item.name;
        }
        return defaultName(url);
    }

    static synchronized void setActive(Context context, String url) {
        String normalized = Util.normalizeBase(url);
        if (normalized.isEmpty()) return;
        if (!contains(context, normalized)) {
            List<Item> list = load(context);
            list.add(new Item(defaultName(normalized), normalized));
            save(context, list);
        }
        AppPrefs.get(context).edit().putString(AppPrefs.KEY_ACTIVE_URL, normalized).apply();
    }

    static synchronized boolean contains(Context context, String url) {
        String normalized = Util.normalizeBase(url);
        for (Item item : load(context)) {
            if (item.url.equals(normalized)) return true;
        }
        return false;
    }

    /** @return true 表示已添加，false 表示地址无效或已存在。 */
    static synchronized boolean add(Context context, String name, String url) {
        String normalized = Util.normalizeBase(url);
        if (normalized.isEmpty() || contains(context, normalized)) return false;
        List<Item> list = load(context);
        String finalName = name == null ? "" : name.trim();
        if (finalName.isEmpty()) finalName = defaultName(normalized);
        list.add(new Item(finalName, normalized));
        save(context, list);
        return true;
    }

    static synchronized void update(Context context, String oldUrl, String name, String url) {
        String normalized = Util.normalizeBase(url);
        if (normalized.isEmpty()) return;
        List<Item> list = load(context);
        for (Item item : list) {
            if (item.url.equals(oldUrl)) {
                item.name = name == null || name.trim().isEmpty() ? defaultName(normalized) : name.trim();
                item.url = normalized;
            }
        }
        save(context, list);
        String active = Util.normalizeBase(
                AppPrefs.get(context).getString(AppPrefs.KEY_ACTIVE_URL, ""));
        if (active.equals(oldUrl)) {
            AppPrefs.get(context).edit().putString(AppPrefs.KEY_ACTIVE_URL, normalized).apply();
        }
    }

    /** 删除服务器；允许删到空列表（开源版不强制保留预设）。 */
    static synchronized boolean remove(Context context, String url) {
        List<Item> list = load(context);
        List<Item> keep = new ArrayList<>();
        boolean found = false;
        for (Item item : list) {
            if (item.url.equals(url)) {
                found = true;
            } else {
                keep.add(item);
            }
        }
        if (!found) return false;
        save(context, keep);
        String active = Util.normalizeBase(
                AppPrefs.get(context).getString(AppPrefs.KEY_ACTIVE_URL, ""));
        if (active.equals(url) || active.isEmpty()) {
            AppPrefs.get(context).edit().putString(AppPrefs.KEY_ACTIVE_URL,
                    keep.isEmpty() ? "" : keep.get(0).url).apply();
        }
        return true;
    }
}
