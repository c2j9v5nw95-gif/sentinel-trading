import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    TradingView?: any;
    __tvScriptLoading?: Promise<void>;
  }
}

export type ChartMarker = {
  time: number; // unix seconds
  price?: number;
  kind: "entry_long" | "entry_short" | "exit" | "tp" | "sl" | "manual" | "rejection" | "recovery";
  text?: string;
  tooltip?: string;
};

const TF_OPTIONS: { label: string; value: string }[] = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1d", value: "D" },
];

const KIND_TOGGLES: { key: ChartMarker["kind"]; label: string; color: string }[] = [
  { key: "entry_long", label: "Entry L", color: "var(--success)" },
  { key: "entry_short", label: "Entry S", color: "var(--danger)" },
  { key: "exit", label: "Exit", color: "var(--foreground)" },
  { key: "tp", label: "TP", color: "var(--warning)" },
  { key: "sl", label: "SL", color: "var(--danger)" },
  { key: "manual", label: "Manual", color: "var(--accent)" },
  { key: "rejection", label: "Rejected", color: "var(--muted-foreground)" },
  { key: "recovery", label: "Recovery", color: "var(--warning)" },
];

const TV_SCRIPT_URL = "https://s3.tradingview.com/tv.js";

function loadTvScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.TradingView) return Promise.resolve();
  if (window.__tvScriptLoading) return window.__tvScriptLoading;
  window.__tvScriptLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TV_SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load TradingView script"));
    document.head.appendChild(s);
  });
  return window.__tvScriptLoading;
}

function shapeForMarker(m: ChartMarker) {
  switch (m.kind) {
    case "entry_long":
      return { shape: "arrow_up", color: "#22c55e", text: m.text ?? "Entry" };
    case "entry_short":
      return { shape: "arrow_down", color: "#ef4444", text: m.text ?? "Entry" };
    case "exit":
      return { shape: "flag", color: "#e5e7eb", text: m.text ?? "Exit" };
    case "tp":
      return { shape: "flag", color: "#eab308", text: m.text ?? "TP" };
    case "sl":
      return { shape: "flag", color: "#ef4444", text: m.text ?? "SL" };
    case "manual":
      return { shape: "flag", color: "#a855f7", text: m.text ?? "Manual" };
    case "rejection":
      return { shape: "flag", color: "#94a3b8", text: m.text ?? "Rejected" };
    case "recovery":
      return { shape: "flag", color: "#f97316", text: m.text ?? "Recovery" };
  }
}

export function TradingViewChart({
  symbol,
  markers,
}: {
  symbol: string;
  markers: ChartMarker[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const containerId = `tv_${symbol}_${Math.random().toString(36).slice(2, 8)}`;
  const idRef = useRef(containerId);
  const [interval, setInterval] = useState<string>("60");
  const [enabled, setEnabled] = useState<Record<ChartMarker["kind"], boolean>>({
    entry_long: true,
    entry_short: true,
    exit: true,
    tp: true,
    sl: true,
    manual: true,
    rejection: false,
    recovery: true,
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!containerRef.current) return;
    containerRef.current.innerHTML = `<div id="${idRef.current}" style="height:100%;width:100%"></div>`;

    loadTvScript()
      .then(() => {
        if (cancelled || !window.TradingView) return;
        widgetRef.current = new window.TradingView.widget({
          autosize: true,
          symbol: `BYBIT:${symbol}.P`,
          interval,
          container_id: idRef.current,
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "rgba(0,0,0,0)",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: false,
          studies: [],
        });

        // Attempt to draw markers when chart is ready.
        const tryDraw = () => {
          try {
            const w = widgetRef.current;
            if (!w?.onChartReady) return;
            w.onChartReady(() => {
              const chart = w.activeChart?.();
              if (!chart?.createShape) return;
              for (const m of markers) {
                if (!enabled[m.kind]) continue;
                const visual = shapeForMarker(m);
                try {
                  chart.createShape(
                    { time: m.time, price: m.price ?? 0 },
                    {
                      shape: visual.shape,
                      lock: true,
                      disableSelection: true,
                      disableSave: true,
                      disableUndo: true,
                      text: visual.text,
                      overrides: {
                        color: visual.color,
                        textcolor: visual.color,
                        fontsize: 11,
                      },
                    },
                  );
                } catch {
                  /* widget API quirks — skip individual marker on failure */
                }
              }
            });
          } catch {
            /* ignore */
          }
        };
        // Wait a tick — widget needs to mount.
        setTimeout(tryDraw, 600);
      })
      .catch(() => {
        setError("Kunne ikke laste TradingView-charten.");
      });

    return () => {
      cancelled = true;
      try {
        widgetRef.current?.remove?.();
      } catch {
        /* ignore */
      }
      widgetRef.current = null;
    };
    // re-init when symbol/interval/enabled set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval, JSON.stringify(enabled), JSON.stringify(markers.map((m) => m.time + m.kind))]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {TF_OPTIONS.map((tf) => (
            <button
              key={tf.value}
              onClick={() => setInterval(tf.value)}
              className={`rounded px-2 py-1 text-xs ${
                interval === tf.value
                  ? "bg-accent text-accent-foreground"
                  : "border border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {KIND_TOGGLES.map((t) => (
            <button
              key={t.key}
              onClick={() => setEnabled((s) => ({ ...s, [t.key]: !s[t.key] }))}
              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                enabled[t.key]
                  ? "border-border bg-card text-foreground"
                  : "border-border bg-transparent text-muted-foreground line-through"
              }`}
              title={t.label}
            >
              <span
                className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                style={{ background: t.color }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative h-[560px] overflow-hidden rounded-lg border border-border bg-card">
        <div ref={containerRef} className="h-full w-full" />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/90 text-sm text-muted-foreground">
            <div className="text-center">
              <p>{error}</p>
              <a
                href={`https://www.tradingview.com/chart/?symbol=BYBIT:${symbol}.P`}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs text-primary underline"
              >
                Åpne på TradingView
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
