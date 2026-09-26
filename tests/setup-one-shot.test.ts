import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CcusageRunner, renderOneShot } from "@/lib/setup";
import { loadClientSources, oneShotBlobs } from "@/lib/setup-package";

/**
 * Runs the macOS/Linux one-off report end to end, as pasted into a terminal:
 * the whole command goes to bash (or zsh) at once. HOME and TMPDIR are scratch
 * folders, so the test can see that nothing is left behind; ccusage and npx are
 * stand-ins, the server a local stub of /api/usage.
 */

const TOKEN = `0123456789abcdef'"$!\`x`;
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
      response.writeHead(401).end('{"error":"unauthorized"}');
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

function hasShell(name: string): boolean {
  try {
    execFileSync(name, ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("one-off report (macOS/Linux)", { timeout: 60_000 }, () => {
  let scratch: string;
  let home: string;
  let temp: string;
  let bin: string;
  let stub: Stub;

  function tool(name: string, script: string) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  async function script(runner: CcusageRunner, machineId = "", token = TOKEN): Promise<string> {
    const settings = { apiUrl: stub.url, groupId: "Otthoni gép", machineId };
    return renderOneShot("macos", runner, settings, token, oneShotBlobs(await loadClientSources()));
  }

  /**
   * The core puts the Homebrew folders first on PATH, where a real ccusage may
   * live: like the installer's PATH line, a config named by USAGERATIO_CONFIG
   * brings the stand-ins back to the front.
   */
  function run(shell: string, text: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const pathFile = path.join(scratch, "path.conf");
    writeFileSync(pathFile, `PATH='${bin}':"$PATH"\n`);
    const env = {
      HOME: home,
      TMPDIR: temp,
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: "en_US.UTF-8",
      USAGERATIO_CONFIG: pathFile,
    } as unknown as NodeJS.ProcessEnv;
    return new Promise((resolve) => {
      execFile(shell, ["-c", text], { env, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      });
    });
  }

  /** Nothing is left in the temporary folder or the home folder. */
  function expectNoTrace() {
    expect(readdirSync(temp)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }

  beforeEach(async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "usageratio-once-test-"));
    home = path.join(scratch, "home");
    temp = path.join(scratch, "tmp");
    bin = path.join(scratch, "tools");
    for (const folder of [home, temp, bin]) mkdirSync(folder);
    tool("node", `exec "${process.execPath}" "$@"`);
    tool("scutil", "echo test-mac");
    stub = await startServer();
  });

  afterEach(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each(["bash", "zsh"].filter(hasShell))("sends one report with the installed ccusage from %s", async (shell) => {
    tool("ccusage", `cat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`);
    tool("npx", "echo npx must not run >&2; exit 1");

    const result = await run(shell, await script("global"));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("✅ Sync successful: 1 providers sent.\n");
    expect(stub.reports).toEqual([
      expect.objectContaining({ machineId: "test-mac", groupId: "Otthoni gép", providers: { claude: 1234 } }),
    ]);
    expectNoTrace();
  });

  it("runs the current ccusage through npx when it is not installed", async () => {
    const calls = path.join(scratch, "npx-calls");
    tool(
      "npx",
      `echo "$*" >>"${calls}"\n[ "$1 $2" = "--yes ccusage@latest" ] || exit 1\ncat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`,
    );

    const result = await run("bash", await script("npx", "vendeg-gep"));

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(stub.reports).toEqual([expect.objectContaining({ machineId: "vendeg-gep", providers: { claude: 1234 } })]);
    expect(readFileSync(calls, "utf8")).toMatch(/^--yes ccusage@latest blocks .*\n--yes ccusage@latest daily /);
    expectNoTrace();
  });

  it("reports a refused token on the console and still cleans up", async () => {
    tool("ccusage", `cat <<'JSON'\n${JSON.stringify(CCUSAGE_REPORT)}\nJSON`);

    const result = await run("bash", await script("global", "", "wrong-token-0123456789"));

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/^❌ Sync failed: ccusage could not be read: Cycle endpoint answered HTTP 401/);
    expect(stub.reports).toEqual([]);
    expectNoTrace();
  });
});
