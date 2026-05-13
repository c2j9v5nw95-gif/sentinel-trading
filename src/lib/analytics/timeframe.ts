// Timeframe helpers for analytics snapshots.
// Maps app TF strings to Bybit V5 kline `interval` values.

export type Timeframe =
  | '1m' | '2m' | '5m' | '10m' | '15m' | '30m' | '1h' | '4h' | '1d';

export const ALL_TIMEFRAMES: readonly Timeframe[] = [
  '1m', '2m', '5m', '10m', '15m', '30m', '1h', '4h', '1d',
] as const;

export function isTimeframe(x: unknown): x is Timeframe {
  return typeof x === 'string' && (ALL_TIMEFRAMES as readonly string[]).includes(x);
}

/** Bybit V5 kline interval string for a given timeframe. */
export function toBybitInterval(tf: Timeframe): string {
  switch (tf) {
    case '1m': return '1';
    case '2m': return '2';
    case '5m': return '5';
    case '10m': return '10';
    case '15m': return '15';
    case '30m': return '30';
    case '1h': return '60';
    case '4h': return '240';
    case '1d': return 'D';
  }
}

/** Best-effort: turn `payload.timeframe` / `payload.interval` into a Timeframe. */
export function resolveTimeframe(raw: unknown): Timeframe | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (isTimeframe(s)) return s;
  // Common TradingView interval values: "1","5","15","60","240","D","W"
  const map: Record<string, Timeframe> = {
    '1': '1m', '2': '2m', '5': '5m', '10': '10m', '15': '15m', '30': '30m',
    '60': '1h', '240': '4h', 'd': '1d', '1d': '1d',
  };
  return map[s] ?? null;
}
