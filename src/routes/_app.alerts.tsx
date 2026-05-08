import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/alerts")({
  component: AlertsPage,
});

function AlertsPage() {
  const { data } = useQuery({
    queryKey: ["alerts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("system_alerts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader title="System alerts" description="Critical and warning events from the engine." />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState title="No alerts" hint="System is quiet." />
        ) : (
          <ul className="divide-y divide-border">
            {data!.map((a) => (
              <li key={a.id} className="flex items-start gap-3 py-3">
                <span
                  className={`mt-0.5 inline-flex shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${
                    a.severity === "critical"
                      ? "bg-danger/15 text-danger border-danger/40"
                      : a.severity === "warning"
                      ? "bg-warning/15 text-warning border-warning/40"
                      : "bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {a.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{a.category}</div>
                  <div className="text-xs text-muted-foreground">{a.message}</div>
                </div>
                <span className="text-xs text-muted-foreground tabular">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
