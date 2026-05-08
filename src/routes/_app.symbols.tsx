import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";

export const Route = createFileRoute("/_app/symbols")({
  component: SymbolsPage,
});

type ModeOverride = "inherit_global" | "paper" | "testnet" | "live";

function SymbolsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["symbols"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*").order("symbol");
      return data ?? [];
    },
  });

  const setOverride = useMutation({
    mutationFn: async (args: { id: string; value: ModeOverride }) => {
      const dbValue = args.value === "inherit_global" ? null : args.value;
      const { error } = await supabase.from("symbols")
        .update({ execution_mode_override: dbValue })
        .eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["symbols"] }),
  });

  return (
    <>
      <PageHeader
        title="Symbols"
        description="Per-symbol sizing, protection and exit configuration. Final exposure = balance × balance% × leverage × multiplier."
      />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No symbols configured"
            hint="Add a symbol to enable trading on it."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Symbol</th>
                  <th>On</th>
                  <th>Mode</th>
                  <th>Transport</th>
                  <th title="Account balance %">Bal %</th>
                  <th>Lev</th>
                  <th title="Position size multiplier">Mult</th>
                  <th>Margin</th>
                  <th>SL %</th>
                  <th>TSL act / cb</th>
                  <th>TP2</th>
                  <th>TP1 %</th>
                  <th title="Hard cap on estimated exposure (USDT)">Max Notional</th>
                  <th title="Hard cap on margin allocated (USDT)">Max Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data!.map((s) => (
                  <tr key={s.id}>
                    <td className="py-2 font-medium">{s.symbol}</td>
                    <td>{s.enabled ? "✓" : "—"}</td>
                    <td>
                      <select
                        value={s.execution_mode_override ?? "inherit_global"}
                        disabled={setOverride.isPending}
                        onChange={(e) => setOverride.mutate({ id: s.id, value: e.target.value as ModeOverride })}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                      >
                        <option value="inherit_global">inherit</option>
                        <option value="paper">paper</option>
                        <option value="testnet">testnet</option>
                        <option value="live">live</option>
                      </select>
                      {s.execution_mode_override
                        ? <span className="ml-1"><ModeChip mode={s.execution_mode_override} /></span>
                        : null}
                    </td>
                    <td className="text-xs">{s.preferred_transport}</td>
                    <td>{s.account_balance_percent}</td>
                    <td>{s.leverage}x</td>
                    <td>{s.position_size_multiplier}</td>
                    <td className="text-xs">{s.margin_mode}</td>
                    <td>{s.sl_pct}</td>
                    <td className="text-xs">
                      {s.tsl_enabled
                        ? `${s.tsl_activation_profit_pct} / ${s.tsl_callback_pct}`
                        : "off"}
                    </td>
                    <td>{s.tp2_enabled ? "✓" : "—"}</td>
                    <td>{s.tp1_exit_percent}</td>
                    <td className={s.max_position_notional_usdt == null ? "text-muted-foreground" : ""}>
                      {s.max_position_notional_usdt == null ? "—" : `${s.max_position_notional_usdt} USDT`}
                    </td>
                    <td className={s.max_margin_usage_usdt == null ? "text-muted-foreground" : ""}>
                      {s.max_margin_usage_usdt == null ? "—" : `${s.max_margin_usage_usdt} USDT`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Sizing model">
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Entry notional</span> = available
            Bybit balance × (balance % ÷ 100) × leverage × multiplier.
          </p>
          <p>
            <span className="font-medium text-foreground">Margin allocated</span> = balance × (balance % ÷ 100).
          </p>
          <p>
            Exits always use the live Bybit position size — multiplier and balance % are
            entry-only. Leverage is applied via Bybit V5 before each entry.
          </p>
          <p>
            <span className="font-medium text-destructive">Hard caps override sizing.</span>{" "}
            If estimated exposure exceeds <code>max_position_notional_usdt</code> or
            margin exceeds <code>max_margin_usage_usdt</code>, the entry is rejected and
            logged as a risk decision (<code>gate=exposure_limit</code>,{" "}
            <code>outcome=block</code>). Trades are never silently shrunk.
          </p>
          <p className="text-xs">
            Validation: balance % ∈ [0.1, 100] · multiplier ∈ [0.1, 3.0] · leverage capped
            by the symbol's Bybit limit · caps must be &gt; 0 when set (blank = no cap).
          </p>
        </div>
      </Card>
    </>
  );
}
