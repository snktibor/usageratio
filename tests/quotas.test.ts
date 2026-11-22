import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MACHINES, WORKSPACE_QUOTAS } from "@/lib/config";
import { createInvite, MAX_PENDING_INVITES } from "@/lib/invites";
import { MAX_PROVIDERS } from "@/lib/providers";
import { loadQuotaRefusals, QUOTA_REFUSAL_DAYS, quotaRefusalMessage, recordQuotaRefusal } from "@/lib/quota-refusals";
import {
  countMachines,
  growsPast,
  machineCounting,
  machineIdOfField,
  machinesGrowPast,
  workspaceQuotas,
} from "@/lib/quotas";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { MAX_GROUPS } from "@/lib/settings";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { MAX_TOKENS } from "@/lib/tokens";
import { useRedis } from "./helpers/redis-fixture";
import { tenant } from "./helpers/tenant";

const MULTI = { REGISTRATION: "invite" };
const CLOSED = { REGISTRATION: "" };

describe("workspaceQuotas", () => {
  it("is the design's quota table in multi-tenant mode", () => {
    expect(workspaceQuotas(MULTI)).toEqual({
      machines: 25,
      providers: 20,
      groups: 20,
      tokens: 50,
      members: 10,
      pendingInvites: 10,
      ownedWorkspaces: 3,
    });
    expect(workspaceQuotas({ REGISTRATION: "open" })).toEqual({ ...WORKSPACE_QUOTAS });
    // A copy: nobody can change the table through it.
    workspaceQuotas(MULTI).machines = 1;
    expect(workspaceQuotas(MULTI).machines).toBe(25);
  });

  it("keeps today's instance-wide caps on a single-user instance", () => {
    expect(workspaceQuotas(CLOSED)).toEqual({
      machines: MAX_MACHINES,
      providers: MAX_PROVIDERS,
      groups: MAX_GROUPS,
      tokens: MAX_TOKENS,
      members: null,
      pendingInvites: MAX_PENDING_INVITES,
      ownedWorkspaces: null,
    });
    expect(workspaceQuotas(CLOSED)).toMatchObject({ machines: 200, groups: 50, tokens: 100 });
  });
});

describe("machine counting", () => {
  const fields = ["claude:mac", "openai:mac", "claude:win", "gemini:mac"];

  it("counts entries on a single-user instance and distinct machines in multi-tenant mode", () => {
    expect(machineCounting(CLOSED)).toBe("entries");
    expect(machineCounting(MULTI)).toBe("machines");
    expect(countMachines(fields, "entries")).toBe(4);
    expect(countMachines(fields, "machines")).toBe(2);
  });

  it("reads the machine id after the provider id, colons in it included", () => {
    expect(machineIdOfField("claude:mac")).toBe("mac");
    expect(machineIdOfField("claude:host:8080")).toBe("host:8080");
  });

  it("refuses only growth that ends over the limit", () => {
    expect(growsPast(24, 25, 25)).toBe(false);
    expect(growsPast(25, 26, 25)).toBe(true);
    // Already over: staying, or shrinking, is never refused.
    expect(growsPast(30, 30, 25)).toBe(false);
    expect(growsPast(30, 29, 25)).toBe(false);
    expect(growsPast(30, 31, 25)).toBe(true);

    expect(machinesGrowPast(fields, ["openai:win"], 2, "machines")).toBe(false);
    expect(machinesGrowPast(fields, ["claude:new"], 2, "machines")).toBe(true);
    expect(machinesGrowPast(fields, ["openai:win"], 4, "entries")).toBe(true);
    expect(machinesGrowPast(fields, ["claude:mac"], 4, "entries")).toBe(false);
  });
});

