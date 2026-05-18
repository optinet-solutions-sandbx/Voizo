"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarDays, Clock, Info, ListChecks, Loader2, Megaphone, MessageSquareText, Phone, Play, Save, Timer } from "lucide-react";
import { createCampaignV2, parsePhoneList, type CallWindow } from "@/lib/campaignV2Data";
import SegmentImporter from "@/components/SegmentImporter";
import DateTimePicker from "@/components/DateTimePicker";

// Default SMS content pre-filled on the Create Campaign form.
// Split into message + link + opt-out so operators can edit each section.
// Link and opt-out require an Edit toggle with confirmation (Manifesto §8: Compliance first).
//
// Current brand: Lucky7even Canada. Approved by Maria, provided by Ernie (2026-04-22).
// TODO: make defaults per-brand when multi-brand Campaign V2 lands
// (see .agent/handoffs/2026-04-21_HANDOFF_Dialer_Phase_A_Landed.md §7 item #11).
const DEFAULT_SMS_MESSAGE =
  "Your 20 totally FREE spins await! Deposit $30 with code LUCKY for 300% bonus up to $500. Ends midnight.";
const DEFAULT_SMS_LINK = "https://playmojo.live/promotions?fast-deposit=modal&bonus=LUCKY";
const SMS_OPTOUT_FOOTER = "STOP? Qwt5.me";
const SHORTENED_URL_LENGTH = 22; // Mobivate shortens to cllk.me/xxxxxx

/** Estimate SMS segment count from character length (GSM-7 encoding). */
function smsSegmentCount(len: number): number {
  if (len === 0) return 0;
  if (len <= 160) return 1;
  return Math.ceil(len / 153); // multi-part SMS uses 153 chars per segment
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">{children}</label>;
}

type DropdownOption = { value: string; label: string; group?: string };

