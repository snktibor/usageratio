"use client";

import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { CheckCircleIcon, CopyIcon } from "@/components/icons";

/** A file path that wraps after its separators rather than in the middle of a name. */
export function BreakablePath({ path }: { path: string }) {
  return (
    <>
      {path.split(/(?<=[\\/])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

type CopyState = "idle" | "copied" | "selected";

/**
 * Copies `text` to the clipboard. Where the browser refuses (an insecure
 * origin, a denied permission), it selects the shown code instead, so the
 * keyboard shortcut finishes the job.
 */
function CopyButton({
  text,
  target,
  label,
  disabled = false,
}: {
  text: string;
  target: RefObject<HTMLElement | null>;
  /** What is copied, for screen readers: "install.sh tartalma". */
  label: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "selected";
      const code = target.current;
      const selection = window.getSelection();
      if (code && selection) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), next === "copied" ? 2000 : 6000);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        disabled={disabled}
        aria-label={`${label} másolása`}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule px-2.5 py-1 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        {state === "copied" ? (
          <>
            <CheckCircleIcon className="text-good" />
            Másolva
          </>
        ) : state === "selected" ? (
          "Kijelölve: Ctrl+C / ⌘C"
        ) : (
          <>
            <CopyIcon />
            Másolás
          </>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? `${label} a vágólapon.` : state === "selected" ? `${label} kijelölve.` : ""}
      </span>
    </>
  );
}

/**
 * A command to paste into a terminal, with its copy button. Long commands wrap
 * instead of scrolling: a command cut off at the edge looks complete when it is not.
 */
export function CommandBlock({ command, label }: { command: string; label: string }) {
  const code = useRef<HTMLElement>(null);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-raised py-1.5 pl-4 pr-1.5 sm:flex-row sm:items-start sm:gap-3">
      <pre className="min-w-0 grow py-1 pr-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink wrap-anywhere sm:pr-0">
        <code ref={code}>{command}</code>
      </pre>
      <div className="self-end sm:self-auto">
        <CopyButton text={command} target={code} label={label} />
      </div>
    </div>
  );
}

/** One file of a package: what it is for, how to save it, and its whole content. */
export function FileBlock({
  name,
  role,
  saveCommand,
  installedAs,
  content,
  unavailable,
}: {
  name: string;
  role: string;
  saveCommand: string;
  installedAs: string | null;
  /** Null while the fields that produce it are invalid. */
  content: string | null;
  /** Shown instead of the content while it is null. */
  unavailable?: string;
}) {
  const code = useRef<HTMLElement>(null);
  return (
    <article aria-label={name} className="overflow-hidden rounded-lg border border-rule">
      <header className="px-4 pb-3.5 pt-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <h3 className="min-w-0 pt-0.5 font-mono text-[15px] font-medium text-ink wrap-anywhere">{name}</h3>
          <CopyButton text={content ?? ""} target={code} label={`${name} tartalma`} disabled={content === null} />
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{role}</p>
        <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-ink-3">Mentés</dt>
          <dd className="min-w-0 font-mono text-[13px] text-ink-2 wrap-anywhere">{saveCommand}</dd>
          <dt className="text-ink-3">Végleges helye</dt>
          <dd className="min-w-0 text-ink-2 wrap-anywhere">
            {installedAs ? (
              <span className="font-mono text-[13px]">
                <BreakablePath path={installedAs} />
              </span>
            ) : (
              "nem települ, csak egyszer fut"
            )}
          </dd>
        </dl>
      </header>
      {content === null ? (
        <p className="border-t border-rule bg-raised px-4 py-4 text-sm text-ink-2 sm:px-5">{unavailable}</p>
      ) : (
        <pre
          tabIndex={0}
          aria-label={`${name} tartalma`}
          className="code-scroll max-h-64 overflow-auto border-t border-rule bg-raised px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2 sm:px-5"
        >
          <code ref={code}>{content}</code>
        </pre>
      )}
    </article>
  );
}
