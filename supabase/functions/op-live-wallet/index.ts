// op-live-wallet — JWT-protected operator endpoint returning a live Bybit
// wallet snapshot for the dashboard. Read-only, signed.
//
// Routes through the execution bridge VPS when configured (fixed whitelisted
// IP) — direct Edge egress lands on CloudFront POPs that Bybit rejects with
// retCode 10010 ("Unmatched IP"). Falls back to direct only if bridge is
// unconfigured.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BybitRest, BybitError } from "../_shared/bybit-rest.ts";
import { BridgeBybitRest, bridgeConfigured } from "../_shared/bridge-rest.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: u } = await userClient.auth.getUser();
  if (!u.user) return json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", u.user.id);
  if (!roles?.some((r) => r.role === "operator")) {
    return json({ error: "forbidden" }, 403);
  }

  const apiKey = Deno.env.get("BYBIT_LIVE_API_KEY") ?? "";
  const apiSecret = Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "";
  if (!apiKey || !apiSecret) {
    return json({ error: "live_keys_missing", message: "BYBIT_LIVE_API_KEY / SECRET not configured" }, 400);
  }

  // Prefer the bridge — Edge egress IP isn't whitelisted on Bybit.
  const rest = bridgeConfigured()
    ? new BridgeBybitRest({
        bridgeUrl: Deno.env.get("EXECUTION_BRIDGE_URL")!,
        bridgeSecret: Deno.env.get("EXECUTION_BRIDGE_SECRET")!,
        label: "op-live-wallet",
      })
    : new BybitRest({ apiKey, apiSecret, baseUrl: "https://api.bybit.com", recvWindowMs: 5000 });

  try {
    // Wallet — try UNIFIED first, fall back to CONTRACT
    // (We intentionally do NOT call /v5/account/info — it is not bridge-allowlisted.
    //  account_mode is derived from the wallet-balance response below.)
    let walletRaw: any;
    try {
      walletRaw = await rest.request({
        endpoint: "/v5/account/wallet-balance", method: "GET",
        query: { accountType: "UNIFIED" },
      });
    } catch {
      walletRaw = await rest.request({
        endpoint: "/v5/account/wallet-balance", method: "GET",
        query: { accountType: "CONTRACT" },
      });
    }
    const acct = (walletRaw as any).result?.list?.[0] ?? {};
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const coins: any[] = acct.coin ?? [];
    const usdt = coins.find((c) => c.coin === "USDT") ?? {};

    const totalEquity = num(acct.totalEquity ?? usdt.equity);
    const availableBalance = num(
      acct.totalAvailableBalance ?? usdt.availableToWithdraw ?? usdt.walletBalance,
    );
    const unrealizedPnl = num(acct.totalPerpUPL ?? usdt.unrealisedPnl);
    const usedMargin = num(
      acct.totalInitialMargin ?? acct.totalMaintenanceMargin ?? usdt.totalPositionIM,
    );

    return json({
      ok: true,
      account_mode: accountMode,
      total_equity: totalEquity,
      available_balance: availableBalance,
      unrealized_pnl: unrealizedPnl,
      used_margin: usedMargin,
      synced_at: new Date().toISOString(),
      raw: { account_type: acct.accountType ?? null, transport: bridgeConfigured() ? "bridge" : "direct" },
    });
  } catch (e) {
    if (e instanceof BybitError) {
      return json({ error: `bybit_${e.retCode}`, message: e.retMsg }, 502);
    }
    return json({ error: "exception", message: (e as Error)?.message ?? String(e) }, 502);
  }
});
