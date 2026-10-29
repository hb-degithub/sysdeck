package net.hbmin.serverpanel;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

/** DSH 会话列表：按 workspace 分组（组头 + 会话行）。 */
final class DshSessionsAdapter extends RecyclerView.Adapter<DshSessionsAdapter.Holder> {

    interface Listener {
        void onSession(DshSessionInfo session);
    }

    private static final int TYPE_HEADER = 0;
    private static final int TYPE_SESSION = 1;

    private final List<Object> rows = new ArrayList<>(); // String=组头，DshSessionInfo=会话
    private final Listener listener;
    private final long now = System.currentTimeMillis();

    DshSessionsAdapter(Listener listener) {
        this.listener = listener;
    }

    void submit(List<DshSessions.Group> groups) {
        rows.clear();
        for (DshSessions.Group group : groups) {
            rows.add(group.workspace + "（" + group.sessions.size() + "）");
            rows.addAll(group.sessions);
        }
        notifyDataSetChanged();
    }

    int groupCount() {
        int count = 0;
        for (Object row : rows) if (row instanceof String) count++;
        return count;
    }

    @Override
    public int getItemViewType(int position) {
        return rows.get(position) instanceof String ? TYPE_HEADER : TYPE_SESSION;
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        int layout = viewType == TYPE_HEADER
                ? R.layout.item_dsh_group : R.layout.item_dsh_session;
        return new Holder(LayoutInflater.from(parent.getContext()).inflate(layout, parent, false), viewType);
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        Object row = rows.get(position);
        if (holder.viewType == TYPE_HEADER) {
            ((TextView) holder.itemView).setText(String.valueOf(row));
            return;
        }
        final DshSessionInfo session = (DshSessionInfo) row;
        holder.title.setText(session.displayTitle());
        holder.tag.setText(session.tag());
        holder.tag.setTextColor(holder.tag.getContext().getColor(
                session.hasPreset() ? R.color.err
                        : session.resumable ? R.color.accent : R.color.text_secondary));
        holder.meta.setText(DshSessions.rowMeta(session, now));
        holder.itemView.setOnClickListener(v -> listener.onSession(session));
    }

    @Override
    public int getItemCount() {
        return rows.size();
    }

    static final class Holder extends RecyclerView.ViewHolder {
        final int viewType;
        final TextView title;
        final TextView tag;
        final TextView meta;

        Holder(View itemView, int viewType) {
            super(itemView);
            this.viewType = viewType;
            title = itemView.findViewById(R.id.dsh_session_title);
            tag = itemView.findViewById(R.id.dsh_session_tag);
            meta = itemView.findViewById(R.id.dsh_session_meta);
        }
    }
}
