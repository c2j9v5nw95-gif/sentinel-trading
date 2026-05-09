// op-test-bybit-connection — JWT-protected operator diagnostic.
//
// Verifies a Bybit V5 API connection (testnet OR live) by running a sequence
// of read-only signed calls. Optionally places a tiny "safe order" that is
// immediately cancelled, gated behind an explicit typed confirmation.
//
// Body shape:
//   { mode: "testnet" | "live",
//     symbol?: string,                    // default BTCUSDT
//     safe_order?: {                      // optional and disabled by default
//       enabled: true,
//       confirm: "RUN SAFE ORDER TEST",   // required exact phrase
//     } }
//
// Response: full per-check payload + { ok, error_code, error_message }.
// Always persists a row to bybit_diagnostics.

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { BybitRest, BybitError, BybitTransportError } from "../_shared/bybit-rest.ts";
import { liveBaseUrl } from "../_shared/live-client.ts";
import { notify } from "../_shared/telegram.ts";

const SAFE_ORDER_PHRASE = "RUN SAFE ORDER TEST";

interface CheckResult {
  ok: boolean;
  detail?: unknown;
  error?: { code: string; message: string };
  ms?: number;
}

type Mode = "testnet" | "live";

function credsFor(mode: Mode) {
  if (mode === "testnet") {
    return {
      apiKey: Deno.env.get("BYBIT_TESTNET_API_KEY") ?? "",
      apiSecret: Deno.env.get("BYBIT_TESTNET_API_SECRET") ?? "",
      baseUrl: "https://api-testnet.bybit.com",
    };
  }
  return {
    apiKey: Deno.env.get("BYBIT_LIVE_API_KEY") ?? "",
    apiSecret: Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "",
    baseUrl: "https://api.bybit.com",
  };
}

