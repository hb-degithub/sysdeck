package net.hbmin.serverpanel;

import android.text.Spannable;
import android.text.SpannableString;
import android.text.style.TypefaceSpan;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

/** 聊天气泡列表：用户右、助手左；``` 代码块用等宽字体；文本可长按选择复制。 */
final class ChatAdapter extends RecyclerView.Adapter<ChatAdapter.Holder> {

    private final List<ChatMessage> items = new ArrayList<>();

    void submit(List<ChatMessage> messages) {
        items.clear();
        if (messages != null) items.addAll(messages);
        notifyDataSetChanged();
    }

    void append(ChatMessage message) {
        items.add(message);
        notifyItemInserted(items.size() - 1);
    }

    int size() {
        return items.size();
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_chat_message, parent, false);
        return new Holder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        ChatMessage message = items.get(position);
        boolean user = message.isUser();
        boolean tool = "tool".equals(message.role);
        LinearLayout row = (LinearLayout) holder.itemView;
        row.setGravity(user ? Gravity.END : Gravity.START);
        TextView bubble = holder.bubble;
        bubble.setBackgroundResource(user ? R.drawable.bubble_user : R.drawable.bubble_assistant);
        if (tool) {
            bubble.setTextColor(bubble.getContext().getColor(R.color.text_secondary));
            bubble.setTextSize(12);
        } else {
            bubble.setTextColor(bubble.getContext().getColor(R.color.text_primary));
            bubble.setTextSize(14);
        }
        bubble.setText(renderText(message.text));
    }

    @Override
    public int getItemCount() {
        return items.size();
    }

    static final class Holder extends RecyclerView.ViewHolder {
        final TextView bubble;

        Holder(View itemView) {
            super(itemView);
            bubble = itemView.findViewById(R.id.chat_bubble);
        }
    }

    /** ``` 包围的段落用等宽字体，其余保持普通字体。 */
    static CharSequence renderText(String text) {
        if (text == null || text.isEmpty()) return "";
        String[] parts = text.split("```", -1);
        StringBuilder plain = new StringBuilder();
        List<int[]> codeRanges = new ArrayList<>();
        for (int i = 0; i < parts.length; i++) {
            int start = plain.length();
            plain.append(parts[i]);
            if (i % 2 == 1 && plain.length() > start) {
                codeRanges.add(new int[]{start, plain.length()});
            }
        }
        SpannableString spannable = new SpannableString(plain.toString());
        for (int[] range : codeRanges) {
            spannable.setSpan(new TypefaceSpan("monospace"), range[0], range[1],
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return spannable;
    }
}
