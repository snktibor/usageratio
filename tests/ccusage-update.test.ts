import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CCUSAGE_VERSION } from "@/lib/setup";

// scripts/ccusage-update.mjs, the pin bump behind .github/workflows/ccusage-update.yml. The
// smoke test itself runs real ccusage releases through npx, so only the workflow runs it.
const SCRIPT = "../scripts/ccusage-update.mjs";
type Read = (file: string) => string;
const { bumpedSources, compareVersions, currentVersion, pickCandidate } = (await import(SCRIPT)) as {
  bumpedSources: (version: string, read?: Read) => { file: string; content: string }[];
  compareVersions: (a: string, b: string) => number;
  currentVersion: (read?: Read) => string;
  pickCandidate: (times: Record<string, string>, current: string, cooldownDays: number, now?: number) => string | null;
};

const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("compareVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareVersions("20.0.10", "20.0.9")).toBeGreaterThan(0);
    expect(compareVersions("19.9.9", "20.0.0")).toBeLessThan(0);
    expect(compareVersions("20.1.0", "20.1.0")).toBe(0);
  });

  it("refuses anything but x.y.z", () => {
    expect(() => compareVersions("20.0.1-beta.1", "20.0.0")).toThrow(/stable/);
  });
});

describe("pickCandidate", () => {
  const times = {
    created: "2025-01-01T00:00:00Z",
    modified: "2026-11-10T00:00:00Z",
    "20.0.24": "2026-10-01T00:00:00Z",
    "20.0.47": "2026-11-01T00:00:00Z",
    "20.0.48": "2026-11-06T00:00:00Z",
    "20.1.0-beta.1": "2026-11-02T00:00:00Z",
    "20.0.49": "2026-11-09T00:00:00Z",
  };

  it("takes the newest stable release that is past the cooldown", () => {
    expect(pickCandidate(times, "20.0.24", 3, NOW)).toBe("20.0.48");
    expect(pickCandidate(times, "20.0.24", 0, NOW)).toBe("20.0.49");
    expect(pickCandidate(times, "20.0.24", 30, NOW)).toBeNull();
  });

  it("never goes back to, or stays at, the pinned version", () => {
    expect(pickCandidate(times, "20.0.48", 3, NOW)).toBeNull();
    expect(pickCandidate(times, "20.0.99", 0, NOW)).toBeNull();
  });
});

describe("currentVersion and bumpedSources", () => {
  it("reads the pin the clients and lib/setup.ts share", () => {
    expect(currentVersion()).toBe(CCUSAGE_VERSION);
  });

  it("rewrites every pin site and nothing else", () => {
    const files = new Map(bumpedSources("99.1.2").map(({ file, content }) => [file, content] as const));
    expect([...files.keys()].sort()).toEqual([
      "clients/shared/report-usage-core.ps1",
      "clients/shared/report-usage-core.sh",
      "lib/setup.ts",
    ]);
    expect(currentVersion((file) => files.get(file) ?? "")).toBe("99.1.2");
    for (const [file, content] of files) {
      expect(content.replaceAll("99.1.2", CCUSAGE_VERSION)).toBe(readFileSync(file, "utf8"));
    }
  });

  it("refuses a pre-release or anything that is not a version", () => {
    expect(() => bumpedSources("20.1.0-beta.1")).toThrow(/stable/);
    expect(() => bumpedSources("latest")).toThrow(/stable/);
  });

  it("notices pins that disagree", () => {
    const disagreeing = bumpedSources("99.1.2").map(({ file, content }) => [file, content] as const);
    const read = (file: string) =>
      file === "lib/setup.ts" ? readFileSync(file, "utf8") : (new Map(disagreeing).get(file) ?? "");
    expect(() => currentVersion(read)).toThrow(/disagree/);
  });
});
