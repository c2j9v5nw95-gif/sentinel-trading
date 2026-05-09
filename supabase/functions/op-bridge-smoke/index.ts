// op-bridge-smoke — operator-only end-to-end test that proves a signed Bybit
// V5 call routes successfully through the execution bridge VPS. Read-only:
// fetches /v5/account/wallet-balance via BridgeBybitRest. Persists a row to
// bridge_smoke_tests for the UI history.
import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BridgeBybitRest } from "../_shared/bridge-rest.ts";
import { BybitError, BybitTransportError, type BybitTrace } from "../_shared/bybit-rest.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth
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

  const bridgeUrl = Deno.env.get("EXECUTION_BRIDGE_URL")?.trim();
  const bridgeSecret = Deno.env.get("EXECUTION_BRIDGE_SECRET")?.trim();
  if (!bridgeUrl || !bridgeSecret) {
    return json({ error: "bridge_not_configured" }, 400);
  }

  let lastTrace: Partial<BybitTrace> = {};
  const rest = new BridgeBybitRest({
    bridgeUrl, bridgeSecret, label: "smoke-test",
    traceWriter: (t) => { lastTrace = t; },
  });

  const startedAt = Date.now();
  let ok = false;
  let httpStatus: number | null = null;
  let retCode: number | null = null;
  let retMsg: string | null = null;
  let errorMsg: string | null = null;
  let accountEquity: number | null = null;
  let accountAvailable: number | null = null;
  let walletRaw: any = null;

  // Try UNIFIED, fall back to CONTRACT.
  for (const accountType of ["UNIFIED", "CONTRACT"]) {
    try {
      const r = await rest.request({
        endpoint: "/v5/account/wallet-balance",
        method: "GET",
        query: { accountType },
      });
      walletRaw = (r as any).result;
      retCode = (r as any).retCode ?? 0;
      retMsg = (r as any).retMsg ?? "OK";
      httpStatus = lastTrace.http_status ?? 200;
      ok = true;
      break;
    } catch (e) {
      if (e instanceof BybitError) {
        retCode = e.retCode;
        retMsg = e.retMsg;
        httpStatus = lastTrace.http_status ?? null;
        errorMsg = `bybit_${e.retCode}: ${e.retMsg}`;
        // Only fall back from UNIFIED on this specific class of mismatch.
        if (accountType === "UNIFIED") continue;
      } else if (e instanceof BybitTransportError) {
        errorMsg = `transport_${e.kind}: ${e.diagnostics.body_snippet ?? ""}`.slice(0, 300);
        httpStatus = e.diagnostics.http_status ?? null;
        break;
      } else {
        errorMsg = (e as Error)?.message?.slice(0, 300) ?? "unknown";
        break;
      }
    }
  }

  const totalMs = Date.now() - startedAt;
  const bybitMs = lastTrace.duration_ms ?? null;
  const publicIp = null; // bridge does not echo IP per call; rely on health check

  if (ok && walletRaw) {
    const acct = walletRaw.list?.[0] ?? {};
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const coins: any[] = acct.coin ?? [];
    const usdt = coins.find((c) => c.coin === "USDT") ?? {};
    accountEquity = num(acct.totalEquity ?? usdt.equity);
    accountAvailable = num(
      acct.totalAvailableBalance ?? usdt.availableToWithdraw ?? usdt.walletBalance,
    );
  }

  const row = {
    ok,
    total_ms: totalMs,
    bybit_ms: bybitMs,
    http_status: httpStatus,
    ret_code: retCode,
    ret_msg: retMsg,
    public_ip: publicIp,
    account_equity: accountEquity,
    account_available: accountAvailable,
    error: errorMsg,
    raw: {
      account_type: walletRaw?.list?.[0]?.accountType ?? null,
      trace: {
        endpoint: lastTrace.endpoint,
        cf_ray: lastTrace.cf_ray,
        bapi_request_id: lastTrace.bapi_request_id,
        body_snippet: lastTrace.body_snippet,
      },
    } as Record<string, unknown>,
  };

  const { data: inserted } = await sb.from("bridge_smoke_tests")
    .insert(row).select("id,checked_at").maybeSingle();

  return json({
    ok,
    check_id: inserted?.id ?? null,
    checked_at: inserted?.checked_at ?? new Date().toISOString(),
    ...row,
  });
});
