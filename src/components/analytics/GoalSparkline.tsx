import type { SparklinePoint } from "@/lib/campaignAnalytics";

interface GoalSparklineProps {
  series: SparklinePoint[];
  color?: string;
  width?: number;
  height?: number;
}

/** Real per-day goal series (replaces the fake static SVG). Data-driven polyline. */
export default function GoalSparkline({ series, color = "#10b981", width = 110, height = 28 }: GoalSparklineProps) {
  if (series.length === 0) return <span className="text-[var(--text-3)] text-[11px]">—</span>;
  const max = Math.max(1, ...series.map((p) => p.goals)); // guard div-by-zero
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const points = series
    .map((p, i) => {
      const x = i * stepX;
      const y = height - (p.goals / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const flat = series.every((p) => p.goals === 0);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="opacity-90">
      <polyline points={points} fill="none" stroke={flat ? "var(--text-3)" : color} strokeWidth="1.6" />
    </svg>
  );
}
