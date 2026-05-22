// Parse a Response body as JSON, returning an empty object on parse failure.
// Centralizes the `await r.json().catch(() => ({}))` pattern that was inlined
// at ~10 callsites in campaigns/v2/[id]/page.tsx and audience/page.tsx.
//
// Returns `any` to preserve the original implicit-`any` behavior of those
// callsites (each accesses different fields polymorphically). Tightening to
// typed callsites is a separate audit pass; this extraction is mechanical.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody(r: Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return {};
  }
}
