import type { Translator } from "@/lib/i18n";
import { parseId } from "@/lib/validation";

/**
 * The client setup packages behind /setup: which files make up a package,
 * what each one is for, where the installer puts it, and the per-machine
 * config the page generates. Pure, so the page shows exactly what the ZIP
 * download (lib/setup-package.ts) contains. The API token is never part of a
 * package: the installer asks for it and checks it against the server.
 *
 * Carries no UI text of its own: everything shown to a visitor is a
 * `Setup.*` message key (messages/{en,hu,de}.json), translated by the caller.
 */

export type SetupOs = "macos" | "linux" | "windows";
export type SetupMode = "auto" | "manual";
/** The three ways the page can hand over the package: which tab is open. */
export type InstallRoute = "zip" | "manual" | "oneShot";

// Auto mode's installer per OS decides what Setup.mode_auto_* may claim:
// clients/setup/install.sh (macOS and Linux, branching on `uname -s`) registers
// a crontab entry; clients/auto/install-task.ps1 (Windows) registers a scheduled
// task with a daily 00:00 trigger repeating hourly — none of the three has a
// "runs at startup" trigger.
export const SETUP_OSES: readonly SetupOs[] = ["macos", "linux", "windows"];
export const SETUP_MODES: readonly SetupMode[] = ["auto", "manual"];
export const INSTALL_ROUTES: readonly InstallRoute[] = ["zip", "manual", "oneShot"];

/**
 * The address the reporters fall back to, too. Deliberately not a real
 * endpoint: it is only ever returned when the request's host can't be
 * trusted (see usageEndpoint in lib/setup-package.ts), and a client
 * should fail loudly there rather than silently reporting to someone
 * else's deployment.
 */
export const DEFAULT_API_URL = "https://your-domain.example/api/usage";

/**
 * The ccusage version the clients pin themselves to (`npx --yes ccusage@$CCUSAGE_VERSION`),
 * overridable per machine with USAGERATIO_CCUSAGE_VERSION ("latest" is an explicit opt-in).
 * Kept equal to the same constant in clients/shared/report-usage-core.sh and
 * report-usage-core.ps1; tests/setup.test.ts checks all three stay in sync.
 */
export const CCUSAGE_VERSION = "20.0.24";

