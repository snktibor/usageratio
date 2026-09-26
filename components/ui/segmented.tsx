"use client";

import type { ReactNode } from "react";

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: ReactNode;
}

/**
 * A row of radio pills, exactly one always checked: the budget's period, a
 * sub-limit's mode, and the like. `name` must be unique among the radio
 * groups on the page (a `useId()` per instance is the usual choice).
 */
export function Segmented<Value extends string>({
  name,
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  name: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly SegmentedOption<Value>[];
  size?: "sm" | "md";
  className?: string;
}) {
  const padding = size === "sm" ? "px-3 py-1 text-sm" : "px-5 py-1.5";
  return (
    <div className={`inline-flex flex-wrap rounded-md border border-rule p-0.5 ${className ?? ""}`}>
      {options.map((option) => (
        <label
          key={option.value}
          className={`cursor-pointer rounded-[5px] text-ink-2 transition-colors has-[:checked]:bg-ink has-[:checked]:text-page has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${padding}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
