"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import OrganizerTable from "@/components/lab/OrganizerTable";
import CollectionsManager from "@/components/lab/CollectionsManager";
import { SectionTick } from "@/app/analytics/SectionIsland";

// The campaign's knowledge base, on its own page: what the agent can say or
// match (Scenarios), and which bundle of it a campaign uses (Collections).
// Test-calling lives in the Listener Lab; flow-building in the Script Builder.
export default function PlaybookPage() {
  const [tab, setTab] = useState<"scenarios" | "collections">("scenarios");

  const tabCls = (on: boolean) =>
    `px-3.5 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap ${
      on ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
    }`;

  return (
    <div className="p-4 w-full max-w-[1200px] mx-auto grid gap-4">
      <Link
        href="/script-builder"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-[var(--text-3)] transition hover:text-[var(--text-1)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Script Builder
      </Link>

      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <SectionTick color="#4d90f0" />
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">Playbook</h1>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-[var(--text-3)]">
          Everything the agent can say or recognize. <strong className="text-[var(--text-2)]">Scenarios</strong> are
          single moves — a situation, the line (or briefing) for it, and how it&rsquo;s delivered.{" "}
          <strong className="text-[var(--text-2)]">Collections</strong> bundle the scenarios one campaign uses; the
          active collection scopes what the agent matches against on a call. Script boxes reference these — lines typed
          directly in the Script Builder land here automatically, tagged with the script&rsquo;s name.
        </p>
      </div>

      {/* Tabs — same pill group as the campaigns toolbar filters */}
      <div className="flex w-fit gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl">
        <button onClick={() => setTab("scenarios")} className={tabCls(tab === "scenarios")}>
          Scenarios
        </button>
        <button onClick={() => setTab("collections")} className={tabCls(tab === "collections")}>
          Collections
        </button>
      </div>

      {tab === "scenarios" ? <OrganizerTable /> : <CollectionsManager onActiveChange={() => {}} />}
    </div>
  );
}
