import { Card, EmptyState } from "@/components/PageHeader";
import type { SignalLite } from "@/lib/symbol-metrics";

const REPLAY_ELIGIBLE = new Set(["rejected", "error", "skipped"]);

function statusTone(s: string) {
  switch (s) {
    case "executed":
    case "succeeded":
      return "border-success/40 bg-success/10 text-success";
    case "rejected":
    case "error":
      return "border-danger/40 bg-danger/10 text-danger";
    case "skipped":
      return "border-warning/40 bg-warning/10 text-warning";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function SignalHistoryTable({ signals }: { signals: SignalLite[] }) {
  const rows = [...signals]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 50);

  return (
    <Card title={`Signal history (${rows.length})`}>
      {rows.length === 0 ? (
        <EmptyState title="Ingen signaler" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular">
            <thead className="text-left uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Tid</th>
                <th>Type</th>
                <th>Action</th>
                <th>Status</th>
                <th>Decision reason</th>
                <th>Replay</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 text-muted-foreground">
                    {new Date(s.created_at).toLocaleString()}
                  </td>
                  <td>{s.type}</td>
                  <td>{s.action ?? "—"}</td>
                  <td>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${statusTone(
                        s.status,
                      )}`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="max-w-[420px] truncate text-muted-foreground" title={s.decision_reason ?? ""}>
                    {s.decision_reason ?? "—"}
                  </td>
                  <td>
                    {REPLAY_ELIGIBLE.has(s.status) ? (
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        eligible
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted-foreground">
            Replay-handlinger utføres på Signals-siden.
          </p>
        </div>
      )}
    </Card>
  );
}
