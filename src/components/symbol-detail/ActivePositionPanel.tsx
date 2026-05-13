import { Card } from "@/components/PageHeader";
import { fmtNum, fmtSigned, fmtDuration } from "@/components/overview/format";
import type { PositionLite } from "@/lib/symbol-metrics";

export type ActivePosition = PositionLite & {
  protection_state: string;
  sl_price: number | null;
  tsl_active: boolean;
  tsl_trigger_price: number | null;
  last_seen_price: number | null;
  unprotected_since: string | null;
  leverage: number | null;
};

function unrealized(p: ActivePosition): number {
  if (!p.entry_price || !p.qty_open || !p.last_seen_price) return 0;
  const diff =
    p.side === "long"
      ? p.last_seen_price - p.entry_price
      : p.entry_price - p.last_seen_price;
  return diff * p.qty_open;
}

export function ActivePositionPanel({ position }: { position: ActivePosition | null }) {
  return (
    <Card title="Active position">
      {!position ? (
        <p className="text-sm text-muted-foreground">Ingen åpen posisjon.</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2 text-xs tabular">
          <Row k="Side" v={<span className={position.side === "long" ? "text-success" : "text-danger"}>{position.side}</span>} />
          <Row k="Qty" v={fmtNum(position.qty_open ?? 0, 4)} />
          <Row k="Entry" v={fmtNum(position.entry_price ?? 0, 6)} />
          <Row k="Mark" v={fmtNum(position.last_seen_price ?? 0, 6)} />
          <Row
            k="Unrealized"
            v={
              <span className={unrealized(position) >= 0 ? "text-success" : "text-danger"}>
                {fmtSigned(unrealized(position), 2)}
              </span>
            }
          />
          <Row k="Leverage" v={`${fmtNum(position.leverage ?? 0, 0)}x`} />
          <Row k="Protection" v={<ProtectionBadge state={position.protection_state} />} />
          <Row k="SL" v={position.sl_price != null ? fmtNum(position.sl_price, 6) : "—"} />
          <Row
            k="TSL"
            v={
              position.tsl_active
                ? `trigger ${fmtNum(position.tsl_trigger_price ?? 0, 6)}`
                : "off"
            }
          />
          <Row k="Open for" v={fmtDuration(position.opened_at)} />
          {position.unprotected_since && (
            <Row
              k="Unprotected"
              v={<span className="text-warning">since {fmtDuration(position.unprotected_since)}</span>}
            />
          )}
        </dl>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right text-foreground">{v}</dd>
    </>
  );
}

function ProtectionBadge({ state }: { state: string }) {
  const tone =
    state === "protected"
      ? "border-success/40 bg-success/10 text-success"
      : state === "unprotected"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-border bg-muted text-muted-foreground";
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${tone}`}>
      {state}
    </span>
  );
}
