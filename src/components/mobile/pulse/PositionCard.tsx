import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { fmtNum, fmtSigned, pnlTone, fmtDuration } from "@/components/overview/format";

export interface PositionCardData {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  last_seen_price: number | null;
  opened_at: string;
  protection_state: string;
  exit_recovery_state: string | null;
  execution_mode: string;
}

function unrealized(p: PositionCardData) {
  const q = Number(p.qty_open ?? 0);
  const e = Number(p.entry_price ?? 0);
  const l = Number(p.last_seen_price ?? 0);
  if (!q || !e || !l) return { pnl: 0, pct: 0 };
  const pnl = (l - e) * q * (p.side === "short" ? -1 : 1);
  const pct = ((l - e) / e) * 100 * (p.side === "short" ? -1 : 1);
  return { pnl, pct };
}

function ProtectionDot({ state }: { state: string }) {
  const cls =
    state === "unprotected"
      ? "bg-danger"
      : state === "sl_and_tsl" || state === "protected"
      ? "bg-success"
      : "bg-warning";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />;
}

export function PositionCard({ p }: { p: PositionCardData }) {
  const { pnl, pct } = unrealized(p);
  const sideTone = p.side === "long" ? "text-success" : "text-danger";
  const recovering = p.exit_recovery_state === "pending" || p.exit_recovery_state === "manual_required";

  return (
    <Link
      to="/m/positions/$symbol"
      params={{ symbol: p.symbol }}
      className="block rounded-2xl border border-border/60 bg-card p-4 transition-colors active:bg-accent/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold tracking-tight">{p.symbol}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${sideTone}`}>
              {p.side}
            </span>
            {p.execution_mode === "live" && (
              <span className="rounded-full border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-danger">
                Live
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground tabular">
            <span className="inline-flex items-center gap-1">
              <ProtectionDot state={p.protection_state} />
              {p.protection_state}
            </span>
            <span>·</span>
            <span>{fmtDuration(p.opened_at)}</span>
            {recovering && (
              <>
                <span>·</span>
                <span className="text-warning">{p.exit_recovery_state}</span>
              </>
            )}
          </div>
        </div>

        <div className="text-right">
          <div className={`text-lg font-semibold tabular ${pnlTone(pnl)}`}>
            {fmtSigned(pct, 2)}%
          </div>
          <div className={`text-[11px] tabular ${pnlTone(pnl)}`}>{fmtSigned(pnl, 2)}</div>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
      </div>

      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground tabular">
        <span>entry {fmtNum(p.entry_price ?? 0, 4)}</span>
        <span>mark {fmtNum(p.last_seen_price ?? 0, 4)}</span>
        <span>qty {fmtNum(p.qty_open ?? 0, 4)}</span>
      </div>
    </Link>
  );
}
