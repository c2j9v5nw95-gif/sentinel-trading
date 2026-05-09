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

const LIVE_DEFAULTS = {
  account_balance_percent: 5,
  leverage: 10,
  position_size_multiplier: 1.0,
};

const LIVE_CONFIRM_PHRASE = "ENABLE LIVE";

type SymbolRow = {
  id: string;
  symbol: string;
  enabled: boolean;
  execution_mode_override: string | null;
  preferred_transport: string;
  account_balance_percent: number;
  leverage: number;
  position_size_multiplier: number;
  margin_mode: string;
  sl_pct: number;
  tsl_enabled: boolean;
  tsl_activation_profit_pct: number;
  tsl_callback_pct: number;
  tp2_enabled: boolean;
  tp1_exit_percent: number;
  max_position_notional_usdt: number | null;
  max_margin_usage_usdt: number | null;
};

function SymbolsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["symbols"],
    queryFn: async () => {
      const { data } = await supabase.from("symbols").select("*").order("symbol");
      return (data ?? []) as SymbolRow[];
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingLive, setPendingLive] = useState<null | { id: string; symbol: string }>(null);
  const [adding, setAdding] = useState(false);

  const addSymbol = useMutation({
    mutationFn: async (args: { symbol: string; category: string; enabled: boolean }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase.from("symbols").insert({
        symbol: args.symbol,
        category: args.category,
        enabled: args.enabled,
        execution_mode_override: null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["symbols"] }),
  });

  const updateSymbol = useMutation({
    mutationFn: async (args: { id: string; patch: Record<string, unknown> }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await supabase.from("symbols").update(args.patch as any).eq("id", args.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["symbols"] }),
  });

  const onModeChange = (s: SymbolRow, value: ModeOverride) => {
    if (value === "live") {
      setPendingLive({ id: s.id, symbol: s.symbol });
      return;
    }
    const dbValue = value === "inherit_global" ? null : value;
    updateSymbol.mutate({ id: s.id, patch: { execution_mode_override: dbValue } });
  };

  return (
    <>
      <PageHeader
        title="Symbols"
        description="Per-symbol sizing, protection and exit configuration. Final exposure = balance × balance% × leverage × multiplier."
        actions={
          <button
            onClick={() => setAdding(true)}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            + Add symbol
          </button>
        }
      />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState title="No symbols configured" hint="Add a symbol to enable trading on it." />
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
                  <th></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data!.map((s) => (
                  <SymbolRowView
                    key={s.id}
                    s={s}
                    editing={editingId === s.id}
                    busy={updateSymbol.isPending}
                    onEdit={() => setEditingId(s.id)}
                    onCancel={() => setEditingId(null)}
                    onModeChange={(v) => onModeChange(s, v)}
                    onSave={(patch) =>
                      updateSymbol.mutate(
                        { id: s.id, patch },
                        { onSuccess: () => setEditingId(null) },
                      )
                    }
                  />
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
            updateSymbol.mutate(
              {
                id: pendingLive.id,
                patch: { execution_mode_override: "live", ...LIVE_DEFAULTS },
              },
              { onSuccess: () => setPendingLive(null) },
            );
          }}
        />
      )}

      {adding && (
        <AddSymbolDialog
          existing={(data ?? []).map((s) => s.symbol.toUpperCase())}
          busy={addSymbol.isPending}
          onCancel={() => setAdding(false)}
          onConfirm={(args) =>
            addSymbol.mutate(args, {
              onSuccess: () => setAdding(false),
              onError: (e) => alert((e as Error).message),
            })
          }
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Row (read + edit)
// ---------------------------------------------------------------------------

type Draft = {
  enabled: boolean;
  preferred_transport: string;
  account_balance_percent: string;
  leverage: string;
  position_size_multiplier: string;
  margin_mode: string;
  sl_pct: string;
  tsl_enabled: boolean;
  tsl_activation_profit_pct: string;
  tsl_callback_pct: string;
  tp2_enabled: boolean;
  tp1_exit_percent: string;
  max_position_notional_usdt: string;
  max_margin_usage_usdt: string;
};

const toDraft = (s: SymbolRow): Draft => ({
  enabled: s.enabled,
  preferred_transport: s.preferred_transport,
  account_balance_percent: String(s.account_balance_percent),
  leverage: String(s.leverage),
  position_size_multiplier: String(s.position_size_multiplier),
  margin_mode: s.margin_mode,
  sl_pct: String(s.sl_pct),
  tsl_enabled: s.tsl_enabled,
  tsl_activation_profit_pct: String(s.tsl_activation_profit_pct),
  tsl_callback_pct: String(s.tsl_callback_pct),
  tp2_enabled: s.tp2_enabled,
  tp1_exit_percent: String(s.tp1_exit_percent),
  max_position_notional_usdt: s.max_position_notional_usdt == null ? "" : String(s.max_position_notional_usdt),
  max_margin_usage_usdt: s.max_margin_usage_usdt == null ? "" : String(s.max_margin_usage_usdt),
});

function validateDraft(d: Draft): { ok: boolean; patch?: Record<string, unknown>; error?: string } {
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));

  const bp = num(d.account_balance_percent);
  const lev = num(d.leverage);
  const mult = num(d.position_size_multiplier);
  const sl = num(d.sl_pct);
  const tslAct = num(d.tsl_activation_profit_pct);
  const tslCb = num(d.tsl_callback_pct);
  const tp1 = num(d.tp1_exit_percent);
  const maxNot = numOrNull(d.max_position_notional_usdt);
  const maxMar = numOrNull(d.max_margin_usage_usdt);

  if (!(bp >= 0 && bp <= 100)) return { ok: false, error: "Bal % must be 0–100" };
  if (!(lev >= 1 && lev <= 100)) return { ok: false, error: "Leverage must be 1–100" };
  if (!(mult > 0)) return { ok: false, error: "Multiplier must be > 0" };
  if (!(sl > 0)) return { ok: false, error: "SL % must be > 0" };
  if (!(tslAct >= 0)) return { ok: false, error: "TSL activation must be ≥ 0" };
  if (!(tslCb > 0)) return { ok: false, error: "TSL callback must be > 0" };
  if (!(tp1 >= 1 && tp1 <= 100)) return { ok: false, error: "TP1 % must be 1–100" };
  if (maxNot != null && !(maxNot >= 0)) return { ok: false, error: "Max notional must be ≥ 0" };
  if (maxMar != null && !(maxMar >= 0)) return { ok: false, error: "Max margin must be ≥ 0" };

  return {
    ok: true,
    patch: {
      enabled: d.enabled,
      preferred_transport: d.preferred_transport,
      account_balance_percent: bp,
      leverage: lev,
      position_size_multiplier: mult,
      margin_mode: d.margin_mode,
      sl_pct: sl,
      tsl_enabled: d.tsl_enabled,
      tsl_activation_profit_pct: tslAct,
      tsl_callback_pct: tslCb,
      tp2_enabled: d.tp2_enabled,
      tp1_exit_percent: tp1,
      max_position_notional_usdt: maxNot,
      max_margin_usage_usdt: maxMar,
    },
  };
}

