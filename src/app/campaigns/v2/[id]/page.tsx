"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Bot, Clock, MessageSquareText, Phone, Play, Pause, Settings, Loader2 } from "lucide-react";
import { fetchCampaignV2, fetchCampaignNumbersV2, fetchCallsV2, fetchSmsMessagesV2, updateCampaignV2Status } from "@/lib/campaignV2Data";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-500/15 text-gray-400 border-gray-500/25",
    running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    paused: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    completed: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    archived: "bg-gray-500/15 text-gray-400 border-gray-500/25",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${map[status] ?? map.draft}`}>
      {status}
    </span>
  );
}

function SmsStatusCell({ sms }: { sms: Row | undefined }) {
  if (!sms) return <span className="text-[var(--text-3)]">—</span>;
  const status = (sms.status as string) || "queued";
  const label: Record<string, string> = {
    queued: "Queued",
    sent: "Sent",
    delivered: "Delivered",
    failed: "Failed",
    undelivered: "Undelivered",
  };
  const cls: Record<string, string> = {
    queued: "bg-gray-500/15 text-gray-400 border-gray-500/25",
    sent: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    delivered: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    failed: "bg-red-500/15 text-red-400 border-red-500/25",
    undelivered: "bg-amber-500/15 text-amber-400 border-amber-500/25",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${cls[status] ?? cls.queued}`}>
      {label[status] ?? status}
    </span>
  );
}

type Tab = "numbers" | "calls" | "settings";

