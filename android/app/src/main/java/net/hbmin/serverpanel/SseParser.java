package net.hbmin.serverpanel;

import java.util.ArrayList;
import java.util.List;

/**
 * SSE 行解析（纯逻辑，可 JDK 单测）：
 *  - 支持 chunk 任意拆分（半行/半事件）
 *  - 多行 data: 用 \n 合并为一个事件
 *  - 忽略注释行（: 开头）与空行分隔
 */
final class SseParser {

    private final StringBuilder buffer = new StringBuilder();
    private final StringBuilder data = new StringBuilder();

    /** 喂入任意 chunk，返回本次能解析出的完整事件 data 列表。 */
    List<String> feed(String chunk) {
        List<String> events = new ArrayList<>();
        if (chunk == null || chunk.isEmpty()) return events;
        buffer.append(chunk);
        int newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            String line = buffer.substring(0, newline);
            buffer.delete(0, newline + 1);
            if (line.endsWith("\r")) {
                line = line.substring(0, line.length() - 1);
            }
            handleLine(line, events);
        }
        return events;
    }

    /** 流结束时调用：把最后一条未以空行结束的事件也吐出来。 */
    List<String> finish() {
        List<String> events = new ArrayList<>();
        if (buffer.length() > 0) {
            String line = buffer.toString();
            buffer.setLength(0);
            if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
            handleLine(line, events);
        }
        flush(events);
        return events;
    }

    void reset() {
        buffer.setLength(0);
        data.setLength(0);
    }

    private void handleLine(String line, List<String> events) {
        if (line.isEmpty()) {
            flush(events);
            return;
        }
        if (line.startsWith(":")) {
            return; // 注释 / 心跳
        }
        if (line.startsWith("data:")) {
            String value = line.substring("data:".length());
            if (value.startsWith(" ")) value = value.substring(1);
            if (data.length() > 0) data.append('\n');
            data.append(value);
        }
        // event:/id:/retry: 暂不处理
    }

    private void flush(List<String> events) {
        if (data.length() > 0) {
            events.add(data.toString());
            data.setLength(0);
        }
    }
}
