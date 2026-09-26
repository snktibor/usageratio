import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupMode } from "@/lib/setup";
import { buildSetupZip, loadClientSources } from "@/lib/setup-package";
import { readZip } from "./read-zip";

/**
 * Runs the macOS installer end to end, the way a downloaded ZIP is used: unpack
 * it anywhere, `bash install.sh`. HOME is a scratch folder; crontab, scutil and
 * ccusage are stand-ins on PATH; the server is a local stub of /api/usage.
 * A `node` stand-in outside the usual places also exercises the PATH line the
 * installer writes for cron.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const CCUSAGE_REPORT = {
  daily: [
    {
      date: "2026-09-21",
      agents: [
        { agent: "claude", modelBreakdowns: [{ modelName: "claude-sonnet-4", inputTokens: 1000, outputTokens: 234 }] },
      ],
    },
  ],
};

interface Stub {
  url: string;
  reports: Record<string, unknown>[];
  server: Server;
}

async function startServer(): Promise<Stub> {
  const reports: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          tokenMode: "snapshot",
          providers: ["claude"],
          cycle: { sinceDate: "2026-09-21", timeZone: "Europe/Budapest" },
        }),
      );
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      reports.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(201, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/usage`, reports, server };
}

function run(cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Next.js types NODE_ENV as always present; the installer runs without it on purpose.
    const childEnv = env as unknown as NodeJS.ProcessEnv;
    execFile("bash", ["install.sh"], { cwd, env: childEnv, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

// Each case starts bash, curl and node several times: far above the default 5 s on a busy machine.
describe.skipIf(process.platform === "win32")("install.sh", { timeout: 60_000 }, () => {
  let scratch: string;
  let home: string;
  let bin: string;
  let stub: Stub;

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: "/bin/zsh", LANG: "en_US.UTF-8", ...extra };
  }

  function tool(name: string, script: string) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  /** Unpacks a freshly built package into its own folder, as Archive Utility would. */
  async function unpack(mode: SetupMode, groupId: string, machineId = ""): Promise<string> {
    const { bytes } = buildSetupZip("macos", mode, { apiUrl: stub.url, groupId, machineId }, await loadClientSources());
    const folder = mkdtempSync(path.join(scratch, `package-${mode}-`));
    for (const entry of readZip(bytes)) writeFileSync(path.join(folder, entry.name), entry.data, { mode: entry.mode });
    return folder;
  }

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "usageratio-setup-"));
    home = path.join(scratch, "home");
    bin = path.join(scratch, "tools");
    mkdirSync(home);
    mkdirSync(bin);
    tool("node", `exec "${process.execPath}" "$@"`);
    tool("ccusage", `cat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`);
    tool("scutil", "echo test-mac");
    tool("crontab", 'if [ "$1" = "-l" ]; then cat "$HOME/crontab.txt" 2>/dev/null; else cat >"$HOME/crontab.txt"; fi');
    stub = await startServer();
  });

  afterEach(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  it("installs the auto reporter, schedules it and sends a first report", async () => {
    const result = await run(await unpack("auto", "Otthoni gép"), env({ USAGERATIO_API_TOKEN: TOKEN }));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usageratio is installed (auto) as test-mac in group Otthoni gép.");
    for (const file of ["auto/report-usage.sh", "shared/report-usage-core.sh", "shared/ccusage-providers.cjs"]) {
      expect(statSync(path.join(home, ".usageratio", file)).mode & 0o777, file).toBe(0o700);
    }

    const configFile = path.join(home, ".config/usageratio/config");
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    const config = readFileSync(configFile, "utf8");
    expect(config).toContain(`API_URL='${stub.url}'`);
    expect(config).toContain(`API_TOKEN='${TOKEN}'`);
    expect(config).toContain("MACHINE_ID='test-mac'");
    expect(config).toContain("GROUP_ID='Otthoni gép'");
    expect(config).toContain(`PATH='${bin}':"$PATH"`);

    expect(readFileSync(path.join(home, "crontab.txt"), "utf8")).toBe(
      `0 * * * * /bin/bash "${home}/.usageratio/auto/report-usage.sh" >/dev/null 2>&1\n`,
    );
    expect(stub.reports).toEqual([
      expect.objectContaining({ machineId: "test-mac", groupId: "Otthoni gép", providers: { claude: 1234 } }),
    ]);
  });

  it("installs the manual reporter behind a sync-tokens alias, once", async () => {
    const folder = await unpack("manual", "Work");
    const first = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));
    const second = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));

    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.stdout).toContain("✅ Sync successful: 1 providers sent.");
    const aliases = readFileSync(path.join(home, ".zshrc"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("alias sync-tokens="));
    expect(aliases).toEqual([`alias sync-tokens='/bin/bash "$HOME/.usageratio/manual/report-usage.sh"'`]);
    expect(existsSync(path.join(home, "crontab.txt"))).toBe(false);
  });

  it("keeps the machine id in use when reinstalled, unless the package names one", async () => {
    await run(await unpack("auto", "Work"), env({ USAGERATIO_API_TOKEN: TOKEN }));
    tool("scutil", "echo renamed-mac");
    await run(await unpack("auto", "Work"), env({ USAGERATIO_API_TOKEN: TOKEN }));
    const configFile = path.join(home, ".config/usageratio/config");
    expect(readFileSync(configFile, "utf8")).toContain("MACHINE_ID='test-mac'");

    await run(await unpack("auto", "Work", "studio"), env({ USAGERATIO_API_TOKEN: TOKEN }));
    expect(readFileSync(configFile, "utf8")).toContain("MACHINE_ID='studio'");
    expect(readFileSync(path.join(home, "crontab.txt"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("installs nothing when the server rejects the token", async () => {
    const result = await run(await unpack("auto", "Work"), env({ USAGERATIO_API_TOKEN: "wrong-token-wrong-token" }));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("rejected");
    expect(existsSync(path.join(home, ".usageratio"))).toBe(false);
    expect(stub.reports).toEqual([]);
  });

  it("refuses to ask for a token without a terminal", async () => {
    const result = await run(await unpack("auto", "Work"), env());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("USAGERATIO_API_TOKEN");
  });

  it("names a file missing from the package", async () => {
    const folder = await unpack("auto", "Work");
    rmSync(path.join(folder, "report-usage-core.sh"));
    const result = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("report-usage-core.sh is missing");
  });
});
