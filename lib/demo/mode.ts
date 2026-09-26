/**
 * Demo mode (`DEMO_MODE=1`): the dashboard runs on an in-memory store seeded
 * with synthetic data, needs no PIN, and refuses every write. Meant for local
 * exploration, screenshots and end-to-end tests; never for a real deployment.
 */
export const isDemoMode = (): boolean => process.env.DEMO_MODE === "1";

/**
 * The response a mutating endpoint returns in demo mode instead of doing its
 * work; null otherwise. Built here rather than with `lib/http.ts`'s helper
 * because that module imports the store, which imports this one.
 */
export function demoReadOnly(): Response | null {
  if (!isDemoMode()) return null;
  return Response.json({ error: "demo_read_only" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
