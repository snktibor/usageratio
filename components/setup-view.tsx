"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { fetchApiToken } from "@/components/clipboard";
import { BreakablePath, CommandBlock, FileBlock } from "@/components/code-block";
import { ArrowLeftIcon, DownloadIcon, StopCircleIcon } from "@/components/icons";
import { InfoTip } from "@/components/info-tip";
import { StatusLine } from "@/components/status-line";
import { TokenCopyButton } from "@/components/token-copy-button";
import { apiTokenStatusNote, type ApiTokenStatus } from "@/lib/api-token";
import {
  CCUSAGE_RUNNERS,
  checkMachineSettings,
  folderCommand,
  INSTALL_ROUTES,
  INSTALLED_CONFIG,
  installerCommand,
  LOG_FILE,
  MODE_LABEL,
  MODE_SUMMARY,
  OS_LABEL,
  packageFiles,
  packageName,
  parseRoute,
  renderConfig,
  renderOneShot,
  ROUTE_LABEL,
  RUNNER_LABEL,
  RUNNER_SUMMARY,
  saveCommand,
  SETUP_MODES,
  SETUP_OSES,
  uninstallCommand,
  zipInstallCommand,
  type CcusageRunner,
  type ClientSources,
  type InstallRoute,
  type MachineSettings,
  type OneShotBlobs,
  type SetupMode,
  type SetupOs,
} from "@/lib/setup";

export interface SetupGroup {
  id: string;
  /** "#rrggbb" */
  color: string;
}

const FIELD =
  "rounded-md border border-rule bg-raised px-3 py-2 text-ink placeholder:text-ink-3 aria-invalid:border-critical";

/** The client's last choices, so returning to the page skips picking them again. */
const SETUP_PREFS_COOKIE = "usageratio-setup";

interface SetupPrefs {
  os?: string;
  route?: string;
  group?: string;
  machine?: string;
}

function readSetupPrefs(): SetupPrefs | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${SETUP_PREFS_COOKIE}=([^;]*)`));
    return match?.[1] ? (JSON.parse(decodeURIComponent(match[1])) as SetupPrefs) : null;
  } catch {
    return null; // Cookies are optional; the defaults still work for this page view.
  }
}

function writeSetupPrefs(prefs: { os: SetupOs; route: InstallRoute; group: string; machine: string }) {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${SETUP_PREFS_COOKIE}=${encodeURIComponent(JSON.stringify(prefs))}; path=/setup; max-age=${oneYear}; samesite=lax`;
  } catch {
    // Cookies are optional; the selection still works for this page view.
  }
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[0.9em] text-ink wrap-anywhere">{children}</code>;
}

