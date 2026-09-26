"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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

/**
 * Sudo mode's unlock form: shown wherever a copy failed with `sudo_required`
 * (token-copy-button.tsx, the one-shot route's command copy). Confirming the
 * PIN here only grants the 5-minute window; it does not retry the copy
 * itself — a fresh click is what keeps the clipboard permission on Safari.
 */
export function SudoUnlock({ onUnlocked }: { onUnlocked: () => void }) {
  const t = useTranslations("Setup");
  const tAuth = useTranslations("Auth");
  const numeric = useNumericHint();
  const [pin, setPin] = useState("");
  const [reveal, setReveal] = useState(false);
  const [state, setState] = useState<UnlockState>({ phase: "idle" });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ phase: "busy" });

    let response: Response;
    try {
      response = await fetch("/api/auth/sudo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
        cache: "no-store",
      });
    } catch {
      setState({ phase: "error", message: t("sudo_error_generic") });
      return;
    }

    if (response.status === 204) {
      setPin("");
      setState({ phase: "idle" });
      onUnlocked();
      return;
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      attemptsLeft?: number;
      retryAfterSeconds?: number;
    } | null;
    if (response.status === 401 && payload?.error === "sudo_invalid") {
      setState({ phase: "error", message: tAuth("pin_invalid", { attemptsLeft: payload.attemptsLeft ?? 0 }) });
    } else if (response.status === 429) {
      const minutes = Math.max(1, Math.ceil((payload?.retryAfterSeconds ?? 60) / 60));
      setState({ phase: "error", message: tAuth("rate_limited", { minutes }) });
    } else {
      setState({ phase: "error", message: t("sudo_error_generic") });
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-2.5 rounded-md border border-rule bg-raised p-3.5"
    >
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
          {state.phase === "busy" ? t("sudo_unlocking") : t("sudo_unlock")}
        </button>
      </div>
      <div aria-live="polite">{state.phase === "error" && <StatusLine tone="problem">{state.message}</StatusLine>}</div>
    </form>
  );
}
