// Deno-side canonical timeframe resolver for ingest paths.
// Mirrors src/lib/analytics/timeframe.ts normalization map.
//
// Priority:
//   1. payload.timeframe
//   2. payload.interval
//   3. Latest health_snapshots payload.timeframe|interval for same
//      (symbol, strategy) within `lookbackHours` (default 24h).
//   4. (skipped — null preferred over a bad default)

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type Timeframe =
  | "1m" | "2m" | "5m" | "10m" | "15m" | "30m" | "1h" | "4h" | "1d";

const VALID = new Set<string>([
  "1m","2m","5m","10m","15m","30m","1h","4h","1d",
]);

const TV_MAP: Record<string, Timeframe> = {
  "1": "1m", "2": "2m", "5": "5m", "10": "10m", "15": "15m", "30": "30m",
  "60": "1h", "240": "4h", "d": "1d", "1d": "1d",
};

export function normalizeTimeframe(raw: unknown): Timeframe | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (VALID.has(s)) return s as Timeframe;
  return TV_MAP[s] ?? null;
}

export type ResolveSource =
  | "payload.timeframe"
  | "payload.interval"
  | "health_snapshot"
  | "none";

export interface ResolveResult {
  timeframe: Timeframe | null;
  source: ResolveSource;
}

export interface ResolveArgs {
  sb: SupabaseClient;
  symbol: string | null | undefined;
  strategy: string | null | undefined;
  payload: Record<string, unknown> | null | undefined;
  lookbackHours?: number;
}

export async function resolveTradeTimeframe(args: ResolveArgs): Promise<ResolveResult> {
  const p = args.payload ?? {};
  const fromTf = normalizeTimeframe((p as Record<string, unknown>).timeframe);
  if (fromTf) return { timeframe: fromTf, source: "payload.timeframe" };

  const fromIv = normalizeTimeframe((p as Record<string, unknown>).interval);
  if (fromIv) return { timeframe: fromIv, source: "payload.interval" };

  if (args.symbol && args.strategy) {
    const sinceMs = Date.now() - (args.lookbackHours ?? 24) * 3_600_000;
    const since = new Date(sinceMs).toISOString();
    const { data } = await args.sb
      .from("health_snapshots")
      .select("payload, created_at")
      .eq("symbol", args.symbol)
      .eq("strategy", args.strategy)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    for (const row of data ?? []) {
      const hp = (row as { payload?: Record<string, unknown> }).payload ?? {};
      const tf = normalizeTimeframe(hp.timeframe) ?? normalizeTimeframe(hp.interval);
      if (tf) return { timeframe: tf, source: "health_snapshot" };
    }
  }

  return { timeframe: null, source: "none" };
}
