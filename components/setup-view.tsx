"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { BreakablePath, CommandBlock, FileBlock } from "@/components/code-block";
import { ArrowLeftIcon, DownloadIcon, StopCircleIcon } from "@/components/icons";
import { TokenCopyButton } from "@/components/token-copy-button";
import type { ApiTokenStatus } from "@/lib/api-token";
import {
  checkMachineSettings,
  folderCommand,
  INSTALLED_CONFIG,
  installerCommand,
  LOG_FILE,
  MODE_LABEL,
  MODE_SUMMARY,
  OS_LABEL,
  packageFiles,
  packageName,
  renderConfig,
  saveCommand,
  SETUP_MODES,
  SETUP_OSES,
  uninstallCommand,
  zipInstallCommand,
  type ClientSources,
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
        Amikor kéri, add meg a <Code>USAGE_API_TOKEN</Code>-t; gépelés közben nem látszik. A telepítő ellenőrzi a
        szerveren, a helyükre másolja a fájlokat
        {os === "windows" && mode === "auto" ? ", regisztrálja az ütemezett feladatot" : ""}, és elküld egy
        próbajelentést.
      </p>
      <TokenCopyButton status={tokenStatus} />
    </>
  );
}

/**
 * The setup page: one choice of system and mode drives both routes, the ZIP
 * download and the files to copy, so the two always install the same thing.
 */
