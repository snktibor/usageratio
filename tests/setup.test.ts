import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { locales } from "@/i18n/locales.generated";
import {
  CCUSAGE_VERSION,
  CLIENT_SOURCES,
  checkMachineSettings,
  DEFAULT_API_URL,
  detectOs,
  type MachineSettings,
  packageFiles,
  renderConfig,
  renderOneShot,
  renderReadme,
  SETUP_MODES,
  SETUP_OSES,
} from "@/lib/setup";
import { buildSetupZip, loadClientSources, oneShotBlobs, usageEndpoint } from "@/lib/setup-package";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import hu from "@/messages/hu.json";
import { readZip } from "./read-zip";

const MESSAGES = { en, hu, de } as const;

const SETTINGS: MachineSettings = {
  apiUrl: "https://usageratio.example.com/api/usage",
  groupId: "Otthoni gép",
  machineId: "",
};

const t = createTranslator({ locale: "en", messages: en, namespace: "Setup" });

const COMBINATIONS = SETUP_OSES.flatMap((os) => SETUP_MODES.map((mode) => ({ os, mode })));

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

describe("setup package contents", () => {
  it.each(COMBINATIONS)("ships exactly the $mode reporter in the $os package", ({ os, mode }) => {
    const names = packageFiles(os, mode).map((file) => file.name);
    const reporters = names.filter((name) => name.startsWith("report-usage-") && !name.includes("core"));
    expect(reporters).toEqual([`report-usage-${mode}.${os === "windows" ? "ps1" : "sh"}`]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("adds the task installer to the Windows auto package only", () => {
    const has = (os: "macos" | "windows", mode: "auto" | "manual") =>
      packageFiles(os, mode).some((file) => file.name === "install-task.ps1");
    expect([has("windows", "auto"), has("windows", "manual"), has("macos", "auto")]).toEqual([true, false, false]);
  });

  it("names only repository files that exist", () => {
    for (const source of CLIENT_SOURCES) expect(existsSync(source), source).toBe(true);
    for (const { os, mode } of COMBINATIONS) {
      for (const file of packageFiles(os, mode)) {
        if (file.source) expect(CLIENT_SOURCES).toContain(file.source);
      }
    }
  });

  it("pins the same ccusage version in both reporter cores and lib/setup.ts", () => {
    const shell = readFileSync("clients/shared/report-usage-core.sh", "utf8");
    const powershell = readFileSync("clients/shared/report-usage-core.ps1", "utf8");
    expect(shell).toContain(`CCUSAGE_VERSION="\${USAGERATIO_CCUSAGE_VERSION:-${CCUSAGE_VERSION}}"`);
    expect(powershell).toContain(`if (-not $ccusageVersion) { $ccusageVersion = '${CCUSAGE_VERSION}' }`);
  });

  it("keeps the Windows scripts plain ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI", () => {
    for (const source of CLIENT_SOURCES.filter((path) => /\.(ps1|cmd)$/.test(path))) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: only printable ASCII, tab, CR and LF may appear
      expect(readFileSync(source, "utf8"), source).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    }
  });

  it("uses the file names the installers look for", () => {
    const shell = readFileSync("clients/setup/install.sh", "utf8");
    const powershell = readFileSync("clients/setup/install.ps1", "utf8");
    for (const name of [
      "report-usage-auto.sh",
      "report-usage-manual.sh",
      "report-usage-core.sh",
      "ccusage-providers.cjs",
    ]) {
      expect(shell).toContain(name);
    }
    for (const name of [
      "report-usage-auto.ps1",
      "report-usage-manual.ps1",
      "report-usage-core.ps1",
      "ccusage-providers.cjs",
      "install-task.ps1",
      "config.json",
    ]) {
      expect(powershell).toContain(name);
    }
  });
});

describe("renderConfig", () => {
  it("writes the macOS config for bash to source", () => {
    expect(renderConfig("macos", { ...SETTINGS, machineId: "mac-studio" })).toBe(
      'API_URL="https://usageratio.example.com/api/usage"\nMACHINE_ID="mac-studio"\nGROUP_ID="Otthoni gép"\n',
    );
  });

  it("writes the Windows config as JSON, accents included, without a token", () => {
    const text = renderConfig("windows", SETTINGS);
    expect(JSON.parse(text)).toEqual({
      apiUrl: "https://usageratio.example.com/api/usage",
      machineId: "",
      groupId: "Otthoni gép",
    });
    expect(text.endsWith("\n")).toBe(true);
  });

  it("refuses a value that would break out of the shell quotes", () => {
    for (const groupId of ['Work"; rm -rf ~; "', "$(id)", "`id`", "a\\b"]) {
      expect(() => renderConfig("macos", { ...SETTINGS, groupId })).toThrow();
    }
  });

  it("adds COST=1 to the macOS config only when the cost opt-in is on", () => {
    expect(renderConfig("macos", { ...SETTINGS, machineId: "mac-studio" })).not.toContain("COST");
    expect(renderConfig("macos", { ...SETTINGS, machineId: "mac-studio", cost: true })).toBe(
      'API_URL="https://usageratio.example.com/api/usage"\nMACHINE_ID="mac-studio"\nGROUP_ID="Otthoni gép"\nCOST=1\n',
    );
    expect(renderConfig("macos", { ...SETTINGS, machineId: "mac-studio", cost: false })).not.toContain("COST");
  });

  it('adds "cost": true to the Windows config only when the opt-in is on', () => {
    expect(JSON.parse(renderConfig("windows", SETTINGS))).not.toHaveProperty("cost");
    expect(JSON.parse(renderConfig("windows", { ...SETTINGS, cost: true }))).toEqual({
      apiUrl: SETTINGS.apiUrl,
      machineId: "",
      groupId: SETTINGS.groupId,
      cost: true,
    });
  });
});

describe("checkMachineSettings", () => {
  it("accepts a group and an empty machine id, trimmed", () => {
    expect(checkMachineSettings("  Work ", "   ")).toEqual({ ok: true, groupId: "Work", machineId: "" });
    expect(checkMachineSettings("Otthoni gép", "mac-studio")).toEqual({
      ok: true,
      groupId: "Otthoni gép",
      machineId: "mac-studio",
    });
  });

  it("asks for a missing group and flags a bad machine id at the same time", () => {
    const check = checkMachineSettings(" ", "my/mac");
    expect(check).toEqual({ ok: false, group: "missing", machine: "invalid" });
  });

  it("tells a missing group from an invalid one", () => {
    expect(checkMachineSettings("", "")).toMatchObject({ group: "missing", machine: null });
    expect(checkMachineSettings("$HOME", "")).toMatchObject({ group: "invalid", machine: null });
  });

  it("rejects what the ingest API would reject", () => {
    for (const group of ['Wo"rk', "-Work", "x".repeat(65), "$HOME"]) {
      expect(checkMachineSettings(group, "").ok, group).toBe(false);
    }
  });
});

describe("usageEndpoint", () => {
  it("points production clients at the production domain, not the deployment URL", () => {
    const env = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "usageratio.example.com" };
    expect(usageEndpoint(headers({ host: "usageratio-abc123-my-projects.vercel.app" }), env)).toBe(
      "https://usageratio.example.com/api/usage",
    );
  });

  it("uses the address the page was opened on elsewhere", () => {
    expect(usageEndpoint(headers({ host: "localhost:3111" }), {})).toBe("http://localhost:3111/api/usage");
    expect(
      usageEndpoint(headers({ "x-forwarded-host": "usageratio.vercel.app", "x-forwarded-proto": "https" }), {}),
    ).toBe("https://usageratio.vercel.app/api/usage");
  });

  it("falls back to the default for a host it cannot vouch for", () => {
    expect(usageEndpoint(headers({ host: 'evil"host' }), {})).toBe(DEFAULT_API_URL);
    expect(usageEndpoint(headers({}), {})).toBe(DEFAULT_API_URL);
  });
});

describe("detectOs", () => {
  it("recognises Windows from the platform hint or the user agent", () => {
    expect(detectOs(null, '"Windows"')).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", null)).toBe("windows");
    expect(detectOs("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", '"macOS"')).toBe("macos");
    expect(detectOs(null, null)).toBe("macos");
  });

  it("recognises desktop Linux from the platform hint or the user agent, but not Android", () => {
    expect(detectOs(null, '"Linux"')).toBe("linux");
    expect(detectOs("Mozilla/5.0 (X11; Linux x86_64)", null)).toBe("linux");
    expect(detectOs("Mozilla/5.0 (Linux; Android 14; Pixel 8)", '"Android"')).toBe("macos");
  });
});

describe("buildSetupZip", () => {
  it("packs executable macOS scripts with LF line ends and no token", async () => {
    const sources = await loadClientSources();
    const { fileName, bytes } = buildSetupZip("macos", "auto", SETTINGS, sources, t);
    const entries = readZip(bytes);

    expect(fileName).toBe("usageratio-macos-auto.zip");
    expect(entries.map((entry) => entry.name)).toEqual([
      "README.txt",
      ...packageFiles("macos", "auto").map((file) => file.name),
    ]);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("install.sh")!.mode).toBe(0o755);
    expect(byName.get("report-usage-auto.sh")!.data.toString("utf8")).toBe(sources["clients/auto/report-usage.sh"]);
    expect(byName.get("config")!.mode).toBe(0o644);
    expect(byName.get("config")!.data.toString("utf8")).toBe(renderConfig("macos", SETTINGS));
    for (const entry of entries) expect(entry.data.includes("\r\n"), entry.name).toBe(false);
    // The installer asks for the token; the package never carries one.
    expect(byName.get("config")!.data.toString("utf8")).not.toMatch(/TOKEN/i);
  });

  it("packs executable Linux scripts, sharing the macOS installer and reporter", async () => {
    const sources = await loadClientSources();
    const { fileName, bytes } = buildSetupZip("linux", "auto", SETTINGS, sources, t);
    const entries = readZip(bytes);

    expect(fileName).toBe("usageratio-linux-auto.zip");
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("install.sh")!.mode).toBe(0o755);
    expect(byName.get("install.sh")!.data.toString("utf8")).toBe(sources["clients/setup/install.sh"]);
    expect(byName.get("report-usage-auto.sh")!.data.toString("utf8")).toBe(sources["clients/auto/report-usage.sh"]);
    for (const entry of entries) expect(entry.data.includes("\r\n"), entry.name).toBe(false);
  });

  it("packs the Windows package with CRLF line ends and a README Notepad reads", async () => {
    const sources = await loadClientSources();
    const entries = readZip(buildSetupZip("windows", "auto", SETTINGS, sources, t).bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));

    expect([...byName.keys()]).toContain("install.cmd");
    expect([...byName.keys()]).toContain("install-task.ps1");
    for (const [name, data] of byName) {
      expect(data.toString("utf8").replace(/\r\n/g, ""), name).not.toContain("\n");
    }
    expect(
      byName
        .get("README.txt")!
        .subarray(0, 3)
        .equals(Buffer.from([0xef, 0xbb, 0xbf])),
    ).toBe(true);
    // A byte order mark in front of its #! line would make Node refuse the parser.
    expect(byName.get("ccusage-providers.cjs")!.subarray(0, 2).toString()).toBe("#!");
    expect(JSON.parse(byName.get("config.json")!.toString("utf8"))).toEqual({
      apiUrl: SETTINGS.apiUrl,
      machineId: "",
      groupId: "Otthoni gép",
    });
  });
});

