"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { HistoryIcon, XIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";
import {
  apiTokenProblem,
  apiTokenStatusNote,
  AUDIT_ACTION_LABEL,
  AUDIT_LIMIT,
  type ApiTokenStatus,
  type AuditEntry,
} from "@/lib/api-token";
import { formatDateTime, formatTimestamp } from "@/lib/format";

/** How long "Igen" stays disabled after the confirmation opens. */
const CONFIRM_DELAY_SECONDS = 5;

const FIELD =
  "rounded-md border border-rule bg-page px-3 py-2 text-ink placeholder:text-ink-3 disabled:opacity-50";
const QUIET_BUTTON =
  "rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40";
const PRIMARY_BUTTON =
  "rounded-md bg-ink px-5 py-1.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-40";
const NESTED_DIALOG =
  "m-auto max-h-[calc(100dvh-2rem)] rounded-xl border border-rule bg-raised text-base text-ink shadow-2xl backdrop:bg-black/60";

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; status: ApiTokenStatus };

/**
 * The confirmation before a stored token is replaced. "Igen" only becomes
 * clickable after CONFIRM_DELAY_SECONDS, so a reflexive Enter cannot confirm it.
 * Mounted only while it is open.
 */
function ConfirmReplaceDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState(CONFIRM_DELAY_SECONDS);
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    // StrictMode runs this twice in development: the dialog is already open the second time.
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    const openedAt = Date.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, CONFIRM_DELAY_SECONDS - Math.floor((Date.now() - openedAt) / 1000));
      setSecondsLeft(left);
      if (left === 0) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      // Closed by either button or by Escape; only "Igen" sets `confirmed`.
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        if (confirmed.current) onConfirm();
        else onCancel();
      }}
      className={`w-[min(26rem,calc(100vw-2rem))] px-6 py-5 ${NESTED_DIALOG}`}
    >
      <h2 id={titleId} className="text-lg font-medium">
        Biztosan módosítod az API-tokent?
      </h2>
      <p id={textId} className="mt-2 text-sm leading-relaxed text-ink-2">
        A tárolt token felülíródik, és ezután a Telepítés oldal gombja az újat másolja. A módosítás az auditnaplóba
        kerül. Az „Igen” gomb {CONFIRM_DELAY_SECONDS} másodperc múlva válik aktívvá.
      </p>
      <div className="mt-6 flex justify-end gap-3">
        <button type="button" autoFocus onClick={() => dialogRef.current?.close()} className={QUIET_BUTTON}>
          Mégse
        </button>
        <button
          type="button"
          disabled={secondsLeft > 0}
          onClick={() => {
            confirmed.current = true;
            dialogRef.current?.close();
          }}
          className={`min-w-28 tabular-nums ${PRIMARY_BUTTON}`}
        >
          {secondsLeft > 0 ? `Igen (${secondsLeft})` : "Igen"}
        </button>
      </div>
    </dialog>
  );
}

type AuditLoad =
  | { phase: "loading" }
  | { phase: "failed"; expired: boolean }
  | { phase: "ready"; entries: AuditEntry[]; currentSession: string | null };

