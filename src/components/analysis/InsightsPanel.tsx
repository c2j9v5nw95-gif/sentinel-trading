/**
 * Collapsible auto-generated insights panel for /analysis.
 */

import { useMemo, useState } from 'react';
import { Card } from '@/components/PageHeader';
import type { Insight, InsightCategory, InsightSeverity } from '@/lib/analysis/insights';

const SEVERITY_STYLES: Record<InsightSeverity, string> = {
  positive: 'border-emerald-500/40 bg-emerald-500/5',
  info: 'border-border bg-muted/20',
  warning: 'border-amber-500/50 bg-amber-500/5',
};

const SEVERITY_DOT: Record<InsightSeverity, string> = {
  positive: 'bg-emerald-500',
  info: 'bg-sky-500',
  warning: 'bg-amber-500',
};

const CATEGORY_LABEL: Record<InsightCategory, string> = {
  dataset: 'Datasett',
  drivers: 'Drivere',
  correlation: 'Korrelasjoner',
  segments: 'Sweet spots',
  anti: 'Anti-mønstre',
  ranking: 'Ranking',
  quality: 'Datakvalitet',
  recommendation: 'Anbefaling',
};

const CATEGORY_ORDER: InsightCategory[] = [
  'dataset',
  'drivers',
  'correlation',
  'segments',
  'anti',
  'ranking',
  'recommendation',
  'quality',
];

export function InsightsPanel({ insights }: { insights: Insight[] }) {
  const [open, setOpen] = useState(true);

  const grouped = useMemo(() => {
    const map = new Map<InsightCategory, Insight[]>();
    for (const i of insights) {
      if (!map.has(i.category)) map.set(i.category, []);
      map.get(i.category)!.push(i);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [insights]);

  const counts = useMemo(() => {
    const c = { positive: 0, info: 0, warning: 0 } as Record<InsightSeverity, number>;
    for (const i of insights) c[i.severity]++;
    return c;
  }, [insights]);

  return (
    <Card>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span>📋 Insights</span>
          <span className="text-xs font-normal text-muted-foreground">
            auto-generert fra aktivt datasett · {insights.length} funn
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {counts.positive > 0 && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {counts.positive}
            </span>
          )}
          {counts.warning > 0 && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {counts.warning}
            </span>
          )}
          {counts.info > 0 && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-sky-500" />
              {counts.info}
            </span>
          )}
          <span>{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {insights.length === 0 && (
            <p className="text-xs text-muted-foreground">Ingen insights å vise.</p>
          )}
          {grouped.map(([cat, items]) => (
            <div key={cat}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABEL[cat]}
              </div>
              <ul className="space-y-1.5">
                {items.map((i) => (
                  <li
                    key={i.id}
                    className={`flex gap-2 rounded border px-2 py-1.5 text-xs ${SEVERITY_STYLES[i.severity]}`}
                  >
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[i.severity]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-foreground">{i.title}</div>
                      <div className="text-muted-foreground">{i.text}</div>
                      {i.detail && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground/80">{i.detail}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
