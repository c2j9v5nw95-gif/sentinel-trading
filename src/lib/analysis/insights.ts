/**
 * Deterministic, rule-based insight generator for the /analysis page.
 * Pure TS — takes rows + ranked list, returns a list of human-readable findings.
 * No LLM, no side effects.
 */

import type { AnalysisDataset, AnalysisRow, FeatureKey } from './analysis.functions';
import { ALL_FEATURES } from './analysis.functions';
import {
  LABEL_ORDER,
  bucketByQuartile,
  correlateFeatureWithTargets,
  labelMix,
  summarizeFeature,
  type RankedRow,
} from './stats';

export type InsightSeverity = 'positive' | 'info' | 'warning';
export type InsightCategory =
  | 'dataset'
  | 'drivers'
  | 'correlation'
  | 'segments'
  | 'anti'
  | 'ranking'
  | 'quality'
  | 'recommendation';

export interface Insight {
  id: string;
  severity: InsightSeverity;
  category: InsightCategory;
  title: string;
  text: string;
  detail?: string;
}

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined, digits = 2) =>
  v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/** Overall baseline win-share (profitable + profitable_plus) / n on active rows. */
function baseline(rows: AnalysisRow[]) {
  return labelMix(rows).winShare;
}

function datasetInsights(dataset: AnalysisDataset, active: AnalysisRow[]): Insight[] {
  const out: Insight[] = [];
  const mix = labelMix(active);
  const base = mix.winShare;

  out.push({
    id: 'ds-size',
    severity: 'info',
    category: 'dataset',
    title: 'Datasett',
    text: `${dataset.meta.included} aktive symboler analysert (${dataset.meta.excluded} ekskludert). Baseline win-share = ${pct(base, 1)}.`,
    detail: `Label-fordeling: ${LABEL_ORDER.map((l) => `${l} ${mix.counts[l]} (${pct(mix.n ? mix.counts[l] / mix.n : 0, 0)})`).join(' · ')}`,
  });

  if (dataset.meta.included === 0) {
    out.push({
      id: 'ds-empty',
      severity: 'warning',
      category: 'dataset',
      title: 'For lite data',
      text: 'Ingen aktive rader etter filtrering — juster filtre eller importer flere backtests.',
    });
    return out;
  }

  const rejectedShare = mix.n ? mix.counts.rejected_backtest / mix.n : 0;
  if (rejectedShare > 0.7) {
    out.push({
      id: 'ds-reject-heavy',
      severity: 'warning',
      category: 'quality',
      title: 'Aggressiv filtrering',
      text: `${pct(rejectedShare, 0)} av backtests er rejected — strategien slipper gjennom få kandidater. Vurder mildere terskler eller re-kalibrering.`,
    });
  }
  if (base < 0.05 && mix.n >= 20) {
    out.push({
      id: 'ds-low-winshare',
      severity: 'warning',
      category: 'quality',
      title: 'Svært lav vinner-andel',
      text: `Kun ${pct(base, 1)} av symboler er profitable — vanskelig å trekke robuste konklusjoner om drivere.`,
    });
  }
  if (dataset.meta.strategies.length === 1) {
    out.push({
      id: 'ds-single-strategy',
      severity: 'info',
      category: 'quality',
      title: 'Én strategi-versjon',
      text: 'Kun én strategy_version i datasettet — kjør flere versjoner for å sammenligne edge over tid.',
    });
  }
  return out;
}

