"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { CopyError, type CopyErrorCode, copyText } from "@/components/clipboard";
import { StatusLine } from "@/components/status-line";

type UnlockState = { phase: "idle" } | { phase: "busy" } | { phase: "error"; message: string };

/** GET /api/auth/sudo: whether the configured PIN is digits only, for the numeric keypad. */
function useNumericHint(): boolean {
  const [numeric, setNumeric] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/sudo", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { numeric?: unknown } | null) => {
        if (!cancelled && typeof payload?.numeric === "boolean") setNumeric(payload.numeric);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return numeric;
}

/** The PIN was not accepted; the message is already the one to show. */
class SudoRefused extends Error {}

/**
 * Sudo mode's unlock form: shown wherever an action or a copy failed with
 * `sudo_required`. Confirming the PIN grants the 5-minute window.
 *
 * With `copy` (token-copy-button.tsx, the one-shot route's command copy), the
 * submit also finishes the copy: `copyText` is started inside the submit, on
 * a promise that first unlocks and then builds the text, so the clipboard
 * write stays within the user's gesture, as Safari requires.
 */
export function SudoUnlock({
  onUnlocked,
  copy,
  onCopyFailed,
}: {
  /** After the PIN is accepted; with `copy`, once the text is on the clipboard too. */
  onUnlocked: () => void;
  /** Builds the text to copy, once the PIN is accepted. */
  copy?: () => Promise<string>;
  /** A copy that failed after the PIN was accepted. */
  onCopyFailed?: (code: CopyErrorCode) => void;
}) {
  const t = useTranslations("Setup");
  const tAuth = useTranslations("Auth");
  const numeric = useNumericHint();
  const [pin, setPin] = useState("");
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState<UnlockState>({ phase: "idle" });

  /** POST /api/auth/sudo; rejects with a SudoRefused when the PIN is not accepted. */
  async function unlock(): Promise<void> {
    let response: Response;
    try {
      response = await fetch("/api/auth/sudo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
        cache: "no-store",
      });
    } catch {
      throw new SudoRefused(t("sudo_error_generic"));
    }
    if (response.status === 204) return;

    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      attemptsLeft?: number;
      retryAfterSeconds?: number;
    } | null;
    if (response.status === 401 && payload?.error === "sudo_invalid") {
      throw new SudoRefused(tAuth("pin_invalid", { attemptsLeft: payload.attemptsLeft ?? 0 }));
    }
    if (response.status === 429) {
      const minutes = Math.max(1, Math.ceil((payload?.retryAfterSeconds ?? 60) / 60));
      throw new SudoRefused(tAuth("rate_limited", { minutes }));
    }
    throw new SudoRefused(t("sudo_error_generic"));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ phase: "busy" });
    // No await before copyText: the clipboard write has to start inside this submit.
    const unlocked = unlock();
    const done = copy ? copyText(unlocked.then(copy)) : unlocked;
    done.then(
      () => {
        setPin("");
        setState({ phase: "idle" });
        onUnlocked();
      },
      (error: unknown) => {
        if (error instanceof SudoRefused) {
          setState({ phase: "error", message: error.message });
          return;
        }
        setPin("");
        setState({ phase: "idle" });
        onCopyFailed?.(error instanceof CopyError ? error.code : "generic");
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 rounded-md border border-rule bg-raised p-3.5">
      <label htmlFor="sudo-pin" className="block text-sm text-ink-2">
        {t("sudo_prompt")}
      </label>
      <div className="flex items-center gap-2">
        <input
          id="sudo-pin"
          name="pin"
          type={numeric || !reveal ? "password" : "text"}
          inputMode={numeric ? "numeric" : undefined}
          autoComplete="current-password"
          minLength={5}
          required
          value={pin}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setPin(numeric ? value.replace(/\D/g, "") : value);
          }}
          className="min-w-0 grow rounded-md border border-rule bg-page px-3 py-1.5 text-ink"
        />
        {!numeric && (
          <button
            type="button"
            onClick={() => setReveal((value) => !value)}
            className="shrink-0 text-sm text-ink-2 transition-colors hover:text-ink"
          >
            {reveal ? tAuth("pin_hide") : tAuth("pin_show")}
          </button>
        )}
        <button
          type="submit"
          disabled={state.phase === "busy" || pin.length === 0}
          className="shrink-0 rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {state.phase === "busy" ? t("sudo_unlocking") : copy ? t("sudo_unlock_copy") : t("sudo_unlock")}
        </button>
      </div>
      <div aria-live="polite">{state.phase === "error" && <StatusLine tone="problem">{state.message}</StatusLine>}</div>
    </form>
  );
}
