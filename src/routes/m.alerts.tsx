import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fmtAge } from "@/components/overview/format";

export const Route = createFileRoute("/m/alerts")({
  component: AlertsPage,
});

interface Alert {
  id: string;
  category: string;
  message: string;
  severity: "critical" | "warning" | "info" | string;
  created_at: string;
}

const GROUPS: { key: "critical" | "warning" | "info"; label: string; tone: string }[] = [
  { key: "critical", label: "Critical", tone: "text-danger" },
  { key: "warning", label: "Warning", tone: "text-warning" },
  { key: "info", label: "Info", tone: "text-muted-foreground" },
];

function AlertRow({ a }: { a: Alert }) {
  const tone =
    a.severity === "critical"
      ? "border-l-danger"
      : a.severity === "warning"
      ? "border-l-warning"
      : "border-l-border";
  return (
    <div className={`rounded-xl border border-border/50 border-l-2 ${tone} bg-card p-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">{a.category}</div>
        <div className="text-[10px] text-muted-foreground tabular">{fmtAge(a.created_at)}</div>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{a.message}</div>
    </div>
  );
}

function AlertsPage() {
  const { data } = useQuery({
    queryKey: ["mobile", "alerts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("system_alerts")
        .select("id,category,message,severity,created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as Alert[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];
  const grouped = GROUPS.map((g) => ({
    ...g,
    items: rows.filter((r) => r.severity === g.key),
  }));
  const total = rows.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-baseline justify-between px-1">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <span className="text-xs text-muted-foreground tabular">{total} total</span>
      </div>

      {total === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
          All clear
        </div>
      ) : (
        grouped.map((g) =>
          g.items.length === 0 ? null : (
            <section key={g.key}>
              <div className="mb-2 flex items-center justify-between px-1">
                <h2 className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${g.tone}`}>
                  {g.label}
                </h2>
                <span className="text-[11px] tabular text-muted-foreground">{g.items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {g.items.map((a) => (
                  <AlertRow key={a.id} a={a} />
                ))}
              </div>
            </section>
          ),
        )
      )}
    </div>
  );
}
