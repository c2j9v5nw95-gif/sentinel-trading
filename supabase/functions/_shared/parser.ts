// TradingView alert parser.
// Accepts the Pine Script alert format used by the strategy:
//   key=value pairs separated by ';' (preferred), newline, or CR.
// Tolerates JSON, leading/trailing whitespace, and surrounding text
// (e.g. when TradingView wraps the alert inside email boilerplate).
//
// Examples:
//   secret=TOKEN;type=trade;action=ENTER-LONG;ticker=PIEVERSEUSDT.P;strategy=EL1;tag=STRAT2
//   type=stats;action=HEALTH;ticker=PIEVERSEUSDT.P;strategy=HEALTH_ALL;trigger=HEARTBEAT;...

export type AlertAction =
  | "ENTER-LONG"
  | "ENTER-SHORT"
  | "EXIT-LONG"
  | "EXIT-SHORT"
  | "HEALTH";

export interface ParsedAlert {
  type: "trade" | "stats";
  action?: AlertAction;
  symbol?: string;        // normalized (callers also strip .P)
  raw_ticker?: string;    // exactly as received (e.g. PIEVERSEUSDT.P)
  strategy?: string;      // logical strategy name (defaults to strategy_code)
  tag?: string;
  strategy_code?: string; // EL1 / ES1 / XL1 / XL4 / XS1 ...
  portion?: string;       // raw portion field (REST etc) — caller normalizes
  bar_time?: string;      // raw barTime (ISO or epoch-ms string)
  // type=stats fields
  net_profit?: number;
  winrate?: number;
  profit_factor?: number;
  raw: Record<string, unknown>;
}

const VALID_ACTIONS = new Set([
  "ENTER-LONG", "ENTER-SHORT", "EXIT-LONG", "EXIT-SHORT", "HEALTH",
]);

function normAction(v: unknown): AlertAction | undefined {
  if (v == null) return undefined;
  // Tolerate "enter long", "enter_long", "enterlong"
  const s = String(v).trim().toUpperCase().replace(/[\s_]+/g, "-");
  if (VALID_ACTIONS.has(s)) return s as AlertAction;
  // Common synonyms
  if (s === "ENTERLONG") return "ENTER-LONG";
  if (s === "ENTERSHORT") return "ENTER-SHORT";
  if (s === "EXITLONG") return "EXIT-LONG";
  if (s === "EXITSHORT") return "EXIT-SHORT";
  return undefined;
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(String(v).replace(/[%,]/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseKvText(body: string): Record<string, string> {
  // Find the first occurrence of "<word>=" so we can tolerate prefixed noise.
  const startIdx = body.search(/[A-Za-z_][A-Za-z0-9_]*\s*=/);
  const slice = startIdx >= 0 ? body.slice(startIdx) : body;
  // Split on ';', newline, or '|' (TradingView often glues alert message and
  // study output with ' | ' between the two halves).
  const parts = slice.split(/[;\n\r|]+/);
  const obj: Record<string, string> = {};
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) continue;
    obj[k] = v;
  }
  return obj;
}

export function parseAlert(body: string): ParsedAlert | null {
  if (!body) return null;
  const trimmed = body.trim();
  let raw: Record<string, unknown>;
  if (trimmed.startsWith("{")) {
    try { raw = JSON.parse(trimmed); } catch { return null; }
  } else {
    raw = parseKvText(trimmed);
  }
  return fromObject(raw);
}

// Extract the secret BEFORE full parsing — used by ingest-webhook for auth.
export function extractSecret(body: string): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      return typeof j?.secret === "string" ? j.secret : undefined;
    } catch { return undefined; }
  }
  const m = trimmed.match(/(?:^|[;\n\r])\s*secret\s*=\s*([^;\n\r]+)/i);
  return m?.[1]?.trim();
}

function fromObject(o: Record<string, unknown>): ParsedAlert {
  const typeStr = String(o.type ?? "trade").toLowerCase();
  const type: "trade" | "stats" = typeStr === "stats" ? "stats" : "trade";
  const ticker = o.ticker ?? o.symbol;
  const tickerStr = ticker != null ? String(ticker) : undefined;
  // strategy_code is sent as the `strategy` field in the Pine Script alerts;
  // `strategy_code` is also accepted for forward-compatibility.
  const strategyCode = o.strategy_code != null
    ? String(o.strategy_code)
    : (o.strategy != null ? String(o.strategy) : undefined);
  const strategyName = o.strategy_name != null
    ? String(o.strategy_name)
    : (o.strategy != null ? String(o.strategy) : undefined);

  return {
    type,
    action: normAction(o.action),
    symbol: tickerStr,
    raw_ticker: tickerStr,
    strategy: strategyName,
    tag: o.tag != null ? String(o.tag) : "",
    strategy_code: strategyCode,
    portion: o.portion != null ? String(o.portion) : undefined,
    bar_time: normalizeBarTime(o.barTime ?? o.bar_time),
    net_profit: num(o.netProfit ?? o.net_profit),
    winrate: num(o.winrate),
    profit_factor: num(o.profitFactor ?? o.profit_factor),
    raw: o,
  };
}
