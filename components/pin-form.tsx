"use client";

import { useTranslations } from "next-intl";
import { useActionState, useRef } from "react";
import { type LoginError, type LoginState, login } from "@/app/actions";
import { StopCircleIcon } from "@/components/icons";
import type { Translator } from "@/lib/i18n";

const INITIAL_STATE: LoginState = { error: null };

/** How long an address stays locked out after its last allowed guess (lib/auth.ts). */
const LOCKOUT_MINUTES = 15;

/**
 * The failure code from the server action, in the visitor's language.
 *
 * The parameter is named `tAuth`, matching the caller's variable: the
 * messages test statically scans for `<name>("key")` calls and resolves the
 * namespace from a `const <name> = useTranslations("Namespace")` binding
 * found anywhere in this file — a parameter called `t` would be misread as
 * the `HomePage` translator declared below in `PinForm`.
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
    case "invalid": {
      const attemptsLeft = error.attemptsLeft ?? 0;
      return attemptsLeft > 0
        ? tAuth("pin_invalid", { attemptsLeft })
        : tAuth("pin_locked", { minutes: LOCKOUT_MINUTES });
    }
  }
}

/** `labelledBy`: id of the heading that names the field. `next`: where a successful login continues. */
export function PinForm({ labelledBy, next }: { labelledBy: string; next: string }) {
  const t = useTranslations("HomePage");
  const tAuth = useTranslations("Auth");
  const [state, formAction, pending] = useActionState(login, INITIAL_STATE);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={formAction} className="mt-10 max-w-xs">
      {/* Lets password managers file the PIN under a recognisable account name. */}
      <input type="text" name="username" autoComplete="username" defaultValue="usageratio" readOnly hidden />
      <input type="hidden" name="next" value={next} />

      <input
        id="pin"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="current-password"
        pattern="[0-9]{5}"
        minLength={5}
        maxLength={5}
        placeholder="•••••"
        required
        // biome-ignore lint/a11y/noAutofocus: the PIN field is the page's only control
        autoFocus
        aria-labelledby={labelledBy}
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? "pin-error" : undefined}
        onInput={(event) => {
          const input = event.currentTarget;
          input.value = input.value.replace(/\D/g, "").slice(0, 5);
          // The fifth digit submits: nothing else can follow it.
          if (input.value.length === 5 && !pending) formRef.current?.requestSubmit();
        }}
        className="block w-full rounded-md border border-rule bg-raised px-4 py-3 text-3xl tracking-[0.5em] text-ink placeholder:text-rule"
      />

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
