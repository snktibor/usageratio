/** A copy that failed for a reason worth telling as is. */
export class CopyError extends Error {}

/** The API token from the server; every call is one entry on the audit trail. */
export async function fetchApiToken(): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/api-token/reveal", { method: "POST", cache: "no-store" });
  } catch {
    throw new CopyError("A szerver nem válaszolt. Ellenőrizd a kapcsolatot, és próbáld újra.");
  }
  const payload = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (response.ok && typeof payload?.token === "string") return payload.token;
  switch (response.status) {
    case 401:
      throw new CopyError("A munkamenet lejárt. Töltsd újra az oldalt, és lépj be a PIN-kóddal.");
    case 404:
      throw new CopyError("Nincs tárolt token. A dashboard Beállítások paneljén adhatod meg.");
    case 409:
      throw new CopyError("A tárolt token nem fejthető vissza. Add meg újra a Beállítások panelen.");
    case 500:
      throw new CopyError("A szerveren nincs érvényes TOKEN_ENCRYPTION_KEY.");
    default:
      throw new CopyError("Az adattár most nem érhető el. Próbáld újra kicsit később.");
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
    throw new CopyError("Ez a böngésző itt nem enged a vágólapra írni (csak HTTPS-en működik).");
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    throw new CopyError("A böngésző nem engedte a vágólapra írást. Kattints újra az oldalon, és próbáld megint.");
  }
}