describe("renderOneShot", () => {
  const BLOBS = { parser: "UEFSU0VS\nUEFSU0VS", unixCore: "VU5JWA==", windowsCore: "V0lORE9XUw==" };
  const TOKEN = `abc'def$!\`0123456789`;

  it("quotes every value for the shell and passes the settings in the environment", () => {
    const text = renderOneShot("macos", "npx", { ...SETTINGS, machineId: "mac-studio" }, TOKEN, BLOBS);
    expect(text).toContain(`USAGERATIO_API_TOKEN='abc'\\''def$!\`0123456789' \\\n`);
    expect(text).toContain("USAGERATIO_GROUP_ID='Otthoni gép' \\\n");
    expect(text).toContain("USAGERATIO_MACHINE_ID='mac-studio' \\\n");
    expect(text).toContain("USAGERATIO_CCUSAGE=npx \\\n");
    expect(text).toContain("\nUEFSU0VS\nUEFSU0VS\nUSAGERATIO_PARSER\n");
    expect(text).toContain("\nVU5JWA==\nUSAGERATIO_CORE\n");
    expect(text).not.toContain("V0lORE9XUw==");
    // One subshell from the first line to the last: nothing stays set in the terminal.
    expect(text.startsWith(" (\n")).toBe(true);
    expect(text.endsWith('\nbash "$d/report-usage-core.sh"\n)')).toBe(true);
  });

  it("is the same command on macOS and Linux", () => {
    expect(renderOneShot("linux", "global", SETTINGS, TOKEN, BLOBS)).toBe(
      renderOneShot("macos", "global", SETTINGS, TOKEN, BLOBS),
    );
  });

  it("adds USAGERATIO_COST only when the opt-in is on", () => {
    expect(renderOneShot("macos", "npx", SETTINGS, TOKEN, BLOBS)).not.toContain("USAGERATIO_COST");
    expect(renderOneShot("macos", "npx", { ...SETTINGS, cost: true }, TOKEN, BLOBS)).toContain(
      "USAGERATIO_COST=1 \\\n",
    );
    expect(renderOneShot("windows", "global", SETTINGS, TOKEN, BLOBS)).not.toContain("USAGERATIO_COST");
    expect(renderOneShot("windows", "global", { ...SETTINGS, cost: true }, TOKEN, BLOBS)).toContain(
      "    USAGERATIO_COST = '1'\n",
    );
  });

  it("builds a PowerShell block that cleans up after itself", () => {
    const text = renderOneShot("windows", "global", SETTINGS, "abc'def\u2019ghi0123456789", BLOBS);
    expect(text).toContain("    USAGERATIO_API_TOKEN = 'abc''def\u2019\u2019ghi0123456789'\n");
    expect(text).toContain("    USAGERATIO_CCUSAGE = 'global'\n");
    expect(text).toContain("@'\nV0lORE9XUw==\n'@\n");
    expect(text).not.toContain("VU5JWA==");
    expect(text).toMatch(
      /\} finally \{\n.*SetEnvironmentVariable\(\$name, \$null\).*\n.*Remove-Item -LiteralPath \$dir -Recurse/,
    );
    expect(text.startsWith("& {\n")).toBe(true);
  });

  it("packs the scripts so they unpack to the repository files, in short lines of plain base64", async () => {
    const sources = await loadClientSources();
    const blobs = oneShotBlobs(sources);
    const files = {
      parser: "clients/shared/ccusage-providers.cjs",
      unixCore: "clients/shared/report-usage-core.sh",
      windowsCore: "clients/shared/report-usage-core.ps1",
    } as const;
    for (const [key, source] of Object.entries(files) as [keyof typeof files, (typeof files)[keyof typeof files]][]) {
      const blob = blobs[key];
      // Nothing a shell could expand, and never a line that ends the here-document early.
      expect(blob).toMatch(/^[A-Za-z0-9+/=\n]+$/);
      expect(Math.max(...blob.split("\n").map((line) => line.length))).toBeLessThanOrEqual(76);
      expect(gunzipSync(Buffer.from(blob, "base64")).toString("utf8")).toBe(sources[source]);
    }
  });
});

