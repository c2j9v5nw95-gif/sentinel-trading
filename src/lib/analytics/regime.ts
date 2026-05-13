// regime classification per (symbol, timeframe).
import { adx, atr, candleRangePct, ema, emaSlopePct, median, percentile, relVolume, type Bar } from './indicators';

export type RegimeClass =
  | 'trending_up' | 'trending_down' | 'ranging'
  | 'volatile_expansion' | 'volatile_compression';

export interface RegimePayload {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  ema_slope_pct: number | null;
  dist_from_ema50_pct: number | null;
  adx14: number | null;
  atr: number | null;
  atr_pct: number | null;
  candle_range_pct: number | null;
  rel_volume_20: number | null;
  bar_time: string | null;
}

export interface RegimeResult {
  regime_class: RegimeClass | null;
  payload: RegimePayload;
}

function atrPctSeries(bars: Bar[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i < bars.length; i++) {
    const slice = bars.slice(i - window, i + 1);
    const a = atr(slice, 14);
    const c = slice[slice.length - 1].close;
    if (a != null && c > 0) out.push((a / c) * 100);
  }
  return out;
}

export function computeRegime(bars: Bar[]): RegimeResult {
  const lastBar = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const slope = emaSlopePct(bars, 20, 5);
  const a = atr(bars, 14);
  const close = lastBar?.close ?? null;
  const atr_pct = a != null && close && close > 0 ? (a / close) * 100 : null;
  const adx14 = adx(bars, 14);
  const cr = lastBar ? candleRangePct(lastBar) : null;
  const rv = relVolume(bars, 20);
  const dist50 = ema50 != null && close && close > 0 ? ((close - ema50) / ema50) * 100 : null;

  // Distribution context for volatility classes (last 100 bars).
  const atrPctHist = atrPctSeries(bars.slice(-Math.min(bars.length, 120)), 30);
  const sortedAtr = [...atrPctHist].sort((x, y) => x - y);
  const p80 = percentile(sortedAtr, 80);
  const p20 = percentile(sortedAtr, 20);
  const crMedian = median(bars.slice(-100).map((b) => candleRangePct(b) ?? 0).filter((x) => x > 0));

  let regime_class: RegimeClass | null = null;
  if (atr_pct != null && p80 != null && cr != null && crMedian != null && atr_pct > p80 && cr > crMedian * 1.5) {
    regime_class = 'volatile_expansion';
  } else if (atr_pct != null && p20 != null && atr_pct < p20) {
    regime_class = 'volatile_compression';
  } else if (adx14 != null && adx14 >= 25 && ema20 != null && ema50 != null && ema200 != null && slope != null) {
    if (ema20 > ema50 && ema50 > ema200 && slope > 0) regime_class = 'trending_up';
    else if (ema20 < ema50 && ema50 < ema200 && slope < 0) regime_class = 'trending_down';
    else regime_class = 'ranging';
  } else {
    regime_class = 'ranging';
  }

  return {
    regime_class,
    payload: {
      ema20, ema50, ema200,
      ema_slope_pct: slope,
      dist_from_ema50_pct: dist50,
      adx14,
      atr: a,
      atr_pct,
      candle_range_pct: cr,
      rel_volume_20: rv,
      bar_time: lastBar ? new Date(lastBar.bar_time).toISOString() : null,
    },
  };
}
