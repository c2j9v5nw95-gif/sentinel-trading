# Mobile Pulse MVP — Plan

A separate mobile-first surface alongside the existing desktop console. Strictly read-only, three tabs: **Pulse / Positions / Alerts**. iPhone Pro Max as the reference device, safe-area aware, calm mission-control aesthetic.

No execution, no mutations, no new backend services. Reuse existing tables + queries from the current overview/positions/alerts code.

---

## 1. Information Architecture

```
/m                    → redirects to /m/pulse
/m/pulse              → Tab 1: system pulse (default)
/m/positions          → Tab 2: open positions list
/m/positions/$symbol  → drill-in for a single open position
/m/alerts             → Tab 3: alerts inbox
```

- `/m` is its own layout route — **no desktop sidebar**, **no `StatusBar`**, **no `LiveRiskHaltedBanner`** chrome.
- Desktop routes (`/overview`, `/positions`, …) stay untouched.
- Auto-route on small viewports: on first load, if `window.innerWidth < 768` and path is `/`, redirect to `/m/pulse`. Desktop users are never forced into mobile.
- A small "Desktop view" link in the mobile settings drawer (later) is the only escape hatch — not in MVP.

Per-tab content:

- **Pulse** = Live Status Strip → Today Hero → Open Positions stack → Needs Attention (conditional).
- **Positions** = card list of open positions → tap → detail view (KPIs, TradingView mini, timeline).
- **Alerts** = grouped Critical / Warning / Info, newest first.

---

## 2. Component Hierarchy

```
src/routes/
  _mobile.tsx                       layout: safe-area shell + bottom tab bar
  _mobile.index.tsx                 redirect → /m/pulse
  _mobile.pulse.tsx
  _mobile.positions.tsx
  _mobile.positions_.$symbol.tsx
  _mobile.alerts.tsx

src/components/mobile/
  shell/
    MobileShell.tsx                 safe-area wrapper, scroll container
    BottomTabBar.tsx                3 tabs, thumb-zone, active indicator
    TopBrandBar.tsx                 thin header, mode chip (LIVE/PAPER/TESTNET)
  pulse/
    LiveStatusStrip.tsx             horizontally scrollable status pills
    StatusPill.tsx                  reusable pill (green/yellow/red)
    TodayHero.tsx                   large PnL card + sparkline
    OpenPositionsStack.tsx          stacked cards
    PositionCard.tsx                shared with Positions tab
    NeedsAttentionList.tsx          conditional, severity-grouped
    AttentionItem.tsx
  positions/
    PositionListItem.tsx
    PositionDetail.tsx              KPI grid + chart + timeline
    PositionTimeline.tsx            vertical event timeline
    MiniTradingView.tsx             thin wrapper around existing TradingViewChart
  alerts/
    AlertsGroup.tsx                 section header + count
    AlertRow.tsx
  primitives/
    Metric.tsx                      label + big value + delta
    Sparkline.tsx                   reuse from src/components/overview/Sparkline.tsx
    Sheet.tsx                       bottom sheet (shadcn Drawer wrapper)
```

Reused as-is: `src/integrations/supabase/client`, existing query patterns from `RealizedPnLTodayCard`, `UnrealizedPnLCard`, `BridgeHealthCard`, `RecoveryAlertBanner`, the alerts query in `_app.alerts.tsx`, `Sparkline`, `format.ts` helpers (`fmtNum`, `fmtSigned`, `pnlTone`, `fmtAge`, `fmtDuration`).

Reused for detail: existing `TradingViewChart` (perpetuals format `BYBIT:{symbol}.P`).

---

## 3. Mobile Interaction Model

- **One-hand, thumb-zone**: bottom tab bar fixed at `bottom + safe-area-inset-bottom`, primary actions (drill-in arrows, expand) always in lower 2/3 of screen.
- **Minimal taps**: Pulse tab is fully visible without taps. Position cards expand to detail with a single tap (full route, not modal — back swipe works).
- **No execution affordances**: cards are visually flat, no buttons that could be misread as "close" or "stop". Only chevron-right for navigation and pull-to-refresh.
- **Pull-to-refresh** on Pulse and Alerts (invalidates the React Query cache for that screen). No live websocket added in MVP — same `refetchInterval` cadence as today (5–30s).
- **Soft animations**: Tailwind `transition-*` only. Tab-switch fade. Status pill color changes ease over 300ms. No heavyweight motion libs.
- **Calm error states**: empty/healthy = blank space + small reassurance line ("All clear"). Never red unless real.
- **Swipe-to-acknowledge**: out of scope for MVP (would require a write). Alerts list is read-only.

---

## 4. Responsive Strategy

