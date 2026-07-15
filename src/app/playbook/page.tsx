"use client";

import { useState } from "react";
import OrganizerTable from "@/components/lab/OrganizerTable";
import CollectionsManager from "@/components/lab/CollectionsManager";

// The campaign's knowledge base, on its own page: what the agent can say or
// match (Scenarios), and which bundle of it a campaign uses (Collections).
// Test-calling lives in the Listener Lab; flow-building in the Script Builder.
export default function PlaybookPage() {
  const [tab, setTab] = useState<"scenarios" | "collections">("scenarios");

  const tabCls = (on: boolean) =>
    `rounded-lg px-4 py-2 text-sm font-medium transition ${
      on ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
    }`;

  return (
    <div className="flex flex-col px-4 py-6 pb-[env(safe-area-inset-bottom)] sm:px-6 sm:py-8 space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-white">Playbook</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          Everything the agent can say or recognize. <strong>Scenarios</strong> are single moves — a
          situation, the line (or briefing) for it, and how it&rsquo;s delivered. <strong>Collections</strong>{" "}
          bundle the scenarios one campaign uses; the active collection scopes what the agent matches
          against on a call. Script boxes reference these — lines typed directly in the Script Builder
          land here automatically, tagged with the script&rsquo;s name.
        </p>
      </header>

      <div className="flex gap-2">
        <button onClick={() => setTab("scenarios")} className={tabCls(tab === "scenarios")}>
          Scenarios
        </button>
        <button onClick={() => setTab("collections")} className={tabCls(tab === "collections")}>
          Collections
        </button>
      </div>

      <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-4">
        {tab === "scenarios" ? <OrganizerTable /> : <CollectionsManager onActiveChange={() => {}} />}
      </div>
    </div>
  );
}
