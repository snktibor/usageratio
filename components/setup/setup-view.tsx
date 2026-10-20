"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeftIcon } from "@/components/icons";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ManualRoute } from "@/components/setup/manual-route";
import { OneShotRoute } from "@/components/setup/one-shot-route";
import { PackageSettings } from "@/components/setup/package-settings";
import { RouteTabs } from "@/components/setup/route-tabs";
import { SetupNotes } from "@/components/setup/setup-notes";
import { readSetupPrefs, writeSetupPrefs } from "@/components/setup/use-setup-prefs";
import { ZipRoute } from "@/components/setup/zip-route";
import { Link } from "@/i18n/routing";
import type { ApiTokenStatus } from "@/lib/api-token";
import {
  type ClientSources,
  checkMachineSettings,
  type InstallRoute,
  type OneShotBlobs,
  packageFiles,
  packageName,
  parseRoute,
  SETUP_OSES,
  type SetupMode,
  type SetupOs,
} from "@/lib/setup";

export interface SetupGroup {
  id: string;
  /** "#rrggbb" */
  color: string;
}

/**
 * The setup page: one choice of system and mode drives both routes, the ZIP
 * download and the files to copy, so the two always install the same thing.
 */
export function SetupView({
  initialOs,
  initialMode,
  initialRoute,
  apiUrl,
  groups,
  sources,
  oneShot,
  tokenStatus,
}: {
  initialOs: SetupOs;
  initialMode: SetupMode;
  initialRoute: InstallRoute;
  apiUrl: string;
  groups: SetupGroup[];
  sources: ClientSources;
  oneShot: OneShotBlobs;
  tokenStatus: ApiTokenStatus;
}) {
  const t = useTranslations("Setup");
  const locale = useLocale();
  const [os, setOs] = useState(initialOs);
  const [mode, setMode] = useState(initialMode);
  const [route, setRoute] = useState(initialRoute);
  const [group, setGroup] = useState(groups[0]?.id ?? "Personal");
  const [machine, setMachine] = useState("");
  const skipPrefsWrite = useRef(true);
  const ids = {
    group: useId(),
    groupNote: useId(),
    machine: useId(),
    machineNote: useId(),
    tabs: useId(),
    notes: useId(),
  };

  // Restores the client's last group/machine/tab choice, and its last os when the URL didn't ask for one explicitly.
  // Runs before the effect below rewrites the address, so it still sees the address the page was opened with.
  useEffect(() => {
    const saved = readSetupPrefs();
    if (saved) {
      const query = new URLSearchParams(window.location.search);
      if (!query.has("os") && saved.os && (SETUP_OSES as readonly string[]).includes(saved.os)) {
        setOs(saved.os as SetupOs);
      }
      if (!query.has("route")) {
        const savedRoute = parseRoute(saved.route);
        if (savedRoute) setRoute(savedRoute);
      }
      if (saved.group) setGroup(saved.group);
      if (saved.machine) setMachine(saved.machine);
    }
  }, []);

  // The choice stays in the address, so a reload or a saved link opens the same package and tab.
  useEffect(() => {
    window.history.replaceState(null, "", `?os=${os}&mode=${mode}&route=${route}`);
  }, [os, mode, route]);

  useEffect(() => {
    if (skipPrefsWrite.current) {
      skipPrefsWrite.current = false;
      return;
    }
    writeSetupPrefs({ os, route, group, machine });
  }, [os, route, group, machine]);

  const check = checkMachineSettings(group, machine);
  const settings = check.ok ? { apiUrl, groupId: check.groupId, machineId: check.machineId } : null;
  const files = packageFiles(os, mode).filter((file) => !file.zipOnly);
  const name = packageName(os, mode);
  const zipHref = settings
    ? `/api/setup?${new URLSearchParams({
        os,
        mode,
        group: settings.groupId,
        machine: settings.machineId,
        locale,
      })}`
    : null;

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            <ArrowLeftIcon />
            {t("back_to_dashboard")}
          </Link>
        </div>
      </header>

      <div className="mt-12 max-w-2xl sm:mt-16">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">{t("install_client")}</h1>
        <p className="mt-4 text-ink-2">{t("install_client_intro")}</p>
      </div>

      <PackageSettings
        os={os}
        setOs={setOs}
        mode={mode}
        setMode={setMode}
        group={group}
        setGroup={setGroup}
        machine={machine}
        setMachine={setMachine}
        groups={groups}
        check={check}
        ids={ids}
      />

      <div className="mt-14">
        <RouteTabs tabsId={ids.tabs} value={route} onChange={setRoute} />

        <ZipRoute
          tabsId={ids.tabs}
          hidden={route !== "zip"}
          os={os}
          mode={mode}
          name={name}
          zipHref={zipHref}
          tokenStatus={tokenStatus}
        />
        <ManualRoute
          tabsId={ids.tabs}
          hidden={route !== "manual"}
          os={os}
          mode={mode}
          files={files}
          sources={sources}
          settings={settings}
          tokenStatus={tokenStatus}
        />
        <OneShotRoute
          tabsId={ids.tabs}
          hidden={route !== "oneShot"}
          os={os}
          settings={settings}
          draft={{ apiUrl, groupId: group.trim(), machineId: machine.trim() }}
          tokenStatus={tokenStatus}
          blobs={oneShot}
        />
      </div>

      <SetupNotes os={os} mode={mode} notesId={ids.notes} />
    </main>
  );
}
