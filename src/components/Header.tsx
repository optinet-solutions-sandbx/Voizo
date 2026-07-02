"use client";

// Global top bar (hybrid nav, 2026-06-16). Left: page title. Center: global search. Right:
// context-aware primary action · notifications · account menu (theme toggle lives in there).
// The sidebar is now nav-only. Desktop only — mobile keeps the Sidebar's MobileTopBar/BottomNav.

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import GlobalSearch from "@/components/GlobalSearch";
import NotificationBell from "@/components/NotificationBell";
import AccountMenu from "@/components/AccountMenu";
import { primaryActionFor } from "@/lib/navPrimaryAction";

const TITLES: { match: (p: string) => boolean; title: string }[] = [
  { match: (p) => p.startsWith("/dashboard"), title: "Dashboard" },
  { match: (p) => p.startsWith("/activity"), title: "Live Activity" },
  { match: (p) => p.startsWith("/workers"), title: "Workers" },
  { match: (p) => p.startsWith("/campaigns"), title: "Campaigns" },
  { match: (p) => p.startsWith("/reviews"), title: "Reviews" },
  { match: (p) => p.startsWith("/audience"), title: "Audience" },
  { match: (p) => p.startsWith("/do-not-call"), title: "Do Not Call" },
  { match: (p) => p.startsWith("/knowledge-bases"), title: "Knowledge Bases" },
  { match: (p) => p.startsWith("/phone-numbers"), title: "Phone Numbers" },
  { match: (p) => p.startsWith("/analytics"), title: "Analytics" },
  { match: (p) => p.startsWith("/app-center"), title: "App Center" },
  { match: (p) => p.startsWith("/settings"), title: "Settings" },
  { match: (p) => p.startsWith("/deleted-history"), title: "Deleted History" },
];

function titleFor(pathname: string): string {
  for (const t of TITLES) if (t.match(pathname)) return t.title;
  return "Dashboard";
}

export default function Header() {
  const pathname = usePathname();
  const pageTitle = titleFor(pathname);
  const action = primaryActionFor(pathname);

  return (
    <header className="hidden md:flex items-center gap-4 px-6 h-[57px] bg-[var(--bg-sidebar)] border-b border-[var(--border)] flex-shrink-0">
      <h1 className="text-sm font-semibold text-[var(--text-1)] shrink-0">{pageTitle}</h1>

      <div className="flex-1 flex justify-center">
        <div className="w-full max-w-xl">
          <GlobalSearch />
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {action && (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary hover:bg-primary text-white text-xs font-medium transition-colors shadow-sm shadow-primary/20"
          >
            <Plus size={14} /> {action.label}
          </Link>
        )}
        <NotificationBell />
        <AccountMenu />
      </div>
    </header>
  );
}
