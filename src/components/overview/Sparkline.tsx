interface Props {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({ values, width = 120, height = 32, className }: Props) {
  if (!values || values.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(height - ((v - min) / span) * height).toFixed(2)}`)
    .join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const tone = last >= first ? "text-success" : "text-danger";
  return (
    <svg width={width} height={height} className={`${tone} ${className ?? ""}`} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
