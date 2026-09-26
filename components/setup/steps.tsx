"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { TokenCopyButton } from "@/components/token-copy-button";
import type { ApiTokenStatus } from "@/lib/api-token";
import type { SetupMode, SetupOs } from "@/lib/setup";

/** Small building blocks shared by the setup page's routes: a numbered step,
 * a segmented (radio-button) control, inline code, and the token prompt. */

export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.9em] text-ink wrap-anywhere">{children}</code>;
}

export function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  labels,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm text-ink-3">{legend}</legend>
      <div className="mt-1.5 inline-flex rounded-md border border-rule p-0.5">
        {options.map((option) => (
          <label
            key={option}
            className="cursor-pointer rounded-[5px] px-5 py-1.5 text-ink-2 transition-colors hover:text-ink has-[:checked]:bg-ink has-[:checked]:text-page has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="sr-only"
            />
            {labels[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-4">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-full border border-rule text-sm tabular-nums text-ink-2"
      >
        {number}
      </span>
      <div className="space-y-3 pt-0.5 leading-relaxed">{children}</div>
    </li>
  );
}

export function TokenNote({ os, mode, tokenStatus }: { os: SetupOs; mode: SetupMode; tokenStatus: ApiTokenStatus }) {
  const t = useTranslations("Setup");
  return (
    <>
      <p>
        {t.rich("token_note", {
          auto: os === "windows" && mode === "auto" ? "true" : "false",
          Code: (chunks: ReactNode) => <Code>{chunks}</Code>,
        })}
      </p>
      <TokenCopyButton status={tokenStatus} />
    </>
  );
}
