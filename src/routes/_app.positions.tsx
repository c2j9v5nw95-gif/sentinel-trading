import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/positions")({
  component: PositionsPage,
});

function PositionsPage() {
  const { data } = useQuery({
    queryKey: ["positions"],
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select("*")
        .order("opened_at", { ascending: false });
      return data ?? [];
    },
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader title="Positions" description="Live position state reconciled with Bybit." />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState title="No positions" hint="Open positions will appear here." />
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Protection</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 font-medium">{p.symbol}</td>
                  <td className={p.side === "long" ? "text-success" : "text-danger"}>
                    {p.side.toUpperCase()}
                  </td>
                  <td>{p.qty_open}</td>
                  <td>{p.entry_price}</td>
                  <td>
                    <span
                      className={
                        p.protection_state === "unprotected"
                          ? "text-danger"
                          : p.protection_state === "sl_and_tsl"
                          ? "text-success"
                          : "text-muted-foreground"
                      }
                    >
                      {p.protection_state}
                    </span>
                  </td>
                  <td>{p.tp1_done ? "✓" : "—"}</td>
                  <td>{p.tp2_done ? "✓" : "—"}</td>
                  <td className="text-xs text-muted-foreground">
                    {new Date(p.opened_at).toLocaleString()}
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
