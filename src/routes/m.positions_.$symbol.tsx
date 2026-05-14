import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { fmtNum, fmtSigned, pnlTone, fmtDuration } from "@/components/overview/format";

export const Route = createFileRoute("/m/positions_/$symbol")({
  component: PositionDetailPage,
});

interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  last_seen_price: number | null;
  opened_at: string;
  closed_at: string | null;
  protection_state: string;
  sl_price: number | null;
  tp1_done: boolean;
  tp2_done: boolean;
  exit_recovery_state: string | null;
  exit_recovery_attempts: number | null;
  exit_recovery_last_at: string | null;
  unprotected_since: string | null;
  execution_mode: string;
  leverage: number | null;
}

function MiniTradingView({ symbol }: { symbol: string }) {
  const tvSymbol = `BYBIT:${symbol}.P`;
  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tv_mini_${symbol}&symbol=${encodeURIComponent(
    tvSymbol,
  )}&interval=15&hidesidetoolbar=1&hidetoptoolbar=1&symboledit=0&saveimage=0&toolbarbg=0&studies=[]&theme=dark&style=1&timezone=Etc%2FUTC&withdateranges=0&hideideas=1&locale=en`;
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
      <iframe
        title={`tv-${symbol}`}
        src={src}
        className="block h-[280px] w-full"
        allowTransparency
        scrolling="no"
        frameBorder={0}
      />
    </div>
  );
}

function TimelineRow({
  label,
  ts,
  tone = "default",
  detail,
}: {
  label: string;
  ts: string | null | undefined;
  tone?: "default" | "success" | "danger" | "warning";
  detail?: string;
}) {
  if (!ts) return null;
  const dot =
    tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : tone === "warning" ? "bg-warning" : "bg-muted-foreground";
  return (
    <li className="relative flex gap-3 pl-5">
      <span className={`absolute left-1.5 top-1.5 h-2 w-2 rounded-full ${dot} ring-2 ring-background`} />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
      </div>
      <div className="text-[11px] text-muted-foreground tabular">
        {new Date(ts).toLocaleString()}
      </div>
    </li>
  );
}

function PositionDetailPage() {
  const { symbol } = Route.useParams();

  const { data: pos } = useQuery({
    queryKey: ["mobile", "position_detail", symbol],
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select("*")
        .eq("symbol", symbol)
        .order("opened_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as Position | null;
    },
    refetchInterval: 5_000,
  });

  if (!pos) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
          No position found for {symbol}
        </div>
      </div>
    );
  }

  const q = Number(pos.qty_open ?? 0);
  const e = Number(pos.entry_price ?? 0);
  const l = Number(pos.last_seen_price ?? 0);
  const upnl = q && e && l ? (l - e) * q * (pos.side === "short" ? -1 : 1) : 0;
  const upnlPct = e ? ((l - e) / e) * 100 * (pos.side === "short" ? -1 : 1) : 0;

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{pos.symbol}</h1>
          <span
            className={`text-[11px] font-bold uppercase tracking-wider ${
              pos.side === "long" ? "text-success" : "text-danger"
            }`}
          >
            {pos.side}
          </span>
          {pos.execution_mode === "live" && (
            <span className="rounded-full border border-danger/40 bg-danger/10 px-2 py-0.5 text-[10px] font-bold uppercase text-danger">
              Live
            </span>
          )}
        </div>
        <div className={`mt-1 text-3xl font-semibold tabular ${pnlTone(upnl)}`}>
          {fmtSigned(upnlPct, 2)}%
        </div>
        <div className={`text-sm tabular ${pnlTone(upnl)}`}>{fmtSigned(upnl, 2)} USDT</div>
      </header>

      <MiniTradingView symbol={pos.symbol} />

      <section className="grid grid-cols-2 gap-2">
        <Kpi label="Entry" value={fmtNum(pos.entry_price ?? 0, 6)} />
        <Kpi label="Mark" value={fmtNum(pos.last_seen_price ?? 0, 6)} />
        <Kpi label="Qty" value={fmtNum(pos.qty_open ?? 0, 4)} />
        <Kpi label="Leverage" value={pos.leverage ? `${pos.leverage}x` : "—"} />
        <Kpi label="SL" value={pos.sl_price != null ? fmtNum(pos.sl_price, 6) : "—"} />
        <Kpi label="Protection" value={pos.protection_state} />
        <Kpi label="Hold" value={fmtDuration(pos.opened_at, pos.closed_at)} />
        <Kpi label="TPs" value={`${pos.tp1_done ? "✓" : "—"} / ${pos.tp2_done ? "✓" : "—"}`} />
      </section>

      <section>
        <h2 className="mb-3 px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Timeline
        </h2>
        <ol className="relative space-y-3 border-l border-border/60 pl-1">
          <TimelineRow label="Entered" ts={pos.opened_at} tone="success" />
          <TimelineRow
            label="Unprotected since"
            ts={pos.unprotected_since}
            tone="warning"
          />
          <TimelineRow
            label="TP1 hit"
            ts={pos.tp1_done ? pos.opened_at : null}
            tone="success"
          />
          <TimelineRow
            label="TP2 hit"
            ts={pos.tp2_done ? pos.opened_at : null}
            tone="success"
          />
          <TimelineRow
            label="Recovery attempted"
            ts={pos.exit_recovery_last_at}
            tone="warning"
            detail={
              pos.exit_recovery_state
                ? `${pos.exit_recovery_state} · ${pos.exit_recovery_attempts ?? 0} attempts`
                : undefined
            }
          />
          <TimelineRow label="Closed" ts={pos.closed_at} tone="default" />
        </ol>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border/40 bg-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular">{value}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/m/positions"
      className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground"
    >
      <ChevronLeft className="h-4 w-4" />
      Positions
    </Link>
  );
}
