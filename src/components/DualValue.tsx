// Compact two-line cell: large effective value + small "cfg N" hint when configured differs.
function fmt(v: number | null | undefined, dec: number) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(dec);
}

export function DualValue({
  eff,
  cfg,
  dec,
  suffix = "",
}: {
  eff: number | null;
  cfg: number | null;
  dec: number;
  suffix?: string;
}) {
  const effStr = fmt(eff, dec);
  const cfgStr = fmt(cfg, dec);
  const differs =
    eff != null && cfg != null && Number.isFinite(eff) && Number.isFinite(cfg) && Number(eff) !== Number(cfg);
  return (
    <div className="leading-tight">
      <div>{effStr}{eff != null && suffix ? suffix : ""}</div>
      {differs && (
        <div className="text-[10px] text-muted-foreground">cfg {cfgStr}{suffix}</div>
      )}
    </div>
  );
}
