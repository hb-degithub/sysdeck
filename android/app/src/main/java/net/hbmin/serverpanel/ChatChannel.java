package net.hbmin.serverpanel;

/** 聊天发送通道选择（纯逻辑可 JDK 单测）。 */
final class ChatChannel {

    static final String AUTO = "auto";
    static final String SDK = "sdk";
    static final String HEADLESS = "headless";

    private ChatChannel() {
    }

    static boolean valid(String channel) {
        return AUTO.equals(channel) || SDK.equals(channel) || HEADLESS.equals(channel);
    }

    /** 会话绑定 SDK 续聊时用 sdk，否则用 auto（服务端自行决定 headless/auto）。 */
    static String forSession(boolean sdkBound) {
        return sdkBound ? SDK : AUTO;
    }

    /** 容错：非法值回落到会话默认通道。 */
    static String normalize(String requested, boolean sdkBound) {
        return valid(requested) ? requested : forSession(sdkBound);
    }

    static String label(String channel) {
        if (SDK.equals(channel)) return "SDK";
        if (HEADLESS.equals(channel)) return "headless";
        return "auto";
    }
}
