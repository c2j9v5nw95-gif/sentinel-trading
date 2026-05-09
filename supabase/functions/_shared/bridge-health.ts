// Shared helpers for bridge health: signed health-check call + DB log writer.
// Used by op-bridge-health (manual + scheduled) and the live execution gate.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const enc = new TextEncoder();
async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const b = new Uint8Array(sig); let o = "";
  for (const x of b) o += x.toString(16).padStart(2, "0");
  return o;
}
async function sha256Hex(payload: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(payload));
  const b = new Uint8Array(buf); let o = "";
  for (const x of b) o += x.toString(16).padStart(2, "0");
  return o;
}

export interface BridgeHealthResult {
  ok: boolean;
  latency_ms: number;
  http_status: number | null;
  bridge_version: string | null;
  public_ip: string | null;
  region: string | null;
  bybit_reachable: boolean | null;
  error: string | null;
  raw: unknown;
}

export async function pingBridgeHealth(): Promise<BridgeHealthResult> {
  const url = Deno.env.get("EXECUTION_BRIDGE_URL")?.trim().replace(/\/+$/, "");
  const secret = Deno.env.get("EXECUTION_BRIDGE_SECRET")?.trim();
  if (!url || !secret) {
    return {
      ok: false, latency_ms: 0, http_status: null, bridge_version: null,
      public_ip: null, region: null, bybit_reachable: null,
      error: "bridge_not_configured", raw: null,
    };
  }
  const path = "/v1/health";
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex("");
  const sig = await hmacSha256Hex(secret, `${ts}.${nonce}.GET.${path}.${bodyHash}`);
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url + path, {
      method: "GET",
      headers: {
        "X-Bridge-Timestamp": ts,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": sig,
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const latency = Date.now() - start;
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* */ }
    return {
      ok: res.ok && body?.ok === true,
      latency_ms: latency,
      http_status: res.status,
      bridge_version: body?.version ?? null,
      public_ip: body?.public_ip ?? null,
      region: body?.region ?? null,
      bybit_reachable: body?.bybit_reachable ?? null,
      error: res.ok ? null : `http_${res.status}`,
      raw: body ?? text.slice(0, 500),
    };
  } catch (e) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      http_status: null, bridge_version: null,
      public_ip: null, region: null, bybit_reachable: null,
      error: (e as Error).message?.slice(0, 200) ?? "fetch_failed",
      raw: null,
    };
  }
}

export async function recordBridgeHealth(sb: SupabaseClient, r: BridgeHealthResult): Promise<string | null> {
  const { data } = await sb.from("bridge_health_checks").insert({
    ok: r.ok, latency_ms: r.latency_ms, http_status: r.http_status,
    bridge_version: r.bridge_version, public_ip: r.public_ip, region: r.region,
    bybit_reachable: r.bybit_reachable, error: r.error, raw: r.raw,
  }).select("id").maybeSingle();
  return data?.id ?? null;
}

/** Live-gate precheck: returns null if bridge is healthy enough to use, else reason. */
export async function bridgeRecentlyHealthy(sb: SupabaseClient, withinSeconds = 120): Promise<string | null> {
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data } = await sb.from("bridge_health_checks")
    .select("ok,checked_at,error,bybit_reachable")
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return "no_recent_health_check";
  if (!data.ok) return `last_check_failed:${data.error ?? "unknown"}`;
  if (data.bybit_reachable === false) return "bridge_cannot_reach_bybit";
  return null;
}
