// Pure indicator helpers for analytics snapshots.
// Bars are oldest-first.

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bar_time: number; // ms epoch (open time)
}

function last<T>(arr: T[]): T | undefined { return arr[arr.length - 1]; }

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** EMA series (same length as values; null until enough data). */
function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder RSI(14). */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** True range series. */
function trSeries(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { out.push(b.high - b.low); continue; }
    const p = bars[i - 1];
    out.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  return out;
}

/** Wilder ATR(14). */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr = trSeries(bars);
  let a = tr.slice(1, period + 1).reduce((x, y) => x + y, 0) / period;
  for (let i = period + 1; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/** Wilder ADX(14). */
export function adx(bars: Bar[], period = 14): number | null {
  if (bars.length < period * 2 + 1) return null;
  const plusDM: number[] = [0], minusDM: number[] = [0], tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  // Wilder smoothing
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; pS += plusDM[i]; mS += minusDM[i]; }
  const dxs: number[] = [];
  const pushDX = () => {
    const pdi = trS === 0 ? 0 : 100 * (pS / trS);
    const mdi = trS === 0 ? 0 : 100 * (mS / trS);
    const sum = pdi + mdi;
    dxs.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  };
  pushDX();
  for (let i = period + 1; i < bars.length; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    pushDX();
  }
  if (dxs.length < period) return null;
  let a = dxs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < dxs.length; i++) a = (a * (period - 1) + dxs[i]) / period;
  return a;
}

/** (last close - close N bars ago) / close N bars ago * 100, signed. */
export function emaSlopePct(bars: Bar[], emaPeriod: number, lookback = 5): number | null {
  if (bars.length < emaPeriod + lookback) return null;
  const closes = bars.map((b) => b.close);
  const series = emaSeries(closes, emaPeriod);
  const a = series[series.length - 1];
  const b = series[series.length - 1 - lookback];
  if (a == null || b == null || b === 0) return null;
  return ((a - b) / b) * 100;
}

export function candleRangePct(bar: Bar): number | null {
  if (!bar || bar.close <= 0) return null;
  return ((bar.high - bar.low) / bar.close) * 100;
}

/** last volume / SMA(volume, period). */
export function relVolume(bars: Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const vs = bars.slice(-period - 1, -1).map((b) => b.volume);
  const avg = vs.reduce((a, b) => a + b, 0) / period;
  const v = last(bars)!.volume;
  if (!avg || !Number.isFinite(avg)) return null;
  return v / avg;
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
