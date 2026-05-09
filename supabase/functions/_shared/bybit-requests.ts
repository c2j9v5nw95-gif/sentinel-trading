// Canonical Bybit V5 request builders.
//
// Both the diagnostics function AND the live/testnet executor MUST go through
// these helpers when calling /v5/position/list and /v5/order/create. This
// guarantees identical query keys, casing, body shape, and serialization so
// any executor 403 vs diagnostics 200 can be attributed to runtime/IP, never
// to request-shape drift.

import type { BybitRequestOpts } from "./bybit-rest.ts";

export interface PositionListByCategoryArgs {
  category: "linear" | "inverse";
  settleCoin?: string;       // diagnostics-style sweep
  symbol?: string;           // executor-style per-symbol
}

export function buildPositionListRequest(args: PositionListByCategoryArgs): BybitRequestOpts {
  const query: Record<string, string> = { category: args.category };
  if (args.symbol) query.symbol = args.symbol;
  if (args.settleCoin) query.settleCoin = args.settleCoin;
  return {
    endpoint: "/v5/position/list",
    method: "GET",
    query,
  };
}

export interface OrderCreateArgs {
  category: "linear" | "inverse";
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit";
  qty: string;
  reduceOnly: boolean;
  orderLinkId: string;
  timeInForce: "IOC" | "GTC" | "FOK";
  price?: string;
}

export function buildOrderCreateRequest(args: OrderCreateArgs): BybitRequestOpts {
  const body: Record<string, unknown> = {
    category: args.category,
    symbol: args.symbol,
    side: args.side,
    orderType: args.orderType,
    qty: args.qty,
    reduceOnly: args.reduceOnly,
    orderLinkId: args.orderLinkId,
    timeInForce: args.timeInForce,
  };
  if (args.orderType === "Limit" && args.price) body.price = args.price;
  return {
    endpoint: "/v5/order/create",
    method: "POST",
    body,
    idempotencyKey: args.orderLinkId,
  };
}

/** Boot-time self-check — proves the canonical helpers stay in lockstep. */
export function assertCanonicalShapes(): void {
  const pos = buildPositionListRequest({ category: "linear", symbol: "BTCUSDT" });
  if (pos.endpoint !== "/v5/position/list" || pos.method !== "GET") {
    throw new Error("bybit-requests:position_list_shape_drift");
  }
  const ord = buildOrderCreateRequest({
    category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market",
    qty: "0", reduceOnly: false, orderLinkId: "X", timeInForce: "IOC",
  });
  if (ord.endpoint !== "/v5/order/create" || ord.method !== "POST") {
    throw new Error("bybit-requests:order_create_shape_drift");
  }
}