function driverInsights(active: AnalysisRow[]): Insight[] {
  const out: Insight[] = [];
  if (active.length < 10) return out;

  const summaries = ALL_FEATURES.map((f) => summarizeFeature(active, f))
    .filter((s) => s.n >= 10 && s.separation != null && Number.isFinite(s.separation))
    .sort((a, b) => Math.abs(b.separation!) - Math.abs(a.separation!));

  const top = summaries.slice(0, 3).filter((s) => Math.abs(s.separation!) >= 0.3);
  if (top.length === 0) {
    out.push({
      id: 'drv-none',
      severity: 'info',
      category: 'drivers',
      title: 'Ingen tydelige drivere',
      text: 'Ingen feature skiller vinnere fra tapere med Cohen\'s d ≥ 0.3. Datasettet kan være for lite eller strategien for uniform.',
    });
    return out;
  }
  for (const s of top) {
    const d = s.separation!;
    const winMed = s.perLabel.profitable_plus.median ?? s.perLabel.profitable.median;
    const loseMed = s.perLabel.rejected_backtest.median;
    const strength = Math.abs(d) >= 0.8 ? 'stor' : Math.abs(d) >= 0.5 ? 'merkbar' : 'moderat';
    const dir = d > 0 ? 'høyere' : 'lavere';
    out.push({
      id: `drv-${s.feature}`,
      severity: 'positive',
      category: 'drivers',
      title: `Driver: ${s.feature}`,
      text: `${strength} separasjon (d=${d.toFixed(2)}) — vinnere har ${dir} verdi. Median vinnere ${num(winMed)} vs. tapere ${num(loseMed)}.`,
    });
  }

  // Correlations vs net%
  const corrs = ALL_FEATURES.map((f) => ({ f, ...correlateFeatureWithTargets(active, f) }))
    .filter((c) => c.n >= 10 && c.net != null && Math.abs(c.net) >= 0.3)
    .sort((a, b) => Math.abs(b.net!) - Math.abs(a.net!))
    .slice(0, 3);
  for (const c of corrs) {
    const dir = c.net! > 0 ? 'positivt' : 'negativt';
    out.push({
      id: `corr-${c.f}`,
      severity: 'info',
      category: 'correlation',
      title: `Korrelasjon: ${c.f}`,
      text: `${dir} korrelert med net% (r=${c.net!.toFixed(2)}, n=${c.n}).`,
    });
  }
  return out;
}

function segmentInsights(active: AnalysisRow[]): Insight[] {
  const out: Insight[] = [];
  const base = baseline(active);
  if (active.length < 12 || base <= 0) return out;

  type Hit = { feature: FeatureKey; q: number; edge: [number, number]; ws: number; n: number; lift: number };
  const hits: Hit[] = [];
  const antiHits: Hit[] = [];

  for (const f of ALL_FEATURES) {
    const b = bucketByQuartile(active, f);
    if (!b) continue;
    b.buckets.forEach((bucket, qi) => {
      if (bucket.length < 5) return;
      const ws = labelMix(bucket).winShare;
      const lift = base > 0 ? ws / base : 0;
      const edge: [number, number] = [b.edges[qi], b.edges[qi + 1]];
      if (ws >= base * 1.5 && ws >= 0.25) {
        hits.push({ feature: f, q: qi + 1, edge, ws, n: bucket.length, lift });
      }
      if (ws === 0 && bucket.length >= 5) {
        antiHits.push({ feature: f, q: qi + 1, edge, ws, n: bucket.length, lift: 0 });
      }
    });
  }

  hits.sort((a, b) => b.lift - a.lift);
  for (const h of hits.slice(0, 4)) {
    out.push({
      id: `seg-${h.feature}-q${h.q}`,
      severity: 'positive',
      category: 'segments',
      title: `Sweet spot: ${h.feature} Q${h.q}`,
      text: `Range ${num(h.edge[0])}–${num(h.edge[1])}: ${pct(h.ws, 0)} win-share (${h.lift.toFixed(1)}× baseline), n=${h.n}.`,
    });
  }

  antiHits.sort((a, b) => b.n - a.n);
  for (const h of antiHits.slice(0, 3)) {
    out.push({
      id: `anti-${h.feature}-q${h.q}`,
      severity: 'warning',
      category: 'anti',
      title: `Unngå: ${h.feature} Q${h.q}`,
      text: `Range ${num(h.edge[0])}–${num(h.edge[1])}: 0/${h.n} vinnere — konsistent unngå-sone.`,
    });
  }

  return out;
}

