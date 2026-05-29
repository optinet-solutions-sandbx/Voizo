// Minimal className combiner used by the animated icon components.
// Intentionally dependency-free (no clsx/tailwind-merge) — the icons only ever
// pass a single className through. Expand later if real shadcn components arrive.
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
