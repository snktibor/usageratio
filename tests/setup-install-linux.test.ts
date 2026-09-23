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
 * Runs the Linux installer end to end, the way a downloaded ZIP is used: unpack
 * it anywhere, `bash install.sh`. HOME is a scratch folder; crontab, hostname and
 * ccusage are stand-ins on PATH; the server is a local stub of /api/usage. Unlike
 * the macOS installer this one never calls scutil, and picks .bashrc over
 * .bash_profile for a bash shell.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const CCUSAGE_REPORT = {
  daily: [
    {
      date: "2026-09-21",
      agents: [{ agent: "claude", modelBreakdowns: [{ modelName: "claude-sonnet-4", inputTokens: 1000, outputTokens: 234 }] }],
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
describe.skipIf(process.platform === "win32")("install-linux.sh", { timeout: 60_000 }, () => {
  let scratch: string;
  let home: string;
  let bin: string;
  let stub: Stub;

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: "/bin/bash", LANG: "en_US.UTF-8", ...extra };
  }

  function tool(name: string, script: string) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  /** Unpacks a freshly built Linux package into its own folder, as a file manager would. */
  async function unpack(mode: SetupMode, groupId: string, machineId = ""): Promise<string> {
    const { bytes } = buildSetupZip("linux", mode, { apiUrl: stub.url, groupId, machineId }, await loadClientSources());
    const folder = mkdtempSync(path.join(scratch, `package-${mode}-`));
    for (const entry of readZip(bytes)) writeFileSync(path.join(folder, entry.name), entry.data, { mode: entry.mode });
    return folder;
  }

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "usageratio-setup-linux-"));
    home = path.join(scratch, "home");
    bin = path.join(scratch, "tools");
    mkdirSync(home);
    mkdirSync(bin);
    tool("node", `exec "${process.execPath}" "$@"`);
    tool("ccusage", `cat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`);
    tool("hostname", 'echo test-linux');
    tool("crontab", 'if [ "$1" = "-l" ]; then cat "$HOME/crontab.txt" 2>/dev/null; else cat >"$HOME/crontab.txt"; fi');
    stub = await startServer();
  });

  afterEach(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  it("installs the auto reporter, schedules it and sends a first report, without calling scutil", async () => {
    const result = await run(await unpack("auto", "Otthoni gép"), env({ USAGERATIO_API_TOKEN: TOKEN }));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usageratio is installed (auto) as test-linux in group Otthoni gép.");
    for (const file of ["auto/report-usage.sh", "shared/report-usage-core.sh", "shared/ccusage-providers.cjs"]) {
      expect(statSync(path.join(home, ".usageratio", file)).mode & 0o777, file).toBe(0o700);
    }

    const configFile = path.join(home, ".config/usageratio/config");
    const config = readFileSync(configFile, "utf8");
    expect(config).toContain(`API_URL='${stub.url}'`);
    expect(config).toContain("MACHINE_ID='test-linux'");
    expect(config).toContain("GROUP_ID='Otthoni gép'");

    expect(readFileSync(path.join(home, "crontab.txt"), "utf8")).toBe(
      `0 * * * * /bin/bash "${home}/.usageratio/auto/report-usage.sh" >/dev/null 2>&1\n`,
    );
    expect(stub.reports).toEqual([
      expect.objectContaining({ machineId: "test-linux", groupId: "Otthoni gép", providers: { claude: 1234 } }),
    ]);
  });

  it("installs the manual reporter behind a sync-tokens alias in .bashrc, not .bash_profile", async () => {
    const folder = await unpack("manual", "Work");
    const result = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✅ Sync successful: 1 providers sent.");
    expect(existsSync(path.join(home, ".bash_profile"))).toBe(false);
    const aliases = readFileSync(path.join(home, ".bashrc"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("alias sync-tokens="));
    expect(aliases).toEqual([`alias sync-tokens='/bin/bash "$HOME/.usageratio/manual/report-usage.sh"'`]);
  });
});