function explainBybitError(e: unknown): { code: string; message: string } {
  if (e instanceof BybitError) {
    const hint =
      e.retCode === 10003 || e.retCode === 10004 || e.retCode === 10005
        ? "API key invalid, expired, or signature wrong. Re-issue keys with Contract: Orders + Positions + Wallet permissions."
      : e.retCode === 10010
        ? "IP not whitelisted. Either remove IP restrictions on the API key or whitelist Lovable Cloud egress."
      : e.retCode === 10016
        ? "Bybit service temporarily unavailable. Retry in a few seconds."
      : e.retCode === 110043 || e.retCode === 110025
        ? "Position mode mismatch — set the account to one-way mode for USDT perpetuals."
      : e.retCode === 33004
        ? "API key has insufficient permissions for this endpoint."
      : `Bybit returned retCode ${e.retCode}.`;
    return { code: `bybit_${e.retCode}`, message: `${e.retMsg} — ${hint}` };
  }
  const msg = (e as Error)?.message ?? String(e);
  return { code: "exception", message: msg };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result?: T; err?: unknown; ms: number }> {
  const t = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - t };
  } catch (err) {
    return { err, ms: Date.now() - t };
  }
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
  if (!u.user) return new Response("Unauthorized", { status: 401 });

  const sb = serviceClient();
  const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", u.user.id);
  if (!roles?.some((r) => r.role === "operator")) {
    return new Response("Forbidden", { status: 403 });
  }

  // Parse input
  let body: { mode?: Mode; symbol?: string; safe_order?: { enabled?: boolean; confirm?: string } } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const mode: Mode = body.mode === "live" ? "live" : "testnet";
  const symbol = body.symbol || "BTCUSDT";

  const creds = credsFor(mode);
  const checks: Record<string, CheckResult> = {};
  let permissions: unknown = null;
  let accountType: string | null = null;
  let lastResponse: unknown = null;
  let topError: { code: string; message: string } | null = null;

  // Pre-check: secrets present?
  if (!creds.apiKey || !creds.apiSecret) {
    const err = {
      code: "missing_credentials",
      message: `BYBIT_${mode.toUpperCase()}_API_KEY / SECRET is not configured for this environment.`,
    };
    checks.credentials_present = { ok: false, error: err };
    await persist(sb, u.user.id, mode, false, checks, null, null, null, err);
    return json({ ok: false, mode, checks, error: err });
  }
  checks.credentials_present = { ok: true };

  // NOTE: read-only live diagnostics are always permitted — they're how the
  // operator validates the live API keys BEFORE flipping live_enabled on.
  // Mutating actions (safe_order_test) still require live_enabled below.
  if (mode === "live") {
    checks.live_gate = { ok: true, detail: { note: "read-only checks allowed regardless of live_enabled" } };
  }

  const rest = new BybitRest({ ...creds, recvWindowMs: 5000 });

  // 1) API auth + 2) account info  (signed call: /v5/account/info)
  {
    const t = await timed(() => rest.request({ endpoint: "/v5/account/info", method: "GET" }));
    if (t.err) {
      const err = explainBybitError(t.err);
      checks.api_auth = { ok: false, error: err, ms: t.ms };
      checks.account_info = { ok: false, error: err, ms: t.ms };
      topError ??= err;
    } else {
      lastResponse = t.result;
      const r = (t.result as any).result;
      accountType = r?.unifiedMarginStatus ? `unified:${r.unifiedMarginStatus}` : (r?.marginMode ?? "unknown");
      checks.api_auth = { ok: true, ms: t.ms };
      checks.account_info = { ok: true, detail: r, ms: t.ms };
    }
  }

  // 3) wallet / balance — /v5/account/wallet-balance
  if (checks.api_auth.ok) {
    const t = await timed(() => rest.request({
      endpoint: "/v5/account/wallet-balance", method: "GET",
      query: { accountType: "UNIFIED" },
    }));
    if (t.err) {
      // Try CONTRACT type as fallback for non-unified accounts.
      const t2 = await timed(() => rest.request({
        endpoint: "/v5/account/wallet-balance", method: "GET",
        query: { accountType: "CONTRACT" },
      }));
      if (t2.err) {
        const err = explainBybitError(t2.err);
        checks.wallet_balance = { ok: false, error: err, ms: t.ms + t2.ms };
        topError ??= err;
      } else {
        lastResponse = t2.result;
        checks.wallet_balance = { ok: true, detail: (t2.result as any).result, ms: t.ms + t2.ms };
      }
    } else {
      lastResponse = t.result;
      checks.wallet_balance = { ok: true, detail: (t.result as any).result, ms: t.ms };
    }
  }

  // 4) open positions — /v5/position/list
  if (checks.api_auth.ok) {
    const t = await timed(() => rest.request({
      endpoint: "/v5/position/list", method: "GET",
      query: { category: "linear", settleCoin: "USDT" },
    }));
    if (t.err) {
      const err = explainBybitError(t.err);
      checks.read_positions = { ok: false, error: err, ms: t.ms };
      topError ??= err;
    } else {
      lastResponse = t.result;
      const list = (t.result as any).result?.list ?? [];
      checks.read_positions = { ok: true, detail: { count: list.length }, ms: t.ms };
    }
  }

  // 5) open orders — /v5/order/realtime
  if (checks.api_auth.ok) {
    const t = await timed(() => rest.request({
      endpoint: "/v5/order/realtime", method: "GET",
      query: { category: "linear", settleCoin: "USDT" },
    }));
    if (t.err) {
      const err = explainBybitError(t.err);
      checks.read_orders = { ok: false, error: err, ms: t.ms };
      topError ??= err;
    } else {
      lastResponse = t.result;
      const list = (t.result as any).result?.list ?? [];
      checks.read_orders = { ok: true, detail: { count: list.length }, ms: t.ms };
    }
  }

  // 6) instrument info + 7) leverage limits — /v5/market/instruments-info (signed for consistency)
  if (checks.api_auth.ok) {
    const t = await timed(() => rest.request({
      endpoint: "/v5/market/instruments-info", method: "GET",
      query: { category: "linear", symbol },
    }));
    if (t.err) {
      const err = explainBybitError(t.err);
      checks.instrument_info = { ok: false, error: err, ms: t.ms };
      checks.leverage_limits = { ok: false, error: err, ms: t.ms };
      topError ??= err;
    } else {
      lastResponse = t.result;
      const inst = (t.result as any).result?.list?.[0];
      checks.instrument_info = {
        ok: !!inst,
        detail: inst ? {
          symbol: inst.symbol, status: inst.status,
          lotSizeFilter: inst.lotSizeFilter, priceFilter: inst.priceFilter,
        } : null,
        ms: t.ms,
        error: inst ? undefined : { code: "symbol_not_found", message: `${symbol} not listed on this venue.` },
      };
      checks.leverage_limits = {
        ok: !!inst?.leverageFilter,
        detail: inst?.leverageFilter ?? null,
        ms: t.ms,
        error: inst?.leverageFilter ? undefined : { code: "no_leverage_filter", message: "Symbol returned no leverageFilter — cannot place leveraged orders." },
      };
    }
  }

  // 8) permissions — /v5/user/query-api
  if (checks.api_auth.ok) {
    const t = await timed(() => rest.request({ endpoint: "/v5/user/query-api", method: "GET" }));
    if (t.err) {
      const err = explainBybitError(t.err);
      checks.permissions = { ok: false, error: err, ms: t.ms };
      topError ??= err;
    } else {
      lastResponse = t.result;
      const r = (t.result as any).result;
      permissions = r?.permissions ?? null;
      // Required permission groups for this app:
      //   ContractTrade.Order  — placing / reducing / SL+TP
      //   ContractTrade.Position — reading / leverage / trading-stop
      //   Wallet.AccountTransfer (optional but useful)
      const ct = r?.permissions?.ContractTrade ?? [];
      const required: Record<string, boolean> = {
        place_orders: ct.includes("Order") || ct.includes("Trade"),
        read_positions: ct.includes("Position") || ct.includes("Order"),
        set_leverage: ct.includes("Position"),
        reduce_only_exits: ct.includes("Order") || ct.includes("Trade"),
        sl_tsl_protection: ct.includes("Position"), // /v5/position/trading-stop
      };
      const missing = Object.entries(required).filter(([_k, v]) => !v).map(([k]) => k);
      checks.permissions = {
        ok: missing.length === 0,
        detail: { required, missing, ip_whitelist: r?.ips, expires_at: r?.expiredAt, readOnly: r?.readOnly },
        ms: t.ms,
        error: missing.length === 0 ? undefined : {
          code: "missing_permissions",
          message: `API key is missing: ${missing.join(", ")}. Re-issue the key with Contract: Orders + Positions enabled.`,
        },
      };
      if (missing.length > 0) topError ??= checks.permissions.error!;
    }
  }

  // OPTIONAL safe order test — disabled by default
  const safeReq = body.safe_order;
  if (safeReq?.enabled) {
    if (safeReq.confirm !== SAFE_ORDER_PHRASE) {
      checks.safe_order_test = {
        ok: false,
        error: { code: "missing_confirmation", message: `Type "${SAFE_ORDER_PHRASE}" in safe_order.confirm to enable.` },
      };
    } else if (mode === "live") {
      // Block in live unless an explicit live override is in place.
      const { data: s } = await sb.from("app_settings").select("live_enabled").maybeSingle();
      if (!s?.live_enabled) {
        checks.safe_order_test = {
          ok: false,
          error: { code: "live_disabled", message: "Safe order test in live mode requires live_enabled=true." },
        };
      } else {
        await runSafeOrderTest();
      }
    } else {
      await runSafeOrderTest();
    }
  }

  async function runSafeOrderTest() {
    const inst = (checks.instrument_info?.detail as any) || null;
    const minQty = Number(inst?.lotSizeFilter?.minOrderQty ?? 0.001);
    const tickSize = Number(inst?.priceFilter?.tickSize ?? 0.1);

    // Get a far-from-market limit price so it never fills.
    const tk = await timed(() => rest.request({
      endpoint: "/v5/market/tickers", method: "GET",
      query: { category: "linear", symbol },
    }));
    if (tk.err) {
      checks.safe_order_test = { ok: false, error: explainBybitError(tk.err), ms: tk.ms };
      return;
    }
    const last = Number(((tk.result as any).result?.list?.[0]?.lastPrice) ?? 0);
    if (!(last > 0)) {
      checks.safe_order_test = { ok: false, error: { code: "no_ticker", message: "No ticker price available." }, ms: tk.ms };
      return;
    }
    // Far-below-market BUY limit so it cannot match.
    const px = Math.floor((last * 0.5) / tickSize) * tickSize;
    const linkId = `DIAG-${Date.now().toString(36)}`;

    const place = await timed(() => rest.request({
      endpoint: "/v5/order/create", method: "POST",
      body: {
        category: "linear", symbol, side: "Buy", orderType: "Limit",
        qty: String(minQty), price: String(px), timeInForce: "GTC",
        orderLinkId: linkId, reduceOnly: false,
      },
      idempotencyKey: linkId,
    }));
    if (place.err) {
      checks.safe_order_test = { ok: false, error: explainBybitError(place.err), ms: place.ms };
      return;
    }
    const placedId = (place.result as any).result?.orderId;

    const cancel = await timed(() => rest.request({
      endpoint: "/v5/order/cancel", method: "POST",
      body: { category: "linear", symbol, orderLinkId: linkId },
    }));
    checks.safe_order_test = {
      ok: !cancel.err,
      detail: { placed_order_id: placedId, link_id: linkId, place_ms: place.ms, cancel_ms: cancel.ms },
      error: cancel.err ? explainBybitError(cancel.err) : undefined,
    };
  }

  const failed = Object.entries(checks).filter(([_k, v]) => !v.ok);
  const ok = failed.length === 0;

  if (!ok && topError) {
    await sb.from("system_alerts").insert({
      severity: "warning",
      category: "bybit_diagnostic",
      message: `${mode.toUpperCase()} Bybit diagnostic failed: ${topError.code}`,
      context: { mode, error: topError, failed_checks: failed.map(([k]) => k) },
    });
    notify({
      severity: "warning", category: "bybit_diagnostic_failure",
      execution_mode: mode,
      reason: `${topError.code}: ${topError.message}`,
      extra: { failed_checks: failed.map(([k]) => k) },
    });
  }

  await persist(sb, u.user.id, mode, ok, checks, permissions, accountType, lastResponse, topError);

  return json({
    ok, mode, symbol, checks, permissions, account_type: accountType,
    last_response: lastResponse, error: topError,
  });
});

async function persist(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  mode: Mode,
  ok: boolean,
  checks: Record<string, CheckResult>,
  permissions: unknown,
  accountType: string | null,
  lastResponse: unknown,
  err: { code: string; message: string } | null,
) {
  await sb.from("bybit_diagnostics").insert({
    mode, ok, checks, permissions, account_type: accountType,
    last_response: lastResponse, error_code: err?.code ?? null,
    error_message: err?.message ?? null, ran_by: userId,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
