import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLIENT_SOURCES,
  checkMachineSettings,
  DEFAULT_API_URL,
  detectOs,
  packageFiles,
  renderConfig,
  SETUP_MODES,
  SETUP_OSES,
  type MachineSettings,
} from "@/lib/setup";
import { buildSetupZip, loadClientSources, usageEndpoint } from "@/lib/setup-package";
import { readZip } from "./read-zip";

const SETTINGS: MachineSettings = {
  apiUrl: "https://usageratio.snktibor.hu/api/usage",
  groupId: "Otthoni gép",
  machineId: "",
};

const COMBINATIONS = SETUP_OSES.flatMap((os) => SETUP_MODES.map((mode) => ({ os, mode })));

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

describe("setup package contents", () => {
  it.each(COMBINATIONS)("ships exactly the $mode reporter in the $os package", ({ os, mode }) => {
    const names = packageFiles(os, mode).map((file) => file.name);
    const reporters = names.filter((name) => name.startsWith("report-usage-") && !name.includes("core"));
    expect(reporters).toEqual([`report-usage-${mode}.${os === "macos" ? "sh" : "ps1"}`]);
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

  it("keeps the Windows scripts plain ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI", () => {
    for (const source of CLIENT_SOURCES.filter((path) => /\.(ps1|cmd)$/.test(path))) {
      expect(readFileSync(source, "utf8"), source).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
    }
  });

  it("uses the file names the installers look for", () => {
    const shell = readFileSync("clients/setup/install.sh", "utf8");
    const powershell = readFileSync("clients/setup/install.ps1", "utf8");
    for (const name of ["report-usage-auto.sh", "report-usage-manual.sh", "report-usage-core.sh", "ccusage-providers.cjs"]) {
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
      'API_URL="https://usageratio.snktibor.hu/api/usage"\nMACHINE_ID="mac-studio"\nGROUP_ID="Otthoni gép"\n',
    );
  });

  it("writes the Windows config as JSON, accents included, without a token", () => {
    const text = renderConfig("windows", SETTINGS);
    expect(JSON.parse(text)).toEqual({
      apiUrl: "https://usageratio.snktibor.hu/api/usage",
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

  it("asks for a missing group and explains a bad machine id at the same time", () => {
    const check = checkMachineSettings(" ", "my/mac");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.group).toMatch(/Add meg a csoportot/);
    expect(check.machine).toMatch(/A gép azonosítója/);
  });

  it("rejects what the ingest API would reject", () => {
    for (const group of ['Wo"rk', "-Work", "x".repeat(65), "$HOME"]) {
      expect(checkMachineSettings(group, "").ok, group).toBe(false);
    }
  });
});

describe("usageEndpoint", () => {
  it("points production clients at the production domain, not the deployment URL", () => {
    const env = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "usageratio.snktibor.hu" };
    expect(usageEndpoint(headers({ host: "usageratio-abc123-snktibors-projects.vercel.app" }), env)).toBe(
      "https://usageratio.snktibor.hu/api/usage",
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
});

describe("buildSetupZip", () => {
  it("packs executable macOS scripts with LF line ends and no token", async () => {
    const sources = await loadClientSources();
    const { fileName, bytes } = buildSetupZip("macos", "auto", SETTINGS, sources);
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

  it("packs the Windows package with CRLF line ends and a README Notepad reads", async () => {
    const sources = await loadClientSources();
    const entries = readZip(buildSetupZip("windows", "auto", SETTINGS, sources).bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry.data]));

    expect([...byName.keys()]).toContain("install.cmd");
    expect([...byName.keys()]).toContain("install-task.ps1");
    for (const [name, data] of byName) {
      expect(data.toString("utf8").replace(/\r\n/g, ""), name).not.toContain("\n");
    }
    expect(byName.get("README.txt")!.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    // A byte order mark in front of its #! line would make Node refuse the parser.
    expect(byName.get("ccusage-providers.cjs")!.subarray(0, 2).toString()).toBe("#!");
    expect(JSON.parse(byName.get("config.json")!.toString("utf8"))).toEqual({
      apiUrl: SETTINGS.apiUrl,
      machineId: "",
      groupId: "Otthoni gép",
    });
  });
});
