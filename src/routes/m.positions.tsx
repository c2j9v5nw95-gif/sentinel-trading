import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PositionCard, type PositionCardData } from "@/components/mobile/pulse/PositionCard";

export const Route = createFileRoute("/m/positions")({
  component: PositionsListPage,
});

function PositionsListPage() {
  const { data } = useQuery({
    queryKey: ["mobile", "positions_list"],
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select(
          "id,symbol,side,qty_open,entry_price,last_seen_price,opened_at,protection_state,exit_recovery_state,execution_mode",
        )
        .is("closed_at", null)
        .order("opened_at", { ascending: false });
      return (data ?? []) as PositionCardData[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between px-1">
        <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
        <span className="text-xs text-muted-foreground tabular">{rows.length} open</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
          No open positions
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => (
            <PositionCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
