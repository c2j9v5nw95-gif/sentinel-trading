/**
 * OCR via Lovable AI Gateway (vision model). Server-only helper.
 *
 * Returns parsed TradingView backtest metrics with per-field confidences and the
 * raw model text. NEVER writes to the database — the caller (createServerFn)
 * persists only after the user reviews and confirms.
 */

const GATEWAY_URL = 'https://ai.gateway.lovable.dev/v1/chat/completions';

export type OcrFieldValue = {
  value: number | null;
  confidence: number; // 0..1
  source_text?: string | null;
};

export type OcrExtraction = {
  ok: boolean;
  error?: string;
  raw_text: string;
  overall_confidence: number;
  field_confidences: Record<string, number>;
  metrics: {
    net_profit_usd: OcrFieldValue;
    net_profit_pct: OcrFieldValue;
    max_drawdown_usd: OcrFieldValue;
    max_drawdown_pct: OcrFieldValue;
    win_rate_pct: OcrFieldValue;
    num_trades: OcrFieldValue;
    profit_factor: OcrFieldValue;
    expected_payoff_usd: OcrFieldValue;
    sharpe_ratio: OcrFieldValue;
    avg_pnl_pct: OcrFieldValue;
    avg_bars_in_trade: OcrFieldValue;
    largest_profit_usd: OcrFieldValue;
    largest_loss_usd: OcrFieldValue;
    profitable_trades_count: OcrFieldValue;
    losing_trades_count: OcrFieldValue;
  };
};

const SYSTEM_PROMPT = `You read TradingView strategy-tester backtest screenshots and extract performance metrics.

CRITICAL RULES:
1. Distinguish USD values from percentages. Many fields appear as BOTH (e.g. "+14.05 USD  +0.14%"). Capture both into the *_usd and *_pct fields respectively.
2. Preserve signs. Negative PnL must be negative. Drawdown is always magnitude (positive number).
3. If a field is missing or unreadable, return value=null and confidence=0. Do NOT guess.
4. Confidence is 0..1: 1.0 = certain, 0.5 = legible but ambiguous, 0.0 = not present / unreadable.
5. Numbers only — no units, no commas, no currency symbols. Use dot as decimal separator.
6. "Profitable trades" usually shown as "76.92%  10/13" → win_rate_pct=76.92, profitable_trades_count=10, num_trades=13, losing_trades_count=3.
7. EMPTY REPORT: If the screenshot says "This report requires trade data", "The strategy report appears after the script makes even one trade", or otherwise shows NO metrics (a placeholder/empty state), return ALL fields with value=null and confidence=0, AND include the literal phrase "NO_TRADES_IN_PERIOD" inside raw_text. Do NOT invent zeros.

Reply ONLY with a single JSON object matching the schema. No prose, no markdown.`;

const RESPONSE_SCHEMA_INSTRUCTION = `Return JSON with this exact shape:
{
  "raw_text": "<short text dump of the key labels and values you used>",
  "metrics": {
    "net_profit_usd":          { "value": number|null, "confidence": number, "source_text": string|null },
    "net_profit_pct":          { "value": number|null, "confidence": number, "source_text": string|null },
    "max_drawdown_usd":        { "value": number|null, "confidence": number, "source_text": string|null },
    "max_drawdown_pct":        { "value": number|null, "confidence": number, "source_text": string|null },
    "win_rate_pct":            { "value": number|null, "confidence": number, "source_text": string|null },
    "num_trades":              { "value": number|null, "confidence": number, "source_text": string|null },
    "profit_factor":           { "value": number|null, "confidence": number, "source_text": string|null },
    "expected_payoff_usd":     { "value": number|null, "confidence": number, "source_text": string|null },
    "sharpe_ratio":            { "value": number|null, "confidence": number, "source_text": string|null },
    "avg_pnl_pct":             { "value": number|null, "confidence": number, "source_text": string|null },
    "avg_bars_in_trade":       { "value": number|null, "confidence": number, "source_text": string|null },
    "largest_profit_usd":      { "value": number|null, "confidence": number, "source_text": string|null },
    "largest_loss_usd":        { "value": number|null, "confidence": number, "source_text": string|null },
    "profitable_trades_count": { "value": number|null, "confidence": number, "source_text": string|null },
    "losing_trades_count":     { "value": number|null, "confidence": number, "source_text": string|null }
  }
}`;