describe("packageFiles roleKey", () => {
  it("names a Setup.role_* key that exists in every locale's messages", () => {
    for (const [locale, messages] of Object.entries(MESSAGES)) {
      for (const { os, mode } of COMBINATIONS) {
        for (const file of packageFiles(os, mode)) {
          expect(file.roleKey.startsWith("role_"), `${locale} ${os}/${mode} ${file.name}`).toBe(true);
          expect(messages.Setup, `${locale} is missing Setup.${file.roleKey}`).toHaveProperty(file.roleKey);
        }
      }
    }
  });
});

describe("renderReadme", () => {
  it("includes the mode sentence, the settings and every file's role", () => {
    const settings = { ...SETTINGS, machineId: "mac-studio" };
    const readme = renderReadme("macos", "auto", settings, t);
    expect(readme).toContain(t("mode_auto_macos"));
    expect(readme).toContain(settings.groupId);
    expect(readme).toContain(settings.machineId);
    expect(readme).toContain(settings.apiUrl);
    for (const file of packageFiles("macos", "auto")) {
      expect(readme).toContain(file.name);
      expect(readme).toContain(t(file.roleKey));
    }
  });

  it("names the machine by its default text while none was given", () => {
    const readme = renderReadme("windows", "manual", SETTINGS, t);
    expect(readme).toContain(t("readme_machine_default"));
  });

  it.each(locales)("renders in %s without a missing key", (locale) => {
    const translate = createTranslator({
      locale,
      messages: MESSAGES[locale],
      namespace: "Setup",
      onError: (error) => {
        throw error;
      },
    });
    for (const { os, mode } of COMBINATIONS) {
      expect(() => renderReadme(os, mode, SETTINGS, translate)).not.toThrow();
    }
  });
});
