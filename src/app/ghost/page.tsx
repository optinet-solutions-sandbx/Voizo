import { notFound } from "next/navigation";
import { ghostPortalEnabled } from "@/lib/ghost/ghostConfig";
import type { Metadata } from "next";
import GhostRunsClient from "./GhostRunsClient";

export const metadata: Metadata = {
  title: "GhostPortal · Voizo",
  description: "Internal operator control room for manual-upload voice-AI runs.",
};

// GhostPortal — internal Operator Control Room. Behind the global Basic-Auth
// middleware (NOT in PUBLIC_PATH_PREFIXES) and dark-launched behind the
// GHOST_PORTAL_ENABLED flag: when off, the route 404s (looks absent). The flag
// is server-only (no NEXT_PUBLIC_), so the gate must run per request.
export const dynamic = "force-dynamic";

export default function GhostPortalPage() {
  if (!ghostPortalEnabled()) notFound();
  return <GhostRunsClient />;
}
