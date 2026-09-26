/** A copy problem's reason, worth telling apart: components translate it as `Setup.copy_problem_<code>`. */
export type CopyErrorCode =
  | "no_response"
  | "session_expired"
  | "no_token"
  | "token_unreadable"
  | "no_key"
  | "storage_unavailable"
  | "insecure_context"
  | "permission_denied"
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

/** The API token from the server; every call is one entry on the audit trail. */
export async function fetchApiToken(): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/api-token/reveal", { method: "POST", cache: "no-store" });
  } catch {
    throw new CopyError("no_response");
  }
  const payload = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (response.ok && typeof payload?.token === "string") return payload.token;
  switch (response.status) {
    case 401:
      throw new CopyError("session_expired");
    case 404:
      throw new CopyError("no_token");
    case 409:
      throw new CopyError("token_unreadable");
    case 500:
      throw new CopyError("no_key");
    default:
      throw new CopyError("storage_unavailable");
  }
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
