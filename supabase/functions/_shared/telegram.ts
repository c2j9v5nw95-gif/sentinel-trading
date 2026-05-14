// Shared Telegram operator-alert helper.
// - Reads notification_settings (singleton) for gating, severity threshold, rate limit, dedupe window.
// - Logs every attempt to notification_events.
// - Critical alerts bypass rate limit but still dedupe.
import { serviceClient } from "./db.ts";

export type Severity = "info" | "warning" | "critical";

export type Category =
  | "live_entry"
  | "live_exit"
  | "tp_hit"
  | "sl_hit"
  | "tsl_update"
  | "live_risk_halt"
  | "invariant_violation"
  | "unprotected_position"
  | "bybit_diagnostic_failure"
  | "dead_letter"
  | "emergency_stop"
  | "bridge_unreachable"
  | "order_submit_failed"
  | "test";

export interface AlertPayload {
  severity: Severity;
  category: Category;
  execution_mode?: string | null;
  symbol?: string | null;
  side?: string | null;
  leverage?: number | null;
  exposure?: number | null;
  qty?: number | null;
  price?: number | null;
  pnl?: number | null;
  reason?: string | null;
  dashboard_url?: string | null;
  extra?: Record<string, unknown>;
  // Rich entry/exit fields (optional)
  entry_price?: number | null;
  exit_price?: number | null;
  pnl_pct?: number | null;
  hold_seconds?: number | null;
  sl_price?: number | null;
  sl_pct?: number | null;
  tsl_enabled?: boolean | null;
  tsl_activation_pct?: number | null;
  tsl_callback_pct?: number | null;
  confirmed_by_venue?: boolean | null;
  // Override message body completely (skips formatting)
  raw_text?: string;
  // Bypass dedupe (for tests)
  bypass_dedupe?: boolean;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const SEVERITY_EMOJI: Record<Severity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtNum(n: number | null | undefined, digits = 4): string | null {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function fmtDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return null;
  const s = Math.floor(Number(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtSignedPct(n: number | null | undefined, digits = 2): string | null {
  const v = fmtNum(n, digits);
  if (v == null) return null;
  return Number(n) >= 0 ? `+${v}%` : `${v}%`;
}

function fmtSignedUsdt(n: number | null | undefined, digits = 2): string | null {
  const v = fmtNum(n, digits);
  if (v == null) return null;
  return Number(n) >= 0 ? `+${v} USDT` : `${v} USDT`;
}

function buildEntryMessage(p: AlertPayload): string {
  const sevTag = `[${p.severity.toUpperCase()}]`;
  const lines: string[] = [];
  lines.push(`🟢 <b>ENTRY</b> — <b>${escapeHtml(p.symbol ?? "?")}</b>${p.side ? ` ${escapeHtml(p.side.toUpperCase())}` : ""} ${sevTag}`);
  if (p.execution_mode) lines.push(`Mode: <b>${escapeHtml(p.execution_mode)}</b>`);
  const meta: string[] = [];
  if (p.leverage != null) meta.push(`${fmtNum(p.leverage, 2)}x`);
  if (p.qty != null) meta.push(`Qty ${fmtNum(p.qty, 6)}`);
  if (p.entry_price ?? p.price) meta.push(`@ ${fmtNum(p.entry_price ?? p.price)}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (p.exposure != null) lines.push(`Exposure: ${fmtNum(p.exposure, 2)} USDT`);
  if (p.reason) lines.push(`Reason: ${escapeHtml(p.reason)}`);

  // Protection block
  const protLines: string[] = [];
  if (p.sl_price != null) {
    const slPctTxt = p.sl_pct != null ? ` (−${fmtNum(p.sl_pct, 2)}%)` : "";
    const mark = p.confirmed_by_venue === false ? "⚠️" : "✅";
    protLines.push(`SL @ ${fmtNum(p.sl_price)}${slPctTxt} ${mark}${p.confirmed_by_venue === false ? " not confirmed" : " confirmed"}`);
  } else if (p.confirmed_by_venue === false) {
    protLines.push(`⚠️ SL not confirmed`);
  }
  if (p.tsl_enabled) {
    const a = p.tsl_activation_pct != null ? `+${fmtNum(p.tsl_activation_pct, 2)}%` : "?";
    const c = p.tsl_callback_pct != null ? `${fmtNum(p.tsl_callback_pct, 2)}%` : "?";
    protLines.push(`TSL: arms at ${a}, callback ${c}`);
  } else if (p.tsl_enabled === false) {
    protLines.push(`TSL: disabled`);
  }
  if (protLines.length) {
    lines.push("");
    lines.push(`<b>Protection</b>`);
    for (const l of protLines) lines.push(l);
  }
  lines.push(`<i>${new Date().toISOString()}</i>`);
  if (p.dashboard_url) lines.push(`<a href="${escapeHtml(p.dashboard_url)}">Open dashboard</a>`);
  return lines.join("\n");
}

function buildExitMessage(p: AlertPayload): string {
  const win = (p.pnl ?? 0) >= 0;
  const headEmoji = win ? "✅" : "❌";
  const catLabel =
    p.category === "tp_hit" ? "TP HIT" :
    p.category === "sl_hit" ? "SL HIT" :
    "EXIT";
  const lines: string[] = [];
  lines.push(`${headEmoji} <b>${catLabel}</b> — <b>${escapeHtml(p.symbol ?? "?")}</b>${p.side ? ` ${escapeHtml(p.side.toUpperCase())}` : ""}`);
  if (p.execution_mode) lines.push(`Mode: <b>${escapeHtml(p.execution_mode)}</b>`);
  if (p.reason) lines.push(`Reason: ${escapeHtml(p.reason)}`);
  if (p.entry_price != null && (p.exit_price != null || p.price != null)) {
    lines.push(`Entry: ${fmtNum(p.entry_price)} → Exit: ${fmtNum(p.exit_price ?? p.price)}`);
  } else if (p.exit_price != null || p.price != null) {
    lines.push(`Exit: ${fmtNum(p.exit_price ?? p.price)}`);
  }
  if (p.qty != null) {
    const lev = p.leverage != null ? ` · ${fmtNum(p.leverage, 2)}x` : "";
    lines.push(`Qty: ${fmtNum(p.qty, 6)}${lev}`);
  }
  const pnlUsdt = fmtSignedUsdt(p.pnl);
  const pnlPct = fmtSignedPct(p.pnl_pct);
  if (pnlUsdt || pnlPct) {
    lines.push(`PnL: ${[pnlUsdt, pnlPct ? `(${pnlPct})` : null].filter(Boolean).join(" ")}`);
  }
  const dur = fmtDuration(p.hold_seconds);
  if (dur) lines.push(`Hold: ${dur}`);
  lines.push(`<i>${new Date().toISOString()}</i>`);
  if (p.dashboard_url) lines.push(`<a href="${escapeHtml(p.dashboard_url)}">Open dashboard</a>`);
  return lines.join("\n");
}

function buildMessage(p: AlertPayload): string {
  if (p.raw_text) return p.raw_text;
  if (p.category === "live_entry") return buildEntryMessage(p);
  if (p.category === "tp_hit" || p.category === "sl_hit" || p.category === "live_exit") {
    return buildExitMessage(p);
  }
  const emoji = SEVERITY_EMOJI[p.severity];
  const lines: string[] = [];
  lines.push(`${emoji} <b>${escapeHtml(p.category.toUpperCase())}</b> [${p.severity.toUpperCase()}]`);
  if (p.execution_mode) lines.push(`Mode: <b>${escapeHtml(p.execution_mode)}</b>`);
  if (p.symbol) lines.push(`Symbol: <b>${escapeHtml(p.symbol)}</b>${p.side ? ` ${escapeHtml(p.side)}` : ""}`);
  if (p.leverage != null) lines.push(`Leverage: ${fmtNum(p.leverage, 2)}x`);
  if (p.qty != null) lines.push(`Qty: ${fmtNum(p.qty, 6)}`);
  if (p.price != null) lines.push(`Price: ${fmtNum(p.price)}`);
  if (p.exposure != null) lines.push(`Exposure: ${fmtNum(p.exposure, 2)} USDT`);
  if (p.pnl != null) lines.push(`PnL: ${fmtNum(p.pnl, 2)} USDT`);
  if (p.reason) lines.push(`Reason: ${escapeHtml(p.reason)}`);
  lines.push(`<i>${new Date().toISOString()}</i>`);
  if (p.dashboard_url) lines.push(`<a href="${escapeHtml(p.dashboard_url)}">Open dashboard</a>`);
  return lines.join("\n");
}

function buildDedupeKey(p: AlertPayload): string {
  return [p.category, p.symbol ?? "-", p.reason ?? p.raw_text ?? "-"].join("|");
}

export interface SendResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  message_id?: number;
}

export async function sendTelegramAlert(p: AlertPayload): Promise<SendResult> {
  const supa = serviceClient();
  const dedupeKey = buildDedupeKey(p);

  // Load settings
  const { data: settings } = await supa
    .from("notification_settings")
    .select("*")
    .eq("singleton", true)
    .maybeSingle();

  if (!settings || !settings.telegram_enabled) {
    await logEvent(supa, p, dedupeKey, "skipped", "telegram_disabled");
    return { status: "skipped", reason: "telegram_disabled" };
  }

  const allowed: string[] = Array.isArray(settings.enabled_categories)
    ? settings.enabled_categories
    : [];
  if (p.category !== "test" && !allowed.includes(p.category)) {
    await logEvent(supa, p, dedupeKey, "skipped", "category_disabled");
    return { status: "skipped", reason: "category_disabled" };
  }

  if (SEVERITY_RANK[p.severity] < SEVERITY_RANK[settings.min_severity as Severity]) {
    await logEvent(supa, p, dedupeKey, "skipped", "below_min_severity");
    return { status: "skipped", reason: "below_min_severity" };
  }

  // Dedupe within window
  if (!p.bypass_dedupe) {
    const dedupeSince = new Date(Date.now() - settings.dedupe_window_seconds * 1000).toISOString();
    const { data: dup } = await supa
      .from("notification_events")
      .select("id")
      .eq("dedupe_key", dedupeKey)
      .eq("status", "sent")
      .gte("created_at", dedupeSince)
      .limit(1);
    if (dup && dup.length > 0) {
      await logEvent(supa, p, dedupeKey, "skipped", "deduped");
      return { status: "skipped", reason: "deduped" };
    }
  }

  // Rate limit (critical bypasses)
  if (p.severity !== "critical" && !p.bypass_dedupe) {
    const rlSince = new Date(Date.now() - settings.rate_limit_seconds * 1000).toISOString();
    const { count } = await supa
      .from("notification_events")
      .select("id", { count: "exact", head: true })
      .eq("status", "sent")
      .gte("created_at", rlSince);
    if ((count ?? 0) > 0) {
      await logEvent(supa, p, dedupeKey, "skipped", "rate_limited");
      return { status: "skipped", reason: "rate_limited" };
    }
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    await logEvent(supa, p, dedupeKey, "failed", "missing_telegram_secrets");
    return { status: "failed", reason: "missing_telegram_secrets" };
  }

  const text = buildMessage(p);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok) {
      const err = body?.description || `http_${res.status}`;
      await logEvent(supa, p, dedupeKey, "failed", err);
      return { status: "failed", reason: err };
    }
    await logEvent(supa, p, dedupeKey, "sent", null, body?.result?.message_id);
    return { status: "sent", message_id: body?.result?.message_id };
  } catch (e) {
    const msg = (e as Error).message;
    await logEvent(supa, p, dedupeKey, "failed", msg);
    return { status: "failed", reason: msg };
  }
}

async function logEvent(
  supa: ReturnType<typeof serviceClient>,
  p: AlertPayload,
  dedupeKey: string,
  status: "sent" | "skipped" | "failed",
  errorMessage: string | null = null,
  messageId?: number,
) {
  try {
    await supa.from("notification_events").insert({
      provider: "telegram",
      category: p.category,
      severity: p.severity,
      dedupe_key: dedupeKey,
      payload: { ...p, telegram_message_id: messageId ?? null },
      status,
      error_message: errorMessage,
      sent_at: status === "sent" ? new Date().toISOString() : null,
    });
  } catch {
    // best-effort logging
  }
}

// Fire-and-forget wrapper used by hot paths so a Telegram failure never blocks execution.
export function notify(p: AlertPayload): void {
  sendTelegramAlert(p).catch(() => {});
}
