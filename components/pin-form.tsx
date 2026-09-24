"use client";

import { useActionState, useRef } from "react";
import { login, type LoginState } from "@/app/actions";
import { StopCircleIcon } from "@/components/icons";

import { useTranslations } from "next-intl";

const INITIAL_STATE: LoginState = { error: null };

/** `labelledBy`: id of the heading that names the field. `next`: where a successful login continues. */
export function PinForm({ labelledBy, next }: { labelledBy: string; next: string }) {
  const t = useTranslations("Settings");
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
            <span>{state.error}</span>
          </>
        )}
      </p>
    </form>
  );
}