function SymbolRowView({
  s, editing, busy, onEdit, onCancel, onModeChange, onSave,
}: {
  s: SymbolRow;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onModeChange: (v: ModeOverride) => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(s));
  const isLive = s.execution_mode_override === "live";

  // Reset draft when entering edit mode for a fresh row.
  if (editing && draft && (draft as Draft & { __id?: string }).__id !== s.id) {
    // re-init when switching rows (defensive)
  }

  const handleEdit = () => {
    setDraft(toDraft(s));
    onEdit();
  };

  const handleSave = () => {
    const v = validateDraft(draft);
    if (!v.ok) {
      alert(v.error);
      return;
    }
    onSave(v.patch!);
  };

  if (!editing) {
    return (
      <tr className={isLive ? "bg-danger/10" : ""}>
        <td className="py-2 font-medium">{s.symbol}</td>
        <td>{s.enabled ? "✓" : "—"}</td>
        <td>
          <select
            value={s.execution_mode_override ?? "inherit_global"}
            disabled={busy}
            onChange={(e) => onModeChange(e.target.value as ModeOverride)}
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
            ? <span className="ml-1"><ModeChip mode={s.execution_mode_override as "paper" | "testnet" | "live"} /></span>
            : null}
        </td>
        <td className="text-xs">{s.preferred_transport}</td>
        <td>{s.account_balance_percent}</td>
        <td>{s.leverage}x</td>
        <td>{s.position_size_multiplier}</td>
        <td className="text-xs">{s.margin_mode}</td>
        <td>{s.sl_pct}</td>
        <td className="text-xs">
          {s.tsl_enabled ? `${s.tsl_activation_profit_pct} / ${s.tsl_callback_pct}` : "off"}
        </td>
        <td>{s.tp2_enabled ? "✓" : "—"}</td>
        <td>{s.tp1_exit_percent}</td>
        <td className={s.max_position_notional_usdt == null ? "text-muted-foreground" : ""}>
          {s.max_position_notional_usdt == null ? "—" : `${s.max_position_notional_usdt} USDT`}
        </td>
        <td className={s.max_margin_usage_usdt == null ? "text-muted-foreground" : ""}>
          {s.max_margin_usage_usdt == null ? "—" : `${s.max_margin_usage_usdt} USDT`}
        </td>
        <td>
          <button
            onClick={handleEdit}
            className="rounded border border-border bg-background px-2 py-0.5 text-xs hover:bg-muted"
          >
            Edit
          </button>
        </td>
      </tr>
    );
  }

  // Editing row
  const inputCls = "w-16 rounded border border-border bg-background px-1 py-0.5 text-xs";
  const selectCls = "rounded border border-border bg-background px-1 py-0.5 text-xs";

  return (
    <tr className="bg-muted/30">
      <td className="py-2 font-medium">{s.symbol}</td>
      <td>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
      </td>
      <td>
        <select
          value={s.execution_mode_override ?? "inherit_global"}
          disabled={busy}
          onChange={(e) => onModeChange(e.target.value as ModeOverride)}
          className={`${selectCls} ${isLive ? "border-danger text-danger font-bold" : ""}`}
        >
          <option value="inherit_global">inherit</option>
          <option value="paper">paper</option>
          <option value="testnet">testnet</option>
          <option value="live">live</option>
        </select>
      </td>
      <td>
        <select
          value={draft.preferred_transport}
          onChange={(e) => setDraft({ ...draft, preferred_transport: e.target.value })}
          className={selectCls}
        >
          <option value="webhook">webhook</option>
          <option value="email">email</option>
        </select>
      </td>
      <td>
        <input
          type="number" step="0.1" className={inputCls}
          value={draft.account_balance_percent}
          onChange={(e) => setDraft({ ...draft, account_balance_percent: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number" step="1" className={inputCls}
          value={draft.leverage}
          onChange={(e) => setDraft({ ...draft, leverage: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number" step="0.1" className={inputCls}
          value={draft.position_size_multiplier}
          onChange={(e) => setDraft({ ...draft, position_size_multiplier: e.target.value })}
        />
      </td>
      <td>
        <select
          value={draft.margin_mode}
          onChange={(e) => setDraft({ ...draft, margin_mode: e.target.value })}
          className={selectCls}
        >
          <option value="isolated">isolated</option>
          <option value="cross">cross</option>
        </select>
      </td>
      <td>
        <input
          type="number" step="0.1" className={inputCls}
          value={draft.sl_pct}
          onChange={(e) => setDraft({ ...draft, sl_pct: e.target.value })}
        />
      </td>
      <td>
        <div className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={draft.tsl_enabled}
            onChange={(e) => setDraft({ ...draft, tsl_enabled: e.target.checked })}
          />
          <input
            type="number" step="0.1" className="w-12 rounded border border-border bg-background px-1 py-0.5 text-xs"
            value={draft.tsl_activation_profit_pct}
            disabled={!draft.tsl_enabled}
            onChange={(e) => setDraft({ ...draft, tsl_activation_profit_pct: e.target.value })}
          />
          <span className="text-xs">/</span>
          <input
            type="number" step="0.1" className="w-12 rounded border border-border bg-background px-1 py-0.5 text-xs"
            value={draft.tsl_callback_pct}
            disabled={!draft.tsl_enabled}
            onChange={(e) => setDraft({ ...draft, tsl_callback_pct: e.target.value })}
          />
        </div>
      </td>
      <td>
        <input
          type="checkbox"
          checked={draft.tp2_enabled}
          onChange={(e) => setDraft({ ...draft, tp2_enabled: e.target.checked })}
        />
      </td>
      <td>
        <input
          type="number" step="1" className={inputCls}
          value={draft.tp1_exit_percent}
          onChange={(e) => setDraft({ ...draft, tp1_exit_percent: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number" step="1" className="w-20 rounded border border-border bg-background px-1 py-0.5 text-xs"
          placeholder="—"
          value={draft.max_position_notional_usdt}
          onChange={(e) => setDraft({ ...draft, max_position_notional_usdt: e.target.value })}
        />
      </td>
      <td>
        <input
          type="number" step="1" className="w-20 rounded border border-border bg-background px-1 py-0.5 text-xs"
          placeholder="—"
          value={draft.max_margin_usage_usdt}
          onChange={(e) => setDraft({ ...draft, max_margin_usage_usdt: e.target.value })}
        />
      </td>
      <td>
        <div className="flex gap-1">
          <button
            onClick={handleSave}
            disabled={busy}
            className="rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-border bg-background px-2 py-0.5 text-xs hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
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
