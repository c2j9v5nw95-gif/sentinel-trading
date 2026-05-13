import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, EmptyState } from "@/components/PageHeader";
import { fmtNum, fmtSigned, fmtAge } from "./format";

const STALE_MINUTES = 120;

interface Snapshot {
  symbol: string;
  profit_factor: number | null;
  net_profit: number | null;
  winrate: number | null;
  created_at: string;
}

interface Thresholds {
  pf: number | null;
  net: number | null;
  wr: number | null;
}

type Status = "open" | "blocked" | "stale" | "no_data";

interface Row {
  symbol: string;
  status: Status;
  pf: number | null;
  net: number | null;
  wr: number | null;
  capturedAt: string | null;
  breaches: string[];
}

function classify(snap: Snapshot | undefined, t: Thresholds): Row {
  if (!snap) {
    return {
      symbol: "",
      status: "no_data",
      pf: null,
      net: null,
      wr: null,
      capturedAt: null,
      breaches: [],
    };
  }

  const ageMs = Date.now() - new Date(snap.created_at).getTime();
  const isStale = ageMs > STALE_MINUTES * 60 * 1000;

  const breaches: string[] = [];
  if (t.pf != null && snap.profit_factor != null && Number(snap.profit_factor) < t.pf) {
    breaches.push(`PF ${fmtNum(Number(snap.profit_factor), 2)} < ${fmtNum(t.pf, 2)}`);
  }
  if (t.net != null && snap.net_profit != null && Number(snap.net_profit) < t.net) {
    breaches.push(`Net ${fmtSigned(Number(snap.net_profit))} < ${fmtSigned(t.net)}`);
  }
  if (t.wr != null && snap.winrate != null && Number(snap.winrate) < t.wr) {
    breaches.push(`WR ${fmtNum(Number(snap.winrate), 1)} < ${fmtNum(t.wr, 1)}`);
  }

  let status: Status;
  if (isStale) status = "stale";
  else if (breaches.length > 0) status = "blocked";
  else status = "open";

  return {
    symbol: snap.symbol,
    status,
    pf: snap.profit_factor != null ? Number(snap.profit_factor) : null,
    net: snap.net_profit != null ? Number(snap.net_profit) : null,
    wr: snap.winrate != null ? Number(snap.winrate) : null,
    capturedAt: snap.created_at,
    breaches,
  };
}

