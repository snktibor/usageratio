"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CommandBlock } from "@/components/code-block";
import { DownloadIcon } from "@/components/icons";
import { panelId, tabId } from "@/components/setup/route-tabs";
import { Code, Step, TokenNote } from "@/components/setup/steps";
import type { ApiTokenStatus } from "@/lib/api-token";
import { type SetupMode, type SetupOs, zipInstallCommand } from "@/lib/setup";

/** The "download the ZIP" route: the package button, then the terminal or double-click steps. */
export function ZipRoute({
  tabsId,
  hidden,
  os,
  mode,
  name,
  zipHref,
  tokenStatus,
}: {
  tabsId: string;
  hidden: boolean;
  os: SetupOs;
  mode: SetupMode;
  name: string;
  /** Null while the group or machine field is invalid. */
  zipHref: string | null;
  tokenStatus: ApiTokenStatus;
}) {
  const t = useTranslations("Setup");
  const headingId = panelId(tabsId, "zip");
  const unix = os !== "windows";

  return (
    <div
      role="tabpanel"
      id={panelId(tabsId, "zip")}
      aria-labelledby={tabId(tabsId, "zip")}
      hidden={hidden}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern, the panel takes focus after its tab
      tabIndex={0}
      className="mt-8"
    >
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="text-2xl font-semibold tracking-tight">
          {t("download_zip")}
        </h2>
        <p className="mt-2 max-w-2xl text-ink-2">{t("zip_desc")}</p>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
          {zipHref ? (
            <a
              href={zipHref}
              className="inline-flex items-center gap-2.5 rounded-md bg-ink px-5 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
            >
              <DownloadIcon />
              {t("download_package")}
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2.5 rounded-md bg-ink px-5 py-2.5 font-medium text-page opacity-40"
            >
              <DownloadIcon />
              {t("download_package")}
            </button>
          )}
          <span className="font-mono text-sm text-ink-3 wrap-anywhere">{name}.zip</span>
        </div>
        {!zipHref && <p className="mt-3 text-sm text-ink-3">{t("fix_group_machine")}</p>}

        {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
        <ol role="list" className="mt-8 max-w-2xl space-y-6">
          {unix ? (
            <>
              <Step number={1}>
                <p>{t.rich("zip_step_1_unix", { name, Code: (chunks: ReactNode) => <Code>{chunks}</Code> })}</p>
              </Step>
              <Step number={2}>
                <p>{t("zip_step_2_unix")}</p>
                <CommandBlock command={zipInstallCommand(os, mode)} label={t("installer_command")} />
                <p className="text-sm text-ink-3">
                  {t.rich("zip_step_2_unix_alt", { Code: (chunks: ReactNode) => <Code>{chunks}</Code> })}
                </p>
              </Step>
            </>
          ) : (
            <>
              <Step number={1}>
                <p>
                  {t.rich("zip_step_1_win", {
                    strong: (chunks: ReactNode) => <strong className="font-medium text-ink">{chunks}</strong>,
                  })}
                </p>
              </Step>
              <Step number={2}>
                <p>
                  {t.rich("zip_step_2_win", {
                    auto: mode === "auto" ? "true" : "false",
                    Code: (chunks: ReactNode) => <Code>{chunks}</Code>,
                  })}
                </p>
                <p className="text-sm text-ink-3">{t("start_from_powershell")}</p>
                <CommandBlock command={zipInstallCommand(os, mode)} label={t("installer_command")} />
              </Step>
            </>
          )}
          <Step number={3}>
            <TokenNote os={os} mode={mode} tokenStatus={tokenStatus} />
          </Step>
        </ol>
      </section>
    </div>
  );
}
