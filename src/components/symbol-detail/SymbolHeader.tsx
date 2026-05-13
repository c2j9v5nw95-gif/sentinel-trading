import { Link } from "@tanstack/react-router";
import { ModeChip } from "@/components/ModeChip";
import { fmtAge } from "@/components/overview/format";

export function SymbolHeader({
  symbol,
  enabled,
  executionMode,
  preferredTransport,
  leverage,
  marginMode,
  lastHealthAt,
}: {
  symbol: string;
  enabled: boolean;
  executionMode: string | null;
  preferredTransport: string;
  leverage: number;
  marginMode: string;
  lastHealthAt: string | null;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="mb-1">
          <Link
            to="/symbols"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← Symbols
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{symbol}</h1>
          {enabled ? (
            <span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success">
              Enabled
            </span>
          ) : (
            <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
              Disabled
            </span>
          )}
          {executionMode ? (
            <ModeChip mode={executionMode as "paper" | "testnet" | "live"} />
          ) : (
            <span className="text-xs text-muted-foreground">inherit global mode</span>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          leverage {leverage}x · {marginMode} · transport {preferredTransport} · last health{" "}
          {fmtAge(lastHealthAt)}
        </div>
      </div>
    </div>
  );
}