export function SymbolHealthPanel({ symbol }: { symbol: string | null }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["overview", "symbol_health", symbol],
    refetchInterval: 30_000,
    queryFn: async () => {
      let symQ = supabase
        .from("symbols")
        .select("symbol")
        .eq("enabled", true)
        .order("symbol", { ascending: true });
      if (symbol) symQ = symQ.eq("symbol", symbol);
      const { data: syms, error: symErr } = await symQ;
      if (symErr) throw symErr;
      const symbols = (syms ?? []).map((r) => r.symbol as string);

      const { data: strat } = await supabase
        .from("strategies")
        .select("health_min_profit_factor,health_min_net_profit,health_min_winrate")
        .eq("name", "HEALTH_ALL")
        .eq("tag", "")
        .maybeSingle();
      const thresholds: Thresholds = {
        pf: strat?.health_min_profit_factor != null ? Number(strat.health_min_profit_factor) : null,
        net: strat?.health_min_net_profit != null ? Number(strat.health_min_net_profit) : null,
        wr: strat?.health_min_winrate != null ? Number(strat.health_min_winrate) : null,
      };

      if (symbols.length === 0) {
        return { rows: [] as Row[], thresholds };
      }
      const { data: snaps, error: snapErr } = await supabase
        .from("health_snapshots")
        .select("symbol,profit_factor,net_profit,winrate,created_at")
        .eq("strategy", "HEALTH_ALL")
        .eq("tag", "")
        .in("symbol", symbols)
        .order("created_at", { ascending: false })
        .limit(2000);
      if (snapErr) throw snapErr;

      const latest = new Map<string, Snapshot>();
      for (const s of (snaps ?? []) as Snapshot[]) {
        if (!latest.has(s.symbol)) latest.set(s.symbol, s);
      }

      const rows: Row[] = symbols.map((sym) => {
        const r = classify(latest.get(sym), thresholds);
        return { ...r, symbol: sym };
      });
      return { rows, thresholds };
    },
  });

  const rows = data?.rows ?? [];
  const open = rows.filter((r) => r.status === "open");
  const blocked = rows.filter((r) => r.status === "blocked");
  const stale = rows.filter((r) => r.status === "stale");
  const noData = rows.filter((r) => r.status === "no_data");

  const t = data?.thresholds;
  const thresholdLabel = t
    ? [
        t.pf != null ? `PF ≥ ${fmtNum(t.pf, 2)}` : null,
        t.net != null ? `Net ≥ ${fmtSigned(t.net)}` : null,
        t.wr != null ? `WR ≥ ${fmtNum(t.wr, 1)}%` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  async function handleDisable(sym: string) {
    if (!window.confirm(`Disable ${sym}? It will auto-reactivate if a HEALTH_ALL alert arrives again.`)) {
      return;
    }
    setBusy(sym);
    try {
      const { error } = await supabase.from("symbols").update({ enabled: false }).eq("symbol", sym);
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["overview", "symbol_health"] });
    } catch (e) {
      window.alert(`Failed to disable ${sym}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const titleParts = [
    `${open.length} open`,
    `${blocked.length} blocked`,
    stale.length ? `${stale.length} stale` : null,
    noData.length ? `${noData.length} no data` : null,
  ].filter(Boolean);

  return (
    <Card title={`Symbol health · ${titleParts.join(" · ")}`}>
      {rows.length === 0 ? (
        <EmptyState title="No enabled symbols" />
      ) : (
        <div className="space-y-3">
          {thresholdLabel && (
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Thresholds (HEALTH_ALL): {thresholdLabel} · Stale after {STALE_MINUTES} min
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Column title="Open for trades" tone="success" rows={open} />
            <Column title="Blocked by health" tone="danger" rows={[...blocked, ...noData]} />
          </div>
          {stale.length > 0 && (
            <StaleSection rows={stale} onDisable={handleDisable} busy={busy} />
          )}
        </div>
      )}
    </Card>
  );
}

function Column({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: "success" | "danger";
  rows: Row[];
}) {
  return (
    <div>
      <div
        className={`mb-2 text-[10px] font-semibold uppercase tracking-wider ${tone === "success" ? "text-success" : "text-danger"}`}
      >
        {title} ({rows.length})
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <ul className="divide-y divide-border/50">
          {rows.map((r) => (
            <SymbolRow key={r.symbol} row={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StaleSection({
  rows,
  onDisable,
  busy,
}: {
  rows: Row[];
  onDisable: (sym: string) => void;
  busy: string | null;
}) {
  return (
    <div className="rounded border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-warning">
        Stale — no health alert &gt; {STALE_MINUTES} min ({rows.length})
      </div>
      <div className="mb-2 text-[11px] text-muted-foreground">
        These symbols are blocked from new entries until a fresh HEALTH_ALL snapshot arrives. If the alert was removed in TradingView intentionally, disable the symbol here to clean up the list.
      </div>
      <ul className="divide-y divide-border/50">
        {rows.map((r) => (
          <li key={r.symbol} className="flex items-center justify-between gap-2 py-1.5 text-xs tabular">
            <span className="font-semibold">{r.symbol}</span>
            <div className="flex items-center gap-3 text-muted-foreground">
              <span title={r.capturedAt ? `Last snapshot: ${r.capturedAt}` : ""}>
                last {r.capturedAt ? fmtAge(r.capturedAt) : "—"}
              </span>
              <span className="opacity-70">
                PF {r.pf != null ? fmtNum(r.pf, 2) : "—"} · Net {r.net != null ? fmtSigned(r.net) : "—"}
              </span>
              <button
                type="button"
                onClick={() => onDisable(r.symbol)}
                disabled={busy === r.symbol}
                className="rounded border border-danger/50 bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-danger transition hover:bg-danger/20 disabled:opacity-50"
              >
                {busy === r.symbol ? "…" : "Disable"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SymbolRow({ row }: { row: Row }) {
  const tooltip =
    row.status === "blocked"
      ? `Blocked: ${row.breaches.join(", ")} · snapshot ${fmtAge(row.capturedAt!)}`
      : row.status === "no_data"
      ? "No HEALTH_ALL snapshot received yet — gate passes (advisory)."
      : row.status === "stale"
      ? `Stale · last snapshot ${fmtAge(row.capturedAt!)}`
      : row.capturedAt
      ? `Healthy · snapshot ${fmtAge(row.capturedAt)}`
      : "";
  return (
    <li className="flex items-center justify-between gap-2 py-1.5 text-xs tabular" title={tooltip}>
      <span className="font-semibold">{row.symbol}</span>
      <div className="flex items-center gap-3 text-muted-foreground">
        <span>
          PF{" "}
          <span className={row.pf != null && row.pf < 1 ? "text-danger" : "text-foreground"}>
            {row.pf != null ? fmtNum(row.pf, 2) : "—"}
          </span>
        </span>
        <span>
          Net{" "}
          <span
            className={
              row.net == null ? "text-foreground" : row.net < 0 ? "text-danger" : "text-success"
            }
          >
            {row.net != null ? fmtSigned(row.net) : "—"}
          </span>
        </span>
        <StatusPill status={row.status} />
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: Status }) {
  if (status === "open") {
    return (
      <span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success">
        Open
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-danger">
        Blocked
      </span>
    );
  }
  if (status === "stale") {
    return (
      <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warning">
        Stale
      </span>
    );
  }
  return (
    <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
      No data
    </span>
  );
}
