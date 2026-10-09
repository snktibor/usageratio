import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupMode, SetupOs } from "@/lib/setup";
import { buildSetupZip, loadClientSources } from "@/lib/setup-package";
import en from "@/messages/en.json";
import { readZip } from "./read-zip";

/**
 * Runs the shared macOS/Linux installer (clients/setup/install.sh, which
 * branches on `uname -s`) end to end, the way a downloaded ZIP is used: unpack
 * it anywhere, `bash install.sh`. HOME is a scratch folder; crontab and ccusage
 * are stand-ins on PATH, along with whichever tool the OS uses for its machine
 * name (scutil on macOS, hostname on Linux); the server is a local stub of
 * /api/usage. A `node` stand-in outside the usual places also exercises the
 * PATH line the installer writes for cron.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const t = createTranslator({ locale: "en", messages: en, namespace: "Setup" });
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

const DEFAULT_CYCLE = {
  tokenMode: "snapshot",
  providers: ["claude"],
  cycle: { sinceDate: "2026-09-21", timeZone: "Europe/Budapest" },
};

async function startServer(cycleResponse: unknown = DEFAULT_CYCLE): Promise<Stub> {
  const reports: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cycleResponse));
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

interface OsCase {
  os: SetupOs;
  label: string;
  /** install.sh branches on `uname -s`; the tests run on macOS, so both cases stub it. */
  unameOutput: string;
  /** Stands in for the tool the installer asks for the machine's default name. */
  hostTool: string;
  hostMachineId: string;
  renamedMachineId: string;
  /** SHELL the manual mode's alias line is written for. */
  shell: string;
  rcFile: string;
  /** Set only where the installer must not fall back to this file (bash on Linux: .bashrc, not .bash_profile). */
  otherRcFile?: string;
}

const OS_CASES: OsCase[] = [
  {
    os: "macos",
    label: "install.sh (macOS)",
    unameOutput: "Darwin",
    hostTool: "scutil",
    hostMachineId: "test-mac",
    renamedMachineId: "renamed-mac",
    shell: "/bin/zsh",
    rcFile: ".zshrc",
  },
  {
    os: "linux",
    label: "install.sh (Linux)",
    unameOutput: "Linux",
    hostTool: "hostname",
    hostMachineId: "test-linux",
    renamedMachineId: "renamed-linux",
    shell: "/bin/bash",
    rcFile: ".bashrc",
    otherRcFile: ".bash_profile",
  },
];

