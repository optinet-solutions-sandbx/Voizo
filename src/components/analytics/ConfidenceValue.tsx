import type { Confidence } from "@/lib/campaignAnalytics";
import { ANALYTICS_CONFIG } from "@/lib/analyticsConfig";

interface ConfidenceValueProps {
  value: number | null; // 0..1
  median: number | null; // portfolio median for benchmark color
  confidence: Confidence;
  higherIsBetter?: boolean; // default true
}

/** Value + confidence gating + benchmark-relative color (G4: thin never colors, excluded from median). */
export default function ConfidenceValue({ value, median, confidence, higherIsBetter = true }: ConfidenceValueProps) {
  if (value === null) return <span className="text-[var(--text-3)] tabular-nums">—</span>;
  const label = `${(value * 100).toFixed(1)}%`;

  // G4: thin samples never get benchmark color, and are visually desaturated.
  if (confidence === "thin") {
    return (
      <span className="text-[var(--text-3)] tabular-nums" title="Thin sample (n<10 connected). Let it accumulate; excluded from the portfolio median">
        {label}
      </span>
    );
  }

  let colorClass = "text-[var(--text-2)]";
  if (median !== null) {
    const band = ANALYTICS_CONFIG.BENCHMARK_BAND_WIDTH * median;
    const delta = value - median;
    const good = higherIsBetter ? delta > band : delta < -band;
    const bad = higherIsBetter ? delta < -band : delta > band;
    if (good) colorClass = "text-emerald-400";
    else if (bad) colorClass = "text-red-400";
  }
  const strength = confidence === "half" ? "opacity-70" : "";
  return (
    <span
      className={`tabular-nums ${colorClass} ${strength}`}
      title={median !== null ? `${label} · vs portfolio median ${(median * 100).toFixed(1)}%` : label}
    >
      {label}
    </span>
  );
}
