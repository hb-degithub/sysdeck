package net.hbmin.serverpanel;

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

/** DSH 历史消息气泡：user 右、assistant 左、tool 折叠一行（点击展开参数/结果）。 */
final class DshMessageAdapter extends RecyclerView.Adapter<DshMessageAdapter.Holder> {

    private final List<DshMessage> items = new ArrayList<>();

    void submit(List<DshMessage> messages) {
        items.clear();
        if (messages != null) items.addAll(messages);
        notifyDataSetChanged();
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
        DshMessage message = items.get(position);
        LinearLayout row = (LinearLayout) holder.itemView;
        TextView bubble = holder.bubble;

        if (message.kind == DshMessage.KIND_USER) {
            row.setGravity(Gravity.END);
            bubble.setBackgroundResource(R.drawable.bubble_user);
            bubble.setTextColor(bubble.getContext().getColor(R.color.text_primary));
            bubble.setTextSize(14);
            bubble.setText(HistoryMapper.map("user", message.text, message.ts,
                    null, null, null).text);
            bubble.setClickable(false);
        } else if (message.kind == DshMessage.KIND_TOOL) {
            row.setGravity(Gravity.START);
            bubble.setBackgroundResource(R.drawable.bubble_assistant);
            bubble.setTextColor(bubble.getContext().getColor(R.color.text_secondary));
            bubble.setTextSize(12);
            bubble.setText(message.expanded ? message.toolExpandedText() : message.toolSummary());
            bubble.setClickable(true);
            bubble.setOnClickListener(v -> {
                message.expanded = !message.expanded;
                notifyItemChanged(holder.getAdapterPosition());
            });
        } else {
            row.setGravity(Gravity.START);
            bubble.setBackgroundResource(R.drawable.bubble_assistant);
            bubble.setTextColor(bubble.getContext().getColor(R.color.text_primary));
            bubble.setTextSize(14);
            bubble.setText(ChatAdapter.renderText(message.text));
            bubble.setClickable(false);
        }
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
}
