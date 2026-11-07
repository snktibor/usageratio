import { postForToken } from "@/components/clipboard";
import { setupTokenLabel } from "@/lib/setup";

/**
 * Multi-tenant mode: the setup page's way to a token, since there is no shared one. Each machine
 * gets its own ingest token, bound to it (POST /api/tokens, which needs sudo and goes on the audit
 * trail). One per machine and visit: copying the one-off command twice, downloading the package
 * and then copying the command, or a double click, all get the token issued the first time; the
 * request itself is what is kept, so overlapping calls share it. A failed request is forgotten.
 */

const issued = new Map<string, Promise<string>>();

export function issueMachineToken(machineId: string): Promise<string> {
  const pending = issued.get(machineId);
  if (pending) return pending;
  const request = postForToken(
    "/api/tokens",
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: setupTokenLabel(machineId), machineId, scope: "ingest" }),
    },
    { 422: "too_many_tokens" },
  );
  issued.set(machineId, request);
  request.catch(() => issued.delete(machineId));
  return request;
}

/** A new visit of the setup page starts afresh: a token revoked meanwhile is never handed out again. */
export function forgetIssuedTokens(): void {
  issued.clear();
}
