// analytics-snapshot-balances — read-only snapshot writer for the analytics
// layer. Records paper wallet equity every run; if live trading is enabled and
// API keys are configured, also records a live Bybit wallet snapshot. Fully
// isolated from the execution stack — does not import dispatcher, executor,
// risk-engine, sizing, locks, bridge or venue clients. Only shared deps are
// the service Supabase client and the read-only Bybit V5 HMAC signer (same
// one used by op-live-wallet).

import { serviceClient, corsHeaders } from "../_shared/db.ts";
import { BybitRest, BybitError } from "../_shared/bybit-rest.ts";
import { BridgeBybitRest, bridgeConfigured } from "../_shared/bridge-rest.ts";

type SnapshotRow = {
  source: "paper" | "live";
  total_equity: number | null;
  available_balance: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  used_margin: number | null;
  account_mode: string | null;
  raw: unknown;
  error: string | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function snapshotPaper(sb: ReturnType<typeof serviceClient>): Promise<SnapshotRow> {
  try {
    const { data, error } = await sb.from("paper_wallet").select("*").maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        source: "paper", total_equity: null, available_balance: null,
        unrealized_pnl: null, realized_pnl: null, used_margin: null,
        account_mode: "paper", raw: null, error: "paper_wallet row missing",
      };
    }
    return {
      source: "paper",
      total_equity: num(data.equity_usdt),
      available_balance: num(data.balance_usdt),
      unrealized_pnl: num(data.unrealized_pnl),
      realized_pnl: num(data.realized_pnl),
      used_margin: null,
      account_mode: "paper",
      raw: data,
      error: null,
    };
  } catch (e) {
    return {
      source: "paper", total_equity: null, available_balance: null,
      unrealized_pnl: null, realized_pnl: null, used_margin: null,
      account_mode: "paper", raw: null,
      error: (e as Error)?.message ?? String(e),
    };
  }
}

async function snapshotLive(): Promise<SnapshotRow | null> {
  const apiKey = Deno.env.get("BYBIT_LIVE_API_KEY") ?? "";
  const apiSecret = Deno.env.get("BYBIT_LIVE_API_SECRET") ?? "";
  if (!apiKey || !apiSecret) return null;

  // Prefer the bridge — Edge egress IP isn't whitelisted on Bybit (retCode 10010).
  const rest = bridgeConfigured()
    ? new BridgeBybitRest({
        bridgeUrl: Deno.env.get("EXECUTION_BRIDGE_URL")!,
        bridgeSecret: Deno.env.get("EXECUTION_BRIDGE_SECRET")!,
        label: "analytics-snapshot-balances",
      })
    : new BybitRest({
        apiKey, apiSecret,
        baseUrl: "https://api.bybit.com",
        recvWindowMs: 5000,
      });

  try {
    // Note: /v5/account/info is intentionally NOT called — it is not
    // bridge-allowlisted. account_mode is derived from the wallet-balance
    // response below.
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
    const coins: any[] = acct.coin ?? [];
    const usdt = coins.find((c) => c.coin === "USDT") ?? {};

    const accountType: string | null = acct.accountType ?? null;
    const accountMode = accountType
      ? (accountType === "UNIFIED" ? "unified" : accountType.toLowerCase())
      : "unknown";

    return {
      source: "live",
      total_equity: num(acct.totalEquity ?? usdt.equity),
      available_balance: num(
        acct.totalAvailableBalance ?? usdt.availableToWithdraw ?? usdt.walletBalance,
      ),
      unrealized_pnl: num(acct.totalPerpUPL ?? usdt.unrealisedPnl),
      realized_pnl: null,
      used_margin: num(
        acct.totalInitialMargin ?? acct.totalMaintenanceMargin ?? usdt.totalPositionIM,
      ),
      account_mode: accountMode,
      raw: { account_type: accountType, transport: bridgeConfigured() ? "bridge" : "direct" },
      error: null,
    };
  } catch (e) {
    const msg = e instanceof BybitError
      ? `bybit_${e.retCode}: ${e.retMsg}`
      : (e as Error)?.message ?? String(e);
    return {
      source: "live", total_equity: null, available_balance: null,
      unrealized_pnl: null, realized_pnl: null, used_margin: null,
      account_mode: null, raw: null, error: msg,
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = serviceClient();
  const rows: SnapshotRow[] = [];

  rows.push(await snapshotPaper(sb));

  // Only attempt live snapshot when live trading is enabled in app_settings
  // AND keys are present. We never call Bybit otherwise.
  try {
    const { data: settings } = await sb
      .from("app_settings").select("live_enabled").maybeSingle();
    if (settings?.live_enabled) {
      const live = await snapshotLive();
      if (live) rows.push(live);
    }
  } catch { /* non-fatal — paper snapshot still inserted */ }

  const { error: insertErr } = await sb.from("balance_snapshots").insert(rows);

  return new Response(
    JSON.stringify({
      ok: !insertErr,
      inserted: insertErr ? 0 : rows.length,
      sources: rows.map((r) => ({ source: r.source, ok: !r.error, error: r.error })),
      insert_error: insertErr?.message ?? null,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