export function SetupView({
  initialOs,
  initialMode,
  apiUrl,
  groups,
  sources,
  tokenStatus,
}: {
  initialOs: SetupOs;
  initialMode: SetupMode;
  apiUrl: string;
  groups: SetupGroup[];
  sources: ClientSources;
  tokenStatus: ApiTokenStatus;
}) {
  const [os, setOs] = useState(initialOs);
  const [mode, setMode] = useState(initialMode);
  const [group, setGroup] = useState(groups[0]?.id ?? "Personal");
  const [machine, setMachine] = useState("");
  const ids = {
    group: useId(),
    groupNote: useId(),
    machine: useId(),
    machineNote: useId(),
    zip: useId(),
    manual: useId(),
    notes: useId(),
  };

  // The choice stays in the address, so a reload or a saved link opens the same package.
  useEffect(() => {
    window.history.replaceState(null, "", `?os=${os}&mode=${mode}`);
  }, [os, mode]);

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
        <p className="mt-4 text-ink-2">
          Válaszd ki a gép rendszerét és a futtatás módját. Utána töltsd le a kész csomagot, vagy hozd létre a
          fájlokat kézzel: a két út ugyanoda vezet.
        </p>
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
              hint="A dashboard ezen a néven csoportosítja a gépet. Új név is lehet: az első jelentéskor magától felkerül a listára."
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
              hint="Üresen hagyva a számítógép neve lesz; ha a gépen már fut a kliens, a meglévő azonosítója marad. Minden gépnek egyedi kell."
            />
          </div>
        </div>
      </section>

      <section aria-labelledby={ids.zip} className="mt-16">
        <h2 id={ids.zip} className="text-2xl font-semibold tracking-tight">
          Letöltés ZIP-ben
        </h2>
        <p className="mt-2 max-w-2xl text-ink-2">
          Kész csomag a fenti beállításokkal, telepítővel együtt. Tokent nem tartalmaz: azt a telepítő kéri be.
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
                  Nyisd meg a letöltött ZIP-et: a Letöltések mappában létrejön a <Code>{name}</Code> mappa. Máshová is
                  áthelyezheted.
                </p>
              </Step>
              <Step number={2}>
                <p>Indítsd el a telepítőt a terminálban:</p>
                <CommandBlock command={zipInstallCommand(os, mode)} label="A telepítő parancsa" />
                <p className="text-sm text-ink-3">
                  Ha máshol van a mappa: írd be, hogy <Code>bash</Code> és egy szóköz, húzd az install.sh fájlt a
                  terminál ablakába, majd nyomj Entert.
                </p>
              </Step>
            </>
          ) : (
            <>
              <Step number={1}>
                <p>
                  Kattints a ZIP-re jobb gombbal, és válaszd az <strong className="font-medium text-ink">Összes kibontása…</strong>{" "}
                  lehetőséget. Bárhová kibonthatod.
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

      <section aria-labelledby={ids.manual} className="mt-20">
        <h2 id={ids.manual} className="text-2xl font-semibold tracking-tight">
          Másold és hozd létre
        </h2>
        <p className="mt-2 max-w-2xl text-ink-2">
          Hova? Bárhova. Egy feltétel van: mind a(z) {files.length} fájl ugyanabba a mappába kerüljön, pontosan
          ezekkel a nevekkel. A telepítő innen másolja őket a végleges helyükre, utána a mappa törölhető.
        </p>

        <ol role="list" className="mt-8 space-y-10">
          <Step number={1}>
            <p className="max-w-2xl">
              {unix
                ? "Nyiss egy terminált, hozz létre egy mappát, és lépj bele. A példa a saját mappádba teszi, de bármelyik jó:"
                : "Nyiss egy PowerShellt, és futtasd ezt. Létrehoz egy mappát (bármelyik jó), belép, és felvesz egy paste parancsot, amely a vágólap tartalmát fájlba menti:"}
            </p>
            <CommandBlock command={folderCommand(os)} label="A mappa parancsa" />
          </Step>
          <Step number={2}>
            <p className="max-w-2xl">
              {os === "linux" ? (
                <>
                  Hozd létre a fájlokat. Mindegyiknél: futtasd a terminálban a Mentés sorában álló parancsot, illeszd
                  be a másolt tartalmat, majd zárd <Code>Ctrl+D</Code>-vel. Szövegszerkesztővel is mentheted, csak a
                  név egyezzen.
                </>
              ) : (
                <>
                  Hozd létre a fájlokat. Mindegyiknél: <strong className="font-medium text-ink">Másolás</strong>,
                  majd {os === "macos" ? "a Terminálban" : "a PowerShellben"} a Mentés sorában álló parancs.
                  Szövegszerkesztővel is mentheted, csak a név egyezzen.
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

      <section aria-labelledby={ids.notes} className="mt-20 border-t border-hairline pt-8">
        <h2 id={ids.notes} className="text-lg font-medium">
          Tudnivalók
        </h2>
        <dl className="mt-5 grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-5 text-sm leading-relaxed sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-ink-3">Előfeltétel</dt>
          <dd className="text-ink-2">
            Node.js a gépen: a ccusage és a feldolgozó is ezzel fut. Ellenőrzés: <Code>node --version</Code>
          </dd>

          <dt className="text-ink-3">Token</dt>
          <dd className="text-ink-2">
            A szerver <Code>USAGE_API_TOKEN</Code> értéke, minden gépen ugyanaz. Egy már beállított kliensnél itt
            találod: <Code>{INSTALLED_CONFIG.macos}</Code> (macOS/Linux) vagy{" "}
            <Code>
              <BreakablePath path={INSTALLED_CONFIG.windows} />
            </Code>{" "}
            (Windows). Újratelepítéskor Enterrel megtarthatod a mentettet. A <strong className="font-medium text-ink">Token
            másolása</strong> gomb a Beállítások panelen megadott, titkosítva tárolt másolatot teszi a vágólapra.
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
                Utána töröld a shell indítófájljából (pl. <Code>~/.zshrc</Code> vagy <Code>~/.bashrc</Code>) az{" "}
                <Code>alias sync-tokens=</Code> kezdetű sort.
              </p>
            )}
            {os === "windows" && mode === "auto" && <p>Rendszergazdaként indított PowerShellben futtasd.</p>}
          </dd>
        </dl>
      </section>
    </main>
  );
}
