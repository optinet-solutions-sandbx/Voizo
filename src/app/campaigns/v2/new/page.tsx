"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, CalendarDays, ListChecks, MessageSquareText, Phone, Save, Sparkles } from "lucide-react";
import { createCampaignV2, formatDefaultCallWindowsJson, parsePhoneList } from "@/lib/campaignV2Data";

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">{children}</label>;
}

export default function NewCampaignV2Page() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [vapiAssistantId, setVapiAssistantId] = useState("");
  const [vapiAssistantName, setVapiAssistantName] = useState("");
  const [timezone, setTimezone] = useState("America/Toronto");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [callWindowsJson, setCallWindowsJson] = useState(formatDefaultCallWindowsJson());
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsTemplate, setSmsTemplate] = useState("");
  const [numbersText, setNumbersText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const parsedNumbers = useMemo(() => parsePhoneList(numbersText), [numbersText]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!name.trim()) return setError("Campaign name is required.");
    if (!systemPrompt.trim()) return setError("Prompt is required.");
    if (!vapiAssistantId.trim()) return setError("Vapi assistant ID is required.");
    if (parsedNumbers.length === 0) return setError("Add at least one valid E.164 phone number.");

    let callWindows;
    try {
      callWindows = JSON.parse(callWindowsJson);
      if (!Array.isArray(callWindows) || callWindows.length === 0) {
        throw new Error("Call windows must be a non-empty JSON array.");
      }
    } catch {
      return setError("Call windows must be valid JSON.");
    }

    setSaving(true);
    try {
      const { campaign, numberCount } = await createCampaignV2({
        name: name.trim(),
        systemPrompt: systemPrompt.trim(),
        vapiAssistantId: vapiAssistantId.trim(),
        vapiAssistantName: vapiAssistantName.trim() || undefined,
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
            <div>
              <FieldLabel>Vapi Assistant ID</FieldLabel>
              <input
                value={vapiAssistantId}
                onChange={(e) => setVapiAssistantId(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="669a0235-40bf-4989-8781-406e00899c9d"
              />
            </div>
            <div>
              <FieldLabel>Vapi Assistant Name</FieldLabel>
              <input
                value={vapiAssistantName}
                onChange={(e) => setVapiAssistantName(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Chris - Voice Agent"
              />
            </div>
          </div>
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <CalendarDays size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Schedule</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>Timezone</FieldLabel>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="America/Toronto"
              />
            </div>
            <div />
            <div>
              <FieldLabel>Start At</FieldLabel>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <FieldLabel>End At</FieldLabel>
              <input
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div className="sm:col-span-2">
              <FieldLabel>Call Windows JSON</FieldLabel>
              <textarea
                value={callWindowsJson}
                onChange={(e) => setCallWindowsJson(e.target.value)}
                rows={8}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] font-mono text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
              />
              <p className="text-xs text-[var(--text-3)] mt-2">
                The default JSON matches the Callers.ai schedule. We can replace this with a friendly editor next.
              </p>
            </div>
          </div>
        </section>

        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquareText size={16} className="text-blue-400" />
            <h2 className="text-base font-semibold text-[var(--text-1)]">Post-Call SMS</h2>
          </div>
          <div className="grid gap-4">
            <label className="inline-flex items-center gap-3 text-sm text-[var(--text-2)]">
              <input
                type="checkbox"
                checked={smsEnabled}
                onChange={(e) => setSmsEnabled(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--border)] text-blue-500 focus:ring-blue-500"
              />
              Enable SMS when goal_reached = true
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
          <textarea
            value={numbersText}
            onChange={(e) => setNumbersText(e.target.value)}
            rows={7}
            className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y font-mono text-sm"
            placeholder={"+14035550100\n+14035550101\n+14035550102"}
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
