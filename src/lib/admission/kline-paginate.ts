// Paginated Bybit kline fetcher for Historical Trend Quality v2.
// SERVER-ONLY. Uses bridge passthrough — public market data only.
// Fetches `bars` bars by walking backwards in time using `end` cursor.

import { publicGet } from '@/lib/analytics/bybit-public-kline';
import type { Bar } from '@/lib/analytics/indicators';

const INTERVAL_MS: Record<string, number> = {
  '5': 5 * 60_000,
  '15': 15 * 60_000,
  '60': 60 * 60_000,
};

/**
 * Fetch up to `desired` bars of klines, paginating Bybit's 1000-row limit.
 * Returns bars oldest-first. On partial failure returns what was gathered.
 */
export async function fetchKlinePaginated(
  symbol: string,
  interval: '5' | '15' | '60',
  desired: number,
): Promise<{ ok: true; bars: Bar[]; pages: number } | { ok: false; error: string; bars: Bar[]; pages: number }> {
  const all: Bar[] = [];
  let endCursor: number | undefined;
  const pageSize = 1000;
  const maxPages = Math.ceil(desired / pageSize);
  let pages = 0;

  for (let p = 0; p < maxPages; p++) {
    const query: Record<string, string> = {
      category: 'linear',
      symbol,
      interval,
      limit: String(pageSize),
    };
    if (endCursor != null) query.end = String(endCursor);

    const res = await publicGet('/v5/market/kline', query);
    pages++;
    if (!res.ok) {
      return { ok: false, error: res.error ?? 'unknown', bars: all.sort((a, b) => a.bar_time - b.bar_time), pages };
    }
    const list: any[] = res.payload?.list ?? [];
    if (list.length === 0) break;

    // Bybit row: [ start, open, high, low, close, volume, turnover ]
    const page: Bar[] = list.map((row) => ({
      bar_time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    })).filter((b) => Number.isFinite(b.close) && Number.isFinite(b.bar_time));

    // Bybit returns newest-first; oldest is last element
    if (page.length === 0) break;
    all.push(...page);
    if (all.length >= desired) break;

    // Set end cursor to the oldest bar time minus one interval to fetch older bars
    const oldest = page[page.length - 1].bar_time;
    const ivMs = INTERVAL_MS[interval];
    endCursor = oldest - ivMs;
    if (endCursor <= 0) break;
  }

  // Dedupe by bar_time and sort oldest-first
  const map = new Map<number, Bar>();
  for (const b of all) map.set(b.bar_time, b);
  const bars = Array.from(map.values()).sort((a, b) => a.bar_time - b.bar_time);
  // Trim to last `desired` bars
  const trimmed = bars.length > desired ? bars.slice(bars.length - desired) : bars;
  return { ok: true, bars: trimmed, pages };
}
