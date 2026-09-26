"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "@/components/icons";

/** A pill that switches something on (filled, with a tick) or off (outlined). */
export function ToggleChip({
  checked,
  onChange,
  disabled = false,
  title,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <label title={title} className="relative">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="flex cursor-pointer items-center gap-1.5 rounded-full border border-rule px-3 py-1 text-sm text-ink-3 transition-colors hover:border-ink-3 hover:text-ink peer-checked:border-ink peer-checked:bg-ink peer-checked:text-page peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink peer-disabled:cursor-not-allowed peer-disabled:hover:border-ink">
        {checked && <CheckIcon className="-ml-0.5 size-3.5 shrink-0" />}
        {children}
      </span>
    </label>
  );
}
