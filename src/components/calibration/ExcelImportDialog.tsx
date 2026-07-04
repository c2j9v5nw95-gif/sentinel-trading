import { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { bulkImportBacktestResults } from '@/lib/calibration/calibration.functions';

type ParsedRow = {
  symbol: string;
  test_date: string; // YYYY-MM-DD
  net_profit_usd: number | null;
  net_profit_pct: number | null;
  max_drawdown_usd: number | null;
  max_drawdown_pct: number | null;
  profit_factor: number | null;
  win_rate_pct: number | null;
  num_trades: number | null;
};

type ParseResult = {
  rows: ParsedRow[];
  errors: string[];
};

function toNumOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v: unknown): number | null {
  const n = toNumOrNull(v);
  return n == null ? null : Math.round(n);
}

// Excel date-serial → JS Date (1900 leap-year quirk)
function excelSerialToDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400 * 1000);
}

function normalizeDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number') {
    const d = excelSerialToDate(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  // dd.mm.yyyy or dd/mm/yyyy
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function findKey(obj: Record<string, unknown>, candidates: string[]): string | undefined {
  const keys = Object.keys(obj);
  const norm = (s: string) => s.toLowerCase().replace(/[\s_%()$/-]+/g, '');
  const nk = keys.map((k) => [k, norm(k)] as const);
  for (const c of candidates) {
    const target = norm(c);
    const hit = nk.find(([, n]) => n === target);
    if (hit) return hit[0];
  }
  return undefined;
}

function parseWorkbook(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: 'array', cellDates: true });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
        const errors: string[] = [];
        const rows: ParsedRow[] = [];

        if (raw.length === 0) {
          resolve({ rows, errors: ['Arket er tomt.'] });
          return;
        }

        const first = raw[0];
        const kSymbol = findKey(first, ['Symbol']);
        const kNetUsd = findKey(first, ['Total PnL (USD)', 'Net Profit USD', 'Net Profit $']);
        const kNetPct = findKey(first, ['Total PnL (%)', 'Net Profit %', 'Net Profit Pct']);
        const kDdUsd = findKey(first, ['Max drawdown (USD)', 'Max Drawdown USD']);
        const kDdPct = findKey(first, ['Max drawdown (%)', 'Max Drawdown %']);
        const kPf = findKey(first, ['Profit factor', 'Profit Factor']);
        const kWr = findKey(first, ['Winrate (%)', 'Win Rate %', 'Winrate']);
        const kTr = findKey(first, ['Total trades', 'Trades', 'Num Trades']);
        const kDate = findKey(first, ['Scan date', 'Scan Date', 'Date', 'Test Date']);

        if (!kSymbol) errors.push('Mangler kolonne: Symbol');
        if (!kDate) errors.push('Mangler kolonne: Scan date');

        if (!kSymbol || !kDate) {
          resolve({ rows, errors });
          return;
        }

        raw.forEach((r, i) => {
          const sym = r[kSymbol!];
          const date = normalizeDate(r[kDate!]);
          if (!sym) {
            errors.push(`Rad ${i + 2}: mangler Symbol`);
            return;
          }
          if (!date) {
            errors.push(`Rad ${i + 2}: ugyldig scan date (${String(r[kDate!])})`);
            return;
          }
          rows.push({
            symbol: String(sym).trim().toUpperCase(),
            test_date: date,
            net_profit_usd: kNetUsd ? toNumOrNull(r[kNetUsd]) : null,
            net_profit_pct: kNetPct ? toNumOrNull(r[kNetPct]) : null,
            max_drawdown_usd: kDdUsd ? toNumOrNull(r[kDdUsd]) : null,
            max_drawdown_pct: kDdPct ? toNumOrNull(r[kDdPct]) : null,
            profit_factor: kPf ? toNumOrNull(r[kPf]) : null,
            win_rate_pct: kWr ? toNumOrNull(r[kWr]) : null,
            num_trades: kTr ? toIntOrNull(r[kTr]) : null,
          });
        });

        resolve({ rows, errors });
      } catch (e: any) {
        reject(e);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

type ImportResult = Awaited<ReturnType<typeof bulkImportBacktestResults>>;

export function ExcelImportDialog({ onClose, onImported }: { onClose: () => void; onImported?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [strategy, setStrategy] = useState('');
  const [timeframe, setTimeframe] = useState('5m');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [parsing, setParsing] = useState(false);

  const handleFile = async (f: File | null) => {
    setFile(f);
    setParsed(null);
    setResult(null);
    if (!f) return;
    setParsing(true);
    try {
      const p = await parseWorkbook(f);
      setParsed(p);
    } catch (e: any) {
      toast.error(`Kunne ikke lese fil: ${e?.message ?? e}`);
    } finally {
      setParsing(false);
    }
  };

  const runImport = useMutation({
    mutationFn: async () => {
      if (!parsed) throw new Error('Ingen data');
      if (!strategy.trim()) throw new Error('strategy_version må fylles ut');
      return bulkImportBacktestResults({
        data: {
          strategy_version: strategy.trim(),
          timeframe: timeframe.trim() || '5m',
          candles_tested: 9000,
          rows: parsed.rows,
        },
      });
    },
    onSuccess: (r) => {
      setResult(r);
      toast.success(
        `Import ferdig: ${r.inserted} lagret · ${r.skipped_duplicate} hoppet over · ${r.failed} feil`,
      );
      onImported?.();
    },
    onError: (e: any) => toast.error(`Import feilet: ${e?.message ?? e}`),
  });

  const dateSummary = useMemo(() => {
    if (!parsed?.rows.length) return null;
    const dates = Array.from(new Set(parsed.rows.map((r) => r.test_date))).sort();
    return dates.length === 1 ? dates[0] : `${dates[0]} … ${dates[dates.length - 1]} (${dates.length} datoer)`;
  }, [parsed]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-lg border bg-background p-5 shadow-lg">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-base font-semibold">Importer backtest fra Excel</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Hver rad lagres som en backtest-observasjon. Rader med samme scan-dato som en tidligere lagret rad hoppes over.
            </p>
          </div>
          <button className="rounded px-2 py-1 hover:bg-muted text-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">Strategy version *</span>
              <input
                className="w-full rounded border bg-background px-2 py-1"
                placeholder="f.eks. v2.1"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value)}
              />
            </label>
            <label className="text-xs">
              <span className="block text-muted-foreground mb-1">Timeframe</span>
              <input
                className="w-full rounded border bg-background px-2 py-1"
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              />
            </label>
          </div>

          <label className="block text-xs">
            <span className="block text-muted-foreground mb-1">Excel-fil (.xlsx)</span>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs"
            />
          </label>

          {parsing && <p className="text-xs text-muted-foreground">Leser fil…</p>}

          {parsed && (
            <div className="rounded border p-3 space-y-2 text-xs">
              <div className="flex flex-wrap gap-3">
                <span>Fil: <strong>{file?.name}</strong></span>
                <span>Rader parset: <strong>{parsed.rows.length}</strong></span>
                {dateSummary && <span>Scan-dato: <strong>{dateSummary}</strong></span>}
              </div>
              {parsed.errors.length > 0 && (
                <div className="rounded bg-yellow-500/10 border border-yellow-500/40 p-2">
                  <div className="font-medium mb-1">{parsed.errors.length} advarsel(er) ved parsing:</div>
                  <ul className="list-disc pl-4 max-h-24 overflow-y-auto">
                    {parsed.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                    {parsed.errors.length > 20 && <li>… og {parsed.errors.length - 20} til</li>}
                  </ul>
                </div>
              )}
              {parsed.rows.length > 0 && (
                <div className="max-h-40 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-left pr-2">Symbol</th>
                        <th className="text-left pr-2">Date</th>
                        <th className="text-right pr-2">Net %</th>
                        <th className="text-right pr-2">DD %</th>
                        <th className="text-right pr-2">PF</th>
                        <th className="text-right pr-2">WR %</th>
                        <th className="text-right pr-2">Trades</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((r, i) => (
                        <tr key={i} className="border-t border-border/40">
                          <td className="pr-2">{r.symbol}</td>
                          <td className="pr-2">{r.test_date}</td>
                          <td className="pr-2 text-right">{r.net_profit_pct ?? '—'}</td>
                          <td className="pr-2 text-right">{r.max_drawdown_pct ?? '—'}</td>
                          <td className="pr-2 text-right">{r.profit_factor ?? '—'}</td>
                          <td className="pr-2 text-right">{r.win_rate_pct ?? '—'}</td>
                          <td className="pr-2 text-right">{r.num_trades ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.rows.length > 8 && (
                    <p className="text-muted-foreground pt-1">… og {parsed.rows.length - 8} rader til</p>
                  )}
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="rounded border border-green-500/40 bg-green-500/5 p-3 space-y-2 text-xs">
              <div className="flex gap-4 font-medium">
                <span>Lagret: {result.inserted}</span>
                <span>Hoppet over (samme dato): {result.skipped_duplicate}</span>
                <span>Feilet: {result.failed}</span>
                <span className="text-muted-foreground">Totalt: {result.total}</span>
              </div>
              {result.failed > 0 && (
                <div>
                  <div className="font-medium mb-1">Feil:</div>
                  <ul className="list-disc pl-4 max-h-32 overflow-y-auto">
                    {result.outcomes
                      .filter((o) => o.status === 'error')
                      .slice(0, 30)
                      .map((o, i) => (
                        <li key={i}>
                          {o.symbol} ({o.test_date}): {o.error}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button className="rounded border px-3 py-1 text-sm hover:bg-muted" onClick={onClose}>
              Lukk
            </button>
            <button
              className="rounded bg-primary text-primary-foreground px-3 py-1 text-sm disabled:opacity-50"
              disabled={
                !parsed || parsed.rows.length === 0 || !strategy.trim() || runImport.isPending
              }
              onClick={() => runImport.mutate()}
            >
              {runImport.isPending
                ? 'Importerer…'
                : `Importer ${parsed?.rows.length ?? 0} rader`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
