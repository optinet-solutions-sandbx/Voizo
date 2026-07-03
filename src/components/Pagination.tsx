"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  noun?: string; // pluralized item label in the "Showing X–Y of N <noun>" summary
}

export default function Pagination({ currentPage, totalPages, totalItems, pageSize, onPageChange, noun = "campaigns" }: PaginationProps) {
  if (totalItems === 0) return null;

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  function getPages(): (number | "...")[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1];
    if (currentPage > 3) pages.push("...");
    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push("...");
    pages.push(totalPages);
    return pages;
  }

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-1 mt-4">
      <p className="text-xs text-[var(--text-3)]">
        Showing <span className="font-medium text-[var(--text-2)]">{start}–{end}</span> of{" "}
        <span className="font-medium text-[var(--text-2)]">{totalItems}</span> {noun}
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <button onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}
            className="flex items-center justify-center w-8 h-8 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <ChevronLeft size={15} />
          </button>
          {getPages().map((p, i) =>
            p === "..." ? (
              <span key={`ellipsis-${i}`} className="w-8 h-8 flex items-center justify-center text-xs text-[var(--text-3)]">…</span>
            ) : (
              <button key={p} onClick={() => onPageChange(p as number)}
                className={`w-8 h-8 rounded-md text-xs font-medium transition-colors ${
                  p === currentPage
                    ? "bg-primary text-white border border-primary shadow-md shadow-primary/20"
                    : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)]"
                }`}>
                {p}
              </button>
            )
          )}
          <button onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}
            className="flex items-center justify-center w-8 h-8 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
