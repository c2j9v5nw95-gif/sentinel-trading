// LiveBybitClient — Bybit V5 MAINNET REST.
//
// SAFETY: Live is intentionally independent from TestnetBybitClient. It never
// constructs testnet code paths and never requires BYBIT_TESTNET_* credentials.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { VenueBybitClient } from "./venue-client.ts";

/** Official Bybit mainnet endpoint. Always the safe default. */
export const DEFAULT_LIVE_BASE = "https://api.bybit.com";

/**
 * How long a passing diagnostic is considered "fresh enough" to authorize
 * live execution against an ALTERNATE base URL (e.g. api.bytick.com).
 * The default endpoint never requires this gate.
 */
const ALTERNATE_DIAGNOSTIC_FRESHNESS_MS = 60 * 60 * 1000; // 1h
export const LIVE_GATE_WORKER_VERSION = "live-gate-debug-2026-05-09-v1";

interface GateLookupInput {
  symbol?: string | null;
  signalId?: string | null;
}

interface DiagnosticMatch {
  id: string;
  created_at: string;
  age_ms: number;
  base_url: string;
  symbol: string | null;
}

interface DiagnosticRejection {
  diagnostic_id: string;
  passed_at: string;
  age_ms: number;
  base_url: string | null;
  symbol: string | null;
  reason: string;
}

export interface LiveBaseInfo {
  url: string;
  is_alternate: boolean;
  is_default: boolean;
  source: "env" | "default";
}

/** Resolved at call time so a secret rotation takes effect without redeploy. */
export function liveBaseUrlInfo(): LiveBaseInfo {
  const raw = Deno.env.get("BYBIT_API_BASE_URL")?.trim();
  if (!raw) {
    return { url: DEFAULT_LIVE_BASE, is_alternate: false, is_default: true, source: "default" };
  }
  const normalized = raw.replace(/\/+$/, "");
  return {
    url: normalized,
    is_alternate: normalized !== DEFAULT_LIVE_BASE,
    is_default: normalized === DEFAULT_LIVE_BASE,
    source: "env",
  };
}

/** Back-compat string-only accessor. */
export function liveBaseUrl(): string {
  return liveBaseUrlInfo().url;
}

function normalizeBaseUrl(url?: string | null): string | null {
  if (!url) return null;
  return url.trim().replace(/\/+$/, "");
}

function diagnosticBaseAndSymbol(checks: unknown): { base_url: string | null; symbol: string | null } {
  const c = checks as Record<string, any> | null;
  const meta = c?._meta;
  const bySymbol = c?.read_positions_by_symbol;
  return {
    base_url: normalizeBaseUrl(meta?.detail?.base_url ?? meta?.base_url ?? null),
    symbol: meta?.detail?.symbol ?? bySymbol?.detail?.query?.symbol ?? null,
  };
}

export class LiveBybitClient extends VenueBybitClient {
  constructor(sb: SupabaseClient) {
    super(sb, {
      mode: "live",
      baseUrl: liveBaseUrlInfo().url,
      apiKey: Deno.env.get("BYBIT_LIVE_API_KEY") ?? "",
      apiSecret: Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "",
    });
  }
}

/**
 * Hard gating run before constructing LiveBybitClient.
 * Returns null if execution may proceed; otherwise an error message.
 */
export async function liveExecutionGate(sb: SupabaseClient, input: GateLookupInput = {}): Promise<string | null> {
  const { data: s } = await sb.from("app_settings")
    .select("live_enabled,emergency_stop,live_risk_halted")
    .maybeSingle();
  if (!s) return "settings_missing";
  if (!s.live_enabled) return "live_disabled_globally";
  if (s.emergency_stop) return "emergency_stop_active";
  if (s.live_risk_halted) return "live_risk_breaker_tripped";

  const { count } = await sb.from("invariant_violations")
    .select("id", { count: "exact", head: true })
    .eq("severity", "critical")
    .is("resolved_at", null)
    .is("acknowledged_at", null);
  if ((count ?? 0) > 0) return "critical_invariants_open";

  if (!Deno.env.get("BYBIT_LIVE_API_KEY") || !Deno.env.get("BYBIT_LIVE_API_SECRET")) {
    return "live_api_keys_missing";
  }

  // Alternate-endpoint guard: if operator has overridden BYBIT_API_BASE_URL away
  // from the official mainnet, require a recent passing diagnostic against the
  // CURRENT base URL before allowing live execution.
  const base = liveBaseUrlInfo();
  if (base.is_alternate) {
    const lookup = await findPassingAlternateDiagnostic(sb, base.url, input);
    if (!lookup.match) {
      return `alternate_base_requires_passing_diagnostic:${base.url} (need: mode=live, ok=true, base_url=${base.url}, symbol=${input.symbol ?? "any"}, within ${Math.round(ALTERNATE_DIAGNOSTIC_FRESHNESS_MS / 60000)}m; looked_at=${lookup.rows_seen}; latest_rejection=${lookup.rejections[0]?.reason ?? "none"}; latest_passed_at=${lookup.rejections[0]?.passed_at ?? "none"}; latest_age_min=${lookup.rejections[0] ? Math.round(lookup.rejections[0].age_ms / 60000) : "n/a"})`;
    }
  }

  return null;
}

/** Helper: find a recent passing diagnostic for the given base_url. */
export async function findPassingAlternateDiagnostic(
  sb: SupabaseClient,
  baseUrl: string,
): Promise<{ id: string; created_at: string; age_ms: number; base_url: string } | null> {
  const since = new Date(Date.now() - ALTERNATE_DIAGNOSTIC_FRESHNESS_MS).toISOString();
  const { data: rows } = await sb.from("bybit_diagnostics")
    .select("id,ok,checks,created_at")
    .eq("mode", "live")
    .eq("ok", true)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);
  for (const r of rows ?? []) {
    const meta = (r.checks as Record<string, unknown> | null)?._meta as
      { detail?: { base_url?: string }; base_url?: string } | undefined;
    // Support both shapes: _meta.detail.base_url (current writer) and
    // legacy _meta.base_url (older rows).
    const recordedBase = meta?.detail?.base_url ?? meta?.base_url;
    if (recordedBase === baseUrl) {
      const created = new Date(r.created_at as string).getTime();
      return {
        id: r.id as string,
        created_at: r.created_at as string,
        age_ms: Date.now() - created,
        base_url: recordedBase,
      };
    }
  }
  return null;
}
