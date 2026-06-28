# Coin Recommendations (/recommendations)

A new read-only decision-support page. No changes to execution, dispatcher, risk, bridge, orders, admission status logic, or `symbols.enabled` state — this page only reads existing data and classifies it.

## Data sources (existing, no schema changes)

- **Latest admission result** per symbol → `coin_admission_results` joined with the most recent `coin_admission_runs` (same pattern `/admission` already uses). Provides candidate_score, raw_candidate_score, candidate_bucket, status, trade_eligible, hard_kill_capped, hard_kill_rules, soft_failures, robustness, HTQ/trend, momentum, calibration_score + confidence, BT score/class/summary, breakdown.
- **Active symbols** → `symbols` table where `enabled = true` (same source Kontrollsenter uses at `/kontrollsenter`).
- **Health alerts** → latest `health_snapshots` row per symbol (same source Kontrollsenter / SymbolHealthPanel use). Includes status + captured_at; stale = older than threshold.
- **Latest admission run timestamp** → max(`coin_admission_runs.created_at`).

All reads through existing patterns (`supabase` browser client + RLS already permitting these tables for authenticated users).

## Route and structure

- New file `src/routes/_app.recommendations.tsx` under the existing authenticated `_app` layout.
- Sidebar link added to `AppLayout.tsx` next to Admission.
- Pure classification logic in a new `src/lib/recommendations/classify.ts` (no I/O, easy to test).

## Classification (pure, deterministic)

`classifySymbol(latestAdmission, isActive, health)` returns one of:
- `add_candidate` — not active, trade_eligible, no hard kills, status ∈ {approved, watchlist}, candidate_score ≥ 50, BT not "no_trades only".
- `keep_active` — active, candidate_score ≥ 65, trade_eligible, no hard kills, no severe health alert, status ≠ rejected.
- `watch_closely` — active, any of: 45 ≤ score < 65, status ∈ {watchlist, trend_candidate}, calibration_confidence = low, BT needs_review, soft_failures present, health warning, HTQ/robustness weakened, no_trades basis.
- `consider_remove` — active, any of: hard_kill_rules present, trade_eligible = false, score < 45, status = rejected, severe/stale health alert, calibration warning + low score, very low reviewed BT.

Sub-buckets for new candidates: Prime ≥ 80, Strong ≥ 65, Watch 50–65.

Each result includes a short generated `reason` string built from the triggering rule(s) and 2–3 positive/negative drivers (reused from candidate-score components and admission soft/hard rules). No AI text generation.

## Page layout

Top summary strip (cards): New candidates, Active healthy, Watch closely, Red flags, Active total, Latest admission run timestamp, Stale/missing health alerts.

Four sections (collapsible), each with a compact row list:
- A. Recommended New Coins (sorted candidate_score → calibration → BT → robustness → HTQ; default top 20 + "show more").
- B. Active — Keep / Healthy.
- C. Active — Watch Closely.
- D. Active — Red Flag / Consider Remove.

### Row (compact)
Symbol · Recommendation badge · Candidate Score + bucket bar · Status · Active y/n · Trade eligible y/n · Calibration (score + conf) · BT (score + class) · Robustness · HTQ · Momentum · Health status + last alert time · One-line key reason.

### Expanded detail (reuses existing components)
- Candidate Score breakdown (reuse `CandidateScoreBreakdown` from `/admission`).
- Calibration neighbors (reuse the neighbors table component already used in `/admission`).
- Last backtest summary (small read of `coin_backtest_results` latest row for symbol — same shape `/admission` uses).
- Health/Control Center status: active y/n, latest health snapshot, stale/missing warning.
- Recommendation explanation (deterministic).

## Filters

Top filter bar: Show (All / New / Active), Recommendation chips, Min Candidate Score slider, Bucket multi-select, Trade-eligible-only, Hide hard-kill-capped, Calibration confidence, BT reviewed only, Has health alert, Has hard kill, Has soft warnings, Active/Not. URL-backed via `validateSearch` so views are shareable.

## Data freshness banners

- If latest admission run > 24h old: "Admission data may be stale — run screener again."
- Per-row: if active and no health snapshot in last N minutes (reuse Kontrollsenter's stale threshold): "Health alert stale/missing."

## Files to add / touch

- Add `src/routes/_app.recommendations.tsx` — route, queries, filters, sections, summary strip.
- Add `src/lib/recommendations/classify.ts` — pure classifier + reason builder.
- Add `src/components/recommendations/RecommendationRow.tsx` and `SectionBlock.tsx`.
- Edit `src/components/AppLayout.tsx` — add sidebar nav entry.

## Non-goals (explicit)

No writes anywhere. No mutation of `symbols.enabled`, no execution calls, no admission re-run trigger, no auto add/remove. No changes to dispatcher, executor, risk, bridge, orders, signal flow, or admission scoring code.

## Acceptance

- `/recommendations` renders with the four sections and summary strip.
- Active symbols never appear under "Recommended New Coins".
- Classification matches the rules above and shows a reason per row.
- Hard-kill symbols always land in Red Flag.
- Health alert freshness shown for active symbols when data available.
- Zero changes to execution/trading-related modules.
