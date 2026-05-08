// bybit-recovery — startup hydration from Bybit testnet/live.
//
// Detects venue positions that have NO local row (e.g. after sandbox restart
// or if a manual position was opened on the venue). Creates a local position
// record so the engine can manage it. Marks any local row that's gone-on-venue
// as closed.
//
// Run on demand (operator button) or periodically.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { getClient } from "../_shared/bybit-client.ts";
import type { ExecutionMode } from "../_shared/execution-mode.ts";
import { BybitRest } from "../_shared/bybit-rest.ts";

async function venuePositions(mode: ExecutionMode) {
  const apiKey = Deno.env.get("BYBIT_TESTNET_API_KEY") ?? "";
  const apiSecret = Deno.env.get("BYBIT_TESTNET_API_SECRET") ?? "";
  if (!apiKey || !apiSecret) return [];
  const rest = new BybitRest({
    apiKey, apiSecret,
    baseUrl: mode === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com",
  });
  const r = await rest.request<{ list: Array<{ symbol: string; side: string; size: string; avgPrice: string; leverage: string }> }>({
    endpoint: "/v5/position/list",
    method: "GET",
    query: { category: "linear", settleCoin: "USDT" },
  });
  return (r.result?.list ?? []).filter((x) => Number(x.size) > 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = new URL(req.url);
  const mode = (url.searchParams.get("mode") ?? "testnet") as ExecutionMode;
  if (mode !== "testnet") {
    return new Response(JSON.stringify({ ok: false, error: "only testnet supported" }), {
      status: 400, headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }

  const sb = serviceClient();
  const recovered: string[] = [];
  const closed: string[] = [];

  try {
    const venue = await venuePositions(mode);
    const venueSyms = new Set(venue.map((v) => v.symbol));

    // 1. Recover venue positions missing locally.
    for (const v of venue) {
      const { data: existing } = await sb.from("positions").select("id")
        .eq("symbol", v.symbol).eq("execution_mode", mode)
        .is("closed_at", null).maybeSingle();
      if (existing) continue;
      const side = v.side === "Buy" ? "long" : "short";
      const { data: row } = await sb.from("positions").insert({
        symbol: v.symbol, side, execution_mode: mode,
        qty_initial: Number(v.size), qty_open: Number(v.size),
        entry_price: Number(v.avgPrice), leverage: Number(v.leverage),
        protection_state: "unprotected", unprotected_since: new Date().toISOString(),
      }).select("id").single();
      if (row) {
        await sb.from("position_events").insert({
          position_id: row.id, event_type: "recovered_from_venue",
          detail: { qty: v.size, avgPrice: v.avgPrice },
        });
        await sb.from("system_alerts").insert({
          severity: "warning", category: "recovery",
          message: `Recovered orphan venue position: ${v.symbol} (${side})`,
          context: { position_id: row.id, qty: v.size },
        });
        recovered.push(v.symbol);
      }
    }

    // 2. Close local positions no longer on venue.
    const { data: locals } = await sb.from("positions")
      .select("id,symbol").eq("execution_mode", mode).is("closed_at", null);
    for (const l of locals ?? []) {
      if (!venueSyms.has(l.symbol)) {
        await sb.from("positions").update({
          qty_open: 0, closed_at: new Date().toISOString(), protection_state: "closed",
        }).eq("id", l.id);
        await sb.from("position_events").insert({
          position_id: l.id, event_type: "closed_by_recovery",
          detail: { reason: "no_venue_position" },
        });
        closed.push(l.symbol);
      }
    }

    return new Response(JSON.stringify({ ok: true, mode, recovered, closed }), {
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "content-type": "application/json" },
    });
  }
});
