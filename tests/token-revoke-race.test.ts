import { describe, expect, it, vi } from "vitest";
import { authenticateToken, createToken, listTokens, revokeTokensCreatedBy } from "@/lib/tokens";
import { useRedis } from "./helpers/redis-fixture";
import { tenant } from "./helpers/tenant";

/**
 * A token revoked while its "last used" refresh is still waiting to be
 * written stays revoked: the refresh runs after the response (`defer`), and
 * must not write back the copy it read before the revocation. `defer` is
 * held here, so the revocation can land in between.
 */

const held: (() => Promise<void> | void)[] = [];
vi.mock("@/lib/request-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/request-context")>()),
  defer: (task: () => Promise<void> | void) => {
    held.push(task);
  },
}));

describe("revoking a token while its last-used refresh waits", () => {
  useRedis();

  it("keeps it revoked", async () => {
    const created = await createToken(tenant, "laptop", null, new Date(0), "ingest", "u_AAAAAAAAAAAAAAAAAAAAAA");
    if (!created.ok) throw new Error("unreachable");
    expect((await authenticateToken(tenant, created.token, new Date(1_000_000))).ok).toBe(true);
    expect(held).toHaveLength(1);

    expect(await revokeTokensCreatedBy(tenant, "u_AAAAAAAAAAAAAAAAAAAAAA", new Date(2_000_000))).toBe(1);
    await held[0]!();
    const [token] = await listTokens(tenant);
    expect(token?.revokedAt).toBe(2_000_000);
    expect((await authenticateToken(tenant, created.token, new Date(3_000_000))).ok).toBe(false);
  });
});
