import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, EmptyState } from "@/components/PageHeader";
import { fmtAge } from "./format";

interface Signal {
  id: string;
  symbol: string | null;
  action: string | null;
  status: string;
  decision_reason: string | null;
  created_at: string;
}

interface Alert {
  id: string;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
  created_at: string;
  acknowledged_at: string | null;
}

interface Item {
  id: string;
  kind: "rejection" | "alert";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  created_at: string;
}

export function RecentExecutionEventsList() {
  const { data: rejections } = useQuery({
    queryKey: ["overview", "rejected_signals"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signals")
        .select("id,symbol,action,status,decision_reason,created_at")
        .in("status", ["rejected", "failed"])
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Signal[];
    },
    refetchInterval: 10_000,
  });

  const { data: alerts } = useQuery({
    queryKey: ["overview", "exec_alerts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_alerts")
        .select("id,severity,category,message,created_at,acknowledged_at")
        .in("severity", ["warning", "critical"])
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as Alert[];
    },
    refetchInterval: 10_000,
  });

  const items: Item[] = [];
  for (const r of rejections ?? []) {
    items.push({
      id: `sig-${r.id}`,
      kind: "rejection",
      severity: r.status === "failed" ? "critical" : "warning",
      title: `${r.status.toUpperCase()} · ${r.symbol ?? "—"} ${r.action ?? ""}`.trim(),
      detail: r.decision_reason ?? "no reason recorded",
      created_at: r.created_at,
    });
  }
  for (const a of alerts ?? []) {
    items.push({
      id: `alert-${a.id}`,
      kind: "alert",
      severity: a.severity,
      title: `${a.severity.toUpperCase()} · ${a.category}`,
      detail: a.message,
      created_at: a.created_at,
    });
  }
  items.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  const top = items.slice(0, 12);

  return (
    <Card title="Recent execution & rejection events">
      {top.length === 0 ? (
        <EmptyState title="Quiet" hint="No recent rejections or warnings." />
      ) : (
        <ul className="divide-y divide-border">
          {top.map((it) => (
            <li key={it.id} className="flex items-start gap-3 py-2 text-xs">
              <span
                className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  it.severity === "critical"
                    ? "bg-danger"
                    : it.severity === "warning"
                    ? "bg-warning"
                    : "bg-muted-foreground"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div
                  className={`font-medium ${
                    it.severity === "critical"
                      ? "text-danger"
                      : it.severity === "warning"
                      ? "text-warning"
                      : "text-foreground"
                  }`}
                >
                  {it.title}
                </div>
                <div className="truncate text-muted-foreground" title={it.detail}>
                  {it.detail}
                </div>
              </div>
              <div className="shrink-0 text-[10px] text-muted-foreground">{fmtAge(it.created_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
