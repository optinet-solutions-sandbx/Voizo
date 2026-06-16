// Context-aware primary action for the global top bar. Maps the current route to its main
// "create" action; returns null where there's no obvious one (the button hides). Add a rule
// per section as their create routes are confirmed.

export interface PrimaryAction {
  label: string;
  href: string;
}

const RULES: { match: (pathname: string) => boolean; action: PrimaryAction }[] = [
  // Campaigns list + a campaign detail page → "New Campaign" (the create wizard).
  // Hidden on the wizard itself to avoid a redundant CTA.
  {
    match: (p) => p.startsWith("/campaigns") && p !== "/campaigns/v2/new",
    action: { label: "New Campaign", href: "/campaigns/v2/new" },
  },
];

export function primaryActionFor(pathname: string): PrimaryAction | null {
  for (const rule of RULES) if (rule.match(pathname)) return rule.action;
  return null;
}
