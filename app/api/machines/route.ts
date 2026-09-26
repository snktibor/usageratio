import { json, requireSession, withApiHandler } from "@/lib/api";
import { loadIndexes } from "@/lib/usage-store";

/**
 * GET /api/machines — every known machine, for the settings panel's Machines
 * section (rename, delete, prune). Behind the dashboard's session only: a
 * read, so it needs neither the origin check nor sudo.
 *
 *   → { "machines": [{ "providerId", "machineId", "groupId", "lastSeenAt", "lastTokens" }] }
 *
 * 200 ok · 401 no session · 503 Redis down
 */
export const GET = withApiHandler("api/machines", async () => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const indexes = await loadIndexes();
  return json(
    {
      machines: indexes.machines.map((machine) => ({
        providerId: machine.providerId,
        machineId: machine.machineId,
        groupId: machine.groupId,
        lastSeenAt: machine.lastSeenAt,
        lastTokens: machine.lastTokens,
      })),
    },
    200,
  );
});
