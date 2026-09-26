"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { fetchApiToken } from "@/components/clipboard";
import { CommandBlock } from "@/components/code-block";
import { InfoTip } from "@/components/info-tip";
import { panelId, tabId } from "@/components/setup/route-tabs";
import { Segmented } from "@/components/setup/steps";
import { StatusLine } from "@/components/status-line";
import { type ApiTokenStatus, apiTokenStatusNote } from "@/lib/api-token";
import {
  CCUSAGE_RUNNERS,
  type CcusageRunner,
  type MachineSettings,
  type OneShotBlobs,
  renderOneShot,
  type SetupOs,
} from "@/lib/setup";

/**
 * The one-off report: a single command that sends one report and leaves
 * nothing behind. The page only shows a preview; the command with the real
 * token is built in the click that copies it, like the token-copy button.
 */
export function OneShotRoute({
  tabsId,
  hidden,
  os,
  settings,
  draft,
  tokenStatus,
  blobs,
}: {
  tabsId: string;
  hidden: boolean;
  os: SetupOs;
  /** Null while the group or machine field is invalid. */
  settings: MachineSettings | null;
  /** The fields as typed, for the preview while they are invalid. */
  draft: MachineSettings;
  tokenStatus: ApiTokenStatus;
  blobs: OneShotBlobs;
}) {
  const t = useTranslations("Setup");
  const tSettings = useTranslations("Settings");
  const headingId = panelId(tabsId, "oneShot");
  const [runner, setRunner] = useState<CcusageRunner>("global");
  const available = tokenStatus.state === "stored";
  const note = apiTokenStatusNote(tokenStatus);
  const packedNote = (name: string, blob: string) => t("packed_note", { name, lines: blob.split("\n").length });
  const preview = renderOneShot(os, runner, settings ?? draft, t("token_placeholder"), {
    parser: packedNote("ccusage-providers.cjs", blobs.parser),
    unixCore: packedNote("report-usage-core.sh", blobs.unixCore),
    windowsCore: packedNote("report-usage-core.ps1", blobs.windowsCore),
  });
  const build = async () => {
    if (!settings) throw new Error("invalid settings");
    return renderOneShot(os, runner, settings, await fetchApiToken(), blobs);
  };

  return (
    <div
      role="tabpanel"
      id={panelId(tabsId, "oneShot")}
      aria-labelledby={tabId(tabsId, "oneShot")}
      hidden={hidden}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern, the panel takes focus after its tab
      tabIndex={0}
      className="mt-8"
    >
      <section aria-labelledby={headingId}>
        <div className="relative flex items-center gap-1.5">
          <h2 id={headingId} className="text-2xl font-semibold tracking-tight">
            {t("one_shot_heading")}
          </h2>
          <InfoTip label={t("one_shot_tooltip_aria")}>
            <span className="block">{t("one_shot_tooltip_1")}</span>
            <span className="block">{t("one_shot_tooltip_2")}</span>
            <span className="block text-ink">{t("one_shot_tooltip_3")}</span>
          </InfoTip>
        </div>
        <p className="mt-2 max-w-2xl text-ink-2">{t("one_shot_desc")}</p>

        <div className="mt-6">
          <Segmented
            legend={t("runner_legend")}
            name="runner"
            value={runner}
            options={CCUSAGE_RUNNERS}
            labels={{ global: t("runner_global"), npx: t("runner_npx") }}
            onChange={setRunner}
          />
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">{t(`runner_${runner}_desc`)}</p>
        </div>

        <div className="mt-6 max-w-2xl space-y-3 leading-relaxed">
          <p>{os === "windows" ? t("copy_powershell") : t("copy_terminal")}</p>
          <CommandBlock
            command={preview}
            label={t("one_shot_command")}
            resolve={build}
            disabled={!settings || !available}
          />
          {!settings ? (
            <p className="text-sm text-ink-3">{t("fix_group_machine")}</p>
          ) : available ? (
            <p className="text-sm text-ink-3">{t("copy_fetches_token")}</p>
          ) : null}
          {!available || note.tone === "warning" ? (
            <StatusLine tone={note.tone}>
              {tSettings(note.key)}
              {tokenStatus.state === "empty" || tokenStatus.state === "unreadable" ? t("provide_in_settings") : ""}
            </StatusLine>
          ) : null}
        </div>
      </section>
    </div>
  );
}
