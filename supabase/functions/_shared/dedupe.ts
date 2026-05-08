// Build dedupe key for a signal.
// Prefer barTime when TradingView provides it. Otherwise bucket by configurable
// short window (default 20s). Never bucket by minute — that would block valid
// signals that legitimately fire in the same minute.
export interface DedupeInput {
  symbol: string;
  action: string;
  strategy: string;
  tag: string;
  portion: string;
  barTime?: string | null;
  receivedAtMs: number;
  windowSeconds: number;
}

export function buildDedupeKey(i: DedupeInput): string {
  const base = `${i.symbol}|${i.action}|${i.strategy}|${i.tag ?? ""}|${i.portion}`;
  if (i.barTime) return `${base}|bt=${i.barTime}`;
  const bucket = Math.floor(i.receivedAtMs / 1000 / Math.max(1, i.windowSeconds));
  return `${base}|w=${bucket}`;
}
