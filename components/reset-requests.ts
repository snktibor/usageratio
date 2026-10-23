/**
 * The dashboard's calls to /api/resets (app/api/resets/route.ts), and why one
 * failed: the route's own refusals, or the problems an official figure's save
 * can meet too (components/use-official-entry.ts).
 */

const REFUSALS = ["outside_cycle", "duplicate_reset", "has_later_resets", "not_revertable", "not_found"] as const;

export type ResetProblem = (typeof REFUSALS)[number] | "unauthorized" | "rejected" | "storage" | "network";

export type ResetResult = { ok: true } | { ok: false; problem: ResetProblem };

export async function sendReset(
  method: "POST" | "PUT" | "DELETE",
  body: Record<string, unknown>,
): Promise<ResetResult> {
  let response: Response;
  try {
    response = await fetch("/api/resets", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, problem: "network" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, problem: "unauthorized" };
  if (response.status === 404 || response.status === 409) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const refusal = REFUSALS.find((code) => code === payload?.error);
    return { ok: false, problem: refusal ?? "rejected" };
  }
  // 400 a payload the route refused, 403 a foreign origin or the demo's read-only mode.
  if (response.status === 400 || response.status === 403) return { ok: false, problem: "rejected" };
  return { ok: false, problem: "storage" };
}
