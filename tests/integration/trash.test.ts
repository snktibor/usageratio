import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as restoreRoute } from "@/app/api/trash/[id]/restore/route";
import { DELETE as purgeRoute } from "@/app/api/trash/[id]/route";
import { GET as listRoute } from "@/app/api/trash/route";
import { ingestReport } from "@/lib/ingest";
import { deleteGroup } from "@/lib/manage-store";
import { getRedis } from "@/lib/redis";
import { sha256Hex } from "@/lib/security";
import { serializeGroupEntry } from "@/lib/settings";
import { loadEvents, loadIndexes } from "@/lib/usage-store";
import { manageTrail } from "../helpers/manage-audit";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";
import { KEYS, tenant } from "../helpers/tenant";

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
/** When the reports were made: the routes read the real clock, so this is a day before it. */
const REPORTED = new Date(Date.now() - 86_400_000);

async function ingest(groupId: string, now = REPORTED) {
  const result = await ingestReport(
    tenant,
    { machineId: "mac", groupId, providers: { claude: 100 }, timestamp: now.toISOString() },
    now,
  );
  if (!result.ok) throw new Error("report refused");
}

async function trashed(groupId: string): Promise<string> {
  await ingest(groupId);
  const result = await deleteGroup(tenant, groupId, true, new Date());
  if (!result.ok || !result.trashId) throw new Error("not trashed");
  return result.trashId;
}

async function grantSudo(cookie: string): Promise<void> {
  const sessionId = cookie.split("=")[1]!;
  await getRedis().set(`usage:session:${sha256Hex(`${sessionId}:${PIN}`)}:sudo`, "1", { ex: 300 });
}

function request(method: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/trash/x", { method, headers: { ...ORIGIN, ...headers } });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const UNKNOWN = "AAAAAAAAAAAAAAAA";

describe("GET /api/trash", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a session", async () => {
    expect((await listRoute(request("GET"))).status).toBe(401);
  });

  it("answers 200 with an empty list", async () => {
    const cookie = await seedSession(PIN);
    const response = await listRoute(request("GET", { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], retentionDays: 30 });
  });

  it("lists what was force-deleted, newest first", async () => {
    const cookie = await seedSession(PIN);
    const first = await trashed("Work");
    const second = await trashed("Home");
    const body = (await (await listRoute(request("GET", { cookie }))).json()) as {
      entries: {
        id: string;
        kind: string;
        name: string;
        affected: unknown;
        by: unknown;
        expiresAt: number;
        deletedAt: number;
      }[];
    };
    expect(body.entries.map((entry) => entry.id)).toEqual([second, first]);
    expect(body.entries[0]).toMatchObject({
      kind: "group",
      name: "Home",
      by: null,
      affected: { events: 1, machines: 1, groups: 1 },
    });
    expect(body.entries[0]!.expiresAt - body.entries[0]!.deletedAt).toBe(30 * 86_400_000);
  });
});

describe("POST /api/trash/[id]/restore", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 for a foreign origin before anything else", async () => {
    const response = await restoreRoute(request("POST", { origin: "https://evil.example" }), params(UNKNOWN));
    expect(response.status).toBe(403);
  });

  it("answers 401 without a session", async () => {
    expect((await restoreRoute(request("POST"), params(UNKNOWN))).status).toBe(401);
  });

  it("answers 403 sudo_required with a session but no sudo grant, and restores nothing", async () => {
    const cookie = await seedSession(PIN);
    const id = await trashed("Work");
    const response = await restoreRoute(request("POST", { cookie }), params(id));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(1);
  });

  it("answers 400 for an id that is no trash id", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const response = await restoreRoute(request("POST", { cookie }), params("../settings"));
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown entry", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const response = await restoreRoute(request("POST", { cookie }), params(UNKNOWN));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("not_found");
  });

  it("answers 409 too_many_groups past the cap, and keeps the entry", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const id = await trashed("Work");
    for (let i = 0; i < 50; i += 1)
      await getRedis().hset(KEYS.groups, { [`g${i}`]: serializeGroupEntry("#3987e5", 1) });
    const response = await restoreRoute(request("POST", { cookie }), params(id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("too_many_groups");
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(1);
  });

  it("answers 200 and puts the group's reports back, then 404 for the same entry", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const id = await trashed("Work");
    expect((await loadIndexes(tenant)).groups.map((group) => group.groupId)).not.toContain("Work");

    const response = await restoreRoute(request("POST", { cookie }), params(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      kind: "group",
      id: "Work",
      restored: { events: 1, machines: 1 },
      merged: false,
      group: { id: "Work", excluded: [] },
    });
    const indexes = await loadIndexes(tenant);
    const { eventsByProvider } = await loadEvents(tenant, ["claude"], indexes.groups, REPORTED.getTime() - 1);
    expect(eventsByProvider.claude?.map((event) => event.groupId)).toEqual(["Work"]);
    expect((await manageTrail())[0]).toMatchObject({ action: "trash_restored", trashId: id });

    expect((await restoreRoute(request("POST", { cookie }), params(id))).status).toBe(404);
  });
});

describe("DELETE /api/trash/[id]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 for a foreign origin, 401 without a session, 403 sudo_required without a grant", async () => {
    expect((await purgeRoute(request("DELETE", { origin: "https://evil.example" }), params(UNKNOWN))).status).toBe(403);
    expect((await purgeRoute(request("DELETE"), params(UNKNOWN))).status).toBe(401);
    const cookie = await seedSession(PIN);
    const id = await trashed("Work");
    const response = await purgeRoute(request("DELETE", { cookie }), params(id));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
    expect(await getRedis().exists(KEYS.trashEntry(id))).toBe(1);
  });

  it("answers 400 for an invalid id and 404 for an unknown one", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    expect((await purgeRoute(request("DELETE", { cookie }), params("short"))).status).toBe(400);
    expect((await purgeRoute(request("DELETE", { cookie }), params(UNKNOWN))).status).toBe(404);
  });

  it("answers 200 and deletes the entry for good, then 404", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const id = await trashed("Work");

    const response = await purgeRoute(request("DELETE", { cookie }), params(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, affected: { events: 1, machines: 1, groups: 1 } });
    expect(await getRedis().exists(KEYS.trashEntry(id), KEYS.trashEvents(id, "claude", "Work"))).toBe(0);
    expect((await manageTrail())[0]).toMatchObject({ action: "trash_purged", trashId: id });

    expect((await purgeRoute(request("DELETE", { cookie }), params(id))).status).toBe(404);
  });
});
