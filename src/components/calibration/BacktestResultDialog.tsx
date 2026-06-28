import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import {
  createBacktestResult,
  extractScreenshot,
  listStrategyVersions,
} from '@/lib/calibration/calibration.functions';
import type { OcrExtraction } from '@/lib/calibration/ocr.server';

type Label = 'rejected_backtest' | 'marginal' | 'profitable' | 'profitable_plus';

const LABEL_OPTIONS: Array<{ value: Label; label: string }> = [
  { value: 'rejected_backtest', label: 'Rejected Backtest' },
  { value: 'marginal', label: 'Marginal' },
  { value: 'profitable', label: 'Profitable' },
  { value: 'profitable_plus', label: 'Profitable+' },
];

function autoSuggest(input: {
  net_profit_pct: string;
  max_drawdown_pct: string;
  profit_factor: string;
  num_trades: string;
}): Label {
  const pnl = parseFloat(input.net_profit_pct);
  const dd = Math.abs(parseFloat(input.max_drawdown_pct));
  const pf = parseFloat(input.profit_factor);
  const tr = parseInt(input.num_trades, 10);
  if (!Number.isFinite(pnl) || pnl <= 0 || !(pf >= 1) || !(tr >= 10)) return 'rejected_backtest';
  if (pf >= 1.5 && pnl >= 15 && (Number.isFinite(dd) ? dd <= 15 : true)) return 'profitable_plus';
  if (pf >= 1.2 && pnl >= 5 && (Number.isFinite(dd) ? dd <= 25 : true)) return 'profitable';
  return 'marginal';
}

export type BacktestDialogPrefill = {
  symbol?: string;
  admission_result_id?: string | null;
  admission_run_id?: string | null;
  screener_snapshot?: Record<string, any> | null;
  timeframe?: string;
  candles_tested?: number;
  lookback_equivalent_days?: number | null;
};

type FormFields = {
  symbol: string;
  test_date: string;
  strategy_version: string;
  timeframe: string;
  candles_tested: string;
  net_profit_pct: string;
  net_profit_usd: string;
  max_drawdown_pct: string;
  max_drawdown_usd: string;
  profit_factor: string;
  win_rate_pct: string;
  num_trades: string;
  avg_pnl_pct: string;
  avg_bars_in_trade: string;
  expected_payoff_usd: string;
  sharpe_ratio: string;
  largest_profit_usd: string;
  largest_loss_usd: string;
  profitable_trades_count: string;
  losing_trades_count: string;
  notes: string;
  label: Label;
};

function emptyForm(): FormFields {
  return {
    symbol: '',
    test_date: new Date().toISOString().slice(0, 10),
    strategy_version: '',
    timeframe: '5m',
    candles_tested: '9000',
    net_profit_pct: '',
    net_profit_usd: '',
    max_drawdown_pct: '',
    max_drawdown_usd: '',
    profit_factor: '',
    win_rate_pct: '',
    num_trades: '',
    avg_pnl_pct: '',
    avg_bars_in_trade: '',
    expected_payoff_usd: '',
    sharpe_ratio: '',
    largest_profit_usd: '',
    largest_loss_usd: '',
    profitable_trades_count: '',
    losing_trades_count: '',
    notes: '',
    label: 'marginal',
  };
}

const OCR_FIELDS: Array<keyof FormFields> = [
  'net_profit_pct',
  'net_profit_usd',
  'max_drawdown_pct',
  'max_drawdown_usd',
  'profit_factor',
  'win_rate_pct',
  'num_trades',
  'avg_pnl_pct',
  'avg_bars_in_trade',
  'expected_payoff_usd',
  'sharpe_ratio',
  'largest_profit_usd',
  'largest_loss_usd',
  'profitable_trades_count',
  'losing_trades_count',
];

function confidenceClass(c: number | undefined): string {
  if (c == null) return '';
  if (c >= 0.7) return '';
  if (c >= 0.4) return 'border-yellow-500/70 bg-yellow-500/5';
  return 'border-red-500/70 bg-red-500/5';
}

