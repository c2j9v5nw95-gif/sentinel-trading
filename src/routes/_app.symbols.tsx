import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";
import { useState } from "react";

export const Route = createFileRoute("/_app/symbols")({
  component: SymbolsPage,
});

type ModeOverride = "inherit_global" | "paper" | "testnet" | "live";

// Live default sizing per spec.
const LIVE_DEFAULTS = {
  account_balance_percent: 5,
  leverage: 10,
  position_size_multiplier: 1.0,
};

const LIVE_CONFIRM_PHRASE = "ENABLE LIVE";

function SymbolsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["symbols"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*").order("symbol");
      return data ?? [];
    },
  });

  const { data: wallet } = useQuery({
    queryKey: ["paper-wallet-equity"],
    queryFn: async () => {
      const { data } = await supabase.from("paper_wallet").select("equity_usdt").maybeSingle();
      return data;
    },
  });
  const balanceUsdt = Number(wallet?.equity_usdt ?? 10000);

  const [pendingLive, setPendingLive] = useState<null | {
    id: string; symbol: string;
  }>(null);

  const setOverride = useMutation({
    mutationFn: async (args: { id: string; value: ModeOverride; applyLiveDefaults?: boolean }) => {
      const dbValue = args.value === "inherit_global" ? null : args.value;
      const patch: Record<string, unknown> = { execution_mode_override: dbValue };
      if (args.applyLiveDefaults) Object.assign(patch, LIVE_DEFAULTS);
      const { error } = await supabase.from("symbols").update(patch).eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["symbols"] }),
  });

  const onModeChange = (s: any, value: ModeOverride) => {
    if (value === "live") {
      setPendingLive({ id: s.id, symbol: s.symbol });
      return;
    }
    setOverride.mutate({ id: s.id, value });
  };

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
                {data!.map((s) => {
                  const isLive = s.execution_mode_override === "live";
                  return (
                    <tr key={s.id} className={isLive ? "bg-danger/10" : ""}>
                      <td className="py-2 font-medium">{s.symbol}</td>
                      <td>{s.enabled ? "✓" : "—"}</td>
                      <td>
                        <select
                          value={s.execution_mode_override ?? "inherit_global"}
                          disabled={setOverride.isPending}
                          onChange={(e) => onModeChange(s, e.target.value as ModeOverride)}
                          className={`rounded border bg-background px-1.5 py-0.5 text-xs ${
                            isLive ? "border-danger text-danger font-bold" : "border-border"
                          }`}
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
                  );
                })}
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
            Live default sizing on switch: <code>account_balance_percent=5</code>,{" "}
            <code>leverage=10</code>, <code>multiplier=1.0</code>. Operator may adjust afterwards.
          </p>
        </div>
      </Card>

      {pendingLive && (
        <ConfirmLiveDialog
          symbol={pendingLive.symbol}
          balanceUsdt={balanceUsdt}
          onCancel={() => setPendingLive(null)}
          onConfirm={() => {
            setOverride.mutate(
              { id: pendingLive.id, value: "live", applyLiveDefaults: true },
              { onSuccess: () => setPendingLive(null) },
            );
          }}
        />
      )}
    </>
  );
}

function ConfirmLiveDialog({
  symbol, balanceUsdt, onCancel, onConfirm,
}: {
  symbol: string;
  balanceUsdt: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const margin = balanceUsdt * (LIVE_DEFAULTS.account_balance_percent / 100);
  const exposure = margin * LIVE_DEFAULTS.leverage * LIVE_DEFAULTS.position_size_multiplier;
  const ok = phrase.trim() === LIVE_CONFIRM_PHRASE;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-lg border-2 border-danger bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <span className="rounded bg-danger px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-danger-foreground">
            ⚠ LIVE
          </span>
          <h2 className="text-lg font-semibold">Switch {symbol} to live trading?</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Real funds will be at risk. The system will apply default live sizing
          immediately. You can adjust afterwards in the symbols table.
        </p>

        <div className="mb-4 rounded border border-border bg-background/60 p-3 text-sm">
          <Row k="Symbol" v={symbol} />
          <Row k="Leverage" v={`${LIVE_DEFAULTS.leverage}x`} />
          <Row k="Balance %" v={`${LIVE_DEFAULTS.account_balance_percent}%`} />
          <Row k="Multiplier" v={`${LIVE_DEFAULTS.position_size_multiplier}`} />
          <Row k="Reference balance" v={`${balanceUsdt.toFixed(2)} USDT`} />
          <Row k="Margin allocated" v={`${margin.toFixed(2)} USDT`} />
          <Row k="Estimated exposure" v={`${exposure.toFixed(2)} USDT`} highlight />
        </div>

        <label className="mb-1 block text-xs uppercase text-muted-foreground">
          Type <code className="text-danger">{LIVE_CONFIRM_PHRASE}</code> to confirm
        </label>
        <input
          autoFocus
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          className="mb-4 w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
          placeholder={LIVE_CONFIRM_PHRASE}
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded border border-border bg-background px-4 py-2 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            disabled={!ok}
            onClick={onConfirm}
            className="rounded bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enable live for {symbol}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${highlight ? "font-bold text-danger" : ""}`}>{v}</span>
    </div>
  );
}
