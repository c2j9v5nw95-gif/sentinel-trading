// Server-only helpers for Coin Admission Screener.
// SERVER-ONLY — never import from client/components.

import { publicGet } from '@/lib/analytics/bybit-public-kline';
import {
  computeAdmissionScore,
  median,
  type AdmissionThresholds,
  type AdmissionWeights,
  type SymbolMetrics,
} from './scoring';

export interface BybitInstrument {
  symbol: string;
  status: string;
  contractType: string;
  quoteCoin: string;
  baseCoin: string;
  launchTime: number; // ms epoch
}

export interface BybitTicker {
  symbol: string;
  lastPrice: number | null;
  bid1Price: number | null;
  ask1Price: number | null;
  turnover24h: number | null;
  volume24h: number | null;
  openInterest: number | null;
  openInterestValue: number | null;
  fundingRate: number | null;
}

export interface CoinGeckoEntry {
  id: string;
  symbol: string; // e.g. "btc"
  market_cap_rank: number | null;
  market_cap: number | null;
}

const SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fetch every LinearPerpetual USDT instrument via paginated cursor. */
export async function fetchUniverse(): Promise<BybitInstrument[]> {
  const all: BybitInstrument[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = {
      category: 'linear',
      limit: '1000',
    };
    if (cursor) query.cursor = cursor;
    const res = await publicGet('/v5/market/instruments-info', query);
    if (!res.ok) {
      throw new Error(`fetchUniverse failed (page ${page}): ${res.error ?? 'unknown'}`);
    }
    const list: any[] = res.payload?.list ?? [];
    for (const row of list) {
      if (row.status !== 'Trading') continue;
      if (row.contractType !== 'LinearPerpetual') continue;
      if (row.quoteCoin !== 'USDT') continue;
      const launchTime = Number(row.launchTime);
      if (!Number.isFinite(launchTime)) continue;
      all.push({
        symbol: String(row.symbol),
        status: String(row.status),
        contractType: String(row.contractType),
        quoteCoin: String(row.quoteCoin),
        baseCoin: String(row.baseCoin),
        launchTime,
      });
    }
    cursor = res.payload?.nextPageCursor;
    if (!cursor) break;
  }
  return all;
}

/** Single bulk call — all linear tickers. */
export async function fetchAllTickers(): Promise<Map<string, BybitTicker>> {
  const res = await publicGet('/v5/market/tickers', { category: 'linear' });
  if (!res.ok) {
    throw new Error(`fetchAllTickers failed: ${res.error ?? 'unknown'}`);
  }
  const map = new Map<string, BybitTicker>();
  const list: any[] = res.payload?.list ?? [];
  for (const row of list) {
    const symbol = String(row.symbol);
    map.set(symbol, {
      symbol,
      lastPrice: numOrNull(row.lastPrice),
      bid1Price: numOrNull(row.bid1Price),
      ask1Price: numOrNull(row.ask1Price),
      turnover24h: numOrNull(row.turnover24h),
      volume24h: numOrNull(row.volume24h),
      openInterest: numOrNull(row.openInterest),
      openInterestValue: numOrNull(row.openInterestValue),
      fundingRate: numOrNull(row.fundingRate),
    });
  }
  return map;
}

/** CoinGecko top-N markets. Free API, no key. */
export async function fetchCoinGeckoMarkets(limit = 250): Promise<CoinGeckoEntry[]> {
  const out: CoinGeckoEntry[] = [];
  const pages = Math.ceil(limit / 250);
  for (let p = 1; p <= pages; p++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      // free API rate-limits hard; degrade gracefully
      throw new Error(`coingecko_http_${res.status}`);
    }
    const list: any[] = await res.json();
    for (const row of list) {
      out.push({
        id: String(row.id),
        symbol: String(row.symbol ?? '').toLowerCase(),
        market_cap_rank: row.market_cap_rank != null ? Number(row.market_cap_rank) : null,
        market_cap: row.market_cap != null ? Number(row.market_cap) : null,
      });
    }
    if (p < pages) await SLEEP(1100); // be polite to free API
  }
  return out;
}

