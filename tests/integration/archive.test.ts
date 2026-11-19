import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH as patchGroup } from "@/app/api/groups/[group]/route";
import { PATCH as patchMachine } from "@/app/api/machines/[provider]/[machine]/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { GET as getSettings } from "@/app/api/settings/route";
import { ingestReport } from "@/lib/ingest";
import { loadIndexes } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";
import { tenant } from "../helpers/tenant";

/** Archiving a group or a machine over the API (lib/archived.ts): no sudo, nothing deleted. */

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const NOW = new Date("2026-09-23T00:00:00Z");

async function ingest(body: Record<string, unknown> = {}) {
  const result = await ingestReport(
    tenant,
    { machineId: "mac", groupId: "Personal", providers: { claude: 100 }, timestamp: NOW.toISOString(), ...body },
    NOW,
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
}

function patch(url: string, body: unknown, cookie?: string) {
  return new Request(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { ...ORIGIN, "content-type": "application/json", ...(cookie && { cookie }) },
  });
}

describe("PATCH /api/groups/[group] { archived }", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ group: "Personal" });
  const url = "http://localhost/api/groups/Personal";

  it("archives and restores the group without sudo, and GET /api/settings shows the mark", async () => {
    const cookie = await seedSession(PIN);
    await ingest();

    const archived = await patchGroup(patch(url, { archived: true }, cookie), { params });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, changed: true });

    const settings = await getSettings(
      new Request("http://localhost/api/settings", { headers: { ...ORIGIN, cookie } }),
    );
    const view = (await settings.json()) as { groups: { id: string; archivedAt?: number }[] };
    expect(view.groups.find((group) => group.id === "Personal")?.archivedAt).toEqual(expect.any(Number));

    const again = await patchGroup(patch(url, { archived: true }, cookie), { params });
    expect(await again.json()).toEqual({ ok: true, changed: false });

    const restored = await patchGroup(patch(url, { archived: false }, cookie), { params });
    expect(await restored.json()).toEqual({ ok: true, changed: true });
    expect((await loadIndexes(tenant)).groups[0]).not.toHaveProperty("archivedAt");
  });

  it("answers 400 for a mark that is not a boolean, or that comes with a rename", async () => {
    const cookie = await seedSession(PIN);
    await ingest();
    for (const body of [{ archived: "yes" }, { archived: true, id: "Home" }, { archived: true, merge: true }]) {
      const response = await patchGroup(patch(url, body, cookie), { params });
      expect(response.status).toBe(400);
    }
  });

  it("answers 404 for an unknown group", async () => {
    const cookie = await seedSession(PIN);
    const response = await patchGroup(patch(url, { archived: true }, cookie), { params });
    expect(response.status).toBe(404);
  });
});

describe("PATCH /api/machines/[provider]/[machine] { archived }", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  const params = Promise.resolve({ provider: "claude", machine: "mac" });
  const url = "http://localhost/api/machines/claude/mac";

  it("archives and restores the entry without sudo, and GET /api/machines shows the mark", async () => {
    const cookie = await seedSession(PIN);
    await ingest();

    const archived = await patchMachine(patch(url, { archived: true }, cookie), { params });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, changed: true });

    const list = await getMachines(new Request("http://localhost/api/machines", { headers: { ...ORIGIN, cookie } }));
    const { machines } = (await list.json()) as { machines: { archivedAt?: number }[] };
    expect(machines[0]?.archivedAt).toEqual(expect.any(Number));

    const restored = await patchMachine(patch(url, { archived: false }, cookie), { params });
    expect(await restored.json()).toEqual({ ok: true, changed: true });
    const after = await getMachines(new Request("http://localhost/api/machines", { headers: { ...ORIGIN, cookie } }));
    expect(((await after.json()) as { machines: object[] }).machines[0]).not.toHaveProperty("archivedAt");
  });

  it("answers 400 for a mark that is not a boolean, or that comes with a move", async () => {
    const cookie = await seedSession(PIN);
    await ingest();
    for (const body of [
      { archived: 1 },
      { archived: true, id: "mac-2" },
      { archived: true, group: "Work" },
      { archived: false, merge: true },
    ]) {
      const response = await patchMachine(patch(url, body, cookie), { params });
      expect(response.status).toBe(400);
    }
  });

  it("answers 404 for an unknown machine", async () => {
    const cookie = await seedSession(PIN);
    const response = await patchMachine(patch(url, { archived: true }, cookie), { params });
    expect(response.status).toBe(404);
  });
});