/** Who saved or fetched the token, newest first, in a scrolling list. Mounted only while it is open. */
function AuditDialog({ timeZone, onClose }: { timeZone: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<AuditLoad>({ phase: "loading" });
  const titleId = useId();

  useEffect(() => {
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    let cancelled = false;
    fetch("/api/api-token/audit", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { entries: AuditEntry[]; currentSession: string | null };
        if (!cancelled) setLoad({ phase: "ready", ...payload });
      })
      .catch((status: unknown) => {
        if (!cancelled) setLoad({ phase: "failed", expired: status === 401 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={`w-[min(40rem,calc(100vw-2rem))] flex-col open:flex ${NESTED_DIALOG}`}
    >
      <header className="flex items-center justify-between gap-4 px-6 pt-5">
        <h2 id={titleId} className="text-lg font-medium">
          API-token auditnapló
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Bezárás"
          className="-mr-2 rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
        >
          <XIcon />
        </button>
      </header>
      <p className="px-6 pt-1.5 text-sm leading-relaxed text-ink-3">
        Mikor és melyik böngészőből adták hozzá, módosították vagy kérték le a tokent. A legfrissebb elöl; az utolsó{" "}
        {AUDIT_LIMIT} esemény marad meg. Időpontok {timeZone} idő szerint.
      </p>

      <div
        tabIndex={0}
        aria-label="Auditbejegyzések"
        className="code-scroll mx-6 mb-6 mt-4 min-h-24 grow overflow-y-auto overscroll-contain rounded-lg border border-hairline"
      >
        {load.phase === "loading" ? (
          <p className="px-4 py-4 text-sm text-ink-3">Betöltés…</p>
        ) : load.phase === "failed" ? (
          <p className="px-4 py-4 text-sm text-ink-2">
            {load.expired
              ? "A munkamenet lejárt. Lépj be újra a PIN-kóddal."
              : "A napló nem tölthető be: az adattár most nem érhető el."}
          </p>
        ) : load.entries.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-3">Még nincs bejegyzés.</p>
        ) : (
          <ol role="list" className="divide-y divide-hairline">
            {load.entries.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="px-3.5 py-3 sm:px-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <time dateTime={new Date(entry.at).toISOString()} className="text-sm tabular-nums text-ink sm:text-base">
                    {formatTimestamp(entry.at, timeZone)}
                  </time>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      entry.action === "revealed" ? "border-rule text-ink-2" : "border-ink-3 text-ink"
                    }`}
                  >
                    {AUDIT_ACTION_LABEL[entry.action]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-2">
                  {entry.browser}
                  {entry.os && ` · ${entry.os}`}
                  {entry.session !== null && entry.session === load.currentSession && (
                    <span className="text-ink-3"> · ez a böngésző</span>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-ink-3 wrap-anywhere">
                  IP {entry.ip}
                  {entry.session && <> · munkamenet {entry.session}</>}
                </p>
                {entry.userAgent && (
                  <p className="mt-1 font-mono text-xs leading-relaxed text-ink-3 wrap-anywhere">{entry.userAgent}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </dialog>
  );
}

/**
 * The settings panel's API-token section. The token field belongs to the
 * panel's draft (so the panel's own save can tell it was left unsaved), but it
 * is saved by its own button, to its own endpoint: never with the rest.
 */
export function ApiTokenSettings({
  headingId,
  value,
  onChange,
  timeZone,
}: {
  headingId: string;
  value: string;
  onChange: (value: string) => void;
  timeZone: string;
}) {
  const t = useTranslations("Settings");
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** The token waiting for the "are you sure" answer. */
  const [pending, setPending] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const inputId = useId();
  const noteId = useId();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/api-token", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { status: ApiTokenStatus };
        if (!cancelled) setLoad({ phase: "ready", status: payload.status });
      })
      .catch(() => {
        if (!cancelled) setLoad({ phase: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = load.phase === "ready" ? load.status : null;
  const noKey = status?.state === "no_key";
  const hasStored = status?.state === "stored" || status?.state === "unreadable";

  async function save(token: string) {
    setSaving(true);
    setProblem(null);
    setNotice(null);
    try {
      const response = await fetch("/api/api-token", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && payload) {
        setLoad({ phase: "ready", status: payload.status as ApiTokenStatus });
        onChange("");
        setNotice(payload.action === "created" ? t("token_saved") : t("token_modified"));
      } else if (response.status === 401) {
        setProblem(t("session_expired"));
      } else if (response.status === 500 && payload?.error === "encryption_key_missing") {
        setLoad({ phase: "ready", status: { state: "no_key" } });
      } else if (response.status === 400) {
        setProblem(t("token_rejected"));
      } else {
        setProblem(t("store_unavailable"));
      }
    } catch {
      setProblem(t("server_did_not_respond"));
    } finally {
      setSaving(false);
    }
  }

  function requestSave() {
    const token = value.trim();
    const tokenProblem = apiTokenProblem(token);
    setNotice(null);
    setProblem(tokenProblem);
    if (tokenProblem || noKey) return;
    // Only a first token goes straight in; replacing one (or one whose state is unknown) asks first.
    if (status?.state === "empty") void save(token);
    else setPending(token);
  }

  const statusNote = status ? apiTokenStatusNote(status) : null;
  const updatedAt = status && "updatedAt" in status ? status.updatedAt : null;

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h3 id={headingId} className="font-medium">
          API-token
        </h3>
        <button
          type="button"
          onClick={() => setAuditOpen(true)}
          aria-haspopup="dialog"
          className={`flex items-center gap-2 text-sm ${QUIET_BUTTON}`}
        >
          <HistoryIcon />
          Audit
        </button>
      </div>

      <div id={noteId} className="space-y-1.5">
        {load.phase === "loading" ? (
          <p className="text-sm text-ink-3">Állapot betöltése…</p>
        ) : load.phase === "failed" ? (
          <StatusLine tone="problem">Az állapot nem tölthető be: az adattár most nem érhető el.</StatusLine>
        ) : (
          statusNote && (
            <StatusLine tone={statusNote.tone}>
              {statusNote.text}
              {updatedAt !== null && <> Utoljára mentve: {formatDateTime(updatedAt, timeZone)}.</>}
            </StatusLine>
          )
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label htmlFor={inputId} className="sr-only">
          {hasStored ? "Új API-token" : "API-token"}
        </label>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={600}
          placeholder={hasStored ? "Új token a régi helyére" : t("server_token_placeholder")}
          value={value}
          disabled={noKey}
          onChange={(event) => {
            onChange(event.target.value);
            setProblem(null);
            setNotice(null);
          }}
          onKeyDown={(event) => {
            // Enter saves the token; it must not submit the whole settings form.
            if (event.key !== "Enter") return;
            event.preventDefault();
            requestSave();
          }}
          aria-describedby={noteId}
          aria-invalid={problem !== null || undefined}
          className={`min-w-0 grow font-mono text-sm ${FIELD}`}
        />
        <button
          type="button"
          onClick={requestSave}
          disabled={saving || noKey || load.phase === "loading"}
          className={`shrink-0 self-end sm:self-auto ${QUIET_BUTTON}`}
        >
          {saving ? t("saving") : hasStored ? t("modify_token") : t("add_token")}
        </button>
      </div>

      <div aria-live="polite">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {notice && <StatusLine tone="good">{notice}</StatusLine>}
      </div>

      <p className="text-sm text-ink-3">
        A Telepítés oldal másológombja ezt adja vissza. AES-256-GCM-mel titkosítva kerül az adattárba, és soha
        nem jelenik meg az oldalon; minden mentés és lekérés az auditnaplóba kerül. A kliensek továbbra is a
        szerver <code className="text-ink-2">USAGE_API_TOKEN</code>-jével azonosítanak: ez csak a másolatuk.
      </p>

      {pending !== null && (
        <ConfirmReplaceDialog
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const token = pending;
            setPending(null);
            void save(token);
          }}
        />
      )}
      {auditOpen && <AuditDialog timeZone={timeZone} onClose={() => setAuditOpen(false)} />}
    </section>
  );
}
