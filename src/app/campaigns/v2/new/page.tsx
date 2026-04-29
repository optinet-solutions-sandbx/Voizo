"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, CalendarDays, Clock, ListChecks, Loader2, MessageSquareText, Phone, Play, Save, Sparkles, Timer } from "lucide-react";
import { createCampaignV2, parsePhoneList, type CallWindow } from "@/lib/campaignV2Data";
import SegmentImporter from "@/components/SegmentImporter";

// Default SMS template pre-filled on the Create Campaign form.
// Current brand: Lucky7even Canada. Approved by Maria, provided by Ernie (2026-04-22).
// TODO: make this per-brand configurable when multi-brand Campaign V2 lands
// (see .agent/handoffs/2026-04-21_HANDOFF_Dialer_Phase_A_Landed.md §7 item #11).
const DEFAULT_SMS_TEMPLATE =
  "Your 20 totally FREE spins await! Deposit $30 with code LUCKY for 300% bonus up to $500. Ends midnight. https://playmojo.live/promotions?fast-deposit=modal&bonus=LUCKY STOP? Qwt5.me";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">{children}</label>;
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
  const [startMode, setStartMode] = useState<"now" | "delay">("now");
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>(initialScheduleRows);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const [smsTemplate, setSmsTemplate] = useState(DEFAULT_SMS_TEMPLATE);
  const [numbersText, setNumbersText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedNumbers = useMemo(() => parsePhoneList(numbersText), [numbersText]);

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
      setVoiceId(a.voiceId ?? "");
      setBaseVoiceId(a.voiceId);
      setSystemPrompt(a.systemPrompt ?? "");
    } else {
      setVoiceId("");
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
        timezone: timezone.trim(),
        startAt: startMode === "delay" ? new Date(Date.now() + delayMinutes * 60_000).toISOString() : null,
        endAt: null,
        callWindows,
        smsEnabled,
        smsTemplate: smsTemplate.trim() || null,
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
              <Sparkles size={18} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-[var(--text-1)]">New Campaign V2</h1>
              <p className="text-sm text-[var(--text-3)] mt-1">Create an AI-powered outbound campaign. Pick an assistant, add numbers, and set a schedule.</p>
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-full border border-[var(--border)] bg-[var(--bg-card)] text-xs text-[var(--text-2)]">
          <Bot size={14} className="text-blue-400" />
          AI-only Week 1
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
                <select
                  value={vapiAssistantId}
                  onChange={(e) => handleAssistantChange(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">— Select an assistant —</option>
                  {assistants!.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {vapiAssistantId && (
              <>
                <div>
                  <FieldLabel>Voice</FieldLabel>
                  <select
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">— Use assistant default —</option>
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}{v.id === baseVoiceId ? " (current)" : ""}
                      </option>
                    ))}
                  </select>
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
              <select
                value={timezone}
                onChange={(e) => handleTimezoneChange(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <optgroup label="Americas">
                  <option value="America/Toronto">America/Toronto</option>
                  <option value="America/New_York">America/New_York</option>
                  <option value="America/Chicago">America/Chicago</option>
                  <option value="America/Denver">America/Denver</option>
                  <option value="America/Los_Angeles">America/Los_Angeles</option>
                  <option value="America/Vancouver">America/Vancouver</option>
                  <option value="America/Mexico_City">America/Mexico_City</option>
                </optgroup>
                <optgroup label="Europe">
                  <option value="Europe/London">Europe/London</option>
                  <option value="Europe/Athens">Europe/Athens</option>
                  <option value="Europe/Paris">Europe/Paris</option>
                  <option value="Europe/Berlin">Europe/Berlin</option>
                  <option value="Europe/Madrid">Europe/Madrid</option>
                </optgroup>
                <optgroup label="Asia / Pacific">
                  <option value="Asia/Manila">Asia/Manila</option>
                  <option value="Asia/Singapore">Asia/Singapore</option>
                  <option value="Asia/Tokyo">Asia/Tokyo</option>
                  <option value="Asia/Dubai">Asia/Dubai</option>
                  <option value="Australia/Sydney">Australia/Sydney</option>
                </optgroup>
                <option value="UTC">UTC</option>
              </select>
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
          </div>

          {startMode === "delay" && (
            <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4 mb-1">
              <p className="text-xs text-[var(--text-3)] mb-3">Start dialling after:</p>
              <div className="flex flex-wrap gap-2 mb-3">
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
              <div className="flex items-center gap-2">
                <Clock size={13} className="text-[var(--text-3)]" />
                <span className="text-xs text-[var(--text-2)]">
                  Campaign will start at approximately{" "}
                  <span className="font-semibold text-[var(--text-1)]">
                    {new Date(Date.now() + delayMinutes * 60_000).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </span>
                  {delayMinutes >= 1440 && (
                    <span>
                      {" "}on{" "}
                      <span className="font-semibold text-[var(--text-1)]">
                        {new Date(Date.now() + delayMinutes * 60_000).toLocaleDateString("en-US", {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </span>
                  )}
                </span>
              </div>
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
            <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Message Preview</p>
              <p className="text-sm text-[var(--text-2)] leading-relaxed whitespace-pre-wrap">{smsTemplate}</p>
              <p className="text-[10px] text-[var(--text-3)] mt-3">Template is managed externally. Contact your admin to update.</p>
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
              onImport={(phones) => {
                setNumbersText(phones.join("\n"));
              }}
            />

            <div className="relative">
              <textarea
                value={numbersText}
                onChange={(e) => setNumbersText(e.target.value)}
                rows={5}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono text-sm transition-colors"
                placeholder={"Paste or type numbers here, one per line\ne.g. +14035550100"}
              />
            </div>
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
            disabled={saving}
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
