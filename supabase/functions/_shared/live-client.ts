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
export async function liveExecutionGate(sb: SupabaseClient): Promise<string | null> {
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
    const match = await findPassingAlternateDiagnostic(sb, base.url);
    if (!match) {
      return `alternate_base_requires_passing_diagnostic:${base.url} (need: mode=live, ok=true, base_url=${base.url}, within ${Math.round(ALTERNATE_DIAGNOSTIC_FRESHNESS_MS / 60000)}m)`;
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