export function BacktestResultDialog({
  open,
  onOpenChange,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  prefill?: BacktestDialogPrefill;
  onSaved?: () => void;
}) {
  const [tab, setTab] = useState<'manual' | 'screenshot'>('manual');
  const [form, setForm] = useState<FormFields>(emptyForm);
  const [labelTouched, setLabelTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Screenshot/OCR state
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'failed'>('idle');
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<OcrExtraction | null>(null);
  const [ocrUsed, setOcrUsed] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const versionsQ = useQuery({
    queryKey: ['calibration-strategy-versions'],
    queryFn: () => listStrategyVersions(),
    enabled: open,
  });

  // Apply prefill + default strategy version when dialog opens
  useEffect(() => {
    if (!open) return;
    const fresh = emptyForm();
    if (prefill?.symbol) fresh.symbol = prefill.symbol;
    if (prefill?.timeframe) fresh.timeframe = prefill.timeframe;
    if (prefill?.candles_tested) fresh.candles_tested = String(prefill.candles_tested);
    setForm(fresh);
    setLabelTouched(false);
    setError(null);
    setStage('idle');
    setStoragePath(null);
    setExtraction(null);
    setOcrUsed(false);
    setOcrError(null);
    setTab('manual');
  }, [open, prefill?.symbol]);

  // Global paste handler: while dialog is open, Ctrl/Cmd+V with an image on the
  // clipboard uploads it to the OCR pipeline regardless of which tab is active.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          // Switch to screenshot tab so the user sees status/feedback
          setTab('screenshot');
          // Wrap in a File with a sane name for storage
          const named = new File([file], `paste-${Date.now()}.${(file.type.split('/')[1] || 'png')}`, {
            type: file.type,
          });
          void handleUpload(named);
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open]);


  // Set strategy version once versions load and user hasn't typed
  useEffect(() => {
    if (!open || !versionsQ.data || form.strategy_version) return;
    const def =
      versionsQ.data.last_used_by_user ??
      versionsQ.data.default_fallback ??
      versionsQ.data.last_used_global ??
      '';
    if (def) setForm((f) => ({ ...f, strategy_version: def }));
  }, [open, versionsQ.data, form.strategy_version]);

  // Auto-suggest label as user types numbers — unless they manually changed it
  useEffect(() => {
    if (labelTouched) return;
    const lbl = autoSuggest({
      net_profit_pct: form.net_profit_pct,
      max_drawdown_pct: form.max_drawdown_pct,
      profit_factor: form.profit_factor,
      num_trades: form.num_trades,
    });
    setForm((f) => (f.label === lbl ? f : { ...f, label: lbl }));
  }, [form.net_profit_pct, form.max_drawdown_pct, form.profit_factor, form.num_trades, labelTouched]);

  const lookbackDays = useMemo(() => {
    const candles = parseInt(form.candles_tested, 10);
    if (!Number.isFinite(candles) || candles <= 0) return null;
    const tfMinutes: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
    const mins = tfMinutes[form.timeframe] ?? 5;
    return Math.round((candles * mins) / 1440);
  }, [form.candles_tested, form.timeframe]);

  const handleUpload = async (file: File) => {
    setOcrError(null);
    setExtraction(null);
    setStage('uploading');
    try {
      const { data: u, error: uerr } = await supabase.auth.getUser();
      if (uerr || !u.user) throw new Error('not_signed_in');
      const ext = file.name.split('.').pop() || 'png';
      const path = `${u.user.id}/uploads/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('backtest-screenshots')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      setStoragePath(path);
      setStage('extracting');
      const res = await extractScreenshot({ data: { storage_path: path } });
      if (!res.ok || !res.extraction) {
        setOcrError(res.error ?? 'extraction_failed');
        setStage('failed');
        setOcrUsed(true);
        return;
      }
      setExtraction(res.extraction);
      setOcrUsed(true);
      // Prefill form fields from extraction
      const m = res.extraction.metrics;
      setForm((f) => ({
        ...f,
        net_profit_usd: m.net_profit_usd.value != null ? String(m.net_profit_usd.value) : f.net_profit_usd,
        net_profit_pct: m.net_profit_pct.value != null ? String(m.net_profit_pct.value) : f.net_profit_pct,
        max_drawdown_usd: m.max_drawdown_usd.value != null ? String(m.max_drawdown_usd.value) : f.max_drawdown_usd,
        max_drawdown_pct: m.max_drawdown_pct.value != null ? String(m.max_drawdown_pct.value) : f.max_drawdown_pct,
        win_rate_pct: m.win_rate_pct.value != null ? String(m.win_rate_pct.value) : f.win_rate_pct,
        num_trades: m.num_trades.value != null ? String(m.num_trades.value) : f.num_trades,
        profit_factor: m.profit_factor.value != null ? String(m.profit_factor.value) : f.profit_factor,
        expected_payoff_usd: m.expected_payoff_usd.value != null ? String(m.expected_payoff_usd.value) : f.expected_payoff_usd,
        sharpe_ratio: m.sharpe_ratio.value != null ? String(m.sharpe_ratio.value) : f.sharpe_ratio,
        avg_pnl_pct: m.avg_pnl_pct.value != null ? String(m.avg_pnl_pct.value) : f.avg_pnl_pct,
        avg_bars_in_trade: m.avg_bars_in_trade.value != null ? String(m.avg_bars_in_trade.value) : f.avg_bars_in_trade,
        largest_profit_usd: m.largest_profit_usd.value != null ? String(m.largest_profit_usd.value) : f.largest_profit_usd,
        largest_loss_usd: m.largest_loss_usd.value != null ? String(m.largest_loss_usd.value) : f.largest_loss_usd,
        profitable_trades_count: m.profitable_trades_count.value != null ? String(m.profitable_trades_count.value) : f.profitable_trades_count,
        losing_trades_count: m.losing_trades_count.value != null ? String(m.losing_trades_count.value) : f.losing_trades_count,
      }));
      setStage('review');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : String(err));
      setStage('failed');
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!form.symbol) throw new Error('Symbol påkrevd');
      if (!form.strategy_version) throw new Error('Strategy version påkrevd');
      const numeric = (s: string) => (s.trim() === '' ? null : Number(s));
      const intish = (s: string) => (s.trim() === '' ? null : Math.round(Number(s)));
      const extractionSource = ocrUsed ? 'screenshot_ocr' : 'manual';
      const extractionStatus = 'confirmed';
      const payload = {
        symbol: form.symbol.trim().toUpperCase(),
        test_date: form.test_date,
        strategy_version: form.strategy_version.trim(),
        admission_result_id: prefill?.admission_result_id ?? null,
        admission_run_id: prefill?.admission_run_id ?? null,
        screener_snapshot: prefill?.screener_snapshot ?? null,
        timeframe: form.timeframe,
        candles_tested: parseInt(form.candles_tested, 10) || 9000,
        lookback_equivalent_days: lookbackDays,
        net_profit_pct: numeric(form.net_profit_pct),
        net_profit_usd: numeric(form.net_profit_usd),
        max_drawdown_pct: numeric(form.max_drawdown_pct),
        max_drawdown_usd: numeric(form.max_drawdown_usd),
        profit_factor: numeric(form.profit_factor),
        win_rate_pct: numeric(form.win_rate_pct),
        num_trades: intish(form.num_trades),
        avg_pnl_pct: numeric(form.avg_pnl_pct),
        avg_bars_in_trade: numeric(form.avg_bars_in_trade),
        expected_payoff_usd: numeric(form.expected_payoff_usd),
        sharpe_ratio: numeric(form.sharpe_ratio),
        largest_profit_usd: numeric(form.largest_profit_usd),
        largest_loss_usd: numeric(form.largest_loss_usd),
        profitable_trades_count: intish(form.profitable_trades_count),
        losing_trades_count: intish(form.losing_trades_count),
        label: form.label,
        notes: form.notes || null,
        screenshot_storage_path: storagePath,
        extraction_source: extractionSource as 'manual' | 'screenshot_ocr',
        extraction_status: extractionStatus as 'manual' | 'confirmed',
        extraction_confidence: extraction?.overall_confidence ?? null,
        extracted_raw_text: extraction?.raw_text ?? null,
        extracted_metrics: extraction?.metrics ?? null,
        field_confidences: extraction?.field_confidences ?? null,
      };
      return await createBacktestResult({ data: payload as any });
    },
    onSuccess: () => {
      onSaved?.();
      onOpenChange(false);
    },
    onError: (e: any) => setError(e?.message ?? String(e)),
  });

  const fc = extraction?.field_confidences ?? {};

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Backtest Result</DialogTitle>
          <DialogDescription>
            Hver registrering er en uavhengig observasjon (append-only). Calibration bruker
            bekreftede verdier. Tips: Trykk <kbd className="rounded border px-1 text-[10px]">Ctrl/⌘ + V</kbd> hvor som helst i dialogen for å lime inn screenshot direkte fra utklippstavlen.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList>
            <TabsTrigger value="manual">Manual Entry</TabsTrigger>
            <TabsTrigger value="screenshot">Quick Add from Screenshot</TabsTrigger>
          </TabsList>

          <TabsContent value="screenshot" className="space-y-3 pt-3">
            <div className="rounded border border-dashed p-4 text-sm">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                }}
                className="block w-full text-sm"
                disabled={stage === 'uploading' || stage === 'extracting'}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Last opp et TradingView strategy-tester screenshot. Maks ~8MB. PNG/JPG/WEBP.
              </p>
              {stage === 'uploading' && <p className="mt-2 text-xs">Laster opp…</p>}
              {stage === 'extracting' && <p className="mt-2 text-xs">Leser nøkkeltall (OCR)…</p>}
              {stage === 'failed' && (
                <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600">
                  OCR feilet ({ocrError}). Du kan fortsatt fylle inn manuelt og lagre — screenshot beholdes som dokumentasjon.
                </div>
              )}
              {stage === 'review' && (
                <div className="mt-2 rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-700">
                  Auto-extracted from screenshot — please review and correct before saving.
                  Overall confidence: {(extraction?.overall_confidence ?? 0).toFixed(2)}.
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="manual" />
        </Tabs>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-3">
          <Field label="Symbol" required>
            <Input
              value={form.symbol}
              onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))}
              placeholder="BTCUSDT"
              disabled={!!prefill?.symbol}
            />
          </Field>
          <Field label="Test date" required>
            <Input
              type="date"
              value={form.test_date}
              onChange={(e) => setForm((f) => ({ ...f, test_date: e.target.value }))}
            />
          </Field>
          <Field
            label="Strategy version"
            required
            hint={
              versionsQ.data?.last_used_by_user
                ? `Sist brukt: ${versionsQ.data.last_used_by_user}`
                : undefined
            }
          >
            <Input
              list="strategy-versions"
              value={form.strategy_version}
              onChange={(e) => setForm((f) => ({ ...f, strategy_version: e.target.value }))}
              placeholder="f.eks. EMA-X v3.2"
            />
            <datalist id="strategy-versions">
              {(versionsQ.data?.versions ?? []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>
          <Field label="Timeframe">
            <Input value={form.timeframe} onChange={(e) => setForm((f) => ({ ...f, timeframe: e.target.value }))} />
          </Field>
          <Field label="Candles tested">
            <Input
              type="number"
              value={form.candles_tested}
              onChange={(e) => setForm((f) => ({ ...f, candles_tested: e.target.value }))}
            />
          </Field>
          <Field label="Lookback (auto)" hint={lookbackDays != null ? `${lookbackDays} dager` : ''}>
            <Input value={lookbackDays != null ? `${lookbackDays}d` : '—'} disabled />
          </Field>
        </div>

        <div className="mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground mb-2">Backtest metrics</h4>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {OCR_FIELDS.map((k) => (
              <Field key={k} label={prettyLabel(k)} confidence={fc[k as string]}>
                <Input
                  value={(form as any)[k] ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                  className={confidenceClass(fc[k as string])}
                  inputMode="decimal"
                />
              </Field>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <Label className="text-xs">Label (auto-suggested — overstyrbar)</Label>
          <div className="mt-1 flex flex-wrap gap-2">
            {LABEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setForm((f) => ({ ...f, label: opt.value }));
                  setLabelTouched(true);
                }}
                className={`rounded px-2 py-1 text-xs ${
                  form.label === opt.value ? 'bg-primary text-primary-foreground' : 'bg-muted'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3">
          <Field label="Notes">
            <Textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
        </div>

        {prefill?.admission_result_id && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">admission_result {prefill.admission_result_id.slice(0, 8)}…</Badge>
            {prefill.admission_run_id && (
              <Badge variant="secondary">run {prefill.admission_run_id.slice(0, 8)}…</Badge>
            )}
            {prefill.screener_snapshot && <Badge variant="secondary">snapshot frosset</Badge>}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600 whitespace-pre-wrap">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Lagrer…' : 'Save (Confirm)'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  hint,
  confidence,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  confidence?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs flex items-center gap-2">
        {label}
        {required && <span className="text-red-500">*</span>}
        {confidence != null && (
          <span className="text-[10px] text-muted-foreground">conf {(confidence * 100).toFixed(0)}%</span>
        )}
      </Label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function prettyLabel(k: string): string {
  return k
    .replace(/_/g, ' ')
    .replace(/usd/g, 'USD')
    .replace(/pct/g, '%')
    .replace(/\bpnl\b/i, 'PnL')
    .replace(/\bavg\b/i, 'Avg')
    .replace(/^./, (c) => c.toUpperCase());
}
