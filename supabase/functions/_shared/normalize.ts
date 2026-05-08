// Symbol normalization: strip TradingView ".P" suffix, uppercase, trim.
export function normalizeSymbol(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.trim().toUpperCase().replace(/\.P$/, "");
}
