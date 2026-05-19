// src/app/workers/WorkerPoolPanel.tsx
//
// Right-side panel listing all 5 anonymous slots with status, location,
// campaign, and live call activity. Bidirectional hover/select with the
// globe pins.

"use client";

import { useMemo } from "react";
import {
  CheckCircle2, MapPin, Megaphone, Phone, PhoneCall, Radio, Wrench,
} from "lucide-react";
import type { WorkerSlot } from "./use-workers-state";
import {
  coordsForTimezone, formatLocalTime, formatUtcOffset,
  formatLeasedDuration, formatCallDuration,
} from "./timezone-coords";

// ── Pool-summary stat block ─────────────────────────────────────────────
function PoolSummary({ slots }: { slots: WorkerSlot[] }) {
  const onCall = slots.filter(s => s.status === "leased" && s.inFlightCall).length;
  const leased = slots.filter(s => s.status === "leased").length;
  const free   = slots.filter(s => s.status === "free").length;
  const maint  = slots.filter(s => s.status === "maintenance").length;

  const stats: { value: number; label: string; color: string }[] = [
    { value: onCall,           label: "On call", color: "text-blue-400" },
    { value: leased - onCall,  label: "Idle",    color: "text-amber-400" },
    { value: free,             label: "Free",    color: "text-[var(--text-2)]" },
    { value: maint,            label: "Maint",   color: "text-red-400" },
  ];

  return (
    <div className="grid grid-cols-4 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl py-2.5">
      {stats.map((stat, i) => (
        <div key={stat.label}
             className={`flex flex-col items-center gap-0.5 ${i > 0 ? "border-l border-[var(--border)]" : ""}`}>
          <div className={`font-mono text-lg font-semibold leading-none tabular-nums ${stat.color}`}>
            {stat.value}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mt-1">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Single worker row ───────────────────────────────────────────────────
function WorkerRow({
  slot, now, isSelected, isHovered, onSelect, onHover,
}: {
  slot: WorkerSlot;
  now: Date;
  isSelected: boolean;
  isHovered: boolean;
  onSelect: (idx: number | null) => void;
  onHover: (idx: number | null) => void;
}) {
  const coords = slot.campaign ? coordsForTimezone(slot.campaign.timezone) : null;
  const offset = slot.campaign ? formatUtcOffset(now, slot.campaign.timezone) : null;
  const localTime = slot.campaign ? formatLocalTime(now, slot.campaign.timezone) : null;
  const callDur = slot.inFlightCall ? formatCallDuration(slot.inFlightCall.durationMs) : null;

  // Status visual mapping per design doc §5.2
  let color: "blue" | "amber" | "red" | "slate" = "slate";
  let statusLabel = "free";
  let Icon = CheckCircle2;
  if (slot.status === "maintenance") {
    color = "red"; statusLabel = "maintenance"; Icon = Wrench;
  } else if (slot.status === "leased" && slot.inFlightCall) {
    color = "blue"; statusLabel = "on call"; Icon = PhoneCall;
  } else if (slot.status === "leased") {
    color = "amber"; statusLabel = "idle"; Icon = Radio;
  }

  const iconChipClass = {
    blue:  "bg-blue-500/15 text-blue-400",
    amber: "bg-amber-500/15 text-amber-400",
    red:   "bg-red-500/15 text-red-400",
    slate: "bg-[var(--bg-elevated)] text-[var(--text-3)]",
  }[color];

  const badgeClass = {
    blue:  "bg-blue-500/10 text-blue-400 border-blue-500/30",
    amber: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    red:   "bg-red-500/10 text-red-400 border-red-500/30",
    slate: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]",
  }[color];

  const isActive = isSelected || isHovered;

  return (
    <button
      type="button"
      onClick={() => onSelect(isSelected ? null : slot.slotIndex)}
      onMouseEnter={() => onHover(slot.slotIndex)}
      onMouseLeave={() => onHover(null)}
      className={`w-full text-left rounded-xl p-3 flex flex-col gap-2 transition-all border ${
        isActive
          ? "bg-[var(--bg-hover)] border-[var(--border-2)]"
          : "border-transparent hover:bg-[var(--bg-hover)] hover:border-[var(--border)]"
      }`}>

      <div className="flex items-center gap-2.5">
        <div className={`w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 ${iconChipClass}`}>
          <Icon size={14} />
        </div>
        <div className="flex-1 flex items-baseline justify-between gap-2 min-w-0">
          <span className="text-sm font-semibold text-[var(--text-1)]">
            Worker {slot.slotIndex}
          </span>
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono border ${badgeClass}`}>
            <span className={`w-1.5 h-1.5 rounded-full bg-current ${color === "blue" ? "animate-pulse" : ""}`} />
            {statusLabel}
          </span>
        </div>
      </div>

      {slot.status === "free" ? (
        <p className="text-xs text-[var(--text-3)] italic">Free — no campaign</p>
      ) : slot.status === "maintenance" ? (
        <p className="text-xs text-[var(--text-3)] italic">
          {slot.notes || "Manual intervention required"}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[14px_1fr_auto] gap-1.5 items-center text-xs">
            <MapPin size={11} className="text-[var(--text-3)]" />
            <span className="text-[var(--text-1)]">
              {coords ? `${coords.city}, ${coords.country}` : slot.campaign?.timezone}
            </span>
            <span className="text-[10px] text-[var(--text-3)] font-mono tabular-nums">
              {localTime} · {offset}
            </span>
          </div>

          <div className="grid grid-cols-[14px_1fr_auto] gap-1.5 items-center text-xs min-w-0">
            <Megaphone size={11} className="text-[var(--text-3)]" />
            <span className="text-[var(--text-1)] truncate">{slot.campaign?.name}</span>
            <span className="text-[10px] text-[var(--text-3)] font-mono">
              {slot.campaign?.vapiAssistantName}
            </span>
          </div>

          {slot.inFlightCall ? (
            <div className="flex items-center gap-2 text-xs pt-2 border-t border-[var(--border)]">
              <Phone size={11} className="text-blue-400" />
              <span className="text-[var(--text-1)] font-mono">{slot.inFlightCall.phoneE164}</span>
              <span className="ml-auto text-blue-400 font-mono tabular-nums">{callDur}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs pt-2 border-t border-[var(--border)] text-[var(--text-3)]">
              <Radio size={11} />
              <span>idle · leased {formatLeasedDuration(slot.leasedDurationMs)}</span>
            </div>
          )}
        </>
      )}
    </button>
  );
}

// ── Pool panel ──────────────────────────────────────────────────────────
interface WorkerPoolPanelProps {
  slots: WorkerSlot[];
  now: Date;
  hoveredSlotIndex: number | null;
  selectedSlotIndex: number | null;
  onSlotHover: (idx: number | null) => void;
  onSlotSelect: (idx: number | null) => void;
}

export default function WorkerPoolPanel({
  slots, now,
  hoveredSlotIndex, selectedSlotIndex,
  onSlotHover, onSlotSelect,
}: WorkerPoolPanelProps) {
  const sortedSlots = useMemo(
    () => [...slots].sort((a, b) => a.slotIndex - b.slotIndex),
    [slots],
  );

  return (
    <aside className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden h-full">
      <div className="px-4 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-[var(--text-1)]">Worker Pool</h2>
          <span className="text-[11px] text-[var(--text-3)] font-mono">{slots.length} slots</span>
        </div>
        <PoolSummary slots={slots} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5">
        {sortedSlots.map(slot => (
          <WorkerRow
            key={slot.slotIndex}
            slot={slot}
            now={now}
            isSelected={selectedSlotIndex === slot.slotIndex}
            isHovered={hoveredSlotIndex === slot.slotIndex}
            onSelect={onSlotSelect}
            onHover={onSlotHover}
          />
        ))}
      </div>
    </aside>
  );
}
