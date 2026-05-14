import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PositionCard, type PositionCardData } from "./PositionCard";

export function OpenPositionsStack() {
  const { data } = useQuery({
    queryKey: ["mobile", "open_positions"],
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
    <section>
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Open positions
        </h2>
        <span className="text-[11px] tabular text-muted-foreground">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
          No open positions
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => (
            <PositionCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </section>
  );
}
