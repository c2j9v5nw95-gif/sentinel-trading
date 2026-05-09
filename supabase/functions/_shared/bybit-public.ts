// Public (unauthenticated) Bybit market data — used as price fallback
// when a TradingView alert omits `price`/`close` and no paper_market_prices
// row exists for the symbol.
//
// Bybit V5 ticker endpoint:
//   GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=PENGUUSDT
//
// Returns lastPrice as a number, or null if unavailable.

const PUBLIC_BASE = "https://api.bybit.com";

export async function fetchLastPrice(symbol: string): Promise<number | null> {
  try {
    const url = `${PUBLIC_BASE}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const json = await res.json() as {
      retCode?: number;
      result?: { list?: Array<{ lastPrice?: string; markPrice?: string }> };
    };
    if (json.retCode !== 0) return null;
    const row = json.result?.list?.[0];
    const px = Number(row?.lastPrice ?? row?.markPrice ?? NaN);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}
