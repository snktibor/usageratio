"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { CopyError, type CopyErrorCode, copyText, fetchApiToken } from "@/components/clipboard";
import { CheckCircleIcon, KeyIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import { type ApiTokenStatus, apiTokenStatusNote } from "@/lib/api-token";

type CopyState = { phase: "idle" } | { phase: "busy" } | { phase: "copied" } | { phase: "failed"; code: CopyErrorCode };

/**
 * The setup page's "copy the API token" button. The token is never part of
 * the page: it is fetched from the server on the click, and that fetch is audited.
 */
export function TokenCopyButton({ status }: { status: ApiTokenStatus }) {
  const t = useTranslations("Setup");
  const tCommon = useTranslations("Common");
  const tSettings = useTranslations("Settings");
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
      setState({ phase: "failed", code: error instanceof CopyError ? error.code : "generic" });
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
              {t("token_on_clipboard")}
            </>
          ) : (
            <>
              <KeyIcon />
              {state.phase === "busy" ? tCommon("copying") : t("copy_token")}
            </>
          )}
        </button>
        {available && <span className="text-sm text-ink-3">{t("audit_notice")}</span>}
      </div>
      <div aria-live="polite">
        {state.phase === "failed" ? (
          <StatusLine tone="problem">{t(`copy_problem_${state.code}`)}</StatusLine>
        ) : state.phase === "copied" ? (
          <span className="sr-only">{t("token_on_clipboard_hidden")}</span>
        ) : null}
      </div>
      {!available || note.tone === "warning" ? (
        <StatusLine tone={note.tone}>
          {tSettings(note.key)}
          {status.state === "empty" || status.state === "unreadable" ? t("provide_in_settings") : ""}
        </StatusLine>
      ) : null}
    </div>
  );
}
