// Public (unauthenticated) Bybit market data — used as price/instrument fallback
// when a TradingView alert omits `price`/`close` and no paper_market_prices row
// exists for the symbol.

const PUBLIC_BASE = "https://api.bybit.com";

export interface PublicInstrumentRules {
  qtyStep?: number;
  minQty?: number;
  maxLeverage?: number;
}

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

export async function fetchInstrumentRules(symbol: string): Promise<PublicInstrumentRules | null> {
  try {
    const url = `${PUBLIC_BASE}/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const json = await res.json() as {
      retCode?: number;
      result?: {
        list?: Array<{
          lotSizeFilter?: { qtyStep?: string; minOrderQty?: string };
          leverageFilter?: { maxLeverage?: string };
        }>;
      };
    };
    if (json.retCode !== 0) return null;
    const row = json.result?.list?.[0];
    if (!row) return null;
    const qtyStep = Number(row.lotSizeFilter?.qtyStep ?? NaN);
    const minQty = Number(row.lotSizeFilter?.minOrderQty ?? NaN);
    const maxLeverage = Number(row.leverageFilter?.maxLeverage ?? NaN);
    return {
      ...(Number.isFinite(qtyStep) && qtyStep > 0 ? { qtyStep } : {}),
      ...(Number.isFinite(minQty) && minQty > 0 ? { minQty } : {}),
      ...(Number.isFinite(maxLeverage) && maxLeverage > 0 ? { maxLeverage } : {}),
    };
  } catch {
    return null;
  }
}
