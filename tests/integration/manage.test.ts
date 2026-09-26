import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteGroupRoute, PATCH as patchGroup } from "@/app/api/groups/[group]/route";
import { DELETE as deleteMachineRoute, PATCH as patchMachine } from "@/app/api/machines/[provider]/[machine]/route";
import { POST as pruneMachinesRoute } from "@/app/api/machines/prune/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { DELETE as deleteProviderRoute } from "@/app/api/providers/[provider]/route";
import { INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const NOW = new Date("2026-09-23T00:00:00Z");

async function ingest(body: Record<string, unknown>, now = NOW) {
  const result = await ingestReport(
    { machineId: "mac", groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString(), ...body },
    now,
  );
  if (!result.ok) throw new Error("errors" in result ? result.errors.join("; ") : JSON.stringify(result));
  return result;
}

/** Grants sudo directly on the session the cookie carries, the way the settings panel would after POST /api/auth/sudo. */
async function grantSudo(cookie: string): Promise<void> {
  const sessionId = cookie.split("=")[1]!;
  await getRedis().set(`usage:session:${sha256Hex(`${sessionId}:${PIN}`)}:sudo`, "1", { ex: 300 });
}

function request(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Request(url, {
    method: options.method,
    body: options.body,
    headers: {
      ...ORIGIN,
      ...(options.body !== undefined && { "content-type": "application/json" }),
      ...options.headers,
    },
  });
}

describe("GET /api/machines", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a session", async () => {
    const response = await getMachines(request("http://localhost/api/machines"));
    expect(response.status).toBe(401);
  });

  it("answers 200 with every known machine", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ machineId: "mac-1" });

    const response = await getMachines(request("http://localhost/api/machines", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { machines: unknown[] };
    expect(body.machines).toEqual([
      { providerId: "claude", machineId: "mac-1", groupId: "Personal", lastSeenAt: NOW.getTime(), lastTokens: 100 },
    ]);
  });
});

describe("PATCH /api/machines/[provider]/[machine]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ provider: "claude", machine: "mac-1" });

  it("answers 403 for a foreign origin before checking the session", async () => {
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", {
        method: "PATCH",
        body: JSON.stringify({ id: "mac-2" }),
        headers: { origin: "https://evil.example" },
      }),
      { params },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("forbidden_origin");
  });

  it("answers 401 without a session", async () => {
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", { method: "PATCH", body: JSON.stringify({ id: "mac-2" }) }),
      { params },
    );
    expect(response.status).toBe(401);
  });

  it("answers 400 for an invalid body", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ machineId: "mac-1" });
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", {
        method: "PATCH",
        body: JSON.stringify({ id: "" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_payload");
  });

  it("answers 404 for a machine that does not exist", async () => {
    const cookie = await seedSession(PIN);
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", {
        method: "PATCH",
        body: JSON.stringify({ id: "mac-2" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("not_found");
  });

  it("answers 409 machine_exists onto an id already used by the provider", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ machineId: "mac-1" });
    await ingest({ machineId: "mac-2" });
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", {
        method: "PATCH",
        body: JSON.stringify({ id: "mac-2" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("machine_exists");
  });

  it("answers 200 and renames it, without needing sudo", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ machineId: "mac-1" });
    const response = await patchMachine(
      request("http://localhost/api/machines/claude/mac-1", {
        method: "PATCH",
        body: JSON.stringify({ id: "mac-1-renamed" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 0 } });
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1-renamed")).toBe(1);
  });
});

describe("DELETE /api/machines/[provider]/[machine]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ provider: "claude", machine: "mac-1" });

  it("answers 403 sudo_required with a session but no sudo grant", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ machineId: "mac-1" });
    const response = await deleteMachineRoute(
      request("http://localhost/api/machines/claude/mac-1", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(1);
  });

  it("answers 200 and deletes it once sudo is granted", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({ machineId: "mac-1" });
    const response = await deleteMachineRoute(
      request("http://localhost/api/machines/claude/mac-1", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).affected).toEqual({ events: 1, machines: 1, groups: 0 });
    expect(await getRedis().hexists(KEYS.machines, "claude:mac-1")).toBe(0);
  });
});

