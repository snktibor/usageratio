import { isDemoMode } from "@/lib/demo/mode";
import { log } from "@/lib/log";

/**
 * Who may get in (REGISTRATION). `closed`, the default, is the single-user
 * app: a PIN, one tenant (`default`), the shared USAGE_API_TOKEN. `invite`
 * and `open` are multi-tenant: GitHub sign-in, a workspace per user; `invite`
 * only lets an instance admin's sign-up code create a new workspace, `open`
 * lets anyone. An unknown value is a configuration mistake and falls back to
 * `closed`, the mode that lets nobody new in. The demo is always `closed`.
 */
export type RegistrationMode = "closed" | "invite" | "open";

let warnedValue: string | null = null;

export function registrationMode(env: Record<string, string | undefined> = process.env): RegistrationMode {
  if (isDemoMode()) return "closed";
  const raw = env.REGISTRATION?.trim().toLowerCase() ?? "";
  if (raw === "invite" || raw === "open") return raw;
  if (raw !== "" && raw !== "closed" && warnedValue !== raw) {
    warnedValue = raw;
    log.error("registration.invalid_mode", { rule: "REGISTRATION must be closed, invite or open; using closed" });
  }
  return "closed";
}

/** Whether this instance signs people in with GitHub and keeps a tenant per workspace. */
export function isMultiTenant(env: Record<string, string | undefined> = process.env): boolean {
  return registrationMode(env) !== "closed";
}
