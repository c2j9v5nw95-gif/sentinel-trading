// Centralized entry sizing for execute-entry (Phase 3).
//
// Final entry notional (USDT) = balance * (account_balance_percent / 100)
//                             * leverage
//                             * position_size_multiplier
// Margin allocated (USDT)     = balance * (account_balance_percent / 100)
// Estimated qty (contracts)   = notional / mark_price (rounded to symbol step)
//
// Hard safety caps (per symbol, optional) override the formula:
//   max_position_notional_usdt — exposure cap
//   max_margin_usage_usdt     — margin cap
// If either cap would be exceeded, the trade MUST be blocked by the caller
// (logged as a risk_decisions row with gate=exposure_limit, outcome=block).
// Sizing never silently clamps — operators must see and re-authorize.
//
// Inputs MUST come from a fresh Bybit balance + ticker call; never from
// cached frontend values. Exits do NOT use this module.

export interface SymbolSizing {
  account_balance_percent: number;   // 0.1 .. 100
  leverage: number;                  // 1 .. 125 (capped by Bybit per-symbol)
  position_size_multiplier: number;  // 0.1 .. 3.0
  max_position_notional_usdt?: number | null;
  max_margin_usage_usdt?: number | null;
}

export interface SizingInputs {
  availableBalanceUsdt: number;
  markPrice: number;
  qtyStep?: number;
  minQty?: number;
  symbolMaxLeverage?: number;
}

export interface SizingBreakdown {
  availableBalanceUsdt: number;
  marginAllocatedUsdt: number;
  effectiveLeverage: number;
  multiplier: number;
  estimatedExposureUsdt: number;
  estimatedQty: number;
  maxExposureUsdt: number | null;
  maxMarginUsdt: number | null;
  exposureCapExceeded: boolean;
  marginCapExceeded: boolean;
  capRejectionReason: string | null;
  warnings: string[];
}

export function validateSymbolSizing(s: SymbolSizing): string[] {
  const errs: string[] = [];
  if (!(s.account_balance_percent >= 0.1 && s.account_balance_percent <= 100))
    errs.push("account_balance_percent must be between 0.1 and 100");
  if (!(s.position_size_multiplier >= 0.1 && s.position_size_multiplier <= 3.0))
    errs.push("position_size_multiplier must be between 0.1 and 3.0");
  if (!(s.leverage >= 1 && s.leverage <= 125))
    errs.push("leverage must be between 1 and 125");
  if (s.max_position_notional_usdt != null && !(Number(s.max_position_notional_usdt) > 0))
    errs.push("max_position_notional_usdt must be > 0 when set");
  if (s.max_margin_usage_usdt != null && !(Number(s.max_margin_usage_usdt) > 0))
    errs.push("max_margin_usage_usdt must be > 0 when set");
  return errs;
}

function roundDownStep(n: number, step?: number): number {
  if (!step || step <= 0) return n;
  return Math.floor(n / step) * step;
}

export function computeEntrySizing(
  symbol: SymbolSizing,
  inp: SizingInputs,
): SizingBreakdown {
  const warnings: string[] = [];

  let leverage = Number(symbol.leverage);
  if (inp.symbolMaxLeverage && leverage > inp.symbolMaxLeverage) {
    warnings.push(
      `leverage ${leverage}x exceeds Bybit symbol max ${inp.symbolMaxLeverage}x; clamped`,
    );
    leverage = inp.symbolMaxLeverage;
  }

  const balPct = Number(symbol.account_balance_percent) / 100;
  const multiplier = Number(symbol.position_size_multiplier);
  const margin = inp.availableBalanceUsdt * balPct;
  const exposure = margin * leverage * multiplier;

  let qty = inp.markPrice > 0 ? exposure / inp.markPrice : 0;
  qty = roundDownStep(qty, inp.qtyStep);

  if (inp.minQty && qty < inp.minQty) {
    warnings.push(`computed qty ${qty} below symbol min ${inp.minQty}`);
  }

  const maxExposure = symbol.max_position_notional_usdt != null
    ? Number(symbol.max_position_notional_usdt) : null;
  const maxMargin = symbol.max_margin_usage_usdt != null
    ? Number(symbol.max_margin_usage_usdt) : null;

  const exposureCapExceeded = maxExposure != null && exposure > maxExposure;
  const marginCapExceeded = maxMargin != null && margin > maxMargin;

  const reasons: string[] = [];
  if (exposureCapExceeded) {
    reasons.push(`exposure ${exposure.toFixed(2)} > cap ${maxExposure!.toFixed(2)}`);
  }
  if (marginCapExceeded) {
    reasons.push(`margin ${margin.toFixed(2)} > cap ${maxMargin!.toFixed(2)}`);
  }

  return {
    availableBalanceUsdt: inp.availableBalanceUsdt,
    marginAllocatedUsdt: margin,
    effectiveLeverage: leverage,
    multiplier,
    estimatedExposureUsdt: exposure,
    estimatedQty: qty,
    maxExposureUsdt: maxExposure,
    maxMarginUsdt: maxMargin,
    exposureCapExceeded,
    marginCapExceeded,
    capRejectionReason: reasons.length ? reasons.join("; ") : null,
    warnings,
  };
}
