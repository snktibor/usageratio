import { randomBytes } from "node:crypto";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";

/**
 * Sign-up codes (REGISTRATION=invite): an instance admin's single-use code
 * that lets a new user create a workspace. 256 random bits; only the hash is
 * stored; a code expires after SIGNUP_CODE_DAYS, can be revoked, and is taken
 * with GETDEL when used, so it works exactly once. The link carries it in the
 * URL fragment (`/signup#code`), which a browser never sends to any server.
 */

export const SIGNUP_CODE_DAYS = 14;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SignupCodeEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
  usedAt: number | null;
  usedBy: string | null;
}

export function isSignupCodeShape(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function signupCodeHash(code: string): string {
  return sha256Hex(code);
}

/** Issues a code; the plaintext is returned once and never stored. */
export async function createSignupCode(
  createdBy: string,
  now: Date,
): Promise<{ id: string; code: string; entry: SignupCodeEntry }> {
  const code = randomBytes(32).toString("base64url");
  const id = `sc_${randomBytes(6).toString("base64url")}`;
  const hash = signupCodeHash(code);
  const expiresAt = now.getTime() + SIGNUP_CODE_DAYS * 86_400_000;
  const tx = getRedis().multi();
  tx.set(GLOBAL_KEYS.signupCode(hash), JSON.stringify({ codeId: id }), { ex: SIGNUP_CODE_DAYS * 86_400 });
  tx.hset(GLOBAL_KEYS.signupCodes, {
    [id]: JSON.stringify({ hash, createdAt: now.getTime(), expiresAt, createdBy }),
  });
  await tx.exec();
  return { id, code, entry: { id, createdAt: now.getTime(), expiresAt, createdBy, usedAt: null, usedBy: null } };
}

/** Whether a code with this hash is live (checked before sending anyone to GitHub; it is consumed later). */
export async function signupCodeIsLive(hash: string): Promise<boolean> {
  return Number(await getRedis().exists(GLOBAL_KEYS.signupCode(hash))) === 1;
}

/** Takes the code with this hash out of the store; its id when it was live, null otherwise. */
export async function consumeSignupCode(hash: string, usedBy: string, now: Date): Promise<string | null> {
  const raw = await getRedis().getdel<string>(GLOBAL_KEYS.signupCode(hash));
  if (raw === null || raw === undefined) return null;
  let codeId: unknown;
  try {
    codeId = (JSON.parse(String(raw)) as { codeId?: unknown }).codeId;
  } catch {
    return null;
  }
  if (typeof codeId !== "string") return null;
  const listed = await getRedis().hget<string>(GLOBAL_KEYS.signupCodes, codeId);
  if (listed) {
    const entry = { ...(JSON.parse(String(listed)) as object), usedAt: now.getTime(), usedBy };
    await getRedis().hset(GLOBAL_KEYS.signupCodes, { [codeId]: JSON.stringify(entry) });
  }
  return codeId;
}

/** Every code issued, newest first, without its hash. */
export async function listSignupCodes(): Promise<SignupCodeEntry[]> {
  const raw = toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.signupCodes));
  return Object.entries(raw)
    .flatMap(([id, value]) => {
      try {
        const entry = JSON.parse(value) as Record<string, unknown>;
        return [
          {
            id,
            createdAt: Number(entry.createdAt) || 0,
            expiresAt: Number(entry.expiresAt) || 0,
            createdBy: String(entry.createdBy ?? ""),
            usedAt: typeof entry.usedAt === "number" ? entry.usedAt : null,
            usedBy: typeof entry.usedBy === "string" ? entry.usedBy : null,
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Revokes a code that has not been used; true when there was one to revoke. */
export async function revokeSignupCode(id: string): Promise<boolean> {
  const listed = await getRedis().hget<string>(GLOBAL_KEYS.signupCodes, id);
  if (!listed) return false;
  const { hash, usedAt } = JSON.parse(String(listed)) as { hash?: string; usedAt?: number };
  // A used code is spent already; its entry stays as the record of who used it.
  if (typeof usedAt === "number") return false;
  const tx = getRedis().multi();
  if (typeof hash === "string") tx.del(GLOBAL_KEYS.signupCode(hash));
  tx.hdel(GLOBAL_KEYS.signupCodes, id);
  await tx.exec();
  return true;
}