function rankingInsights(active: AnalysisRow[], ranked: RankedRow[]): Insight[] {
  const out: Insight[] = [];
  if (ranked.length === 0) return out;
  const topN = ranked.slice(0, 5);
  const names = topN.map((r) => r.row.symbol).join(', ');
  out.push({
    id: 'rank-top5',
    severity: 'info',
    category: 'ranking',
    title: 'Topp 5 kandidater',
    text: names,
    detail: topN
      .map((r) => {
        const parts = r.parts;
        const dominant = (Object.entries(parts) as [string, number][]).sort((a, b) => b[1] - a[1])[0];
        return `${r.row.symbol} (score ${r.score.toFixed(2)}, drevet av ${dominant[0]})`;
      })
      .join(' · '),
  });

  // Label bias in top 10
  const top10 = ranked.slice(0, 10);
  const labelCounts: Record<string, number> = {};
  for (const r of top10) {
    const l = r.row.label ?? 'unknown';
    labelCounts[l] = (labelCounts[l] ?? 0) + 1;
  }
  const dominant = Object.entries(labelCounts).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 8 && top10.length === 10) {
    out.push({
      id: 'rank-bias',
      severity: 'warning',
      category: 'ranking',
      title: 'Skjev topp 10',
      text: `${dominant[1]}/10 av top-kandidater har label=${dominant[0]} — score kan være dominert av label-bonus.`,
    });
  }

  const tfSet = new Set(top10.map((r) => r.row.timeframe));
  if (tfSet.size === 1 && new Set(active.map((r) => r.timeframe)).size > 1) {
    out.push({
      id: 'rank-tf-bias',
      severity: 'info',
      category: 'ranking',
      title: 'Timeframe-bias',
      text: `Alle top-10 er på timeframe=${[...tfSet][0]} — vurder å sammenligne på tvers.`,
    });
  }
  return out;
}

function recommendationInsight(active: AnalysisRow[]): Insight[] {
  // Combine top-2 driver sweet spots into a single rule and count hits.
  if (active.length < 15) return [];
  const summaries = ALL_FEATURES.map((f) => summarizeFeature(active, f))
    .filter((s) => s.n >= 10 && s.separation != null)
    .sort((a, b) => Math.abs(b.separation!) - Math.abs(a.separation!))
    .slice(0, 3);

  type Rule = { feature: FeatureKey; op: '>' | '<'; threshold: number };
  const rules: Rule[] = [];
  for (const s of summaries) {
    if (s.separation == null || Math.abs(s.separation) < 0.3) continue;
    // Use median of the winning group as threshold.
    const winMed =
      s.perLabel.profitable_plus.median ?? s.perLabel.profitable.median;
    if (winMed == null) continue;
    rules.push({ feature: s.feature, op: s.separation > 0 ? '>' : '<', threshold: winMed });
  }
  if (rules.length < 2) return [];

  const matched = active.filter((r) =>
    rules.every((rl) => {
      const v = r.features[rl.feature];
      if (v == null) return false;
      return rl.op === '>' ? v > rl.threshold : v < rl.threshold;
    }),
  );
  if (matched.length < 5) return [];
  const ws = labelMix(matched).winShare;
  if (ws < 0.5) return [];
  const ruleText = rules
    .map((r) => `${r.feature} ${r.op} ${num(r.threshold)}`)
    .join(' OG ');
  return [
    {
      id: 'reco-composite',
      severity: 'positive',
      category: 'recommendation',
      title: 'Sammensatt regel',
      text: `Prioriter symboler hvor ${ruleText} — ${matched.length} treff, ${pct(ws, 0)} win-share.`,
    },
  ];
}

function coverageWarnings(active: AnalysisRow[]): Insight[] {
  if (active.length < 10) return [];
  const out: Insight[] = [];
  const low: string[] = [];
  for (const f of ALL_FEATURES) {
    let n = 0;
    for (const r of active) if (r.features[f] != null) n++;
    const cov = n / active.length;
    if (cov < 0.3) low.push(`${f} (${pct(cov, 0)})`);
  }
  if (low.length) {
    out.push({
      id: 'cov-low',
      severity: 'warning',
      category: 'quality',
      title: 'Lav feature-dekning',
      text: `Følgende features har <30% dekning og bør tolkes forsiktig: ${low.join(', ')}.`,
    });
  }
  return out;
}

export function generateInsights(
  dataset: AnalysisDataset,
  active: AnalysisRow[],
  ranked: RankedRow[],
): Insight[] {
  return [
    ...datasetInsights(dataset, active),
    ...driverInsights(active),
    ...segmentInsights(active),
    ...rankingInsights(active, ranked),
    ...recommendationInsight(active),
    ...coverageWarnings(active),
  ];
}
