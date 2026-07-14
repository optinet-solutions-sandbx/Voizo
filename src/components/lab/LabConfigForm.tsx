"use client";

import { useEffect, useState } from "react";
import { VOICE_OPTIONS } from "@/lib/scriptEngine/voices";
import { DEFAULT_SHORT_PROMPT } from "@/lib/scriptEngine/lab-tools";
import { getLabSettings, saveLabSettings } from "@/lib/scriptEngine/lab-db";

const inputCls =
  "w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">{title}</p>
        {hint && <p className="text-[11px] text-gray-600">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

type Props = {
  onAssistantChange: (id: string, name: string) => void;
};

export default function LabConfigForm({ onAssistantChange }: Props) {
  // ── Agent ──
  const [assistants, setAssistants] = useState<{ id: string; name: string }[]>([]);
  const [assistantId, setAssistantId] = useState("");
  const [shortPrompt, setShortPrompt] = useState(DEFAULT_SHORT_PROMPT);
  const [voiceId, setVoiceId] = useState<string>(VOICE_OPTIONS[0].voiceId);
  const [serverOverride, setServerOverride] = useState("");
  const [envBaseUrl, setEnvBaseUrl] = useState<string | null>(null);

  // ── Listener tuning ──
  const [routerModel, setRouterModel] = useState("gpt-5.4-mini");
  const [threshold, setThreshold] = useState(0.7);
  const [cooldown, setCooldown] = useState(4000);
  const [triggerResponse, setTriggerResponse] = useState(true);

  // ── UI ──
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState<{ webhookUrl: string; toolCount: number } | null>(null);

  useEffect(() => {
    fetch("/api/vapi-assistants")
      .then((r) => r.json())
      .then((a) => Array.isArray(a) && setAssistants(a))
      .catch(() => {});
    fetch("/api/lab/configure-assistant")
      .then((r) => r.json())
      .then((j) => setEnvBaseUrl(j.envBaseUrl ?? null))
      .catch(() => {});
    getLabSettings()
      .then((s) => {
        if (!s) return;
        if (s.lab_assistant_id) setAssistantId(s.lab_assistant_id);
        if (s.short_prompt) setShortPrompt(s.short_prompt);
        if (s.server_url_override) setServerOverride(s.server_url_override);
        setRouterModel(s.router_model);
        setThreshold(s.confidence_threshold);
        setCooldown(s.injection_cooldown_ms);
        setTriggerResponse(s.trigger_response);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load settings — did you run the migration?"));
  }, []);

  useEffect(() => {
    const a = assistants.find((x) => x.id === assistantId);
    if (a) onAssistantChange(a.id, a.name);
  }, [assistantId, assistants]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setConfigured(null);
    try {
      // 1. Persist all lab settings first (configure reads server_url_override from here)
      await saveLabSettings({
        lab_assistant_id: assistantId || null,
        short_prompt: shortPrompt,
        server_url_override: serverOverride.trim() || null,
        router_model: routerModel.trim() || "gpt-5.4-mini",
        confidence_threshold: threshold,
        injection_cooldown_ms: cooldown,
        trigger_response: triggerResponse,
      });

      if (!assistantId) {
        setNotice("Settings saved. Select an assistant to push the prompt and configure tools.");
        return;
      }

      // 2. Push prompt + voice onto the assistant
      const voice = VOICE_OPTIONS.find((v) => v.voiceId === voiceId);
      const r1 = await fetch("/api/vapi-assistant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assistantId,
          systemPrompt: shortPrompt,
          ...(voice && { voice: { provider: voice.provider, voiceId: voice.voiceId } }),
        }),
      });
      if (!r1.ok) {
        const j = await r1.json().catch(() => ({}));
        throw new Error(j.error ?? "Failed to save prompt/voice");
      }

      // 3. Configure the assistant for the lab (tools + webhook + monitor)
      const r2 = await fetch("/api/lab/configure-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId }),
      });
      const j2 = await r2.json();
      if (!r2.ok) throw new Error(j2.error ?? "Configure failed");
      setConfigured({ webhookUrl: j2.webhookUrl, toolCount: j2.toolCount });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Lab Agent" hint="The politician — pick a dedicated test assistant; saving overwrites its tools + webhook.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs text-gray-400">Assistant</label>
            <select
              className={inputCls + " [color-scheme:dark]"}
              value={assistantId}
              onChange={(e) => setAssistantId(e.target.value)}
            >
              <option value="">Select an assistant…</option>
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-400">Voice</label>
            <select
              className={inputCls + " [color-scheme:dark]"}
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>

      <Section
        title="Campaign Persona (fallback)"
        hint='Identity + delivery only. If the Playbook has an "identity" scenario, THAT is used instead — keep the persona there, next to the opening line. The listener operating rules are appended automatically when pushed.'
      >
        <textarea
          className={inputCls + " resize-none font-mono text-xs"}
          rows={9}
          value={shortPrompt}
          onChange={(e) => setShortPrompt(e.target.value)}
        />
      </Section>

      <Section
        title="Webhook Server URL"
        hint={`Where VAPI sends live events. Env default: ${envBaseUrl ?? "not set"} — override for local dev with your ngrok URL.`}
      >
        <input
          className={inputCls}
          value={serverOverride}
          onChange={(e) => setServerOverride(e.target.value)}
          placeholder="https://abc123.ngrok-free.app"
        />
      </Section>

      <Section title="Listener Tuning" hint="How aggressively the staff whispers.">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-400">Router Model</label>
            <input className={inputCls} value={routerModel} onChange={(e) => setRouterModel(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-400">Injection Cooldown (ms)</label>
            <input
              className={inputCls}
              type="number"
              step={500}
              value={cooldown}
              onChange={(e) => setCooldown(Number(e.target.value) || 0)}
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            Confidence Threshold: <span className="font-semibold text-gray-200">{threshold.toFixed(2)}</span>
            <span className="ml-1 text-gray-600">(below this, the agent handles it alone)</span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full accent-indigo-500"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={triggerResponse}
            onChange={(e) => setTriggerResponse(e.target.checked)}
          />
          Trigger immediate response on injection
          <span className="text-[10px] text-gray-600">(off = context-only; safer against double-talk)</span>
        </label>
      </Section>

      {/* Status */}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-amber-300">{notice}</p>}
      {configured && (
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            {configured.toolCount} tools ✓
          </span>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            live transcript ✓
          </span>
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            control ✓
          </span>
          <span className="rounded-full bg-gray-700 px-2 py-0.5 text-[11px] text-gray-300">
            {configured.webhookUrl}
          </span>
        </div>
      )}

      {/* Single Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
      >
        {saving ? "Saving & configuring…" : "Save Configuration"}
      </button>
    </div>
  );
}