export default function CampaignV2DetailPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Row | null>(null);
  const [numbers, setNumbers] = useState<Row[]>([]);
  const [calls, setCalls] = useState<Row[]>([]);
  const [smsByPhone, setSmsByPhone] = useState<Map<string, Row>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("numbers");
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const [c, n, cl, sms] = await Promise.all([
          fetchCampaignV2(id),
          fetchCampaignNumbersV2(id),
          fetchCallsV2(id).catch(() => []),
          fetchSmsMessagesV2(id).catch(() => []),
        ]);
        setCampaign(c);
        setNumbers(n);
        setCalls(cl);
        // Build phone -> most-recent SMS map. Rows arrive ordered newest-first,
        // so the first one we see per phone is the latest.
        const map = new Map<string, Row>();
        for (const row of sms) {
          const phone = row.to_phone_e164 as string | undefined;
          if (phone && !map.has(phone)) map.set(phone, row);
        }
        setSmsByPhone(map);
      } catch (err) {
        console.error("Failed to load campaign:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function handleStart() {
    if (!id) return;
    setActing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/campaigns-v2/${id}/start`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(
          typeof body.error === "string"
            ? body.error
            : `Failed to start campaign (${res.status}).`,
        );
        return;
      }
      setCampaign((prev) => prev ? { ...prev, status: "running" } : prev);
    } catch (err) {
      console.error("Start failed:", err);
      setActionError(err instanceof Error ? err.message : "Failed to start campaign.");
    } finally {
      setActing(false);
    }
  }

  async function handlePause() {
    if (!id) return;
    setActing(true);
    try {
      const updated = await updateCampaignV2Status(id, "paused");
      setCampaign(updated);
    } catch (err) {
      console.error("Pause failed:", err);
    } finally {
      setActing(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto flex items-center justify-center py-24 text-[var(--text-3)]">
        <Loader2 size={20} className="animate-spin mr-2" /> Loading...
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto text-center py-24 text-[var(--text-3)]">
        Campaign not found.
      </div>
    );
  }

  const status = campaign.status as string;
  const phoneByNumberId = new Map(
    numbers.map((n) => [n.id as string, n.phone_e164 as string]),
  );

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
      tab === t
        ? "bg-blue-600 text-white"
        : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
    }`;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="mb-6">
        <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-2)] hover:text-blue-400 transition-colors mb-3">
          <ArrowLeft size={14} /> Back to Campaigns
        </Link>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <Bot size={18} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-[var(--text-1)] truncate">{campaign.name as string}</h1>
                <StatusBadge status={status} />
              </div>
              <p className="text-sm text-[var(--text-3)] mt-1">
                {(campaign.vapi_assistant_name as string) || "No agent name"} &middot; {campaign.timezone as string}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(status === "draft" || status === "paused") && (
              <button
                onClick={handleStart}
                disabled={acting}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
              >
                <Play size={15} /> Start
              </button>
            )}
            {status === "running" && (
              <button
                onClick={handlePause}
                disabled={acting}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-600 hover:bg-yellow-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
              >
                <Pause size={15} /> Pause
              </button>
            )}
          </div>
        </div>
      </div>

      {actionError && (
        <div className="mb-6 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {/* Info cards */}
      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <Phone size={12} /> Numbers
          </div>
          <p className="text-xl font-bold text-[var(--text-1)]">{numbers.length}</p>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <Clock size={12} /> Schedule
          </div>
          <p className="text-sm text-[var(--text-2)]">
            {campaign.start_at ? new Date(campaign.start_at as string).toLocaleString() : "Not set"}
            {campaign.end_at ? ` — ${new Date(campaign.end_at as string).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <MessageSquareText size={12} /> SMS
          </div>
          <p className="text-sm text-[var(--text-2)]">{campaign.sms_enabled ? "Enabled" : "Disabled"}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        <button className={tabClass("numbers")} onClick={() => setTab("numbers")}>Numbers</button>
        <button className={tabClass("calls")} onClick={() => setTab("calls")}>Calls</button>
        <button className={tabClass("settings")} onClick={() => setTab("settings")}>
          <Settings size={14} className="inline mr-1 -mt-0.5" />Settings
        </button>
      </div>

      {/* Tab content */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-sm overflow-hidden">
        {tab === "numbers" && (
          numbers.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-3)]">No numbers in this campaign.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-3)] text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-3 font-semibold">Phone</th>
                  <th className="text-left px-5 py-3 font-semibold">Outcome</th>
                  <th className="text-left px-5 py-3 font-semibold">Attempts</th>
                  <th className="text-left px-5 py-3 font-semibold">SMS</th>
                  <th className="text-left px-5 py-3 font-semibold">Last Attempted</th>
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id as string} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors">
                    <td className="px-5 py-3 text-[var(--text-1)] font-mono">{n.phone_e164 as string}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{(n.outcome as string) || "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{(n.attempt_count as number) ?? 0}</td>
                    <td className="px-5 py-3"><SmsStatusCell sms={smsByPhone.get(n.phone_e164 as string)} /></td>
                    <td className="px-5 py-3 text-[var(--text-3)]">{n.last_attempted_at ? new Date(n.last_attempted_at as string).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "calls" && (
          calls.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-3)]">No calls yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-3)] text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-3 font-semibold">Phone</th>
                  <th className="text-left px-5 py-3 font-semibold">Status</th>
                  <th className="text-left px-5 py-3 font-semibold">Duration</th>
                  <th className="text-left px-5 py-3 font-semibold">Goal Reached</th>
                  <th className="text-left px-5 py-3 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id as string} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors">
                    <td className="px-5 py-3 text-[var(--text-1)] font-mono">{phoneByNumberId.get(c.campaign_number_id as string) || "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{(c.status as string) || "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{c.duration_seconds != null ? `${c.duration_seconds}s` : "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{c.goal_reached === true ? "Yes" : c.goal_reached === false ? "No" : "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-3)]">{c.created_at ? new Date(c.created_at as string).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "settings" && (
          <div className="p-5 sm:p-6 grid gap-5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Vapi Assistant</h3>
              <p className="text-sm text-[var(--text-1)] font-medium">{(campaign.vapi_assistant_name as string) || "—"}</p>
              <p className="text-xs text-[var(--text-3)] font-mono mt-1">{(campaign.vapi_assistant_id as string) || "—"}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Call Windows</h3>
              <pre className="whitespace-pre-wrap text-sm text-[var(--text-2)] bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4 font-mono text-xs max-h-48 overflow-y-auto">
                {JSON.stringify(campaign.call_windows, null, 2)}
              </pre>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Max Attempts</h3>
                <p className="text-sm text-[var(--text-2)]">{(campaign.max_attempts as number) ?? "—"}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Retry Interval</h3>
                <p className="text-sm text-[var(--text-2)]">{campaign.retry_interval_minutes ? `${campaign.retry_interval_minutes} min` : "—"}</p>
              </div>
            </div>
            {Boolean(campaign.sms_enabled) && Boolean(campaign.sms_template) && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">SMS Template</h3>
                <pre className="whitespace-pre-wrap text-sm text-[var(--text-2)] bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
                  {String(campaign.sms_template ?? "")}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
