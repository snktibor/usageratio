"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { CopyError, type CopyErrorCode } from "@/components/clipboard";
import { CommandBlock } from "@/components/code-block";
import { DownloadIcon } from "@/components/icons";
import { issueMachineToken } from "@/components/setup/machine-token";
import { panelId, tabId } from "@/components/setup/route-tabs";
import { richCode, Step, TokenNote } from "@/components/setup/steps";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import type { ApiTokenStatus } from "@/lib/api-token";
import { type SetupMode, type SetupOs, zipInstallCommand } from "@/lib/setup";

/** What the multi-tenant package download posts (app/api/setup POST). */
export interface PackageRequest {
  os: SetupOs;
  mode: SetupMode;
  group: string;
  machine: string;
  locale: string;
}

type DownloadState = "idle" | "busy" | "sudo" | { problem: Exclude<CopyErrorCode, "sudo_required"> };

/**
 * Gets the machine's token (issued once per machine and visit, machine-token.ts), posts for the
 * package that carries it, and saves the answer as a file, the way a link to it would.
 */
async function downloadPackage(request: PackageRequest, fileName: string): Promise<DownloadState> {
  try {
    const token = await issueMachineToken(request.machine);
    let response: Response;
    try {
      response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...request, token }),
      });
    } catch {
      return { problem: "no_response" };
    }
    if (!response.ok) return { problem: response.status === 401 ? "session_expired" : "generic" };
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fileName}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return "idle";
  } catch (error) {
    const code = error instanceof CopyError ? error.code : "generic";
    return code === "sudo_required" ? "sudo" : { problem: code };
  }
}

/**
 * The "download the ZIP" route: the package button, then the terminal or double-click steps. In
 * multi-tenant mode the package is posted for (`packageRequest`), with a fresh token for the
 * machine inside, so the installer asks for nothing.
 */
export function ZipRoute({
  tabsId,
  hidden,
  os,
  mode,
  name,
  zipHref,
  tokenStatus,
  packageRequest = null,
  multiTenant = false,
}: {
  tabsId: string;
  hidden: boolean;
  os: SetupOs;
  mode: SetupMode;
  name: string;
  /** Null while the group or machine field is invalid. */
  zipHref: string | null;
  tokenStatus: ApiTokenStatus;
  /** Multi-tenant mode: what to post for the package; null while a field is invalid. */
  packageRequest?: PackageRequest | null;
  multiTenant?: boolean;
}) {
  const t = useTranslations("Setup");
  const [download, setDownload] = useState<DownloadState>("idle");

  async function postForPackage() {
    if (!packageRequest) return;
    setDownload("busy");
    setDownload(await downloadPackage(packageRequest, name));
  }
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
        <p className="mt-2 max-w-2xl text-ink-2">{multiTenant ? t("zip_desc_multi") : t("zip_desc")}</p>

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
          {multiTenant ? (
            <button
              type="button"
              onClick={postForPackage}
              disabled={!packageRequest || download === "busy"}
              className="inline-flex items-center gap-2.5 rounded-md bg-ink px-5 py-2.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <DownloadIcon />
              {t("download_package")}
            </button>
          ) : zipHref ? (
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
        {(multiTenant ? !packageRequest : !zipHref) && (
          <p className="mt-3 text-sm text-ink-3">{t("fix_group_machine")}</p>
        )}
        <div aria-live="polite" className="mt-3 max-w-2xl space-y-3">
          {download === "sudo" && <SudoUnlock onUnlocked={postForPackage} />}
          {typeof download === "object" && (
            <StatusLine tone="problem">
              {download.problem === "generic" ? t("package_download_failed") : t(`copy_problem_${download.problem}`)}
            </StatusLine>
          )}
        </div>

        {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
        <ol role="list" className="mt-8 max-w-2xl space-y-6">
          {unix ? (
            <>
              <Step number={1}>
                <p>{t.rich("zip_step_1_unix", { name, Code: richCode })}</p>
              </Step>
              <Step number={2}>
                <p>{t("zip_step_2_unix")}</p>
                <CommandBlock command={zipInstallCommand(os, mode)} label={t("installer_command")} />
                <p className="text-sm text-ink-3">{t.rich("zip_step_2_unix_alt", { Code: richCode })}</p>
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
                    Code: richCode,
                  })}
                </p>
                <p className="text-sm text-ink-3">{t("start_from_powershell")}</p>
                <CommandBlock command={zipInstallCommand(os, mode)} label={t("installer_command")} />
              </Step>
            </>
          )}
          <Step number={3}>
            {multiTenant ? (
              <p>{t("zip_token_included")}</p>
            ) : (
              <TokenNote os={os} mode={mode} tokenStatus={tokenStatus} />
            )}
          </Step>
        </ol>
      </section>
    </div>
  );
}