/** Every file a package ships from the repository, as is. */
export const CLIENT_SOURCES = [
  "clients/setup/install.sh",
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

/** What a package file is for; a `Setup.role_*` message key. */
export type SetupRoleKey =
  | "role_config"
  | "role_reporter_auto_unix"
  | "role_reporter_manual_unix"
  | "role_core"
  | "role_parser"
  | "role_installer_unix_auto"
  | "role_installer_unix_manual"
  | "role_reporter_auto_win"
  | "role_reporter_manual_win"
  | "role_task_installer"
  | "role_installer_win_auto"
  | "role_installer_win_manual"
  | "role_install_cmd";

export interface PackageFile {
  /** The file's name inside the package folder. */
  name: string;
  /** Shipped as is from the repository; null for the generated config. */
  source: ClientSource | null;
  /** What it is for, shown on the page and in README.txt. */
  roleKey: SetupRoleKey;
  /** Where the installer puts it; null for the installer itself. */
  installedAs: string | null;
  executable: boolean;
  /** Only in the ZIP: a convenience the copy-it-yourself route does without. */
  zipOnly: boolean;
}

export const OS_LABEL: Record<SetupOs, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

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

/** macOS and Linux ship the same reporter, wrapper and installer scripts (install.sh branches on `uname -s`). */
function unixFiles(os: "macos" | "linux", mode: SetupMode): PackageFile[] {
  const root = INSTALL_ROOT[os];
  return [
    {
      name: "config",
      source: null,
      roleKey: "role_config",
      installedAs: INSTALLED_CONFIG[os],
      executable: false,
      zipOnly: false,
    },
    {
      name: `report-usage-${mode}.sh`,
      source: mode === "auto" ? "clients/auto/report-usage.sh" : "clients/manual/report-usage.sh",
      roleKey: mode === "auto" ? "role_reporter_auto_unix" : "role_reporter_manual_unix",
      installedAs: `${root}/${mode}/report-usage.sh`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "report-usage-core.sh",
      source: "clients/shared/report-usage-core.sh",
      roleKey: "role_core",
      installedAs: `${root}/shared/report-usage-core.sh`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "ccusage-providers.cjs",
      source: "clients/shared/ccusage-providers.cjs",
      roleKey: "role_parser",
      installedAs: `${root}/shared/ccusage-providers.cjs`,
      executable: true,
      zipOnly: false,
    },
    {
      name: "install.sh",
      source: "clients/setup/install.sh",
      roleKey: mode === "auto" ? "role_installer_unix_auto" : "role_installer_unix_manual",
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
      roleKey: "role_config",
      installedAs: INSTALLED_CONFIG.windows,
      executable: false,
      zipOnly: false,
    },
    {
      name: `report-usage-${mode}.ps1`,
      source: mode === "auto" ? "clients/auto/report-usage.ps1" : "clients/manual/report-usage.ps1",
      roleKey: mode === "auto" ? "role_reporter_auto_win" : "role_reporter_manual_win",
      installedAs: `${root}\\${mode}\\report-usage.ps1`,
      executable: false,
      zipOnly: false,
    },
  ];
  if (mode === "auto") {
    files.push({
      name: "install-task.ps1",
      source: "clients/auto/install-task.ps1",
      roleKey: "role_task_installer",
      installedAs: `${root}\\auto\\install-task.ps1`,
      executable: false,
      zipOnly: false,
    });
  }
  files.push(
    {
      name: "report-usage-core.ps1",
      source: "clients/shared/report-usage-core.ps1",
      roleKey: "role_core",
      installedAs: `${root}\\shared\\report-usage-core.ps1`,
      executable: false,
      zipOnly: false,
    },
    {
      name: "ccusage-providers.cjs",
      source: "clients/shared/ccusage-providers.cjs",
      roleKey: "role_parser",
      installedAs: `${root}\\shared\\ccusage-providers.cjs`,
      executable: false,
      zipOnly: false,
    },
    {
      name: "install.ps1",
      source: "clients/setup/install.ps1",
      roleKey: mode === "auto" ? "role_installer_win_auto" : "role_installer_win_manual",
      installedAs: null,
      executable: false,
      zipOnly: false,
    },
    {
      name: "install.cmd",
      source: "clients/setup/install.cmd",
      roleKey: "role_install_cmd",
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
  | { ok: false; group: "missing" | "invalid" | null; machine: "invalid" | null };

/** The page's group and machine fields, checked by the same rule the ingest API applies. */
export function checkMachineSettings(group: string, machine: string): SettingsCheck {
  const groupErrors: string[] = [];
  const groupId = parseId(group, "groupId", groupErrors);
  const groupProblem: "missing" | "invalid" | null =
    groupId === "" ? "missing" : groupErrors.length > 0 ? "invalid" : null;

  let machineProblem: "invalid" | null = null;
  let machineId = "";
  if (machine.trim() !== "") {
    const machineErrors: string[] = [];
    machineId = parseId(machine, "machineId", machineErrors);
    if (machineErrors.length > 0) machineProblem = "invalid";
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

export function parseRoute(value: unknown): InstallRoute | null {
  return (INSTALL_ROUTES as readonly unknown[]).includes(value) ? (value as InstallRoute) : null;
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

// ── One-off report ───────────────────────────────────────────────────────────

/** How the one-off report runs ccusage: the installed command, or the current package through npx. */
export type CcusageRunner = "global" | "npx";

export const CCUSAGE_RUNNERS: readonly CcusageRunner[] = ["global", "npx"];

/**
 * The scripts a one-off report unpacks into its temporary folder, gzipped and
 * in base64 (lib/setup-package.ts makes them). An interactive shell applies
 * history expansion even inside a quoted here-document, so the parser's `!`s
 * would not survive a paste as plain text: base64 has nothing to expand.
 */
export interface OneShotBlobs {
  parser: string;
  unixCore: string;
  windowsCore: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell also closes a single-quoted string on the typographic quotes. */
function powershellQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/**
 * A command that sends exactly one report and leaves nothing behind: it
 * unpacks the parser and the reporter core into a temporary folder, runs the
 * core once with the settings in its environment (the same code the installed
 * manual client runs), and removes the folder, log included. An installed
 * client's config is only read: for the machine id when none is given here.
 *
 * `token` is the real API token: only build this in the click that copies it.
 */
export function renderOneShot(
  os: SetupOs,
  runner: CcusageRunner,
  settings: MachineSettings,
  token: string,
  blobs: OneShotBlobs,
): string {
  if (os === "windows") {
    return [
      "& {",
      "  # usageratio: a single report; installs nothing, and removes every temporary file of its own at the end.",
      "  $ErrorActionPreference = 'Stop'",
      "  $dir = Join-Path ([IO.Path]::GetTempPath()) ('usageratio-once-' + [Guid]::NewGuid())",
      "  $vars = [ordered]@{",
      `    USAGERATIO_API_URL = ${powershellQuote(settings.apiUrl)}`,
      `    USAGERATIO_GROUP_ID = ${powershellQuote(settings.groupId)}`,
      `    USAGERATIO_MACHINE_ID = ${powershellQuote(settings.machineId)}`,
      `    USAGERATIO_CCUSAGE = ${powershellQuote(runner)}`,
      "    USAGERATIO_LOG_FILE = (Join-Path $dir 'usageratio.log')",
      `    USAGERATIO_API_TOKEN = ${powershellQuote(token)}`,
      "  }",
      "  function Save-Gzip([string]$Name, [string]$Base64) {",
      "    $packed = [IO.MemoryStream]::new([Convert]::FromBase64String($Base64))",
      "    $gzip = [IO.Compression.GZipStream]::new($packed, [IO.Compression.CompressionMode]::Decompress)",
      "    $file = [IO.File]::Create((Join-Path $dir $Name))",
      "    try { $gzip.CopyTo($file) } finally { $file.Dispose(); $gzip.Dispose() }",
      "  }",
      "  try {",
      "    New-Item -ItemType Directory -Path $dir | Out-Null",
      "    Save-Gzip 'ccusage-providers.cjs' @'",
      blobs.parser,
      "'@",
      "    Save-Gzip 'report-usage-core.ps1' @'",
      blobs.windowsCore,
      "'@",
      "    foreach ($name in $vars.Keys) { [Environment]::SetEnvironmentVariable($name, $vars[$name]) }",
      // A child process: the core ends with `exit`, and a .ps1 file needs the policy bypass.
      "    $shell = (Get-Process -Id $PID).Path",
      "    if ((Split-Path -Leaf $shell) -notmatch '^(powershell|pwsh)(\\.exe)?$') { $shell = 'powershell.exe' }",
      "    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'report-usage-core.ps1') -OutputMode Manual",
      "  } finally {",
      "    foreach ($name in $vars.Keys) { [Environment]::SetEnvironmentVariable($name, $null) }",
      "    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue",
      "  }",
      "}",
    ].join("\n");
  }

  // One subshell, so nothing is left set in the terminal. The leading space keeps
  // it out of the history where the shell ignores such lines (HISTCONTROL=ignorespace,
  // zsh's HIST_IGNORE_SPACE). No comments: zsh does not allow them interactively.
  return [
    " (",
    ": usageratio: a single report, installs nothing, and removes every temporary file of its own at the end",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the generated script
    'd="$(mktemp -d "${TMPDIR:-/tmp}/usageratio-once.XXXXXX")" || exit 1',
    `trap 'rm -rf "$d"' EXIT`,
    "trap 'exit 130' HUP INT TERM",
    `base64 --decode <<'USAGERATIO_PARSER' | gunzip >"$d/ccusage-providers.cjs" || exit 1`,
    blobs.parser,
    "USAGERATIO_PARSER",
    `base64 --decode <<'USAGERATIO_CORE' | gunzip >"$d/report-usage-core.sh" || exit 1`,
    blobs.unixCore,
    "USAGERATIO_CORE",
    "USAGERATIO_OUTPUT_MODE=manual \\",
    `USAGERATIO_CCUSAGE=${runner} \\`,
    'USAGERATIO_LOG_FILE="$d/usageratio.log" \\',
    `USAGERATIO_API_URL=${shellQuote(settings.apiUrl)} \\`,
    `USAGERATIO_GROUP_ID=${shellQuote(settings.groupId)} \\`,
    `USAGERATIO_MACHINE_ID=${shellQuote(settings.machineId)} \\`,
    `USAGERATIO_API_TOKEN=${shellQuote(token)} \\`,
    'bash "$d/report-usage-core.sh"',
    ")",
  ].join("\n");
}

// ── README.txt ───────────────────────────────────────────────────────────────

/**
 * The instructions that travel inside the ZIP, for whoever opens the folder
 * later, in the language of the request (app/api/setup/route.ts builds the
 * translator). tests/messages.test.ts checks every key used here through the
 * `Translator<"Setup">` annotation.
 */
export function renderReadme(
  os: SetupOs,
  mode: SetupMode,
  settings: MachineSettings,
  translate: Translator<"Setup">,
): string {
  const folder = packageName(os, mode);
  const indent = (text: string) => text.replace(/^/gm, "     ");
  const steps =
    os !== "windows"
      ? [
          translate("readme_step_terminal"),
          "",
          indent(zipInstallCommand(os, mode)),
          "",
          translate("readme_step_terminal_alt"),
        ]
      : [
          translate("readme_step_double_click"),
          "",
          indent(zipInstallCommand(os, mode)),
          ...(mode === "auto" ? ["", translate("readme_step_admin")] : []),
        ];
  const width = Math.max(...packageFiles(os, mode).map((file) => file.name.length)) + 2;
  const machine = settings.machineId || translate("readme_machine_default");
  const lines = [
    translate("readme_title", { os: OS_LABEL[os], mode }),
    "",
    translate(`mode_${mode}_${os}`),
    "",
    translate("readme_install_heading"),
    "",
    ...steps,
    translate("readme_step_token", { path: INSTALLED_CONFIG[os] }),
    translate("readme_step_installed", { folder }),
    "",
    translate("readme_settings_heading"),
    "",
    translate("readme_settings_group", { group: settings.groupId }),
    translate("readme_settings_machine", { machine }),
    translate("readme_settings_server", { url: settings.apiUrl }),
    "",
    translate("readme_contents_heading"),
    "",
    ...packageFiles(os, mode).map((file) => `   ${file.name.padEnd(width)}${translate(file.roleKey)}`),
    "",
    translate("readme_log", { path: LOG_FILE[os] }),
    "",
    translate("readme_uninstall_heading"),
    "",
    indent(uninstallCommand(os, mode)),
    ...(os !== "windows" && mode === "manual" ? ["", translate("readme_uninstall_unix_manual")] : []),
    ...(os === "windows" && mode === "auto" ? ["", translate("uninstall_win_auto")] : []),
    "",
  ];
  return lines.join("\n");
}
