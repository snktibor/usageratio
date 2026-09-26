"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BreakablePath, CommandBlock } from "@/components/code-block";
import { Code } from "@/components/setup/steps";
import { INSTALLED_CONFIG, LOG_FILE, type SetupMode, type SetupOs, uninstallCommand } from "@/lib/setup";

/** The collapsed "Information" section: prerequisite, token, update, log and uninstall notes. */
export function SetupNotes({ os, mode, notesId }: { os: SetupOs; mode: SetupMode; notesId: string }) {
  const t = useTranslations("Setup");
  const unix = os !== "windows";

  return (
    <details className="mt-20 border-t border-hairline pt-8">
      <summary id={notesId} className="w-fit cursor-pointer text-sm text-ink-3 transition-colors hover:text-ink">
        {t("info")}
      </summary>
      <dl className="mt-5 grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-5 text-sm leading-relaxed sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-ink-3">{t("prerequisite")}</dt>
        <dd className="text-ink-2">
          {t.rich("prerequisite_desc", { Code: (chunks: ReactNode) => <Code>{chunks}</Code> })}
        </dd>

        <dt className="text-ink-3">{t("token")}</dt>
        <dd className="text-ink-2">
          {t.rich("token_desc", {
            mac: INSTALLED_CONFIG.macos,
            win: INSTALLED_CONFIG.windows,
            Code: (chunks: ReactNode) => <Code>{chunks}</Code>,
            BreakablePath: () => <BreakablePath path={INSTALLED_CONFIG.windows} />,
            strong: (chunks: ReactNode) => <strong className="font-medium text-ink">{chunks}</strong>,
          })}
        </dd>

        <dt className="text-ink-3">{t("update")}</dt>
        <dd className="text-ink-2">{t("update_desc")}</dd>

        <dt className="text-ink-3">{t("log")}</dt>
        <dd className="text-ink-2">
          <Code>
            <BreakablePath path={LOG_FILE[os]} />
          </Code>
        </dd>

        <dt className="text-ink-3">{t("uninstall")}</dt>
        <dd className="space-y-2 text-ink-2">
          <CommandBlock command={uninstallCommand(os, mode)} label={t("uninstall_command")} />
          {unix && mode === "manual" && (
            <p>{t.rich("uninstall_unix_manual", { Code: (chunks: ReactNode) => <Code>{chunks}</Code> })}</p>
          )}
          {os === "windows" && mode === "auto" && <p>{t("uninstall_win_auto")}</p>}
        </dd>
      </dl>
    </details>
  );
}