function StyledSelect({ icon, options, value, onChange, placeholder }: {
  icon?: React.ReactNode;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const groups = options.reduce<Record<string, DropdownOption[]>>((acc, o) => {
    const g = o.group || "";
    (acc[g] ??= []).push(o);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2.5 ${icon ? "pl-3.5" : "pl-4"} pr-10 py-3 rounded-xl bg-[var(--bg-app)] border text-sm text-left cursor-pointer transition-all ${
          open
            ? "border-blue-500 ring-1 ring-blue-500"
            : "border-[var(--border)] hover:border-blue-500/40"
        }`}
      >
        {icon && <span className="text-[var(--text-3)] shrink-0">{icon}</span>}
        <span className={selected ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}>
          {selected?.label || placeholder || "Select…"}
        </span>
      </button>
      <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6"/></svg>
      </div>
      {open && (
        <div className="absolute z-50 mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
          {groupKeys.map((g) => (
            <div key={g}>
              {g && <div className="px-3.5 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{g}</div>}
              {groups[g].map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`w-full text-left px-3.5 py-2.5 text-sm transition-colors ${
                    o.value === value
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Assistant = {
  id: string;
  name: string;
  voiceId: string | null;
  voiceProvider: string | null;
  systemPrompt: string | null;
  firstMessage: string | null;
};

const VOICE_OPTIONS = [
  { id: "3jR9BuQAOPMWUjWpi0ll", name: "Stephen – Sales and Customer Service" },
  { id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark – Dynamic, Balanced and Emotional" },
  { id: "6YQMyaUWlj0VX652cY1C", name: "Mark – Natural Conversations" },
  { id: "2zGvynULFssveGrcP8hi", name: "Jackson – American Tech Sales Rep" },
  { id: "YaarrMwvJxVUpjbZ2RpC", name: "George – Natural, Full and Confident" },
  { id: "pHqSZYhjNK8nDCPRglTL", name: "Alex – Professional" },
  { id: "1IthILLNX448pH19aMvC", name: "Matthew Logovik" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam – Default" },
] as const;

type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
type ScheduleRow = { day: Day; enabled: boolean; start: string; end: string };

const DAYS: { key: Day; label: string }[] = [
  { key: "sun", label: "Sunday" },
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
];

const CALLING_HOURS: Record<string, { start: string; end: string; note: string }> = {
  "America/Toronto":      { start: "09:00", end: "21:00", note: "CRTC: 9am–9:30pm" },
  "America/New_York":     { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm (conservative)" },
  "America/Chicago":      { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Denver":       { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Los_Angeles":  { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Vancouver":    { start: "09:00", end: "21:00", note: "CRTC: 9am–9:30pm" },
  "America/Mexico_City":  { start: "09:00", end: "20:00", note: "PROFECO guidance" },
  "Europe/London":        { start: "08:00", end: "21:00", note: "Ofcom/ICO: 8am–9pm" },
  "Europe/Athens":        { start: "09:00", end: "21:00", note: "EETT guidance" },
  "Europe/Paris":         { start: "09:00", end: "20:00", note: "Bloctel: 9am–8pm" },
  "Europe/Berlin":        { start: "09:00", end: "20:00", note: "UWG: 8am–9pm (conservative)" },
  "Europe/Madrid":        { start: "09:00", end: "21:00", note: "CNMC: 9am–9pm" },
  "Asia/Manila":          { start: "09:00", end: "20:00", note: "NTC guidance" },
  "Asia/Singapore":       { start: "09:00", end: "20:00", note: "PDPA guidance" },
  "Asia/Tokyo":           { start: "09:00", end: "20:00", note: "TCA guidance" },
  "Asia/Dubai":           { start: "09:00", end: "21:00", note: "TRA guidance" },
  "Australia/Sydney":     { start: "09:00", end: "20:00", note: "Do Not Call Register Act: 9am–8pm wkday, 9am–5pm Sat" },
  "UTC":                  { start: "09:00", end: "20:00", note: "Safe default" },
};

function getCallingHours(tz: string) {
  return CALLING_HOURS[tz] ?? { start: "09:00", end: "20:00", note: "Safe default" };
}

function formatLocalTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function initialScheduleRows(): ScheduleRow[] {
  return DAYS.map(({ key }) => ({
    day: key,
    enabled: false,
    start: "09:00",
    end: "17:00",
  }));
}

export default function NewCampaignV2Page() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [vapiAssistantId, setVapiAssistantId] = useState("");
  const [assistants, setAssistants] = useState<Assistant[] | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [baseVoiceId, setBaseVoiceId] = useState<string | null>(null);
  const [timezone, setTimezone] = useState("America/Toronto");
  const [startMode, setStartMode] = useState<"now" | "delay" | "scheduled">("now");
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>(initialScheduleRows);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [smsMessage, setSmsMessage] = useState(DEFAULT_SMS_MESSAGE);
  const [smsLink, setSmsLink] = useState(DEFAULT_SMS_LINK);
  const [smsLinkEditing, setSmsLinkEditing] = useState(false);
  const [smsOptout, setSmsOptout] = useState(SMS_OPTOUT_FOOTER);
  const [smsOptoutEditing, setSmsOptoutEditing] = useState(false);
  const [numbersText, setNumbersText] = useState("");
  // customer.io segment id captured at import time. Single-select sets this;
  // multi-select / manual-paste leave it null. Persisted as campaigns_v2.segment_id
  // so Step 5 (Duplicate), Step 6 (Manual refresh), and Step 7 (Resume-diff)
  // can re-query customer.io for this campaign. NULL = no source segment,
  // refresh endpoints reject with 400.
  const [segmentId, setSegmentId] = useState<number | null>(null);
  // Edit/view toggle for the phone numbers panel. Default true (textarea shown)
  // so a fresh form is immediately typeable. CIO import flips to false to show
  // the numbered preview. User can toggle with the Edit/Done buttons.
  const [phoneEditing, setPhoneEditing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedNumbers = useMemo(() => parsePhoneList(numbersText), [numbersText]);

  // ── SMS composition + validation ──
  const composedSmsTemplate = useMemo(() => {
    const parts = [smsMessage.trim(), smsLink.trim(), smsOptout.trim()].filter(Boolean);
    return parts.join(" ");
  }, [smsMessage, smsLink, smsOptout]);

  const estimatedDeliveredLength = useMemo(() => {
    const msgLen = smsMessage.trim().length;
    const urlLen = smsLink.trim() ? SHORTENED_URL_LENGTH : 0;
    const optLen = smsOptout.trim().length;
    const spaces = (msgLen > 0 ? 1 : 0) + (urlLen > 0 ? 1 : 0);
    return msgLen + urlLen + optLen + spaces;
  }, [smsMessage, smsLink, smsOptout]);

  const smsSegments = smsSegmentCount(estimatedDeliveredLength);
  const hasUrlInMessage = /https?:\/\//i.test(smsMessage);
  const isValidSmsLink = smsLink.trim() === "" || smsLink.trim().startsWith("https://");
  const isSmsBodyEmpty = smsEnabled && smsMessage.trim().length === 0;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/vapi/assistants");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setAssistantsError(body.error || `Failed to load assistants (${res.status})`);
          setAssistants([]);
          return;
        }
        const body = await res.json();
        setAssistants(body.assistants ?? []);
      } catch (err) {
        setAssistantsError(err instanceof Error ? err.message : "Network error");
        setAssistants([]);
      }
    })();
  }, []);

  function handleAssistantChange(id: string) {
    setVapiAssistantId(id);
    const a = assistants?.find((x) => x.id === id);
    if (a) {
      // Voice is LOCKED to the assistant's default — we don't propagate
      // a.voiceId into local voiceId state. The clone-assistant route
      // inherits base.voice (whole config) when our request body voiceId
      // is undefined, which avoids both (a) operators degrading agent
      // performance by mismatching voice to prompt, and (b) the
      // KNOWN_VOICES whitelist failing when a base assistant uses a
      // voice outside our operator-selectable list. baseVoiceId is kept
      // for the read-only display next to the prompt name.
      setBaseVoiceId(a.voiceId);
      setSystemPrompt(a.systemPrompt ?? "");
    } else {
      setBaseVoiceId(null);
      setSystemPrompt("");
    }
  }

  function handleTimezoneChange(tz: string) {
    setTimezone(tz);
    const hours = getCallingHours(tz);
    setScheduleRows((prev) =>
      prev.map((r) => ({ ...r, start: hours.start, end: hours.end })),
    );
  }

  function updateRow(day: Day, patch: Partial<ScheduleRow>) {
    setScheduleRows((prev) => prev.map((r) => (r.day === day ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError("Campaign name is required.");
    if (!vapiAssistantId.trim()) return setError("Pick a Vapi assistant.");
    if (parsedNumbers.length === 0) return setError("Add at least one valid E.164 phone number.");

    const enabledRows = scheduleRows.filter((r) => r.enabled);
    if (enabledRows.length === 0) {
      return setError("Enable at least one day in the schedule.");
    }
    for (const r of enabledRows) {
      if (r.start >= r.end) {
        return setError(`${r.day.toUpperCase()} start time must be before end time.`);
      }
    }
    const callWindows: CallWindow[] = enabledRows.map((r) => ({
      day: r.day,
      start: r.start,
      end: r.end,
    }));

    setSaving(true);
    try {
      // Clone-per-campaign: every campaign gets an isolated Vapi assistant
      // + its own SIP phone number. Zero shared state, zero race conditions.
      const cloneRes = await fetch("/api/vapi/clone-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseAssistantId: vapiAssistantId.trim(),
          voiceId: voiceId || undefined,
          systemPrompt: systemPrompt || undefined,
          campaignName: name.trim(),
        }),
      });

      if (!cloneRes.ok) {
        const errBody = await cloneRes.json().catch(() => ({}));
        throw new Error(errBody.error || `Clone failed (${cloneRes.status})`);
      }

      const cloneData = await cloneRes.json();

      const { campaign } = await createCampaignV2({
        name: name.trim(),
        systemPrompt: systemPrompt,
        vapiAssistantId: cloneData.assistantId,
        vapiAssistantName: cloneData.assistantName,
        vapiSipUri: cloneData.sipUri,
        vapiPoolSlotId: cloneData.poolSlotId,
        baseAssistantId: cloneData.baseAssistantId,
        voiceId: cloneData.voiceId ?? undefined,
        segmentId: segmentId ?? undefined,
        timezone: timezone.trim(),
        startAt: startMode === "delay"
          ? new Date(Date.now() + delayMinutes * 60_000).toISOString()
          : startMode === "scheduled" && scheduledDate
            ? new Date(scheduledDate).toISOString()
            : null,
        endAt: null,
        callWindows,
        smsEnabled,
        smsTemplate: composedSmsTemplate || null,
        smsOnGoalReachedOnly: true,
        numbers: parsedNumbers,
      });

      router.push(`/campaigns/v2/${campaign.id}`);
    } catch (err) {
      console.error("Failed to create Campaign V2:", err);
      setError(err instanceof Error ? err.message : "Failed to save Campaign V2. Please check and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="min-w-0">
          <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-2)] hover:text-blue-400 transition-colors mb-3">
            <ArrowLeft size={14} /> Back to Campaigns
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <Megaphone size={18} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-[var(--text-1)]">New Campaign</h1>
              <p className="text-sm text-[var(--text-3)] mt-1">Create an AI-powered outbound campaign. Pick an assistant, add numbers, and set a schedule.</p>
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-5">
        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Phone size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Campaign Basics</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <FieldLabel>Name</FieldLabel>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="e.g. Reactivation Campaign - Canada"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Vapi Assistant</FieldLabel>
              {assistants === null && !assistantsError ? (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-3)]">
                  <Loader2 size={14} className="animate-spin" /> Loading assistants from Vapi…
                </div>
              ) : assistantsError ? (
                <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                  {assistantsError}
                </div>
              ) : (
                <StyledSelect
                  value={vapiAssistantId}
                  onChange={handleAssistantChange}
                  icon={<Phone size={14} />}
                  placeholder="— Select an assistant —"
                  options={assistants!.map((a) => ({ value: a.id, label: a.name }))}
                />
              )}
            </div>
            {vapiAssistantId && (
              <>
                <div className="sm:col-span-2">
                  <div className="px-4 py-3 rounded-xl bg-blue-500/5 border border-blue-500/15">
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Phone size={12} className="text-blue-400" />
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-3)]">Prompt</span>
                        <span className="text-[var(--text-1)] font-semibold">
                          {assistants?.find((a) => a.id === vapiAssistantId)?.name ?? vapiAssistantId}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Megaphone size={12} className="text-[var(--text-3)]" />
                        <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-3)]">Voice</span>
                        <span className="text-[var(--text-1)] font-semibold">
                          {(baseVoiceId && VOICE_OPTIONS.find((v) => v.id === baseVoiceId)?.name) || "Assistant default"}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-[var(--text-3)] bg-[var(--bg-app)] px-1.5 py-0.5 rounded font-medium">Locked</span>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--text-3)] mt-2">
                      Voice is locked to the assistant&apos;s default to prevent performance drift. To change the voice, update the base assistant in Vapi.
                    </p>
                  </div>
                </div>
                <div className="sm:col-span-2">
                  <FieldLabel>System Prompt</FieldLabel>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={6}
                    className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y text-sm leading-relaxed"
                    placeholder="Select an assistant above to load its prompt."
                  />
                </div>
                <p className="sm:col-span-2 text-xs text-[var(--text-3)]">
                  A dedicated agent will be provisioned for this campaign.
                </p>
              </>
            )}
          </div>
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <CalendarDays size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Schedule</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 mb-5">
            <div>
              <FieldLabel>Timezone</FieldLabel>
              <StyledSelect
                value={timezone}
                onChange={handleTimezoneChange}
                icon={<Clock size={14} />}
                placeholder="Select timezone"
                options={[
                  { value: "America/Toronto", label: "America/Toronto", group: "Americas" },
                  { value: "America/New_York", label: "America/New_York", group: "Americas" },
                  { value: "America/Chicago", label: "America/Chicago", group: "Americas" },
                  { value: "America/Denver", label: "America/Denver", group: "Americas" },
                  { value: "America/Los_Angeles", label: "America/Los_Angeles", group: "Americas" },
                  { value: "America/Vancouver", label: "America/Vancouver", group: "Americas" },
                  { value: "America/Mexico_City", label: "America/Mexico_City", group: "Americas" },
                  { value: "Europe/London", label: "Europe/London", group: "Europe" },
                  { value: "Europe/Athens", label: "Europe/Athens", group: "Europe" },
                  { value: "Europe/Paris", label: "Europe/Paris", group: "Europe" },
                  { value: "Europe/Berlin", label: "Europe/Berlin", group: "Europe" },
                  { value: "Europe/Madrid", label: "Europe/Madrid", group: "Europe" },
                  { value: "Asia/Manila", label: "Asia/Manila", group: "Asia / Pacific" },
                  { value: "Asia/Singapore", label: "Asia/Singapore", group: "Asia / Pacific" },
                  { value: "Asia/Tokyo", label: "Asia/Tokyo", group: "Asia / Pacific" },
                  { value: "Asia/Dubai", label: "Asia/Dubai", group: "Asia / Pacific" },
                  { value: "Australia/Sydney", label: "Australia/Sydney", group: "Asia / Pacific" },
                  { value: "UTC", label: "UTC" },
                ]}
              />
              <p className="text-xs text-[var(--text-3)] mt-2">
                Recommended hours: <span className="text-[var(--text-2)] font-medium">{getCallingHours(timezone).start}–{getCallingHours(timezone).end}</span>
                <span className="text-[var(--text-3)] ml-1">({getCallingHours(timezone).note})</span>
              </p>
            </div>
          </div>

          <FieldLabel>When to Start</FieldLabel>
          <div className="flex gap-2 mb-3">
            <button
              type="button"
              onClick={() => setStartMode("now")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                startMode === "now"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                  : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/40"
              }`}
            >
              <Play size={14} />
              Start Immediately
            </button>
            <button
              type="button"
              onClick={() => setStartMode("delay")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                startMode === "delay"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                  : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/40"
              }`}
            >
              <Timer size={14} />
              Delay Start
            </button>
            <button
              type="button"
              onClick={() => setStartMode("scheduled")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                startMode === "scheduled"
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/20"
                  : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/40"
              }`}
            >
              <CalendarDays size={14} />
              Schedule Date
            </button>
          </div>

          {/* Mode preview — compact, updates live as operator picks a mode */}
          {(() => {
            const isWarn = startMode === "scheduled" && !scheduledDate;
            const tzShort = timezone.split("/").pop()?.replace(/_/g, " ") ?? timezone;
            return (
              <div className={`px-3 py-2 rounded-lg flex items-center gap-2 text-xs mb-3 ${
                isWarn
                  ? "bg-amber-500/[0.08] text-amber-200"
                  : "bg-blue-500/[0.06] text-[var(--text-2)]"
              }`}>
                <Info size={12} className={`shrink-0 ${isWarn ? "text-amber-400" : "text-blue-400"}`} />
                {startMode === "now" && (
                  <p className="leading-snug">Saves as <span className="text-[var(--text-1)] font-medium">draft</span> — click <span className="text-emerald-400 font-medium">Start</span> on the campaign page to begin.</p>
                )}
                {startMode === "delay" && (
                  <p className="leading-snug">
                    Auto-starts in <span className="text-[var(--text-1)] font-medium">{delayMinutes} min</span>
                    {" — "}
                    <span className="text-[var(--text-1)] font-medium">{formatLocalTime(new Date(Date.now() + delayMinutes * 60_000), timezone)}</span>
                    <span className="text-[var(--text-3)]"> · {tzShort}</span>
                  </p>
                )}
                {startMode === "scheduled" && scheduledDate && (
                  <p className="leading-snug">
                    Auto-starts <span className="text-[var(--text-1)] font-medium">{formatLocalTime(new Date(scheduledDate), timezone)}</span>
                    <span className="text-[var(--text-3)]"> · {tzShort}</span>
                  </p>
                )}
                {isWarn && (
                  <p className="leading-snug">Pick a date below — or switch to <span className="font-medium">Start Immediately</span>.</p>
                )}
              </div>
            );
          })()}

          {startMode === "delay" && (
            <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4 mb-1">
              <p className="text-xs text-[var(--text-3)] mb-3">Start dialling after:</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: "30 min", value: 30 },
                  { label: "1 hour", value: 60 },
                  { label: "2 hours", value: 120 },
                  { label: "4 hours", value: 240 },
                  { label: "8 hours", value: 480 },
                  { label: "24 hours", value: 1440 },
                ].map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => setDelayMinutes(preset.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      delayMinutes === preset.value
                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                        : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30 hover:text-blue-400"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {startMode === "scheduled" && (
            <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4 mb-1">
              <p className="text-xs text-[var(--text-3)] mb-2">
                Pick a date and time. Times are in your browser&apos;s timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
              </p>
              <DateTimePicker
                value={scheduledDate}
                onChange={(v) => setScheduledDate(v)}
                min={new Date().toISOString().slice(0, 16)}
              />
            </div>
          )}

          <FieldLabel>Active Days</FieldLabel>
          <p className="text-xs text-[var(--text-3)] mb-2 -mt-1">Pick which days the campaign is allowed to dial out.</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {DAYS.map(({ key, label }) => {
              const row = scheduleRows.find((r) => r.day === key)!;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => updateRow(key, { enabled: !row.enabled })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    row.enabled
                      ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                      : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-3)] hover:border-blue-500/30"
                  }`}
                >
                  {label.slice(0, 3)}
                </button>
              );
            })}
          </div>

          {scheduleRows.some((r) => r.enabled) && (
            <>
              <FieldLabel>Call Hours</FieldLabel>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] divide-y divide-[var(--border)]">
                {scheduleRows.filter((r) => r.enabled).map((row) => (
                  <div key={row.day} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-sm font-medium text-[var(--text-1)] min-w-[5rem]">
                      {DAYS.find((d) => d.key === row.day)?.label}
                    </span>
                    <div className="flex items-center gap-2 flex-1">
                      <input
                        type="time"
                        value={row.start}
                        onChange={(e) => updateRow(row.day, { start: e.target.value })}
                        className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <span className="text-xs text-[var(--text-3)]">to</span>
                      <input
                        type="time"
                        value={row.end}
                        onChange={(e) => updateRow(row.day, { end: e.target.value })}
                        className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-[var(--text-3)] mt-2">
                Calls only dial during these hours, in the campaign&apos;s timezone.
              </p>
            </>
          )}
          {!scheduleRows.some((r) => r.enabled) && (
            <p className="text-xs text-[var(--text-3)]">Select at least one day to set call hours.</p>
          )}
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <MessageSquareText size={16} className="text-blue-400" />
              <h2 className="text-base font-semibold text-[var(--text-1)]">Post-Call SMS</h2>
            </div>
            <button
              type="button"
              onClick={() => setSmsEnabled(!smsEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                smsEnabled ? "bg-blue-600" : "bg-[var(--border)]"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  smsEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-[var(--text-3)] mb-4">
            When enabled, a follow-up SMS is sent automatically after a successful call via Mobivate.
          </p>

          {smsEnabled && (
            <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4 space-y-3">
              {/* ── Message ── */}
              <div>
                <FieldLabel>Message</FieldLabel>
                <textarea
                  value={smsMessage}
                  onChange={(e) => setSmsMessage(e.target.value)}
                  rows={2}
                  placeholder="Enter your promotional message..."
                  className="w-full bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none transition-all"
                />
                {hasUrlInMessage && (
                  <p className="text-[10px] text-amber-400 mt-1">Tip: Use the Link field below for URLs — they&apos;ll be auto-shortened.</p>
                )}
                {isSmsBodyEmpty && (
                  <p className="text-[10px] text-red-400 mt-1">Message cannot be empty when SMS is enabled.</p>
                )}
              </div>

              {/* ── Link ── */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <FieldLabel>Link</FieldLabel>
                  {!smsLinkEditing ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Changing the link affects where customers land. Continue?")) {
                          setSmsLinkEditing(true);
                        }
                      }}
                      className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                    >
                      Edit
                    </button>
                  ) : (
                    <span className="text-[10px] text-amber-400">Editing</span>
                  )}
                </div>
                <input
                  type="url"
                  value={smsLink}
                  onChange={(e) => setSmsLink(e.target.value)}
                  disabled={!smsLinkEditing}
                  placeholder="https://..."
                  className={`w-full bg-[var(--bg-card)] border rounded-lg px-3 py-2 text-sm transition-all ${
                    !isValidSmsLink
                      ? "border-red-500/50 focus:ring-red-500"
                      : "border-[var(--border)] focus:ring-blue-500"
                  } ${
                    smsLinkEditing
                      ? "text-[var(--text-1)] focus:outline-none focus:ring-1 focus:border-blue-500"
                      : "text-[var(--text-3)] opacity-75 cursor-not-allowed"
                  }`}
                />
                {!isValidSmsLink && (
                  <p className="text-[10px] text-red-400 mt-1">Link must start with https://</p>
                )}
              </div>

              {/* ── Opt-out ── */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Opt-out</span>
                  {!smsOptoutEditing ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Changing the opt-out text affects compliance. Continue?")) {
                          setSmsOptoutEditing(true);
                        }
                      }}
                      className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                    >
                      Edit
                    </button>
                  ) : (
                    <span className="text-[10px] text-amber-400">Editing</span>
                  )}
                </div>
                <input
                  type="text"
                  value={smsOptout}
                  onChange={(e) => setSmsOptout(e.target.value)}
                  disabled={!smsOptoutEditing}
                  placeholder="e.g. STOP? Qwt5.me"
                  className={`w-full bg-[var(--bg-card)] border rounded-lg px-3 py-2 text-sm transition-all ${
                    "border-[var(--border)] focus:ring-blue-500"
                  } ${
                    smsOptoutEditing
                      ? "text-[var(--text-1)] focus:outline-none focus:ring-1 focus:border-blue-500"
                      : "text-[var(--text-3)] opacity-75 cursor-not-allowed"
                  }`}
                />
              </div>

              {/* ── Divider ── */}
              <div className="border-t border-[var(--border)]" />

              {/* ── Preview ── */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Preview</span>
                  <span className={`text-[10px] font-medium ${
                    smsSegments > 2 ? "text-red-400" : smsSegments > 1 ? "text-amber-400" : "text-emerald-400"
                  }`}>
                    ~{estimatedDeliveredLength} chars ({smsSegments} SMS{smsSegments !== 1 ? "s" : ""})
                  </span>
                </div>
                <p className="text-xs text-[var(--text-2)] leading-relaxed whitespace-pre-wrap bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2">
                  {smsMessage.trim()}{smsLink.trim() ? ` ${smsLink.trim()}` : ""}{smsOptout.trim() ? ` ${smsOptout.trim()}` : ""}
                </p>
                <p className="text-[10px] text-[var(--text-3)] mt-1">Link appears shortened (cllk.me) on delivery.</p>
              </div>
            </div>
          )}
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <ListChecks size={16} className="text-blue-400" />
              <h2 className="text-base font-semibold text-[var(--text-1)]">Phone Numbers</h2>
            </div>
            {parsedNumbers.length > 0 && (
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/15 text-blue-400 border border-blue-500/20">
                {parsedNumbers.length} number{parsedNumbers.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--text-3)] mb-4">Import from a segment or paste numbers manually.</p>

          <div className="grid gap-3">
            <SegmentImporter
              onImport={(phones, importedSegmentId) => {
                setNumbersText(phones.join("\n"));
                // Capture the segment id for persistence — only populated on
                // single-segment imports; multi-segment imports pass null.
                setSegmentId(importedSegmentId);
                // Switch to view mode so operator immediately sees the
                // numbered preview of what was captured.
                setPhoneEditing(false);
              }}
            />

            {(parsedNumbers.length === 0 || phoneEditing) ? (
              <div className="relative">
                <textarea
                  value={numbersText}
                  onChange={(e) => setNumbersText(e.target.value)}
                  rows={5}
                  className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono text-sm transition-colors"
                  placeholder={"Paste or type numbers here, one per line\ne.g. +14035550100"}
                />
                {parsedNumbers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPhoneEditing(false)}
                    className="absolute top-2 right-2 px-2.5 py-1 rounded-md text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    Done · view {parsedNumbers.length}
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-xl bg-[var(--bg-app)] border border-[var(--border)] max-h-56 overflow-y-auto">
                <div className="sticky top-0 z-10 bg-[var(--bg-app)] px-4 py-2 border-b border-[var(--border)] flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-3)]">
                    {parsedNumbers.length} number{parsedNumbers.length !== 1 ? "s" : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => setPhoneEditing(true)}
                    className="text-xs font-medium text-blue-400 hover:text-blue-300"
                  >
                    Edit
                  </button>
                </div>
                <div className="p-3 font-mono text-xs grid gap-1">
                  {parsedNumbers.map((num, idx) => (
                    <div key={`${idx}-${num}`} className="flex items-baseline gap-3">
                      <span className="text-[var(--text-3)] w-8 text-right shrink-0">{idx + 1}.</span>
                      <span className="text-[var(--text-1)]">{num}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {numbersText.trim() && parsedNumbers.length === 0 && (
              <p className="text-xs text-red-400">No valid E.164 numbers found. Numbers must start with + followed by 8–15 digits.</p>
            )}
          </div>
        </section>

        {error && (
          <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
            {error}
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
          <Link
            href="/campaigns"
            className="px-5 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors text-sm font-medium text-center"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving || isSmsBodyEmpty || !isValidSmsLink}
            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-70 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shadow-md shadow-blue-600/20"
          >
            <Save size={15} />
            {saving ? "Saving..." : "Create Campaign V2"}
          </button>
        </div>
      </form>
    </div>
  );
}