// Each case starts bash, curl and node several times: far above the default 5 s on a busy machine.
describe.skipIf(process.platform === "win32").each(OS_CASES)(
  "$label",
  { timeout: 60_000 },
  ({ os, unameOutput, hostTool, hostMachineId, renamedMachineId, shell, rcFile, otherRcFile }) => {
    let scratch: string;
    let home: string;
    let bin: string;
    let stub: Stub;

    function env(extra: Record<string, string> = {}): Record<string, string> {
      return { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SHELL: shell, LANG: "en_US.UTF-8", ...extra };
    }

    function tool(name: string, script: string) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    }

    /** Unpacks a freshly built package into its own folder, as a file manager would. */
    async function unpack(mode: SetupMode, groupId: string, machineId = ""): Promise<string> {
      const { bytes } = buildSetupZip(os, mode, { apiUrl: stub.url, groupId, machineId }, await loadClientSources(), t);
      const folder = mkdtempSync(path.join(scratch, `package-${mode}-`));
      for (const entry of readZip(bytes))
        writeFileSync(path.join(folder, entry.name), entry.data, { mode: entry.mode });
      return folder;
    }

    beforeEach(async () => {
      scratch = mkdtempSync(path.join(tmpdir(), `usageratio-setup-${os}-`));
      home = path.join(scratch, "home");
      bin = path.join(scratch, "tools");
      mkdirSync(home);
      mkdirSync(bin);
      tool("node", `exec "${process.execPath}" "$@"`);
      tool("ccusage", `cat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`);
      tool("uname", `echo ${unameOutput}`);
      tool(hostTool, `echo ${hostMachineId}`);
      tool(
        "crontab",
        'if [ "$1" = "-l" ]; then cat "$HOME/crontab.txt" 2>/dev/null; else cat >"$HOME/crontab.txt"; fi',
      );
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
      expect(result.stdout).toContain(`usageratio is installed (auto) as ${hostMachineId} in group Otthoni gép.`);
      for (const file of ["auto/report-usage.sh", "shared/report-usage-core.sh", "shared/ccusage-providers.cjs"]) {
        expect(statSync(path.join(home, ".usageratio", file)).mode & 0o777, file).toBe(0o700);
      }

      const configFile = path.join(home, ".config/usageratio/config");
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
      const config = readFileSync(configFile, "utf8");
      expect(config).toContain(`API_URL='${stub.url}'`);
      expect(config).toContain(`API_TOKEN='${TOKEN}'`);
      expect(config).toContain(`MACHINE_ID='${hostMachineId}'`);
      expect(config).toContain("GROUP_ID='Otthoni gép'");
      expect(config).toContain(`PATH='${bin}':"$PATH"`);

      expect(readFileSync(path.join(home, "crontab.txt"), "utf8")).toBe(
        `0 * * * * /bin/bash "${home}/.usageratio/auto/report-usage.sh" >/dev/null 2>&1\n`,
      );
      expect(stub.reports).toEqual([
        expect.objectContaining({ machineId: hostMachineId, groupId: "Otthoni gép", providers: { claude: 1234 } }),
      ]);
    });

    it("counts every provider from its own cycle start", async () => {
      await new Promise((resolve) => stub.server.close(resolve));
      stub = await startServer({
        tokenMode: "snapshot",
        providers: ["claude", "openai"],
        cycle: {
          start: "2026-09-20T22:00:00.000Z",
          end: "2026-09-27T22:00:00.000Z",
          sinceDate: "2026-09-21",
          timeZone: "Europe/Budapest",
          providers: {
            // Claude resets on Thursday at midnight in Budapest; OpenAI on Monday.
            claude: { start: "2026-09-23T22:00:00.000Z", end: "2026-09-30T22:00:00.000Z" },
            openai: { start: "2026-09-20T22:00:00.000Z", end: "2026-09-27T22:00:00.000Z" },
          },
        },
      });
      tool(
        "ccusage",
        `cat <<'JSON'\n${JSON.stringify({
          daily: [
            {
              date: "2026-09-21",
              agents: [
                { agent: "claude", totalTokens: 1234 },
                { agent: "codex", totalTokens: 50 },
              ],
            },
            { date: "2026-09-24", agents: [{ agent: "claude", totalTokens: 100 }] },
          ],
        })}\nJSON`,
      );

      const result = await run(await unpack("auto", "Home"), env({ USAGERATIO_API_TOKEN: TOKEN }));

      expect(result.code).toBe(0);
      expect(stub.reports).toEqual([expect.objectContaining({ providers: { claude: 100, openai: 50 } })]);
    });

    it("installs the manual reporter behind a sync-tokens alias, once", async () => {
      const folder = await unpack("manual", "Work");
      const first = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));
      const second = await run(folder, env({ USAGERATIO_API_TOKEN: TOKEN }));

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(first.stdout).toContain("✅ Sync successful: 1 providers sent.");
      const aliases = readFileSync(path.join(home, rcFile), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("alias sync-tokens="));
      expect(aliases).toEqual([`alias sync-tokens='/bin/bash "$HOME/.usageratio/manual/report-usage.sh"'`]);
      expect(existsSync(path.join(home, "crontab.txt"))).toBe(false);
      if (otherRcFile) expect(existsSync(path.join(home, otherRcFile))).toBe(false);
    });

    it("keeps the machine id in use when reinstalled, unless the package names one", async () => {
      await run(await unpack("auto", "Work"), env({ USAGERATIO_API_TOKEN: TOKEN }));
      tool(hostTool, `echo ${renamedMachineId}`);
      await run(await unpack("auto", "Work"), env({ USAGERATIO_API_TOKEN: TOKEN }));
      const configFile = path.join(home, ".config/usageratio/config");
      expect(readFileSync(configFile, "utf8")).toContain(`MACHINE_ID='${hostMachineId}'`);

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
  },
);
