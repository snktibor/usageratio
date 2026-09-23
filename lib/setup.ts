import { parseId } from "@/lib/validation";

/**
 * The client setup packages behind /setup: which files make up a package,
 * what each one is for, where the installer puts it, and the per-machine
 * config the page generates. Pure, so the page shows exactly what the ZIP
 * download (lib/setup-package.ts) contains. The API token is never part of a
 * package: the installer asks for it and checks it against the server.
 */

export type SetupOs = "macos" | "linux" | "windows";
export type SetupMode = "auto" | "manual";

export const SETUP_OSES: readonly SetupOs[] = ["macos", "linux", "windows"];
export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];

/** The address the reporters fall back to, too. */
export const DEFAULT_API_URL = "https://usageratio.snktibor.hu/api/usage";

/** Every file a package ships from the repository, as is. */
export const CLIENT_SOURCES = [
  "clients/setup/install.sh",
  "clients/setup/install-linux.sh",
  "clients/setup/install.ps1",
  "clients/setup/install.cmd",
  "clients/auto/report-usage.sh",
  "clients/auto/report-usage.ps1",
  "clients/auto/install-task.ps1",
  "clients/manual/report-usage.sh",
  "clients/manual/report-usage.ps1",
  "clients/shared/report-usage-core.sh",
  "clients/shared/report-usage-core.ps1",
  "clients/shared/ccusage-providers.cjs",
] as const;

export type ClientSource = (typeof CLIENT_SOURCES)[number];
export type ClientSources = Record<ClientSource, string>;

/** What the generated config file carries. */
export interface MachineSettings {
  apiUrl: string;
  groupId: string;
  /** Empty: the installer keeps the id the machine already reports under, else the computer's name. */
  machineId: string;
}

export interface PackageFile {
  /** The file's name inside the package folder. */
  name: string;
  /** Shipped as is from the repository; null for the generated config. */
  source: ClientSource | null;
  /** What it is for (Hungarian, shown on the page and in README.txt). */
  role: string;
  /** Where the installer puts it; null for the installer itself. */
  installedAs: string | null;
  executable: boolean;
  /** Only in the ZIP: a convenience the copy-it-yourself route does without. */
  zipOnly: boolean;
}

export const OS_LABEL: Record<SetupOs, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };
export const MODE_LABEL: Record<SetupMode, string> = { auto: "Automatikus", manual: "Manuális" };

export const MODE_SUMMARY: Record<SetupOs, Record<SetupMode, string>> = {
  macos: {
    auto: "Óránként magától küld, a cron ütemezésével, csendben. Telepítés után nincs vele teendő.",
    manual: "Akkor küld, amikor a Terminálban beírod: sync-tokens. Az eredményt ki is írja.",
  },
  linux: {
    auto: "Óránként magától küld, a cron ütemezésével, csendben. Telepítés után nincs vele teendő.",
    manual: "Akkor küld, amikor a terminálban beírod: sync-tokens. Az eredményt ki is írja.",
  },
  windows: {
    auto:
      "Óránként magától küld a Feladatütemezővel, ablak nélkül, akkor is, ha senki nincs bejelentkezve. " +
      "A telepítő ehhez egyszer rendszergazdai jogot kér.",
    manual: "Akkor küld, amikor elindítod az asztali Sync tokens parancsikont. Az eredményt ki is írja.",
  },
};

const INSTALL_ROOT: Record<SetupOs, string> = {
  macos: "~/.usageratio",
  linux: "~/.usageratio",
  windows: "%USERPROFILE%\\.usageratio",
};

export const LOG_FILE: Record<SetupOs, string> = {
  macos: "~/Library/Logs/usageratio.log",
  linux: "~/.usageratio.log",
  windows: "%USERPROFILE%\\.usageratio\\usageratio.log",
};

/** Where an installed client keeps the token: the place to look it up for the next machine. */
export const INSTALLED_CONFIG: Record<SetupOs, string> = {
  macos: "~/.config/usageratio/config",
  linux: "~/.config/usageratio/config",
  windows: "%USERPROFILE%\\.usageratio\\config.json",
};

const CORE_ROLE =
  "A jelentő magja: lekéri a szervertől az aktuális ciklust, lefuttatja a ccusage-et, " +
  "és elküldi a szolgáltatónkénti állást.";