function Segmented<T extends string>({
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

function tabId(tabsId: string, route: InstallRoute): string {
  return `${tabsId}-tab-${route}`;
}

function panelId(tabsId: string, route: InstallRoute): string {
  return `${tabsId}-panel-${route}`;
}

/** The three install routes as an ARIA tablist; arrow keys move the selection like a native tab strip. */
function RouteTabs({
  tabsId,
  value,
  onChange,
}: {
  tabsId: string;
  value: InstallRoute;
  onChange: (route: InstallRoute) => void;
}) {
  const move = (delta: 1 | -1) => {
    const index = INSTALL_ROUTES.indexOf(value);
    const next = INSTALL_ROUTES[(index + delta + INSTALL_ROUTES.length) % INSTALL_ROUTES.length]!;
    onChange(next);
    document.getElementById(tabId(tabsId, next))?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Telepítés módja"
      className="flex flex-wrap gap-1 border-b border-rule"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {INSTALL_ROUTES.map((route) => (
        <button
          key={route}
          type="button"
          role="tab"
          id={tabId(tabsId, route)}
          aria-selected={value === route}
          aria-controls={panelId(tabsId, route)}
          tabIndex={value === route ? 0 : -1}
          onClick={() => onChange(route)}
          className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
            value === route ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink"
          }`}
        >
          {ROUTE_LABEL[route]}
        </button>
      ))}
    </div>
  );
}

/** A field's hint, or its problem in its place. */
function FieldNote({ id, problem, hint }: { id: string; problem: string | null; hint: string }) {
  return problem ? (
    <p id={id} className="mt-2 flex items-start gap-2 text-sm text-ink">
      <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
      <span>{problem}</span>
    </p>
  ) : (
    <p id={id} className="mt-2 text-sm leading-relaxed text-ink-3">
      {hint}
    </p>
  );
}

function Step({ number, children }: { number: number; children: React.ReactNode }) {
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

function TokenNote({ os, mode, tokenStatus }: { os: SetupOs; mode: SetupMode; tokenStatus: ApiTokenStatus }) {
  return (
    <>
      <p>
        Add meg a <Code>USAGE_API_TOKEN</Code>-t, amikor kéri (gépeléskor nem látszik). A telepítő a helyükre
        másolja a fájlokat{os === "windows" && mode === "auto" ? ", regisztrálja az ütemezett feladatot" : ""}, és
        küld egy próbajelentést.
      </p>
      <TokenCopyButton status={tokenStatus} />
    </>
  );
}

const TOKEN_PLACEHOLDER = "‹token: a Másolás gomb illeszti be›";

/** What the preview shows in place of a packed script. */
function packedNote(name: string, blob: string): string {
  return `‹${name}, tömörítve: ${blob.split("\n").length} sor base64›`;
}

/**
 * The one-off report: a single command that sends one report and leaves
 * nothing behind. The page only shows a preview; the command with the real
 * token is built in the click that copies it, like the Token másolása button.
 */
function OneShotSection({
  headingId,
  os,
  settings,
  draft,
  tokenStatus,
  blobs,
}: {
  headingId: string;
  os: SetupOs;
  /** Null while the group or machine field is invalid. */
  settings: MachineSettings | null;
  /** The fields as typed, for the preview while they are invalid. */
  draft: MachineSettings;
  tokenStatus: ApiTokenStatus;
  blobs: OneShotBlobs;
}) {
  const [runner, setRunner] = useState<CcusageRunner>("global");
  const available = tokenStatus.state === "stored";
  const note = apiTokenStatusNote(tokenStatus);
  const preview = renderOneShot(os, runner, settings ?? draft, TOKEN_PLACEHOLDER, {
    parser: packedNote("ccusage-providers.cjs", blobs.parser),
    unixCore: packedNote("report-usage-core.sh", blobs.unixCore),
    windowsCore: packedNote("report-usage-core.ps1", blobs.windowsCore),
  });
  const build = async () => {
    if (!settings) throw new Error("invalid settings");
    return renderOneShot(os, runner, settings, await fetchApiToken(), blobs);
  };

  return (
    <section aria-labelledby={headingId}>
      <div className="relative flex items-center gap-1.5">
        <h2 id={headingId} className="text-2xl font-semibold tracking-tight">
          Egyszeri feltöltés
        </h2>
        <InfoTip label="Mire jó az egyszeri feltöltés?">
          <span className="block">Egyszeri adatküldés olyan gépről, amit nem kötnél be tartósan – például egy vendéggépről.</span>
          <span className="block">
            Utána semmi nem marad a gépen, és nem frissül magától: ha újra kell, másold be újra.
          </span>
          <span className="block text-ink">
            Vigyázz: a parancs a valódi tokent tartalmazza, és ott marad a terminál előzményeiben, amíg nem törlöd.
            Ne oszd meg.
          </span>
        </InfoTip>
      </div>
      <p className="mt-2 max-w-2xl text-ink-2">
        Egyetlen parancs, ami a fenti csoporttal és gépazonosítóval egyszer elküldi a gép állását, és nem hagy
        nyomot.
      </p>

      <div className="mt-6">
        <Segmented
          legend="ccusage ezen a gépen"
          name="runner"
          value={runner}
          options={CCUSAGE_RUNNERS}
          labels={RUNNER_LABEL}
          onChange={setRunner}
        />
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-2">{RUNNER_SUMMARY[runner]}</p>
      </div>

      <div className="mt-6 max-w-2xl space-y-3 leading-relaxed">
        <p>
          {os === "windows"
            ? "Másold ki, illeszd be egy PowerShellbe, és nyomj Entert."
            : "Másold ki, illeszd be egy terminálba, és nyomj Entert."}
        </p>
        <CommandBlock
          command={preview}
          label="Az egyszeri parancs"
          resolve={build}
          disabled={!settings || !available}
        />
        {!settings ? (
          <p className="text-sm text-ink-3">Előbb javítsd a fenti csoportot vagy a gép azonosítóját.</p>
        ) : available ? (
          <p className="text-sm text-ink-3">A Másolás lekéri a tokent, és beleírja a parancsba (bekerül az auditnaplóba).</p>
        ) : null}
        {!available || note.tone === "warning" ? (
          <StatusLine tone={note.tone}>
            {note.text}
            {tokenStatus.state === "empty" || tokenStatus.state === "unreadable"
              ? " A dashboard Beállítások paneljén adhatod meg."
              : ""}
          </StatusLine>
        ) : null}
      </div>
    </section>
  );
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
    zip: useId(),
    manual: useId(),
    oneShot: useId(),
    notes: useId(),
  };

  // Restores the client's last group/machine/tab, and its last os when the URL didn't ask for one explicitly.
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
    ? `/api/setup?${new URLSearchParams({ os, mode, group: settings.groupId, machine: settings.machineId })}`
    : null;
  const selectedGroup = group.trim();
  const unix = os !== "windows";

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-24 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <ArrowLeftIcon />
          Dashboard
        </Link>
      </header>

      <div className="mt-12 max-w-2xl sm:mt-16">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Kliens telepítése</h1>
        {/* <p className="mt-4 text-ink-2">
          Válaszd ki a rendszert és a futtatás módját, majd töltsd le a csomagot, vagy hozd létre a fájlokat kézzel.
          Egyszeri adatküldéshez lent van egy telepítés nélküli parancs is.
        </p> */}
      </div>

      <section aria-label="A csomag beállításai" className="mt-10 rounded-lg border border-rule px-5 py-6 sm:px-6">
        <div className="flex flex-wrap gap-x-10 gap-y-5">
          <Segmented legend="Rendszer" name="os" value={os} options={SETUP_OSES} labels={OS_LABEL} onChange={setOs} />
          <Segmented
            legend="Futtatás"
            name="mode"
            value={mode}
            options={SETUP_MODES}
            labels={MODE_LABEL}
            onChange={setMode}
          />
        </div>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-2">{MODE_SUMMARY[os][mode]}</p>

        <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 border-t border-hairline pt-6 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor={ids.group} className="text-sm text-ink-3">
              Csoport
            </label>
            <input
              id={ids.group}
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              aria-invalid={(!check.ok && check.group !== null) || undefined}
              aria-describedby={ids.groupNote}
              className={`mt-1.5 block w-full ${FIELD}`}
            />
            {groups.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2" aria-label="Meglévő csoportok">
                {groups.map((known) => (
                  <button
                    key={known.id}
                    type="button"
                    aria-pressed={known.id === selectedGroup}
                    onClick={() => setGroup(known.id)}
                    className="inline-flex max-w-full items-center gap-2 rounded-full border border-rule px-3 py-1 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink aria-pressed:border-ink-3 aria-pressed:bg-raised aria-pressed:text-ink"
                  >
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: known.color }} />
                    <span className="truncate">{known.id}</span>
                  </button>
                ))}
              </div>
            )}
            <FieldNote
              id={ids.groupNote}
              problem={check.ok ? null : check.group}
              hint="A dashboard ezen a néven csoportosítja a gépet."
            />
          </div>

          <div className="min-w-0">
            <label htmlFor={ids.machine} className="text-sm text-ink-3">
              Gép azonosítója (nem kötelező)
            </label>
            <input
              id={ids.machine}
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              placeholder="a számítógép neve"
              value={machine}
              onChange={(event) => setMachine(event.target.value)}
              aria-invalid={(!check.ok && check.machine !== null) || undefined}
              aria-describedby={ids.machineNote}
              className={`mt-1.5 block w-full ${FIELD}`}
            />
            <FieldNote
              id={ids.machineNote}
              problem={check.ok ? null : check.machine}
              hint="Üresen hagyva a gép neve lesz."
            />
          </div>
        </div>
      </section>

      <div className="mt-14">
        <RouteTabs tabsId={ids.tabs} value={route} onChange={setRoute} />

        <div
          role="tabpanel"
          id={panelId(ids.tabs, "zip")}
          aria-labelledby={tabId(ids.tabs, "zip")}
          hidden={route !== "zip"}
          tabIndex={0}
          className="mt-8"
        >
          <section aria-labelledby={ids.zip}>
            <h2 id={ids.zip} className="text-2xl font-semibold tracking-tight">
              Letöltés ZIP-ben
            </h2>
            <p className="mt-2 max-w-2xl text-ink-2">
              Kész csomag telepítővel, a fenti beállításokkal. Tokent nem tartalmaz, azt a telepítő kéri be.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
              {zipHref ? (
                <a
                  href={zipHref}
                  className="inline-flex items-center gap-2.5 rounded-md bg-ink px-5 py-2.5 font-medium text-page transition-opacity hover:opacity-90"
                >
                  <DownloadIcon />
                  Csomag letöltése
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-2.5 rounded-md bg-ink px-5 py-2.5 font-medium text-page opacity-40"
                >
                  <DownloadIcon />
                  Csomag letöltése
                </button>
              )}
              <span className="font-mono text-sm text-ink-3 wrap-anywhere">{name}.zip</span>
            </div>
            {!zipHref && <p className="mt-3 text-sm text-ink-3">Előbb javítsd a csoportot vagy a gép azonosítóját.</p>}

            <ol role="list" className="mt-8 max-w-2xl space-y-6">
              {unix ? (
                <>
                  <Step number={1}>
                    <p>
                      Nyisd meg a letöltött ZIP-et: létrejön a <Code>{name}</Code> mappa a Letöltésekben.
                    </p>
                  </Step>
                  <Step number={2}>
                    <p>Indítsd el a telepítőt a terminálban:</p>
                    <CommandBlock command={zipInstallCommand(os, mode)} label="A telepítő parancsa" />
                    <p className="text-sm text-ink-3">
                      Ha máshol van a mappa: írd be <Code>bash </Code>, húzd rá az install.sh fájlt, majd Enter.
                    </p>
                  </Step>
                </>
              ) : (
                <>
                  <Step number={1}>
                    <p>
                      Kattints jobb gombbal a ZIP-re, és válaszd az{" "}
                      <strong className="font-medium text-ink">Összes kibontása…</strong> lehetőséget.
                    </p>
                  </Step>
                  <Step number={2}>
                    <p>
                      A kibontott mappában kattints duplán az <Code>install.cmd</Code> fájlra. Ha a Windows rákérdez,
                      engedélyezd a futtatást{mode === "auto" ? ", majd a rendszergazdai jogot is" : ""}.
                    </p>
                    <p className="text-sm text-ink-3">PowerShellből is indíthatod:</p>
                    <CommandBlock command={zipInstallCommand(os, mode)} label="A telepítő parancsa" />
                  </Step>
                </>
              )}
              <Step number={3}>
                <TokenNote os={os} mode={mode} tokenStatus={tokenStatus} />
              </Step>
            </ol>
          </section>
        </div>

        <div
          role="tabpanel"
          id={panelId(ids.tabs, "manual")}
          aria-labelledby={tabId(ids.tabs, "manual")}
          hidden={route !== "manual"}
          tabIndex={0}
          className="mt-8"
        >
          <section aria-labelledby={ids.manual}>
            <h2 id={ids.manual} className="text-2xl font-semibold tracking-tight">
              Másold és hozd létre
            </h2>
            <p className="mt-2 max-w-2xl text-ink-2">
              Bárhova, csak mind a(z) {files.length} fájl ugyanabba a mappába kerüljön, pontosan ezekkel a nevekkel.
            </p>

            <ol role="list" className="mt-8 space-y-10">
              <Step number={1}>
                <p className="max-w-2xl">
                  {unix
                    ? "Nyiss egy terminált, és hozz létre egy mappát:"
                    : "Nyiss egy PowerShellt, és futtasd ezt: létrehoz egy mappát, és felvesz egy paste parancsot a vágólap fájlba mentéséhez."}
                </p>
                <CommandBlock command={folderCommand(os)} label="A mappa parancsa" />
              </Step>
              <Step number={2}>
                <p className="max-w-2xl">
                  {os === "linux" ? (
                    <>
                      Hozd létre a fájlokat: futtasd a Mentés parancsát, illeszd be a tartalmat, majd zárd{" "}
                      <Code>Ctrl+D</Code>-vel. Szövegszerkesztővel is mentheted, csak a név egyezzen.
                    </>
                  ) : (
                    <>
                      Hozd létre a fájlokat: <strong className="font-medium text-ink">Másolás</strong>, majd a Mentés
                      parancsa {os === "macos" ? "a Terminálban" : "a PowerShellben"}. Szövegszerkesztővel is
                      mentheted, csak a név egyezzen.
                    </>
                  )}
                </p>
                <div className="space-y-4 pt-1">
                  {files.map((file) => (
                    <FileBlock
                      key={file.name}
                      name={file.name}
                      role={file.role}
                      saveCommand={saveCommand(os, file.name)}
                      installedAs={file.installedAs}
                      content={file.source ? sources[file.source] : settings && renderConfig(os, settings)}
                      unavailable="Előbb javítsd a fenti csoportot vagy a gép azonosítóját."
                    />
                  ))}
                </div>
              </Step>
              <Step number={3}>
                <p>Futtasd a telepítőt ugyanebben a mappában:</p>
                <CommandBlock command={installerCommand(os)} label="A telepítő parancsa" />
                <TokenNote os={os} mode={mode} tokenStatus={tokenStatus} />
              </Step>
            </ol>
          </section>
        </div>

        <div
          role="tabpanel"
          id={panelId(ids.tabs, "oneShot")}
          aria-labelledby={tabId(ids.tabs, "oneShot")}
          hidden={route !== "oneShot"}
          tabIndex={0}
          className="mt-8"
        >
          <OneShotSection
            headingId={ids.oneShot}
            os={os}
            settings={settings}
            draft={{ apiUrl, groupId: group.trim(), machineId: machine.trim() }}
            tokenStatus={tokenStatus}
            blobs={oneShot}
          />
        </div>
      </div>

      <details className="mt-20 border-t border-hairline pt-8">
        <summary id={ids.notes} className="w-fit cursor-pointer text-sm text-ink-3 transition-colors hover:text-ink">
          Tudnivalók
        </summary>
        <dl className="mt-5 grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-5 text-sm leading-relaxed sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-ink-3">Előfeltétel</dt>
          <dd className="text-ink-2">
            Node.js a gépen: a ccusage és a feldolgozó is ezzel fut. Ellenőrzés: <Code>node --version</Code>
          </dd>

          <dt className="text-ink-3">Token</dt>
          <dd className="text-ink-2">
            A szerver <Code>USAGE_API_TOKEN</Code> értéke, minden gépen ugyanaz. Beállított gépen itt találod:{" "}
            <Code>{INSTALLED_CONFIG.macos}</Code> (macOS/Linux) vagy{" "}
            <Code>
              <BreakablePath path={INSTALLED_CONFIG.windows} />
            </Code>{" "}
            (Windows). Újratelepítéskor Enterrel megtartható. A <strong className="font-medium text-ink">Token
            másolása</strong> gomb a Beállításokban tárolt, titkosított másolatot adja.
          </dd>

          <dt className="text-ink-3">Frissítés</dt>
          <dd className="text-ink-2">Futtasd újra a telepítőt egy friss csomaggal: a gép azonosítója megmarad.</dd>

          <dt className="text-ink-3">Napló</dt>
          <dd className="text-ink-2">
            <Code>
              <BreakablePath path={LOG_FILE[os]} />
            </Code>
          </dd>

          <dt className="text-ink-3">Eltávolítás</dt>
          <dd className="space-y-2 text-ink-2">
            <CommandBlock command={uninstallCommand(os, mode)} label="Az eltávolítás parancsa" />
            {unix && mode === "manual" && (
              <p>
                Utána töröld az <Code>alias sync-tokens=</Code> sort a shell indítófájlból (pl.{" "}
                <Code>~/.zshrc</Code>).
              </p>
            )}
            {os === "windows" && mode === "auto" && <p>Rendszergazdaként indított PowerShellben futtasd.</p>}
          </dd>
        </dl>
      </details>
    </main>
  );
}
