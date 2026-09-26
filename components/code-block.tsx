"use client";

import { useTranslations } from "next-intl";
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";
import { CopyError, type CopyErrorCode, copyText } from "@/components/clipboard";
import { CheckCircleIcon, CopyIcon } from "@/components/icons";
import { StatusLine } from "@/components/status-line";

/** A file path that wraps after its separators rather than in the middle of a name. */
export function BreakablePath({ path }: { path: string }) {
  return (
    <>
      {path.split(/(?<=[\\/])/).map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static path segments, never reordered
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

type CopyState = "idle" | "busy" | "copied" | "selected";

/**
 * Copies `text` to the clipboard. Where the browser refuses (an insecure
 * origin, a denied permission), it selects the shown code instead, so the
 * keyboard shortcut finishes the job. A `text` built at the click (one that
 * fetches a secret) is never stood in for by the shown code: its problem goes
 * to `onProblem` instead, with the code alongside the translated message so a
 * caller that cares (sudo mode) can tell `sudo_required` apart from the rest.
 */
function CopyButton({
  text,
  target,
  label,
  disabled = false,
  onProblem,
}: {
  text: string | (() => Promise<string>);
  target: RefObject<HTMLElement | null>;
  /** What is copied, for screen readers: "install.sh contents". */
  label: string;
  disabled?: boolean;
  onProblem?: (message: string | null, code: CopyErrorCode | null) => void;
}) {
  const t = useTranslations("Setup");
  const tCommon = useTranslations("Common");
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
    if (typeof text === "function") {
      if (timer.current !== null) window.clearTimeout(timer.current);
      setState("busy");
      onProblem?.(null, null);
      try {
        await copyText(text());
      } catch (error) {
        setState("idle");
        const code: CopyErrorCode = error instanceof CopyError ? error.code : "generic";
        // sudo_required has no text of its own: the caller shows the unlock form instead.
        onProblem?.(code === "sudo_required" ? null : t(`copy_problem_${code}`), code);
        return;
      }
    } else {
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
        disabled={disabled || state === "busy"}
        aria-label={tCommon("copy_aria_label", { label })}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rule px-2.5 py-1 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
      >
        {state === "copied" ? (
          <>
            <CheckCircleIcon className="text-good" />
            {tCommon("copied")}
          </>
        ) : state === "selected" ? (
          tCommon("copy_selected")
        ) : (
          <>
            <CopyIcon />
            {state === "busy" ? tCommon("copying") : tCommon("copy")}
          </>
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied"
          ? tCommon("copied_aria", { label })
          : state === "selected"
            ? tCommon("selected_aria", { label })
            : ""}
      </span>
    </>
  );
}

/**
 * A command to paste into a terminal, with its copy button. Long commands wrap
 * instead of scrolling: a command cut off at the edge looks complete when it is not.
 *
 * With `resolve`, the shown command is only a preview: the button copies what
 * `resolve` builds at the click (a command with a secret in it), and a failed
 * build is told under the block. `onProblem`, when given, also hears about it
 * (with the code) — the setup route uses it to show the sudo unlock form.
 */
export function CommandBlock({
  command,
  label,
  resolve,
  disabled = false,
  onProblem,
}: {
  command: string;
  label: string;
  resolve?: () => Promise<string>;
  disabled?: boolean;
  onProblem?: (message: string | null, code: CopyErrorCode | null) => void;
}) {
  const tCommon = useTranslations("Common");
  const code = useRef<HTMLElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const handleProblem = (message: string | null, problemCode: CopyErrorCode | null) => {
    setProblem(message);
    onProblem?.(message, problemCode);
  };
  const block = (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-raised py-1.5 pl-4 pr-1.5 sm:flex-row sm:items-start sm:gap-3">
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role and aria-label are set together, only when the block scrolls */}
      <pre
        className={`min-w-0 grow py-1 pr-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink wrap-anywhere sm:pr-0 ${resolve ? "code-scroll max-h-80 overflow-y-auto" : ""}`}
        role={resolve ? "region" : undefined}
        tabIndex={resolve ? 0 : undefined}
        aria-label={resolve ? tCommon("preview_aria", { label }) : undefined}
      >
        <code ref={code}>{command}</code>
      </pre>
      <div className="self-end sm:self-auto">
        <CopyButton
          text={resolve ?? command}
          target={code}
          label={label}
          disabled={disabled}
          onProblem={handleProblem}
        />
      </div>
    </div>
  );
  if (!resolve) return block;
  return (
    <div className="space-y-2.5">
      {block}
      <div aria-live="polite">{problem && <StatusLine tone="problem">{problem}</StatusLine>}</div>
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
  const t = useTranslations("Setup");
  const code = useRef<HTMLElement>(null);
  const contentLabel = t("file_content_aria", { name });
  return (
    <article aria-label={name} className="overflow-hidden rounded-lg border border-rule">
      <header className="px-4 pb-3.5 pt-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <h3 className="min-w-0 pt-0.5 font-mono text-[15px] font-medium text-ink wrap-anywhere">{name}</h3>
          <CopyButton text={content ?? ""} target={code} label={contentLabel} disabled={content === null} />
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-2">{role}</p>
        <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-ink-3">{t("file_save_label")}</dt>
          <dd className="min-w-0 font-mono text-[13px] text-ink-2 wrap-anywhere">{saveCommand}</dd>
          <dt className="text-ink-3">{t("file_installed_label")}</dt>
          <dd className="min-w-0 text-ink-2 wrap-anywhere">
            {installedAs ? (
              <span className="font-mono text-[13px]">
                <BreakablePath path={installedAs} />
              </span>
            ) : (
              t("file_not_installed")
            )}
          </dd>
        </dl>
      </header>
      {content === null ? (
        <p className="border-t border-rule bg-raised px-4 py-4 text-sm text-ink-2 sm:px-5">{unavailable}</p>
      ) : (
        <pre
          role="region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be focusable so keyboard users can scroll it
          tabIndex={0}
          aria-label={contentLabel}
          className="code-scroll max-h-64 overflow-auto border-t border-rule bg-raised px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink-2 sm:px-5"
        >
          <code ref={code}>{content}</code>
        </pre>
      )}
    </article>
  );
}
