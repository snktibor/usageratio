"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CommandBlock, FileBlock } from "@/components/code-block";
import { panelId, tabId } from "@/components/setup/route-tabs";
import { Code, Step, TokenNote } from "@/components/setup/steps";
import type { ApiTokenStatus } from "@/lib/api-token";
import {
  type ClientSources,
  folderCommand,
  installerCommand,
  type MachineSettings,
  type PackageFile,
  renderConfig,
  type SetupMode,
  type SetupOs,
  saveCommand,
} from "@/lib/setup";

/** The "copy and create the files by hand" route: no download, same package contents. */
export function ManualRoute({
  tabsId,
  hidden,
  os,
  mode,
  files,
  sources,
  settings,
  tokenStatus,
}: {
  tabsId: string;
  hidden: boolean;
  os: SetupOs;
  mode: SetupMode;
  files: PackageFile[];
  sources: ClientSources;
  /** Null while the group or machine field is invalid. */
  settings: MachineSettings | null;
  tokenStatus: ApiTokenStatus;
}) {
  const t = useTranslations("Setup");
  const headingId = panelId(tabsId, "manual");
  const unix = os !== "windows";

  return (
    <div
      role="tabpanel"
      id={panelId(tabsId, "manual")}
      aria-labelledby={tabId(tabsId, "manual")}
      hidden={hidden}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern, the panel takes focus after its tab
      tabIndex={0}
      className="mt-8"
    >
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="text-2xl font-semibold tracking-tight">
          {t("copy_and_create")}
        </h2>
        <p className="mt-2 max-w-2xl text-ink-2">{t("copy_desc", { count: files.length })}</p>

        {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
        <ol role="list" className="mt-8 space-y-10">
          <Step number={1}>
            <p className="max-w-2xl">{unix ? t("manual_step_1_unix") : t("manual_step_1_win")}</p>
            <CommandBlock command={folderCommand(os)} label={t("folder_command")} />
          </Step>
          <Step number={2}>
            <p className="max-w-2xl">
              {os === "linux"
                ? t.rich("manual_step_2_linux", { Code: (chunks: ReactNode) => <Code>{chunks}</Code> })
                : t.rich("manual_step_2_win_mac", {
                    os,
                    strong: (chunks: ReactNode) => <strong className="font-medium text-ink">{chunks}</strong>,
                  })}
            </p>
            <div className="space-y-4 pt-1">
              {files.map((file) => (
                <FileBlock
                  key={file.name}
                  name={file.name}
                  role={t(file.roleKey)}
                  saveCommand={saveCommand(os, file.name)}
                  installedAs={file.installedAs}
                  content={file.source ? sources[file.source] : settings && renderConfig(os, settings)}
                  unavailable={t("fix_group_machine")}
                />
              ))}
            </div>
          </Step>
          <Step number={3}>
            <p>{t("run_installer_same_folder")}</p>
            <CommandBlock command={installerCommand(os)} label={t("installer_command")} />
            <TokenNote os={os} mode={mode} tokenStatus={tokenStatus} />
          </Step>
        </ol>
      </section>
    </div>
  );
}