/** Daily kline (last 30 bars) for one symbol — used for 7d/30d medians + wick risk. */
export async function fetchDailyKline(symbol: string, limit = 30): Promise<{
  ok: true;
  bars: Array<{ open: number; high: number; low: number; close: number; volume: number; turnover: number; bar_time: number }>;
} | { ok: false; error: string }> {
  const res = await publicGet('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval: 'D',
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (!res.ok) return { ok: false, error: res.error ?? 'unknown' };
  const list: any[] = res.payload?.list ?? [];
  const bars = list.map((row) => ({
    bar_time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    turnover: Number(row[6]),
  })).filter((b) => Number.isFinite(b.close));
  bars.reverse(); // oldest-first
  return { ok: true, bars };
}

async function fetchKlineGeneric(symbol: string, interval: string, limit: number): Promise<{
  ok: true;
  bars: Array<{ open: number; high: number; low: number; close: number; volume: number; bar_time: number }>;
} | { ok: false; error: string }> {
  const res = await publicGet('/v5/market/kline', {
    category: 'linear',
    symbol,
    interval,
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (!res.ok) return { ok: false, error: res.error ?? 'unknown' };
  const list: any[] = res.payload?.list ?? [];
  const bars = list.map((row) => ({
    bar_time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((b) => Number.isFinite(b.close));
  bars.reverse();
  return { ok: true, bars };
}

/** 1h klines for wick / extreme-move analysis (last 30 days = 720 bars). */
export const fetchHourlyKline = (symbol: string, limit = 720) =>
  fetchKlineGeneric(symbol, '60', limit);

/** 5m klines for trend quality (default ~48h = 576 bars). */
export const fetch5mKline = (symbol: string, limit = 576) =>
  fetchKlineGeneric(symbol, '5', limit);

/** 15m klines for trend confirmation (default ~3d = 288 bars). */
export const fetch15mKline = (symbol: string, limit = 288) =>
  fetchKlineGeneric(symbol, '15', limit);

function numOrNull(x: unknown): number | null {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Compute spread in bps from bid/ask. */
export function computeSpreadBps(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || bid <= 0 || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 10000;
}

/** Build SymbolMetrics from gathered data. */
export function buildMetrics(args: {
  symbol: string;
  instrument: BybitInstrument;
  ticker: BybitTicker | undefined;
  cgRank: number | null;
  dailyBars: Array<{ turnover: number }> | null;
  hourlyBars: Array<{ open: number; close: number; high: number; low: number }> | null;
}): SymbolMetrics {
  const { ticker, instrument, dailyBars, hourlyBars, cgRank } = args;

  const ageDays = (Date.now() - instrument.launchTime) / 86400000;

  let turnover7d: number | null = null;
  let turnover30d: number | null = null;
  if (dailyBars && dailyBars.length > 0) {
    const last7 = dailyBars.slice(-7).map((b) => b.turnover).filter(Number.isFinite);
    const last30 = dailyBars.slice(-30).map((b) => b.turnover).filter(Number.isFinite);
    turnover7d = median(last7);
    turnover30d = median(last30);
  }

  // Wick analysis on hourly bars: largest 1h % drop (high → close) on any bar.
  let max1hDrop: number | null = null;
  let extremeWickCount: number | null = null;
  if (hourlyBars && hourlyBars.length > 0) {
    let worstDrop = 0;
    let extreme = 0;
    for (const b of hourlyBars) {
      if (b.high > 0) {
        const drop = ((b.high - b.low) / b.high) * 100;
        if (drop > worstDrop) worstDrop = drop;
        if (drop > 8) extreme++;
      }
    }
    max1hDrop = worstDrop;
    extremeWickCount = extreme;
  }

  return {
    symbol: args.symbol,
    rank: cgRank,
    turnover_24h: ticker?.turnover24h ?? null,
    turnover_7d_median: turnover7d,
    turnover_30d_median: turnover30d,
    open_interest_value: ticker?.openInterestValue ?? null,
    spread_bps: ticker ? computeSpreadBps(ticker.bid1Price, ticker.ask1Price) : null,
    listing_age_days: Math.floor(ageDays),
    funding_rate: ticker?.fundingRate ?? null,
    max_1h_drop_pct: max1hDrop,
    extreme_wick_count: extremeWickCount,
  };
}

/** Run with bounded concurrency. */
export async function pMapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
  onEach?: () => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      onEach?.();
    }
  });
  await Promise.all(workers);
  return results;
}

export { computeAdmissionScore };
export type { AdmissionThresholds, AdmissionWeights, SymbolMetrics };
