// Parse a body as JSON, returning an empty object on parse failure.
// Centralizes the `await r.json().catch(() => ({}))` pattern that was inlined
// across UI fetch callsites and API route handlers.
//
// Accepts both Response (client-side fetch) and Request/NextRequest (server-side
// route handlers) since both expose `.json(): Promise<unknown>`.
//
// Returns `any` to preserve the original implicit-`any` behavior of those
// callsites (each accesses different fields polymorphically). Tightening to
// typed callsites is a separate audit pass; this extraction is mechanical.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody(r: Request | Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return {};
  }
}
