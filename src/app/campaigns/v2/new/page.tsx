"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, CalendarDays, ListChecks, Loader2, MessageSquareText, Phone, Save, Sparkles } from "lucide-react";
import { createCampaignV2, defaultCallWindows, parsePhoneList, type CallWindow } from "@/lib/campaignV2Data";
import SegmentImporter from "@/components/SegmentImporter";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">{children}</label>;
}

type Assistant = { id: string; name: string };

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

function initialScheduleRows(): ScheduleRow[] {
  // Seed from defaultCallWindows(); any day missing from defaults is disabled
  // with a reasonable 09:00–17:00 placeholder the operator can toggle on.
  const defaults = new Map(defaultCallWindows().map((w) => [w.day, w]));
  return DAYS.map(({ key }) => {
    const match = defaults.get(key);
    return match
      ? { day: key, enabled: true, start: match.start, end: match.end }
      : { day: key, enabled: false, start: "09:00", end: "17:00" };
  });
}

export default function NewCampaignV2Page() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [vapiAssistantId, setVapiAssistantId] = useState("");
  const [assistants, setAssistants] = useState<Assistant[] | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);
  const [timezone, setTimezone] = useState("America/Toronto");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [scheduleRows, setScheduleRows] = useState<ScheduleRow[]>(initialScheduleRows);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsTemplate, setSmsTemplate] = useState("");
  const [numbersText, setNumbersText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

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

  function updateRow(day: Day, patch: Partial<ScheduleRow>) {
    setScheduleRows((prev) => prev.map((r) => (r.day === day ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!name.trim()) return setError("Campaign name is required.");
    if (!systemPrompt.trim()) return setError("Prompt is required.");
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

    const selectedAssistant = assistants?.find((a) => a.id === vapiAssistantId);

    setSaving(true);
    try {
      const { campaign, numberCount } = await createCampaignV2({
        name: name.trim(),
        systemPrompt: systemPrompt.trim(),
        vapiAssistantId: vapiAssistantId.trim(),
        vapiAssistantName: selectedAssistant?.name,
        timezone: timezone.trim(),
        startAt: startAt ? new Date(startAt).toISOString() : null,
        endAt: endAt ? new Date(endAt).toISOString() : null,
        callWindows,
        smsEnabled,
        smsTemplate: smsTemplate.trim() || null,
        smsOnGoalReachedOnly: true,
        numbers: parsedNumbers,
      });

      setSuccess(`Saved campaign "${campaign.name}" with ${numberCount} numbers.`);
      setNumbersText("");
      router.refresh();
    } catch (err) {
      console.error("Failed to create Campaign V2:", err);
      setError("Failed to save Campaign V2. Please check Supabase and try again.");
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
              <p className="text-sm text-[var(--text-3)] mt-1">Create the prompt-based outbound campaign that dials first, then lets Vapi talk.</p>
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
                placeholder="Lucky7even RND Calls v2 - Canada"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Prompt</FieldLabel>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={7}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
                placeholder="Write the system prompt that Vapi should follow during the call."
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
                  onChange={(e) => setVapiAssistantId(e.target.value)}
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
              {vapiAssistantId && (
                <p className="text-xs text-[var(--text-3)] mt-2 font-mono">{vapiAssistantId}</p>
              )}
            </div>
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
                onChange={(e) => setTimezone(e.target.value)}
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
            </div>
            <div />
            <div>
              <FieldLabel>Start Date</FieldLabel>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <FieldLabel>End Date</FieldLabel>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <FieldLabel>Weekly Call Hours</FieldLabel>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] divide-y divide-[var(--border)]">
            {scheduleRows.map((row) => (
              <div key={row.day} className="flex items-center gap-3 px-4 py-3">
                <label className="flex items-center gap-2 text-sm text-[var(--text-2)] min-w-[9rem] shrink-0">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => updateRow(row.day, { enabled: e.target.checked })}
                    className="w-4 h-4 rounded border-[var(--border)] text-blue-500 focus:ring-blue-500"
                  />
                  {DAYS.find((d) => d.key === row.day)?.label}
                </label>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="time"
                    value={row.start}
                    onChange={(e) => updateRow(row.day, { start: e.target.value })}
                    disabled={!row.enabled}
                    className="px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                  />
                  <span className="text-xs text-[var(--text-3)]">to</span>
                  <input
                    type="time"
                    value={row.end}
                    onChange={(e) => updateRow(row.day, { end: e.target.value })}
                    disabled={!row.enabled}
                    className="px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-[var(--text-3)] mt-2">
            Calls only dial during these hours, in the campaign&apos;s timezone. Uncheck a day to skip it entirely.
          </p>
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <MessageSquareText size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Post-Call SMS</h2>
          </div>
          <p className="text-xs text-[var(--text-3)] mb-4">
            Sent automatically to the called number right after a successful call. &quot;Successful&quot; means the AI determined the conversation met the campaign&apos;s goal.
          </p>
          <div className="grid gap-4">
            <label className="inline-flex items-center gap-3 text-sm text-[var(--text-2)]">
              <input
                type="checkbox"
                checked={smsEnabled}
                onChange={(e) => setSmsEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--border)] text-blue-500 focus:ring-blue-500"
              />
              Send SMS only when the call is successful
            </label>
            <textarea
              value={smsTemplate}
              onChange={(e) => setSmsTemplate(e.target.value)}
              rows={4}
              className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y disabled:opacity-60"
              placeholder="Thanks for your time. Here is the follow-up message..."
              disabled={!smsEnabled}
            />
          </div>
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <ListChecks size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Phone Numbers</h2>
          </div>

          <SegmentImporter
            onImport={(phones) => {
              setNumbersText((prev) => {
                const sep = prev.trim().length > 0 && !prev.endsWith("\n") ? "\n" : "";
                return prev + sep + phones.join("\n");
              });
            }}
          />

          <textarea
            value={numbersText}
            onChange={(e) => setNumbersText(e.target.value)}
            rows={7}
            className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)]/60 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y font-mono text-sm"
            placeholder={"Paste or type numbers here, one per line\nExample:  +14035550100"}
          />
          <p className="text-xs text-[var(--text-3)] mt-2">
            Parsed numbers: <span className="text-[var(--text-2)] font-semibold">{parsedNumbers.length}</span>
          </p>
        </section>

        {error && (
          <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
            {error}
          </div>
        )}
        {success && (
          <div className="px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-300">
            {success}
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
