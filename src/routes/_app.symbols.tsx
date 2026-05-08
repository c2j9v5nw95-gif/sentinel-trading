import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/symbols")({
  component: SymbolsPage,
});

function SymbolsPage() {
  const { data } = useQuery({
    queryKey: ["symbols"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*").order("symbol");
      return data ?? [];
    },
  });

  return (
    <>
      <PageHeader
        title="Symbols"
        description="Per-symbol sizing, protection and exit configuration."
      />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No symbols configured"
            hint="Add a symbol from the database to enable trading on it."
          />
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Symbol</th>
                <th>Enabled</th>
                <th>Transport</th>
                <th>Size</th>
                <th>Lev</th>
                <th>SL %</th>
                <th>TSL act / cb</th>
                <th>TP2</th>
                <th>TP1 %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 font-medium">{s.symbol}</td>
                  <td>{s.enabled ? "✓" : "—"}</td>
                  <td className="text-xs">{s.preferred_transport}</td>
                  <td>
                    {s.position_size_value}
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      {s.position_size_mode === "fixed_usdt" ? "USDT" : "% eq"}
                    </span>
                  </td>
                  <td>{s.leverage}x</td>
                  <td>{s.sl_pct}</td>
                  <td className="text-xs">
                    {s.tsl_enabled
                      ? `${s.tsl_activation_profit_pct} / ${s.tsl_callback_pct}`
                      : "off"}
                  </td>
                  <td>{s.tp2_enabled ? "✓" : "—"}</td>
                  <td>{s.tp1_exit_percent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
