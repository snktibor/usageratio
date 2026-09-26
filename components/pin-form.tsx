"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef, useState } from "react";
import { type LoginError, type LoginState, login } from "@/app/actions";
import { StopCircleIcon } from "@/components/icons";
import type { Translator } from "@/lib/i18n";

const INITIAL_STATE: LoginState = { error: null };

/**
 * The failure code from the server action, in the visitor's language. Named
 * `tAuth` like the caller's variable: `t` is the `HomePage` translator in this file.
 */
function errorText(tAuth: Translator<"Auth">, error: LoginError): string {
  switch (error.code) {
    case "malformed":
      return tAuth("pin_malformed");
    case "misconfigured":
      return tAuth("pin_misconfigured");
    case "storage_not_configured":
      return tAuth("storage_not_configured");
    case "storage_unavailable":
      return tAuth("storage_unavailable");
    case "rate_limited":
      return tAuth("rate_limited", { minutes: Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60)) });
    case "invalid":
      return tAuth("pin_invalid", { attemptsLeft: error.attemptsLeft ?? 0 });
  }
}

/**
 * `labelledBy`: id of the heading that names the field. `next`: where a
 * successful login continues. `numeric`: the configured PIN is digits only,
 * so a numeric keypad and digit filtering help; otherwise this is a plain
 * passphrase field with a show/hide toggle. `autoSubmitLength`: only set when
 * the owner opted into DASHBOARD_PIN_AUTOSUBMIT=1 — submitting on the Nth
 * keystroke would otherwise reveal the PIN's length to anyone watching.
 */
export function PinForm({
  labelledBy,
  next,
  numeric,
  autoSubmitLength,
}: {
  labelledBy: string;
  next: string;
  numeric: boolean;
  autoSubmitLength?: number | null;
}) {
  const t = useTranslations("HomePage");
  const tAuth = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);
  const formRef = useRef<HTMLFormElement>(null);
  const [reveal, setReveal] = useState(false);

  return (
    <form ref={formRef} action={formAction} className="mt-10 max-w-xs">
      {/* Lets password managers file the PIN under a recognisable account name. */}
      <input type="text" name="username" autoComplete="username" defaultValue="usageratio" readOnly hidden />
      <input type="hidden" name="next" value={next} />

      <div className="flex items-stretch gap-2">
        <input
          id="pin"
          name="pin"
          type={numeric || !reveal ? "password" : "text"}
          inputMode={numeric ? "numeric" : undefined}
          autoComplete="current-password"
          minLength={5}
          placeholder={numeric ? "•••••" : undefined}
          required
          // biome-ignore lint/a11y/noAutofocus: the PIN field is the page's only control
          autoFocus
          aria-labelledby={labelledBy}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "pin-error" : undefined}
          onChange={(event) => {
            const input = event.currentTarget;
            if (numeric) input.value = input.value.replace(/\D/g, "");
            if (autoSubmitLength && input.value.length === autoSubmitLength && !pending) {
              formRef.current?.requestSubmit();
            }
          }}
          className={`block w-full min-w-0 grow rounded-md border border-rule bg-raised px-4 py-3 text-ink placeholder:text-rule ${numeric ? "text-3xl tracking-[0.5em]" : "text-lg"}`}
        />
        {!numeric && (
          <button
            type="button"
            onClick={() => setReveal((value) => !value)}
            className="shrink-0 rounded-md border border-rule px-3 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            {reveal ? tAuth("pin_hide") : tAuth("pin_show")}
          </button>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-4 w-full rounded-md bg-ink px-4 py-3 text-base font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? t("pin_checking") : t("pin_login")}
      </button>

      <p id="pin-error" role="alert" className="mt-4 flex min-h-12 items-start gap-2.5 text-sm text-ink">
        {state.error && (
          <>
            <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
            <span>{errorText(tAuth, state.error)}</span>
          </>
        )}
      </p>
    </form>
  );
}