const PARSER_ROLE = "A ccusage kimenetét szolgáltatónkénti tokenszámokká alakítja. Node.js-szel fut.";
const CONFIG_ROLE =
  "A gép beállításai: a szerver címe, a csoport és a gép azonosítója. A telepítő kiegészíti a tokennel, " +
  "és a helyére írja.";

/** macOS and Linux ship the same reporter and wrapper scripts; only the installer differs. */
function unixFiles(os: "macos" | "linux", mode: SetupMode): PackageFile[] {
  const root = INSTALL_ROOT[os];
  const installerSource = os === "macos" ? "clients/setup/install.sh" : "clients/setup/install-linux.sh";
  return [
    {
      name: "config",
      source: null,
      role: CONFIG_ROLE,
      installedAs: INSTALLED_CONFIG[os],
      executable: false,
      zipOnly: false,
    },
    {
      name: `report-usage-${mode}.sh`,
      source: mode === "auto" ? "clients/auto/report-usage.sh" : "clients/manual/report-usage.sh",
      role:
        mode === "auto"
          ? "Ezt futtatja óránként a cron. Csendes: csak a naplóba ír."
          : "Ezt indítja a sync-tokens parancs, és kiírja, sikerült-e a küldés.",
      installedAs: `${root}/${mode}/report-usage.sh`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "report-usage-core.sh",
      source: "clients/shared/report-usage-core.sh",
      role: CORE_ROLE,
      installedAs: `${root}/shared/report-usage-core.sh`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "ccusage-providers.cjs",
      source: "clients/shared/ccusage-providers.cjs",
      role: PARSER_ROLE,
      installedAs: `${root}/shared/ccusage-providers.cjs`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "install.sh",
      source: installerSource,
      role:
        "A telepítő: bekéri és ellenőrzi a tokent, a helyükre másolja a fájlokat, " +
        (mode === "auto" ? "beállítja az óránkénti cron-feladatot" : "felveszi a sync-tokens parancsot") +
        ", és elküld egy próbajelentést.",
      installedAs: null,
      executable: true,
      zipOnly: false,
    },
  ];
}

function windowsFiles(mode: SetupMode): PackageFile[] {
  const root = INSTALL_ROOT.windows;
  const files: PackageFile[] = [
    {
      name: "config.json",
      source: null,
      role: CONFIG_ROLE,
      installedAs: INSTALLED_CONFIG.windows,
      executable: false,
      zipOnly: false,
    },
    {
      name: `report-usage-${mode}.ps1`,
      source: mode === "auto" ? "clients/auto/report-usage.ps1" : "clients/manual/report-usage.ps1",
      role:
        mode === "auto"
          ? "Ezt futtatja óránként a Feladatütemező, ablak nélkül. Csendes: csak a naplóba ír."
          : "Ezt indítja az asztali Sync tokens parancsikon, és kiírja, sikerült-e a küldés.",
      installedAs: `${root}\\${mode}\\report-usage.ps1`,
      executable: false,
      zipOnly: false,
    },
  ];
  if (mode === "auto") {
    files.push({
      name: "install-task.ps1",
      source: "clients/auto/install-task.ps1",
      role: "Létrehozza az óránkénti, rejtett ütemezett feladatot (usageratio-report).",
      installedAs: `${root}\\auto\\install-task.ps1`,
      executable: false,
      zipOnly: false,
    });
  }
  files.push(
    {
      name: "report-usage-core.ps1",
      source: "clients/shared/report-usage-core.ps1",
      role: CORE_ROLE,
      installedAs: `${root}\\shared\\report-usage-core.ps1`,
      executable: false,
      zipOnly: false,
    },
    {
      name: "ccusage-providers.cjs",
      source: "clients/shared/ccusage-providers.cjs",
      role: PARSER_ROLE,
      installedAs: `${root}\\shared\\ccusage-providers.cjs`,
      executable: false,
      zipOnly: false,
    },
    {
      name: "install.ps1",
      source: "clients/setup/install.ps1",
      role:
        "A telepítő: bekéri és ellenőrzi a tokent, a helyükre másolja a fájlokat, " +
        (mode === "auto" ? "regisztrálja az ütemezett feladatot" : "létrehozza az asztali parancsikont") +
        ", és elküld egy próbajelentést.",
      installedAs: null,
      executable: false,
      zipOnly: false,
    },
    {
      name: "install.cmd",
      source: "clients/setup/install.cmd",
      role: "Dupla kattintással elindítja az install.ps1-et.",
      installedAs: null,
      executable: false,
      zipOnly: true,
    },
  );
  return files;
}

