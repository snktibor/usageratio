import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEE = path.resolve("clients/macos/scripts/statusline-tee.sh");
const INPUT = JSON.stringify({
  model: { display_name: "Opus" },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
});

describe.skipIf(process.platform === "win32")("statusline-tee.sh", () => {
  let dir: string;
  let script: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "usageratio-tee-"));
    script = path.join(dir, "statusline.sh");
    // Stands in for the user's own status line: colours, no trailing newline, a non-zero exit.
    writeFileSync(
      script,
      '#!/bin/bash\ninput=$(cat)\nprintf "\\033[32m%s\\033[0m" "$(echo "$input" | jq -r .model.display_name)"\nexit 3\n',
      {
        mode: 0o755,
      },
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (input: string, extraEnv: Record<string, string> = {}) =>
    spawnSync("bash", [TEE, script], { input, env: { ...process.env, USAGERATIO_DIR: dir, ...extraEnv } });

  it("prints exactly what the user's script prints, and keeps its exit code", () => {
    const direct = spawnSync(script, [], { input: INPUT });
    const through = run(INPUT);
    expect(through.stdout.equals(direct.stdout)).toBe(true);
    expect(through.stderr.toString()).toBe(direct.stderr.toString());
    expect(through.status).toBe(3);
  });

  it("saves the limits Claude Code handed over", () => {
    run(INPUT);
    const saved = JSON.parse(readFileSync(path.join(dir, "claude-limits.json"), "utf8"));
    expect(saved.rate_limits.seven_day.used_percentage).toBe(41.2);
    expect(typeof saved.observed_at).toBe("number");
  });

  it("keeps the last snapshot when a session has no weekly figure", () => {
    run(INPUT);
    const before = readFileSync(path.join(dir, "claude-limits.json"), "utf8");
    run(JSON.stringify({ model: { display_name: "Opus" } }));
    expect(readFileSync(path.join(dir, "claude-limits.json"), "utf8")).toBe(before);
  });

  it("still prints the status line when the snapshot cannot be written", () => {
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "a file, not a folder");
    const through = spawnSync("bash", [TEE, script], {
      input: INPUT,
      env: { ...process.env, USAGERATIO_DIR: blocked },
    });
    expect(through.stdout.toString()).toContain("Opus");
    expect(through.status).toBe(3);
    expect(existsSync(path.join(blocked, "claude-limits.json"))).toBe(false);
  });

  it("passes the bytes through even without a weekly figure", () => {
    const plain = JSON.stringify({ model: { display_name: "Sonnet" } });
    expect(run(plain).stdout.equals(spawnSync(script, [], { input: plain }).stdout)).toBe(true);
  });
});
