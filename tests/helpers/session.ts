import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { sha256Hex } from "@/lib/security";

/**
 * A live dashboard session for the integration tests: writes the session key
 * `isAuthenticated` (lib/auth.ts) looks up and returns the `Cookie` header
 * value a browser holding it would send. The caller stubs `DASHBOARD_PIN` to
 * the same `pin` first (`vi.stubEnv("DASHBOARD_PIN", pin)`).
 */
export async function seedSession(pin = "12345"): Promise<string> {
  const sessionId = randomBytes(32).toString("base64url");
  await getRedis().set(`usage:session:${sha256Hex(`${sessionId}:${pin}`)}`, "1");
  return `usageratio_session=${sessionId}`;
}
