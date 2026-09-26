"use client";

import { useEffect, useId, useRef, useState } from "react";
import { InfoCircleIcon } from "@/components/icons";

/**
 * An (i) button with an explanation that shows on hover and on keyboard focus.
 * A click (or a tap, where there is no hover) keeps it open until a click
 * elsewhere; Escape hides it. The tip is placed against the nearest positioned
 * ancestor, so a long text takes the width of the heading row, not the icon's.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  // null: hover and focus decide; true: kept open by a click; false: dismissed.
  const [forced, setForced] = useState<boolean | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setForced(false);
    }
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setForced(null);
    }
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  const visibility =
    forced === true
      ? "visible opacity-100"
      : forced === false
        ? "invisible opacity-0"
        : "invisible opacity-0 group-hover/tip:visible group-hover/tip:opacity-100 group-has-[:focus-visible]/tip:visible group-has-[:focus-visible]/tip:opacity-100";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only notices the pointer or focus leaving the tip; the button inside is the control
    <span
      ref={root}
      className="group/tip inline-flex"
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && forced === false) setForced(null);
      }}
      onFocus={() => setForced((value) => (value === false ? null : value))}
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) setForced(null);
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={forced === true}
        onClick={() => setForced((value) => value !== true)}
        className="rounded-full p-1 text-ink-3 transition-colors hover:text-ink focus-visible:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-expanded:text-ink"
      >
        <InfoCircleIcon />
      </button>
      {/* Padding, not margin: the pointer can cross to the tip without leaving the hover. */}
      <span role="tooltip" id={id} className={`absolute inset-x-0 top-full z-10 pt-2 transition-opacity ${visibility}`}>
        <span className="block max-w-2xl space-y-2 rounded-md bg-raised px-4 py-3 text-sm leading-relaxed text-ink-2 shadow-lg ring-1 ring-white/10">
          {children}
        </span>
      </span>
    </span>
  );
}
