"use client";

// QA analysis renderer — ported from the ai-chat-qa-tool's AnalysisResultView and
// re-themed to Voizo's design tokens. Takes the model's raw output; if it's JSON,
// renders a structured table (arrays of objects → sub-tables, arrays of primitives
// → numbered lists, nested objects → indented rows, booleans → Yes/No, date-like
// strings → formatted dates). Falls back to wrapped plain text when it isn't JSON.

interface Props {
  analysisText: string;
  // The call's real created_at (ISO). When present it overrides any date the model
  // emits — the model never sees the true date, so its own value is a guess.
  conversationDate?: string | null;
}

function formatKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function tryFormatDate(value: string): string | null {
  if (!/\d{4}/.test(value)) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

function stripCodeFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}

function PrimitiveValue({ value }: { value: string | number | boolean | null }) {
  if (value === null || value === undefined) return <span className="text-[var(--text-3)]">—</span>;
  if (typeof value === "boolean") {
    return (
      <span className={`font-medium ${value ? "text-emerald-400" : "text-[var(--text-3)]"}`}>
        {value ? "Yes" : "No"}
      </span>
    );
  }
  if (typeof value === "string") {
    const formatted = tryFormatDate(value);
    if (formatted) return <span>{formatted}</span>;
  }
  return <span>{String(value)}</span>;
}

function ArrayValue({ items }: { items: unknown[] }) {
  if (items.length === 0) return <span className="text-[var(--text-3)]">—</span>;

  // Array of objects → sub-table
  if (typeof items[0] === "object" && items[0] !== null && !Array.isArray(items[0])) {
    const rows = items as Record<string, unknown>[];
    const keys = Object.keys(rows[0]);
    return (
      <div className="mt-1 rounded-lg border border-[var(--border)] overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--bg-elevated)] border-b border-[var(--border)]">
              {keys.map((k) => (
                <th
                  key={k}
                  className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-[var(--text-3)] whitespace-nowrap"
                >
                  {formatKey(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((row, i) => (
              <tr key={`row-${i}`}>
                {keys.map((k) => (
                  <td key={k} className="px-3 py-2 text-[var(--text-2)] break-words min-w-0 max-w-[220px]">
                    <PrimitiveValue value={row[k] as string | number | boolean | null} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Array of primitives → numbered list
  return (
    <ol className="space-y-1 mt-0.5 list-none">
      {items.map((item, i) => (
        <li key={`item-${i}`} className="flex gap-2.5 items-start">
          <span className="shrink-0 w-4 h-4 rounded-full bg-[var(--bg-elevated)] text-[var(--text-3)] text-[10px] flex items-center justify-center mt-0.5 font-medium">
            {i + 1}
          </span>
          <span className="text-[var(--text-2)] leading-snug">{String(item)}</span>
        </li>
      ))}
    </ol>
  );
}

function AnyValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ArrayValue items={value} />;
  if (value !== null && typeof value === "object") {
    return (
      <div className="mt-1 pl-3 border-l-2 border-[var(--border)] space-y-2">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k}>
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-3)] mb-0.5">
              {formatKey(k)}
            </div>
            <AnyValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  return <PrimitiveValue value={value as string | number | boolean | null} />;
}

function JsonTable({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  return (
    <table className="w-full">
      <tbody>
        {entries.map(([key, value], i) => {
          const isComplex = Array.isArray(value) || (typeof value === "object" && value !== null);
          return (
            <tr key={key} className={i < entries.length - 1 ? "border-b border-[var(--border)]" : ""}>
              <td className="py-3 pr-6 text-[11px] font-semibold text-[var(--text-3)] uppercase tracking-wide align-top whitespace-nowrap w-36">
                {formatKey(key)}
              </td>
              <td className={`py-3 text-sm text-[var(--text-1)] ${isComplex ? "align-top" : "align-middle"}`}>
                <AnyValue value={value} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function QaAnalysisResultView({ analysisText, conversationDate }: Props) {
  const cleaned = stripCodeFences((analysisText ?? "").trim());

  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(cleaned);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw as Record<string, unknown>;
  } catch {
    /* not JSON */
  }

  if (parsed) {
    // The model fabricates a conversation date (it isn't given the real one) —
    // strip every variant and substitute the call's real created_at when we have it.
    const norm = (k: string) => k.toLowerCase().replace(/[\s_-]/g, "");
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = norm(k);
      if (n === "conversationdate" || n === "chatdate" || n === "date" || n === "calldate") continue;
      next[k] = v;
    }
    if (conversationDate) next.conversation_date = conversationDate;

    // Lift dissatisfaction_severity out of each results[] row to a single top-level
    // field (the worst row dictates the call's overall level).
    const SEV_KEY = "dissatisfaction_severity";
    const hasTop = Object.prototype.hasOwnProperty.call(next, SEV_KEY);
    const reordered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (k === "results" && Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && !Array.isArray(v[0])) {
        const rows = v as Record<string, unknown>[];
        let max = 0;
        let firstSev: unknown = null;
        const stripped = rows.map((row) => {
          const { [SEV_KEY]: sev, ...rest } = row;
          if (firstSev == null && sev != null && sev !== "") firstSev = sev;
          const m = String(sev ?? "").match(/[123]/);
          if (m) {
            const nn = parseInt(m[0], 10);
            if (nn > max) max = nn;
          }
          return rest;
        });
        reordered[k] = stripped;
        if (!hasTop) reordered[SEV_KEY] = max > 0 ? max : firstSev;
        continue;
      }
      reordered[k] = v;
    }
    return (
      <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] px-4 py-1 overflow-x-auto min-w-0">
        <JsonTable data={reordered} />
      </div>
    );
  }

  return (
    <div className="bg-[var(--bg-elevated)]/40 rounded-xl border border-[var(--border)] p-4">
      <p className="text-sm text-[var(--text-2)] leading-relaxed whitespace-pre-wrap">{cleaned || "No output."}</p>
    </div>
  );
}