- Mobile surface lives under `/m/*` and is **always rendered at mobile widths** regardless of device — works on desktop too for testing, but layout is locked to a single column max-width 480px, centered.
- Use Tailwind `sm:` only inside the mobile shell to slightly enlarge typography on iPhone Pro Max (≥430 CSS px). No `md:`/`lg:` inside `/m/*`.
- Safe areas: root mobile shell uses `pt-[env(safe-area-inset-top)]` and `pb-[calc(env(safe-area-inset-bottom)+64px)]` (tab bar height).
- Viewport meta: ensure `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` is present in `__root.tsx` (it must already cover the desktop case; verify on implementation).
- Existing desktop routes are unchanged.

---

## 5. Data Requirements

All from existing tables — **no schema changes, no new server functions**.

| Surface | Source |
|---|---|
| Live Status Strip — LIVE / PAPER / TESTNET | `app_settings` (live_enabled, paper_mode_enabled, emergency_stop, entries_paused) |
| Bridge healthy | `bridge_health_checks` latest row (reuse logic from `BridgeHealthCard`) |
| Bybit synced / stale market data | latest `health_snapshots` age + bridge latency |
| Recovery pending | `RecoveryAlertBanner` query |
| Unprotected positions | `positions` where `protection_state='unprotected' AND closed_at IS NULL` |
| Today Hero — realized | `positions` closed since 00:00 UTC (reuse `RealizedPnLTodayCard`) |
| Today Hero — unrealized | open `positions` (reuse `UnrealizedPnLCard` calc) |
| Equity sparkline | `balance_snapshots` last 24h (reuse `EquityCard` query) |
| Open Positions cards | `positions` where `closed_at IS NULL` |
| Position detail | `positions` row + related `signals`/`orders` for timeline |
| Alerts | `system_alerts` (reuse query from `_app.alerts.tsx`) grouped by severity |

Refetch cadence (matches desktop today):
- Status + positions: 5s
- Realized PnL / equity: 10–30s
- Alerts: 5s

---

## 6. Route Structure

TanStack file-based, flat dot-separated:

```
src/routes/
  _mobile.tsx                       (layout, no auth change — mirrors _app.tsx guard)
  _mobile.index.tsx                 (Navigate to /m/pulse)
  _mobile.pulse.tsx
  _mobile.positions.tsx
  _mobile.positions_.$symbol.tsx
  _mobile.alerts.tsx
```

Notes:
- Path prefix is `/m` (rename `_mobile` segment via `createFileRoute("/m")` etc., or keep file convention with explicit `id`/`path`). Will confirm exact naming at implementation against routeTree generation.
- `_mobile.tsx` mirrors `_app.tsx`'s session guard (no SSR session check, client-side redirect to `/login`).
- Optional `/` redirect: small client-side check in `src/routes/index.tsx` — if mobile width, `Navigate to="/m/pulse"`. Desktop unchanged.

---

## 7. PWA Strategy

Per project policy (PWA off by default in Lovable preview):

- **MVP: manifest only, no service worker.** Add `public/manifest.webmanifest` with name, short_name, icons, `display: "standalone"`, `start_url: "/m/pulse"`, `theme_color` matching dark surface, `background_color` matching app background.
- Add iOS-specific tags in `__root.tsx` head: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-touch-icon`.
- Result: installable on iPhone via "Add to Home Screen", launches into `/m/pulse` in standalone mode, safe-area honored — **no service worker, no offline cache**, no preview-iframe issues.
- Defer `vite-plugin-pwa` / offline / push notifications to a later phase, with explicit user opt-in.

---

## 8. Implementation Phases

**Phase A — Shell & navigation** (foundation)
- `_mobile` layout, bottom tab bar, top brand bar with mode chip
- Three empty tab routes
- Manifest + iOS meta + safe-area styling
- `/` smart redirect for narrow viewports

**Phase B — Pulse tab**
- LiveStatusStrip + StatusPill (wired to existing queries)
- TodayHero (realized + unrealized + sparkline)
- OpenPositionsStack with PositionCard
- NeedsAttentionList (conditional)
- Pull-to-refresh

**Phase C — Positions tab**
- List view (PositionListItem)
- Detail route with KPI grid, MiniTradingView, PositionTimeline

**Phase D — Alerts tab**
- Grouped Critical / Warning / Info
- Severity-coloured rows, age badges

**Phase E — Polish**
- Empty/healthy "all clear" states
- Animation timings, haptic-ish micro-interactions (CSS only)
- iPhone Pro Max QA pass at 430×932

Out of scope for this MVP (explicit): screener, analytics, replay, execution, swipe-to-ack writes, websockets, offline cache, push notifications.

---

## Technical notes (for implementation, not user-facing)

- No changes to writers, execution, dispatcher, signal processing, sizing, or any server function.
- All queries use existing `supabase` client; no new RPCs.
- TradingView embed for detail: free widget, perpetual `BYBIT:{symbol}.P` (per project rule).
- Reuse `src/components/overview/format.ts` and `Sparkline.tsx` directly — do not fork.
- File naming will follow TanStack flat dot convention; I'll confirm `_mobile` → `/m` mapping at build time and adjust `createFileRoute(...)` paths accordingly.