describe("quota refusals", () => {
  useRedis();
  const NOW = new Date("2026-11-19T12:00:00Z");
  const other = tenantStore("AAAAAAAAAAAAAAAAAAAAAA" as TenantId);

  it("keeps the newest refusal of each kind, newest first, for a week", async () => {
    const refusal = { limit: 25, machineId: "box", groupId: "Lab" };
    await recordQuotaRefusal(tenant, { ...refusal, code: "too_many_machines", at: NOW.getTime() - 3_600_000 });
    await recordQuotaRefusal(tenant, { ...refusal, code: "too_many_machines", at: NOW.getTime() - 60_000 });
    await recordQuotaRefusal(tenant, { ...refusal, code: "too_many_groups", at: NOW.getTime() - 120_000, limit: 20 });
    expect(await loadQuotaRefusals(tenant, NOW)).toEqual([
      { code: "too_many_machines", at: NOW.getTime() - 60_000, limit: 25, machineId: "box", groupId: "Lab" },
      { code: "too_many_groups", at: NOW.getTime() - 120_000, limit: 20, machineId: "box", groupId: "Lab" },
    ]);
    const later = new Date(NOW.getTime() + QUOTA_REFUSAL_DAYS * 86_400_000);
    expect(await loadQuotaRefusals(tenant, later)).toEqual([]);
    expect(getMemoryStoreForTests()?.ttl(tenant.keys.quotaRefusals) ?? QUOTA_REFUSAL_DAYS * 86_400).toBe(
      QUOTA_REFUSAL_DAYS * 86_400,
    );
    // Another workspace's are its own.
    expect(await loadQuotaRefusals(other, NOW)).toEqual([]);
  });

  it("skips an entry it cannot read", async () => {
    await getRedis().hset(tenant.keys.quotaRefusals, {
      too_many_machines: "not json",
      too_many_providers: JSON.stringify({ at: NOW.getTime(), limit: "20", m: "x", g: "y" }),
      too_many_groups: JSON.stringify({ at: NOW.getTime(), limit: 20, m: "x", g: "y" }),
      unknown_code: JSON.stringify({ at: NOW.getTime(), limit: 1, m: "x", g: "y" }),
    });
    expect((await loadQuotaRefusals(tenant, NOW)).map((refusal) => refusal.code)).toEqual(["too_many_groups"]);
  });

  it("writes the client's message in the default language, or the one the request names", async () => {
    const plain = new Request("http://localhost/api/usage");
    expect(await quotaRefusalMessage("too_many_providers", 20, plain)).toMatch(
      /^This workspace has reached its limit of 20 providers/,
    );
    const hungarian = new Request("http://localhost/api/usage?locale=hu");
    expect(await quotaRefusalMessage("too_many_machines", 25, hungarian)).toMatch(
      /^A munkaterület elérte a\(z\) 25 gépes/,
    );
    const unknown = new Request("http://localhost/api/usage?locale=xx");
    expect(await quotaRefusalMessage("too_many_groups", 20, unknown)).toMatch(/^This workspace/);
  });
});

describe("invite quotas", () => {
  useRedis();
  afterEach(() => vi.unstubAllEnvs());

  it("counts pending invites against the single-user instance's cap too", async () => {
    vi.stubEnv("REGISTRATION", "");
    const tenantId = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;
    for (let i = 0; i < MAX_PENDING_INVITES; i += 1) {
      expect((await createInvite(tenantId, "u_owner", null, new Date())).ok).toBe(true);
    }
    expect(await createInvite(tenantId, "u_owner", null, new Date())).toEqual({
      ok: false,
      reason: "too_many_invites",
      limit: MAX_PENDING_INVITES,
    });
  });
});

describe("the workspace view's quotas", () => {
  useRedis();

  it("carries the people quotas, and names a workspace without a record by its id", async () => {
    const { loadWorkspaceView } = await import("@/lib/workspace");
    const store = tenantStore("CCCCCCCCCCCCCCCCCCCCCC" as TenantId);
    const view = await loadWorkspaceView({ store, role: "member", userId: "u_someone" }, new Date());
    expect(view.name).toBe("CCCCCCCCCCCCCCCCCCCCCC");
    expect(view.quotas).toEqual({ members: 10, pendingInvites: 10, ownedWorkspaces: 3 });
  });
});
