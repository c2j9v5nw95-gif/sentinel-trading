## Scope

Frontend-only enhancement to `/analytics-debug`. No writer, schema, or execution changes.

## Changes

**File:** `src/routes/_app.analytics-debug.tsx` (only this file)

### 1. Expandable rows for `signal_context_snapshots` table

- Add a leading "▸" toggle column.
- Track expanded row IDs in local `useState<Set<string>>`.
- When expanded, render a sub-row spanning all columns with:
  - **For trade rows (`tf_role === 'trade'`)**: a "Trade row detail" key/value grid (see #3).
  - **For context rows**: a compact key/value grid of the indicator subset (`ema_slope_pct`, `adx14`, `atr_pct`, `rel_volume_20`, `dist_from_ema50_pct`, `regime_class`).
  - Plus a collapsible `<pre>` with the full JSON payload (raw view) for both roles.

### 2. `tf_source` badge

- In the `signal_context_snapshots` table, add a small badge next to the `tf` cell.
- Reads `payload.tf_source` (set by writer: `'health_snapshot'`, otherwise treat as `'payload'` when timeframe is present, `'—'` when null).
- Visual:
  - `payload` → neutral muted badge
  - `health_snapshot` → warning-tinted badge (so fallback usage is visible at a glance)
  - missing/null → dashed border muted badge

### 3. Trade row detail view (key/value)

A two-column grid rendering the trade payload fields in a fixed, readable order:

```text
regime_class      tf_source
atr               atr_pct
candle_range_pct  rel_volume_20
ema20             ema50
ema200            ema_slope_pct
dist_from_ema50_pct  rsi14
adx14             volume
```

- Numbers formatted via existing `fmtNum` helper from `src/components/overview/format.ts`.
- Missing fields render `—`.
- Plus a "Show raw JSON" toggle revealing the full `payload` as `<pre>`.

### 4. JSON popover for `regime_snapshots`

- Add the same "▸" expand affordance to the regime table.
- Expanded row shows full `payload` JSON (these rows are already key/value-ish in columns, so no separate detail grid needed — just raw JSON for completeness).

## Out of scope (explicitly NOT doing)

- No Snapshot Explorer page.
- No new analytics endpoints, writers, or DB queries beyond the existing four `useQuery` hooks.
- No changes to `snapshot-signal-context.server.ts`, `snapshot-regime.server.ts`, or any bridge/executor code.
- No new routes; stays on `/analytics-debug`.
- No styling tokens added — uses existing semantic tokens (`muted`, `warning`, `border`, `card`).

## Technical notes

- All state is local `useState` in `AnalyticsDebugPage`. No new hooks files.
- Expansion state keyed by row `id` (uuid), separate Sets for context table and regime table.
- Reuses the existing `Pre` component for raw JSON.
- New small `KV` helper component (local to the file) for the key/value grid.
