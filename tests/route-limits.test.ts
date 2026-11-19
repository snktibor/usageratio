import { describe, expect, it } from "vitest";
import {
  INGEST_RATE_LIMIT_INSTANCE,
  INGEST_RATE_LIMIT_PER_MACHINE,
  INGEST_RATE_LIMIT_PER_MACHINE_MULTI,
  INGEST_RATE_LIMIT_PER_TENANT,
  SIGN_IN_RATE_LIMIT_PER_IP,
  SIGN_IN_RATE_LIMIT_UNKNOWN_IP,
} from "@/lib/config";
import {
  alertTestRules,
  cycleRules,
  exportRules,
  hourBucket,
  ingestRules,
  ipKey,
  officialReportRules,
  registrationRules,
  secondsToHourEnd,
  signInRules,
} from "@/lib/route-limits";

const NOW = new Date("2026-11-19T15:45:30Z");
const scopes = (rules: { scope: string }[]) => rules.map((rule) => rule.scope);

describe("route limits", () => {
  it("names the UTC hour and the seconds left in it", () => {
    expect(hourBucket(NOW)).toBe("2026111915");
    expect(hourBucket(new Date("2026-01-02T03:00:00Z"))).toBe("2026010203");
    expect(secondsToHourEnd(NOW)).toBe(14 * 60 + 30);
    expect(secondsToHourEnd(new Date("2026-11-19T15:00:00Z"))).toBe(3600);
    expect(secondsToHourEnd(new Date("2026-11-19T15:59:59.900Z"))).toBe(1);
  });

  it("hashes a known address and has no key for an unknown one", () => {
    expect(ipKey("203.0.113.7")).toMatch(/^[0-9a-f]{32}$/);
    expect(ipKey("unknown")).toBeNull();
  });

  it("checks ingest narrowest first: machine, address, tenant, instance", () => {
    const base = { tokenId: "tok", tenantId: "t1", machineId: "mac", ip: "203.0.113.7", now: NOW };
    const multi = ingestRules({ ...base, multiTenant: true });
    expect(scopes(multi)).toEqual(["machine", "ip", "tenant", "instance"]);
    expect(multi.map((rule) => rule.limit)).toEqual([
      INGEST_RATE_LIMIT_PER_MACHINE_MULTI,
      1_200,
      INGEST_RATE_LIMIT_PER_TENANT,
      INGEST_RATE_LIMIT_INSTANCE,
    ]);
    expect(multi[2]!.key).toBe("usage:rl:ingest-tenant:t1:2026111915");
    expect(multi[3]!.key).toBe("usage:rl:ingest:global:2026111915");
    // The clock-hour counters expire at the turn of the hour.
    expect(multi[2]!.windowSeconds).toBe(870);
    expect(multi[3]!.windowSeconds).toBe(870);

    expect(ingestRules({ ...base, multiTenant: false })[0]!.limit).toBe(INGEST_RATE_LIMIT_PER_MACHINE);
    expect(scopes(ingestRules({ ...base, machineId: null, ip: "unknown", multiTenant: true }))).toEqual([
      "tenant",
      "instance",
    ]);
  });

  it("keys one machine's counter by its token too", () => {
    const rules = (tokenId: string) =>
      ingestRules({ tokenId, tenantId: "t1", machineId: "mac", ip: "unknown", multiTenant: true, now: NOW });
    expect(rules("a")[0]!.key).not.toBe(rules("b")[0]!.key);
  });

  it("limits the cycle lookup per token", () => {
    expect(cycleRules("tok")).toEqual([
      { name: "cycle", scope: "token", key: "usage:rl:cycle:tok", limit: 120, windowSeconds: 3600 },
    ]);
  });

  it("limits official reports per token, address and tenant", () => {
    expect(scopes(officialReportRules({ tokenId: "tok", tenantId: "t1", ip: "203.0.113.7" }))).toEqual([
      "token",
      "ip",
      "tenant",
    ]);
    expect(scopes(officialReportRules({ tokenId: "tok", tenantId: "t1", ip: "unknown" }))).toEqual(["token", "tenant"]);
  });

  it("limits exports per address and tenant", () => {
    expect(scopes(exportRules({ tenantId: "t1", ip: "203.0.113.7" }))).toEqual(["ip", "tenant"]);
    expect(exportRules({ tenantId: "t1", ip: "unknown" })).toHaveLength(1);
  });

  it("limits alert tests per tenant burst, address and tenant hour", () => {
    const rules = alertTestRules({ tenantId: "t1", ip: "203.0.113.7" });
    expect(rules.map((rule) => [rule.scope, rule.limit, rule.windowSeconds])).toEqual([
      ["tenant", 1, 10],
      ["ip", 60, 3600],
      ["tenant", 30, 3600],
    ]);
    expect(rules[0]!.key).toBe("usage:rl:alerts-test:t1");
  });

  it("gives sign-in a per-address budget, and a shared larger one without a trusted proxy", () => {
    const known = signInRules("203.0.113.7");
    expect(known[0]!.limit).toBe(SIGN_IN_RATE_LIMIT_PER_IP);
    expect(known[0]!.key).toMatch(/^usage:rl:oauth:[0-9a-f]{32}$/);
    const unknown = signInRules("unknown");
    expect(unknown[0]!.limit).toBe(SIGN_IN_RATE_LIMIT_UNKNOWN_IP);
    expect(unknown[0]!.key).toBe("usage:rl:oauth:unknown");
  });

  it("limits new workspaces per address per day, then per instance hour", () => {
    const rules = registrationRules("203.0.113.7", NOW);
    expect(rules.map((rule) => [rule.scope, rule.limit, rule.windowSeconds])).toEqual([
      ["ip", 5, 86_400],
      ["instance", 50, 870],
    ]);
    expect(scopes(registrationRules("unknown", NOW))).toEqual(["instance"]);
  });
});
