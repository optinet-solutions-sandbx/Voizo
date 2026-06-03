import type { ReactNode } from "react";

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}
interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  // Optional custom body; receives the hovered datum (payload[0].payload).
  render?: (row: Record<string, unknown>) => ReactNode;
}

/** Dark-theme tooltip matching the codebase pattern (CSS-var tokens). recharts clones this with active/payload/label. */
export default function ChartTooltip({ active, payload, label, render }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] text-xs rounded-lg px-2.5 py-1.5 shadow-xl pointer-events-none">
      {render ? (
        render(row)
      ) : (
        <>
          {label != null && <p className="font-semibold text-[var(--text-1)]">{label}</p>}
          {payload.map((p, i) => (
            <p key={i} className="text-[var(--text-2)]">
              {p.name}: {String(p.value)}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
