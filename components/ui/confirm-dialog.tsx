"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { NESTED_DIALOG, PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";

const DANGER_BUTTON =
  "rounded-md bg-critical px-5 py-1.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-40";

/**
 * A yes/no confirmation, generalised from the token-replace prompt: any
 * title, body and confirm label, an optional destructive style, and an
 * optional delay before the confirm button may be pressed (a reflexive Enter
 * must not confirm it). Mounted only while it is open.
 *
 * With `stayOpenOnConfirm` the confirm button runs `onConfirm` without closing:
 * the caller carries the action out inside the dialog (asking for the PIN in
 * `children` when it has to) and closes it by unmounting it.
 */
export function ConfirmDialog({
  title,
  body,
  cancelLabel,
  confirmLabel,
  danger = false,
  countdownSeconds = 0,
  onCancel,
  onConfirm,
  stayOpenOnConfirm = false,
  busy = false,
  confirmDisabled = false,
  children,
}: {
  title: ReactNode;
  body: ReactNode;
  cancelLabel: ReactNode;
  /** Called on every tick with the seconds left (0 once the button may be pressed), for its own label. */
  confirmLabel: (secondsLeft: number) => ReactNode;
  /** Styles the confirm button for a destructive action. */
  danger?: boolean;
  /** The confirm button stays disabled for this many seconds after the dialog opens. */
  countdownSeconds?: number;
  onCancel: () => void;
  onConfirm: () => void;
  stayOpenOnConfirm?: boolean;
  /** The action is running: neither button nor Escape does anything. */
  busy?: boolean;
  confirmDisabled?: boolean;
  /** Shown under the body, e.g. the PIN prompt of an action that needs one. */
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmed = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState(countdownSeconds);
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    // StrictMode runs this twice in development: the dialog is already open the second time.
    if (dialogRef.current && !dialogRef.current.open) dialogRef.current.showModal();
    if (countdownSeconds <= 0) return;
    const openedAt = Date.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, countdownSeconds - Math.floor((Date.now() - openedAt) / 1000));
      setSecondsLeft(left);
      if (left === 0) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [countdownSeconds]);

  return (
    <dialog
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      // Closed by either button or by Escape; only the confirm button sets `confirmed`.
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        if (confirmed.current) onConfirm();
        else onCancel();
      }}
      className={`w-[min(26rem,calc(100vw-2rem))] px-6 py-5 ${NESTED_DIALOG}`}
    >
      <h2 id={titleId} className="text-lg font-medium">
        {title}
      </h2>
      <p id={textId} className="mt-2 text-sm leading-relaxed text-ink-2">
        {body}
      </p>
      {children && <div className="mt-4">{children}</div>}
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          // biome-ignore lint/a11y/noAutofocus: the safe choice takes focus when the confirmation opens
          autoFocus
          disabled={busy}
          onClick={() => dialogRef.current?.close()}
          className={QUIET_BUTTON}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={secondsLeft > 0 || busy || confirmDisabled}
          onClick={() => {
            if (stayOpenOnConfirm) {
              onConfirm();
              return;
            }
            confirmed.current = true;
            dialogRef.current?.close();
          }}
          className={`min-w-28 tabular-nums ${danger ? DANGER_BUTTON : PRIMARY_BUTTON}`}
        >
          {confirmLabel(secondsLeft)}
        </button>
      </div>
    </dialog>
  );
}
