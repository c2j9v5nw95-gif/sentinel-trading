// Centralized entry sizing for execute-entry (Phase 3).
//
// Final entry notional (USDT) = balance * (account_balance_percent / 100)
//                             * leverage
//                             * position_size_multiplier
// Margin allocated (USDT)     = balance * (account_balance_percent / 100)
// Estimated qty (contracts)   = notional / mark_price (rounded to symbol step)
//
// Inputs MUST come from a fresh Bybit balance + ticker call; never from
// cached frontend values. Exits do NOT use this module — exits read live
// Bybit position size and apply portion rules from strategy-map.ts.

export interface SymbolSizing {
  account_balance_percent: number;   // 0.1 .. 100
  leverage: number;                  // 1 .. 125 (capped by Bybit per-symbol)
  position_size_multiplier: number;  // 0.1 .. 3.0
}

export interface SizingInputs {
  availableBalanceUsdt: number;      // fresh Bybit wallet balance
  markPrice: number;                 // fresh Bybit mark/last price
  qtyStep?: number;                  // symbol qty step (e.g. 0.001)
  minQty?: number;                   // symbol min order qty
  symbolMaxLeverage?: number;        // per-symbol cap from Bybit
}

export interface SizingBreakdown {
  availableBalanceUsdt: number;
  marginAllocatedUsdt: number;
  effectiveLeverage: number;
  multiplier: number;
  estimatedExposureUsdt: number;
  estimatedQty: number;
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

  let leverage = symbol.leverage;
  if (inp.symbolMaxLeverage && leverage > inp.symbolMaxLeverage) {
    warnings.push(
      `leverage ${leverage}x exceeds Bybit symbol max ${inp.symbolMaxLeverage}x; clamped`,
    );
    leverage = inp.symbolMaxLeverage;
  }

  const balPct = symbol.account_balance_percent / 100;
  const margin = inp.availableBalanceUsdt * balPct;
  const exposure = margin * leverage * symbol.position_size_multiplier;

  let qty = inp.markPrice > 0 ? exposure / inp.markPrice : 0;
  qty = roundDownStep(qty, inp.qtyStep);

  if (inp.minQty && qty < inp.minQty) {
    warnings.push(`computed qty ${qty} below symbol min ${inp.minQty}`);
  }

  return {
    availableBalanceUsdt: inp.availableBalanceUsdt,
    marginAllocatedUsdt: margin,
    effectiveLeverage: leverage,
    multiplier: symbol.position_size_multiplier,
    estimatedExposureUsdt: exposure,
    estimatedQty: qty,
    warnings,
  };
}