describe("POST /api/machines/prune", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 sudo_required with a session but no sudo grant", async () => {
    const cookie = await seedSession(PIN);
    const response = await pruneMachinesRoute(
      request("http://localhost/api/machines/prune", { method: "POST", headers: { cookie } }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
  });

  it("answers 200 and removes the silent machines once sudo is granted", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const staleMs = NOW.getTime() - (INACTIVE_MACHINE_DAYS + 1) * 86_400_000;
    await getRedis().hset(KEYS.machines, { "claude:old": JSON.stringify({ g: "Personal", ts: staleMs, t: 1 }) });

    const response = await pruneMachinesRoute(
      request("http://localhost/api/machines/prune", { method: "POST", headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).affected).toEqual({ events: 0, machines: 1, groups: 0 });
    expect(await getRedis().hexists(KEYS.machines, "claude:old")).toBe(0);
  });
});

describe("PATCH /api/groups/[group]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ group: "Work" });

  it("answers 401 without a session", async () => {
    const response = await patchGroup(
      request("http://localhost/api/groups/Work", { method: "PATCH", body: JSON.stringify({ id: "Team" }) }),
      { params },
    );
    expect(response.status).toBe(401);
  });

  it("answers 200 and renames the group, without needing sudo", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ groupId: "Work" });
    const response = await patchGroup(
      request("http://localhost/api/groups/Work", {
        method: "PATCH",
        body: JSON.stringify({ id: "Team" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(await getRedis().hexists(KEYS.groups, "Team")).toBe(1);
  });

  it("answers 409 group_exists onto a group that already exists, without merge", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ groupId: "Work" });
    await ingest({ groupId: "Team" });
    const response = await patchGroup(
      request("http://localhost/api/groups/Work", {
        method: "PATCH",
        body: JSON.stringify({ id: "Team" }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("group_exists");
  });

  it("answers 403 sudo_required for a merge without a sudo grant, and does not merge", async () => {
    const cookie = await seedSession(PIN);
    await ingest({ groupId: "Work" });
    await ingest({ groupId: "Team" });
    const response = await patchGroup(
      request("http://localhost/api/groups/Work", {
        method: "PATCH",
        body: JSON.stringify({ id: "Team", merge: true }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(1);
  });

  it("answers 200 and merges once sudo is granted", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({ groupId: "Work" });
    await ingest({ groupId: "Team" });
    const response = await patchGroup(
      request("http://localhost/api/groups/Work", {
        method: "PATCH",
        body: JSON.stringify({ id: "Team", merge: true }),
        headers: { cookie },
      }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().hexists(KEYS.groups, "Team")).toBe(1);
  });
});

describe("DELETE /api/groups/[group]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ group: "Work" });

  it("answers 403 sudo_required with a session but no sudo grant", async () => {
    const cookie = await seedSession(PIN);
    const response = await deleteGroupRoute(
      request("http://localhost/api/groups/Work", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
  });

  it("answers 409 group_has_events without force, once sudo is granted", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({ groupId: "Work" });
    const response = await deleteGroupRoute(
      request("http://localhost/api/groups/Work", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("group_has_events");
  });

  it("answers 200 with ?force=1, deleting its events too", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({ groupId: "Work" });
    const response = await deleteGroupRoute(
      request("http://localhost/api/groups/Work?force=1", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(await getRedis().hexists(KEYS.groups, "Work")).toBe(0);
    expect(await getRedis().exists(KEYS.events("claude", "Work"))).toBe(0);
  });
});

describe("DELETE /api/providers/[provider]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ provider: "claude" });

  it("answers 403 sudo_required with a session but no sudo grant", async () => {
    const cookie = await seedSession(PIN);
    const response = await deleteProviderRoute(
      request("http://localhost/api/providers/claude", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
  });

  it("answers 409 provider_has_events without force, once sudo is granted", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({});
    const response = await deleteProviderRoute(
      request("http://localhost/api/providers/claude", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("provider_has_events");
  });

  it("answers 200 with ?force=1, removing the provider entirely", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    await ingest({});
    const response = await deleteProviderRoute(
      request("http://localhost/api/providers/claude?force=1", { method: "DELETE", headers: { cookie } }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(await getRedis().hexists(KEYS.providers, "claude")).toBe(0);
  });

  it("answers 404 for a provider that does not exist", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const response = await deleteProviderRoute(
      request("http://localhost/api/providers/ghost?force=1", { method: "DELETE", headers: { cookie } }),
      { params: Promise.resolve({ provider: "ghost" }) },
    );
    expect(response.status).toBe(404);
  });
});
