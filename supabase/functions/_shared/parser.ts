// TradingView alert parser.
// Accepts JSON or "key=value\nkey=value" plain text. Returns a normalized
// shape; downstream is responsible for symbol normalization, strategy-code
// resolution, dedupe, and DB insertion.

export interface ParsedAlert {
  type: "trade" | "stats";
  symbol?: string;
  strategy?: string;
  tag?: string;
  strategy_code?: string;       // EL1/ES1/XL1.. etc
  bar_time?: string;            // TradingView {{barTime}} ISO
  // type=stats fields:
  net_profit?: number;
  winrate?: number;
  profit_factor?: number;
  raw: Record<string, unknown>;
}

export function parseAlert(body: string): ParsedAlert | null {
  if (!body) return null;
  const trimmed = body.trim();
  // JSON shape
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      return fromObject(j);
    } catch {
      return null;
    }
  }
  // key=value lines
  const obj: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) obj[k] = v;
  }
  return fromObject(obj);
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fromObject(o: Record<string, unknown>): ParsedAlert {
  const type = String(o.type ?? "trade").toLowerCase() === "stats" ? "stats" : "trade";
  return {
    type,
    symbol: o.symbol ? String(o.symbol) : undefined,
    strategy: o.strategy ? String(o.strategy) : undefined,
    tag: o.tag ? String(o.tag) : "",
    strategy_code: o.strategy_code ? String(o.strategy_code) : undefined,
    bar_time: o.barTime ? String(o.barTime) : (o.bar_time ? String(o.bar_time) : undefined),
    net_profit: num(o.net_profit),
    winrate: num(o.winrate),
    profit_factor: num(o.profit_factor),
    raw: o,
  };
}
