// Strategy code mapping (must match the strategy_codes lookup table in DB).
// Long entries: EL1. Short entries: ES1.
// Long exits:  XL1=tp1, XL4=tp2_rest, XL2=sl_failsafe, XL3=opposite, XL5=trend_fail.
// Short exits: XS1=tp1, XS4=tp2_rest, XS2=sl_failsafe, XS3=opposite, XS5=trend_fail.

export type ExitReason = "tp1" | "tp2_rest" | "sl_failsafe" | "opposite" | "trend_fail";
export type EntryReason = "long_entry" | "short_entry";
export type Side = "long" | "short";
export type Portion = "full" | "tp1" | "rest";
export type SignalAction = "ENTER-LONG" | "ENTER-SHORT" | "EXIT-LONG" | "EXIT-SHORT" | "HEALTH";

export interface StrategyMapping {
  side: Side;
  kind: "entry" | "exit";
  entryReason?: EntryReason;
  exitReason?: ExitReason;
  portion: Portion;
}

const MAP: Record<string, StrategyMapping> = {
  EL1: { side: "long", kind: "entry", entryReason: "long_entry", portion: "full" },
  ES1: { side: "short", kind: "entry", entryReason: "short_entry", portion: "full" },

  XL1: { side: "long", kind: "exit", exitReason: "tp1", portion: "tp1" },
  XL4: { side: "long", kind: "exit", exitReason: "tp2_rest", portion: "rest" },
  XL2: { side: "long", kind: "exit", exitReason: "sl_failsafe", portion: "full" },
  XL3: { side: "long", kind: "exit", exitReason: "opposite", portion: "full" },
  XL5: { side: "long", kind: "exit", exitReason: "trend_fail", portion: "full" },

  XS1: { side: "short", kind: "exit", exitReason: "tp1", portion: "tp1" },
  XS4: { side: "short", kind: "exit", exitReason: "tp2_rest", portion: "rest" },
  XS2: { side: "short", kind: "exit", exitReason: "sl_failsafe", portion: "full" },
  XS3: { side: "short", kind: "exit", exitReason: "opposite", portion: "full" },
  XS5: { side: "short", kind: "exit", exitReason: "trend_fail", portion: "full" },
};

export function resolveStrategyCode(code: string | null | undefined): StrategyMapping | null {
  if (!code) return null;
  return MAP[code.trim().toUpperCase()] ?? null;
}

export function actionFor(mapping: StrategyMapping): Exclude<SignalAction, "HEALTH"> {
  if (mapping.kind === "entry") return mapping.side === "long" ? "ENTER-LONG" : "ENTER-SHORT";
  return mapping.side === "long" ? "EXIT-LONG" : "EXIT-SHORT";
}

export function sideOf(action: SignalAction | null | undefined): Side | null {
  if (action === "ENTER-LONG" || action === "EXIT-LONG") return "long";
  if (action === "ENTER-SHORT" || action === "EXIT-SHORT") return "short";
  return null;
}

export function isEntry(action: SignalAction | null | undefined): boolean {
  return action === "ENTER-LONG" || action === "ENTER-SHORT";
}

export function isExit(action: SignalAction | null | undefined): boolean {
  return action === "EXIT-LONG" || action === "EXIT-SHORT";
}
