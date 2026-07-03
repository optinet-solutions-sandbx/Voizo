// shadcn's class combiner — clsx for conditionals + tailwind-merge so later classes
// win over earlier conflicting utilities. Upgraded from the dependency-free join
// (2026-07-02, shadcn infra): a strict superset — existing icon callers that pass
// plain strings/falsy values get identical output.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