export function packageFiles(os: SetupOs, mode: SetupMode): PackageFile[] {
  return os === "windows" ? windowsFiles(mode) : unixFiles(os, mode);
}

/** The ZIP's name without extension; also the folder it unpacks into. */
export function packageName(os: SetupOs, mode: SetupMode): string {
  return `usageratio-${os}-${mode}`;
}

// ── Config ───────────────────────────────────────────────────────────────────

// The macOS/Linux config is sourced by bash: nothing in a value may end its double quotes.
const SHELL_UNSAFE = /["$`\\\r\n]/;

/** The package's config file. The installer adds the token and writes the real one. */
export function renderConfig(os: SetupOs, settings: MachineSettings): string {
  const { apiUrl, machineId, groupId } = settings;
  if (os === "windows") return `${JSON.stringify({ apiUrl, machineId, groupId }, null, 2)}\n`;

  for (const value of [apiUrl, machineId, groupId]) {
    if (SHELL_UNSAFE.test(value)) throw new Error(`config value cannot be written safely: ${JSON.stringify(value)}`);
  }
  return `API_URL="${apiUrl}"\nMACHINE_ID="${machineId}"\nGROUP_ID="${groupId}"\n`;
}

export type SettingsCheck =
  | { ok: true; groupId: string; machineId: string }
  | { ok: false; group: string | null; machine: string | null };

const ID_RULE = "1–64 karakter lehet: betű, szám, szóköz, pont, kötőjel és aláhúzás, az elején betűvel vagy számmal.";

/** The page's group and machine fields, checked by the same rule the ingest API applies. */
export function checkMachineSettings(group: string, machine: string): SettingsCheck {
  let groupProblem: string | null = null;
  const groupErrors: string[] = [];
  const groupId = parseId(group, "groupId", groupErrors);
  if (groupId === "") groupProblem = "Add meg a csoportot, például Work vagy Personal.";
  else if (groupErrors.length > 0) groupProblem = `A csoport neve ${ID_RULE}`;

  let machineProblem: string | null = null;
  let machineId = "";
  if (machine.trim() !== "") {
    const machineErrors: string[] = [];
    machineId = parseId(machine, "machineId", machineErrors);
    if (machineErrors.length > 0) machineProblem = `A gép azonosítója ${ID_RULE}`;
  }

  if (groupProblem || machineProblem) return { ok: false, group: groupProblem, machine: machineProblem };
  return { ok: true, groupId, machineId };
}

// ── Choices ──────────────────────────────────────────────────────────────────

export function parseOs(value: unknown): SetupOs | null {
  return (SETUP_OSES as readonly unknown[]).includes(value) ? (value as SetupOs) : null;
}

export function parseMode(value: unknown): SetupMode | null {
  return (SETUP_MODES as readonly unknown[]).includes(value) ? (value as SetupMode) : null;
}

/** The visitor's own system, from the Sec-CH-UA-Platform hint or the user agent. */
export function detectOs(userAgent: string | null, platformHint: string | null): SetupOs {
  const probe = `${platformHint ?? ""} ${userAgent ?? ""}`;
  if (/windows/i.test(probe)) return "windows";
  // Android's user agent also says "Linux"; it is never the desktop.
  if (/linux/i.test(probe) && !/android/i.test(probe)) return "linux";
  return "macos";
}

// ── Commands ─────────────────────────────────────────────────────────────────

const WINDOWS_RUNNER = "powershell -NoProfile -ExecutionPolicy Bypass -File";

/** Starts the installer of a ZIP unpacked in the Downloads folder. */
export function zipInstallCommand(os: SetupOs, mode: SetupMode): string {
  const folder = packageName(os, mode);
  return os !== "windows"
    ? `bash ~/Downloads/${folder}/install.sh`
    : `${WINDOWS_RUNNER} "$HOME\\Downloads\\${folder}\\install.ps1"`;
}

/** Creates a working folder and steps into it (on Windows it also defines `paste`). */
export function folderCommand(os: SetupOs): string {
  return os !== "windows"
    ? "mkdir -p ~/usageratio-setup && cd ~/usageratio-setup"
    : 'New-Item -ItemType Directory -Force "$HOME\\usageratio-setup" | Out-Null; Set-Location "$HOME\\usageratio-setup"\n' +
        // UTF-8 without a byte order mark: Node refuses one in front of the parser's first line.
        "function paste($name) { [IO.File]::WriteAllText((Join-Path $PWD $name), (Get-Clipboard -Raw)) }";
}

/**
 * Saves the clipboard as `name` in the working folder. Linux has no universal
 * clipboard command (and none at all over SSH into a headless machine), so
 * `cat` reads whatever the terminal's own paste shortcut feeds it instead.
 */
export function saveCommand(os: SetupOs, name: string): string {
  if (os === "macos") return `pbpaste > ${name}`;
  if (os === "linux") return `cat > ${name}`;
  return `paste ${name}`;
}

/** Starts the installer from inside its folder. */
export function installerCommand(os: SetupOs): string {
  return os !== "windows" ? "bash install.sh" : `${WINDOWS_RUNNER} .\\install.ps1`;
}

/** Removes everything the installer set up. */
export function uninstallCommand(os: SetupOs, mode: SetupMode): string {
  if (os !== "windows") {
    return mode === "auto"
      ? "crontab -l | grep -v '/\\.usageratio/auto/report-usage\\.sh' | crontab -\nrm -rf ~/.usageratio ~/.config/usageratio"
      : "rm -rf ~/.usageratio ~/.config/usageratio";
  }
  return mode === "auto"
    ? "Unregister-ScheduledTask -TaskName 'usageratio-report' -Confirm:$false\n" +
        'Remove-Item -Recurse -Force "$env:USERPROFILE\\.usageratio"'
    : `Remove-Item "$([Environment]::GetFolderPath('Desktop'))\\Sync tokens.lnk"\n` +
        'Remove-Item -Recurse -Force "$env:USERPROFILE\\.usageratio"';
}

// ── README.txt ───────────────────────────────────────────────────────────────

/** The instructions that travel inside the ZIP, for whoever opens the folder later. */
export function renderReadme(os: SetupOs, mode: SetupMode, settings: MachineSettings): string {
  const folder = packageName(os, mode);
  const indent = (text: string) => text.replace(/^/gm, "     ");
  const steps =
    os !== "windows"
      ? [
          "1. Nyisd meg a terminált, és indítsd el a telepítőt:",
          "",
          indent(zipInstallCommand(os, mode)),
          "",
          '   Ha máshova bontottad ki: írd be, hogy "bash " (szóközzel), húzd az',
          "   install.sh fájlt a terminál ablakába, és nyomj Entert.",
        ]
      : [
          "1. Kattints duplán az install.cmd fájlra ebben a mappában.",
          "   PowerShellből is indíthatod:",
          "",
          indent(zipInstallCommand(os, mode)),
          ...(mode === "auto" ? ["", "   Az ütemezett feladathoz a telepítő egyszer rendszergazdai jogot kér."] : []),
        ];
  const width = Math.max(...packageFiles(os, mode).map((file) => file.name.length)) + 2;
  const lines = [
    `usageratio – ${OS_LABEL[os]} kliens, ${MODE_LABEL[mode].toLowerCase()} mód`,
    "",
    MODE_SUMMARY[os][mode],
    "",
    "Telepítés",
    "",
    ...steps,
    "2. Amikor kéri, add meg a USAGE_API_TOKEN-t (gépelés közben nem látszik).",
    "   Ugyanaz a token, mint a többi gépen: egy már beállított kliensnél itt van:",
    `   ${INSTALLED_CONFIG[os]}`,
    "3. A telepítő a helyükre másolja a fájlokat, és elküld egy próbajelentést.",
    `   Utána ez a mappa (${folder}) törölhető.`,
    "",
    "Beállítások",
    "",
    `   Csoport: ${settings.groupId}`,
    `   Gép:     ${settings.machineId || "a számítógép neve (újratelepítéskor a korábbi azonosító marad)"}`,
    `   Szerver: ${settings.apiUrl}`,
    "",
    "A mappa tartalma",
    "",
    ...packageFiles(os, mode).map((file) => `   ${file.name.padEnd(width)}${file.role}`),
    "",
    `Napló: ${LOG_FILE[os]}`,
    "",
    "Eltávolítás",
    "",
    indent(uninstallCommand(os, mode)),
    ...(os !== "windows" && mode === "manual"
      ? ["", "   és töröld a shell indítófájljából (pl. ~/.zshrc vagy ~/.bashrc) az alias sync-tokens=... sort."]
      : []),
    ...(os === "windows" && mode === "auto" ? ["", "   (rendszergazdaként indított PowerShellben)"] : []),
    "",
  ];
  return lines.join("\n");
}
