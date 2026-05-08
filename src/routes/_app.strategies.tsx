import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/strategies")({
  component: StrategiesPage,
});

function StrategiesPage() {
  const { data } = useQuery({
    queryKey: ["strategies"],
    queryFn: async () => {
      const { data } = await supabase
        .from("strategies")
        .select("*")
        .order("name");
      return data ?? [];
    },
  });

  return (
    <>
      <PageHeader
        title="Strategies"
        description="Per (strategy, tag) configuration and health thresholds."
      />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No strategies registered"
            hint="Strategies are auto-registered the first time a TradingView alert is received."
          />
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Name</th>
                <th>Tag</th>
                <th>Enabled</th>
                <th>Min winrate</th>
                <th>Min PF</th>
                <th>Min net profit</th>
                <th>Last health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 font-medium">{s.name}</td>
                  <td>{s.tag || "—"}</td>
                  <td>{s.enabled ? "✓" : "—"}</td>
                  <td>{s.health_min_winrate ?? "—"}</td>
                  <td>{s.health_min_profit_factor ?? "—"}</td>
                  <td>{s.health_min_net_profit ?? "—"}</td>
                  <td className="text-xs text-muted-foreground">
                    {s.last_health_at
                      ? new Date(s.last_health_at).toLocaleString()
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
