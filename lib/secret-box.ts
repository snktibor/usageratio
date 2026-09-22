import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the secrets the dashboard keeps in Redis. The 256-bit key
 * lives only in the server's environment, so a copy of the store (a backup, a
 * leaked REST token) holds nothing but ciphertext. Every value gets a fresh
 * 96-bit IV, and the 128-bit tag makes any change to the stored bytes fail to
 * decrypt. `context` is bound in as additional authenticated data: a value
 * sealed for one purpose does not open as another.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** One encrypted value, every part base64url. */
export interface SealedSecret {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
}

/**
 * The key from its env var: 64 hex digits, or the base64 / base64url form of
 * 32 bytes (`openssl rand -base64 32`). Anything else is null: a short or
 * mistyped key is refused rather than stretched into a weak one.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    // Node's base64 decoder reads the base64url alphabet as well.
    const key = Buffer.from(value, "base64");
    if (key.length === KEY_BYTES) return key;
  }
  return null;
}

export function sealSecret(plaintext: string, key: Buffer, context: string): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64url"),
    ct: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

/** The plaintext; throws when the value is damaged, or was sealed with another key or context. */
export function openSecret(sealed: unknown, key: Buffer, context: string): string {
  const value = (typeof sealed === "object" && sealed !== null ? sealed : {}) as Record<string, unknown>;
  const part = (name: string): Buffer => {
    const text = value[name];
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) {
      throw new Error(`The sealed value has no valid "${name}".`);
    }
    return Buffer.from(text, "base64url");
  };
  if (value.v !== 1) throw new Error("The sealed value has an unknown version.");
  const iv = part("iv");
  const tag = part("tag");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("The sealed value has a malformed IV or tag.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(part("ct")), decipher.final()]).toString("utf8");
}
