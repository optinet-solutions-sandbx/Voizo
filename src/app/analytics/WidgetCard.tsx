"use client";

// The uniform dashboard widget shell (console anatomy, 2026-07-02): one identical header row
// (title · muted context · right-aligned actions) + divider + body (+ optional footer). The
// AWS-console trick this borrows: when every widget shares the exact same anatomy, dense
// content reads calm instead of cluttered. Pure layout shell — no state.

import type { ReactNode } from "react";

export default function WidgetCard({
  title,
  icon,
  context,
  actions,
  footer,
  children,
  bodyClassName = "p-3.5",
}: {
  title: string;
  icon?: ReactNode;
  context?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Body padding — pass "p-0" when the body manages its own (tables, row lists). */
  bodyClassName?: string;
}) {
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap px-3.5 py-2.5 border-b border-[var(--border)] bg-[var(--bg-elevated)]/30">
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <h3 className="text-[13px] font-semibold text-[var(--text-1)] whitespace-nowrap">{title}</h3>
          {context && <span className="text-[11px] text-[var(--text-3)] truncate">· {context}</span>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
      {footer && <div className="border-t border-[var(--border)] px-3.5 py-2">{footer}</div>}
    </section>
  );
}
