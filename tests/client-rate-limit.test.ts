import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * clients/shared/report-usage-core.sh against a server that answers every
 * request 429: curl's --retry would otherwise wait out the Retry-After (up to
 * an hour on an hourly limit) three times over; --retry-max-time makes it give
 * up at once on a long one, and the next scheduled run tries again.
 */

let server: Server;
let port = 0;
let hits = 0;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "usageratio-429-"));
  server = createServer((request, response) => {
    hits += 1;
    const wait = request.url?.split("/")[2] ?? "60";
    response.writeHead(429, { "Content-Type": "application/json", "Retry-After": wait });
    response.end('{"error":"rate_limited"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function run(wait: number): Promise<{ code: number; output: string; log: string; seconds: number }> {
  const config = join(dir, `config-${wait}`);
  const logFile = join(dir, `log-${wait}`);
  writeFileSync(
    config,
    [
      `API_URL="http://127.0.0.1:${port}/wait/${wait}/api/usage"`,
      'API_TOKEN="test-token-0123456789"',
      'MACHINE_ID="mac"',
      'GROUP_ID="Personal"',
    ].join("\n"),
  );
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["clients/shared/report-usage-core.sh", "--tokens", "claude=5"],
      {
        env: {
          ...process.env,
          USAGERATIO_CONFIG: config,
          USAGERATIO_LOG_FILE: logFile,
          USAGERATIO_OUTPUT_MODE: "manual",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? Number(error.code) : 0,
          output: `${stdout}${stderr}`,
          log: readFileSync(logFile, "utf8"),
          seconds: (Date.now() - started) / 1000,
        });
      },
    );
  });
}

describe("report-usage-core.sh on a 429", () => {
  it("gives up at once on a long Retry-After, says it is rate limited, and exits 1", async () => {
    hits = 0;
    const result = await run(3600);
    expect(result.code).toBe(1);
    expect(hits).toBe(1);
    expect(result.seconds).toBeLessThan(20);
    expect(result.log).toMatch(/server answered HTTP 429: .*rate limited; the next run tries again/);
    // The menu bar app reads this line (clients/macos MachineReport.parse): it must keep "HTTP 429".
    expect(result.output).toMatch(/❌ Sync failed: server answered HTTP 429/);
  }, 30_000);
});
