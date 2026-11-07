/** A copy problem's reason, worth telling apart: components translate it as `Setup.copy_problem_<code>`. */
export type CopyErrorCode =
  | "no_response"
  | "session_expired"
  | "sudo_required"
  | "no_token"
  | "token_unreadable"
  | "no_key"
  | "storage_unavailable"
  | "insecure_context"
  | "permission_denied"
  | "too_many_tokens"
  | "generic";

/** A copy that failed for a reason worth telling apart. */
export class CopyError extends Error {
  readonly code: CopyErrorCode;

  constructor(code: CopyErrorCode) {
    super(code);
    this.name = "CopyError";
    this.code = code;
  }
}

/**
 * Posts to an endpoint that answers with a token (`{ "token" }`), and turns a refusal into a
 * CopyError: the statuses every such endpoint shares, then `byStatus` for its own.
 */
export async function postForToken(
  url: string,
  init: RequestInit,
  byStatus: Partial<Record<number, CopyErrorCode>> = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", cache: "no-store", ...init });
  } catch {
    throw new CopyError("no_response");
  }
  const payload = (await response.json().catch(() => null)) as { token?: unknown; error?: unknown } | null;
  if (response.ok && typeof payload?.token === "string") return payload.token;
  if (response.status === 401) throw new CopyError("session_expired");
  if (response.status === 403 && payload?.error === "sudo_required") throw new CopyError("sudo_required");
  throw new CopyError(byStatus[response.status] ?? "storage_unavailable");
}

/** The API token from the server; every call is one entry on the audit trail. */
export function fetchApiToken(): Promise<string> {
  return postForToken("/api/api-token/reveal", {}, { 404: "no_token", 409: "token_unreadable", 500: "no_key" });
}

/**
 * Puts text that is still on its way on the clipboard. The ClipboardItem route
 * is taken first: Safari only lets a page write the clipboard inside the click,
 * and there the item may still be waiting for the server's answer. Where that
 * route is missing or refused, the plain write gets the same (single) answer.
 */
export async function copyText(text: Promise<string>): Promise<void> {
  text.catch(() => {}); // reported by whichever route awaits it

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // A server problem surfaces below; anything else gets one more try with writeText.
    }
  }
  const value = await text;
  if (!navigator.clipboard?.writeText) {
    throw new CopyError("insecure_context");
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new CopyError("permission_denied");
  }
}
