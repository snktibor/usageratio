"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircleIcon, KeyIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import { apiTokenStatusNote, type ApiTokenStatus } from "@/lib/api-token";

type CopyState =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "copied" }
  | { phase: "failed"; message: string };

class RevealError extends Error {}

/** The token from the server; every call is one entry on the audit trail. */
async function fetchToken(): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/api-token/reveal", { method: "POST", cache: "no-store" });
  } catch {
    throw new RevealError("A szerver nem válaszolt. Ellenőrizd a kapcsolatot, és próbáld újra.");
  }
  const payload = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (response.ok && typeof payload?.token === "string") return payload.token;
  switch (response.status) {
    case 401:
      throw new RevealError("A munkamenet lejárt. Töltsd újra az oldalt, és lépj be a PIN-kóddal.");
    case 404:
      throw new RevealError("Nincs tárolt token. A dashboard Beállítások paneljén adhatod meg.");
    case 409:
      throw new RevealError("A tárolt token nem fejthető vissza. Add meg újra a Beállítások panelen.");
    case 500:
      throw new RevealError("A szerveren nincs érvényes TOKEN_ENCRYPTION_KEY.");
    default:
      throw new RevealError("Az adattár most nem érhető el. Próbáld újra kicsit később.");
  }
}

/**
 * Puts the token on the clipboard. The ClipboardItem route is taken first:
 * Safari only lets a page write the clipboard inside the click, and there the
 * item may still be waiting for the server's answer. Where that route is
 * missing or refused, the plain write gets the same (single) answer.
 */
async function copyToken(): Promise<void> {
  const token = fetchToken();
  token.catch(() => {}); // reported by whichever route awaits it

  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = token.then((text) => new Blob([text], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // A server problem surfaces below; anything else gets one more try with writeText.
    }
  }
  const text = await token;
  if (!navigator.clipboard?.writeText) {
    throw new RevealError("Ez a böngésző itt nem enged a vágólapra írni (csak HTTPS-en működik).");
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new RevealError("A böngésző nem engedte a vágólapra írást. Kattints újra az oldalon, és próbáld megint.");
  }
}

/**
 * The setup page's "copy the API token" button. The token is never part of
 * the page: it is fetched from the server on the click, and that fetch is audited.
 */
export function TokenCopyButton({ status }: { status: ApiTokenStatus }) {
  const [state, setState] = useState<CopyState>({ phase: "idle" });
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setState({ phase: "busy" });
    try {
      await copyToken();
      setState({ phase: "copied" });
      timer.current = window.setTimeout(() => setState({ phase: "idle" }), 2500);
    } catch (error) {
      setState({
        phase: "failed",
        message: error instanceof RevealError ? error.message : "A másolás nem sikerült. Próbáld újra.",
      });
    }
  }

  const available = status.state === "stored";
  const note = apiTokenStatusNote(status);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!available || state.phase === "busy"}
          className="inline-flex items-center gap-2 rounded-md border border-rule px-3.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          {state.phase === "copied" ? (
            <>
              <CheckCircleIcon className="text-good" />
              Token a vágólapon
            </>
          ) : (
            <>
              <KeyIcon />
              {state.phase === "busy" ? "Másolás…" : "Token másolása"}
            </>
          )}
        </button>
        {available && <span className="text-sm text-ink-3">A lekérés az auditnaplóba kerül.</span>}
      </div>
      <div aria-live="polite">
        {state.phase === "failed" ? (
          <StatusLine tone="problem">{state.message}</StatusLine>
        ) : state.phase === "copied" ? (
          <span className="sr-only">A token a vágólapon.</span>
        ) : null}
      </div>
      {!available || note.tone === "warning" ? (
        <StatusLine tone={note.tone}>
          {note.text}
          {status.state === "empty" || status.state === "unreadable" ? " A dashboard Beállítások paneljén adhatod meg." : ""}
        </StatusLine>
      ) : null}
    </div>
  );
}