const FIELD_KEYS = [
  'net_profit_usd',
  'net_profit_pct',
  'max_drawdown_usd',
  'max_drawdown_pct',
  'win_rate_pct',
  'num_trades',
  'profit_factor',
  'expected_payoff_usd',
  'sharpe_ratio',
  'avg_pnl_pct',
  'avg_bars_in_trade',
  'largest_profit_usd',
  'largest_loss_usd',
  'profitable_trades_count',
  'losing_trades_count',
] as const;

function emptyField(): OcrFieldValue {
  return { value: null, confidence: 0, source_text: null };
}

function emptyExtraction(error?: string): OcrExtraction {
  const metrics = {} as OcrExtraction['metrics'];
  for (const k of FIELD_KEYS) (metrics as any)[k] = emptyField();
  return {
    ok: !error,
    error,
    raw_text: '',
    overall_confidence: 0,
    field_confidences: Object.fromEntries(FIELD_KEYS.map((k) => [k, 0])),
    metrics,
  };
}

function normalizeField(raw: unknown): OcrFieldValue {
  if (!raw || typeof raw !== 'object') return emptyField();
  const o = raw as Record<string, unknown>;
  const value =
    o.value == null || o.value === ''
      ? null
      : Number.isFinite(Number(o.value))
        ? Number(o.value)
        : null;
  const confidence = Math.max(0, Math.min(1, Number(o.confidence ?? 0) || 0));
  const source_text =
    typeof o.source_text === 'string' ? o.source_text.slice(0, 120) : null;
  return { value, confidence, source_text };
}

/**
 * @param imageDataUrl  data:image/png;base64,...  OR a public/signed https URL.
 * @param model         Vendor/model id, e.g. "google/gemini-3-flash-preview".
 */
export async function extractTradingViewMetrics(
  imageDataUrl: string,
  model: string,
): Promise<OcrExtraction> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return emptyExtraction('LOVABLE_API_KEY not configured');

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + RESPONSE_SCHEMA_INSTRUCTION },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract the backtest metrics from this TradingView strategy-tester screenshot. Reply with ONLY the JSON object.',
          },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
  };

  let resp: Response;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Lovable-API-Key': key,
        'X-Lovable-AIG-SDK': 'lovable-fetch',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return emptyExtraction(`network: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return emptyExtraction(`gateway_${resp.status}: ${text.slice(0, 200)}`);
  }

  let payload: any;
  try {
    payload = await resp.json();
  } catch (err) {
    return emptyExtraction(`bad_json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const content: string | undefined = payload?.choices?.[0]?.message?.content;
  if (!content) return emptyExtraction('empty_completion');

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Sometimes models wrap JSON in ```json fences — strip and retry.
    const cleaned = content.replace(/```json|```/g, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      return {
        ...emptyExtraction(`parse_failed: ${err instanceof Error ? err.message : String(err)}`),
        raw_text: content.slice(0, 500),
      };
    }
  }

  const out = emptyExtraction();
  out.ok = true;
  out.raw_text = typeof parsed.raw_text === 'string' ? parsed.raw_text.slice(0, 2000) : '';
  const metricsRaw = parsed.metrics ?? parsed;
  let sumConf = 0;
  let nConf = 0;
  for (const k of FIELD_KEYS) {
    const fv = normalizeField(metricsRaw[k]);
    (out.metrics as any)[k] = fv;
    out.field_confidences[k] = fv.confidence;
    if (fv.value != null) {
      sumConf += fv.confidence;
      nConf += 1;
    }
  }
  out.overall_confidence = nConf > 0 ? sumConf / nConf : 0;
  return out;
}
