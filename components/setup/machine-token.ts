import { CopyError } from "@/components/clipboard";

/**
 * Multi-tenant mode: the setup page's way to a token, since there is no shared one. Each machine
 * gets its own ingest token, bound to it (POST /api/tokens, which needs sudo and goes on the audit
 * trail). One per machine and page visit: copying the one-off command twice, or the token and then
 * the command, reuses the token issued the first time instead of minting another.
 */

const MAX_LABEL_LENGTH = 64;
const issued = new Map<string, string>();

export async function issueMachineToken(machineId: string): Promise<string> {
  const cached = issued.get(machineId);
  if (cached) return cached;
  let response: Response;
  try {
    response = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: `${machineId} (setup)`.slice(0, MAX_LABEL_LENGTH), machineId, scope: "ingest" }),
      cache: "no-store",
    });
  } catch {
    throw new CopyError("no_response");
  }
  const payload = (await response.json().catch(() => null)) as { token?: unknown; error?: unknown } | null;
  if (response.ok && typeof payload?.token === "string") {
    issued.set(machineId, payload.token);
    return payload.token;
  }
  if (response.status === 401) throw new CopyError("session_expired");
  if (response.status === 403 && payload?.error === "sudo_required") throw new CopyError("sudo_required");
  if (response.status === 422) throw new CopyError("too_many_tokens");
  throw new CopyError("storage_unavailable");
}

/** Tests: forgets the tokens issued so far. */
export function forgetIssuedTokens(): void {
  issued.clear();
}
