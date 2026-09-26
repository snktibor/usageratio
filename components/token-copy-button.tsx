"use client";

import { useEffect, useRef, useState } from "react";
import { CopyError, copyText, fetchApiToken } from "@/components/clipboard";
import { CheckCircleIcon, KeyIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import { type ApiTokenStatus, apiTokenStatusNote } from "@/lib/api-token";

type CopyState = { phase: "idle" } | { phase: "busy" } | { phase: "copied" } | { phase: "failed"; message: string };

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
      await copyText(fetchApiToken());
      setState({ phase: "copied" });
      timer.current = window.setTimeout(() => setState({ phase: "idle" }), 2500);
    } catch (error) {
      setState({
        phase: "failed",
        message: error instanceof CopyError ? error.message : "A másolás nem sikerült. Próbáld újra.",
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
          {status.state === "empty" || status.state === "unreadable"
            ? " A dashboard Beállítások paneljén adhatod meg."
            : ""}
        </StatusLine>
      ) : null}
    </div>
  );
}
