import { MAX_MACHINES, WORKSPACE_QUOTAS } from "@/lib/config";
import { MAX_PENDING_INVITES } from "@/lib/invites";
import { MAX_PROVIDERS } from "@/lib/providers";
import { isMultiTenant } from "@/lib/registration";
import { MAX_GROUPS } from "@/lib/settings";
import { MAX_TOKENS } from "@/lib/tokens";

/**
 * The quotas of one workspace (lib/config.ts WORKSPACE_QUOTAS), and the
 * instance-wide caps a single-user instance keeps (closed mode). Every check
 * goes through `growsPast`: a change is refused only when it adds to a count
 * that would then be over its limit, so a workspace already over one (it
 * predates the quotas) loses nothing, shows everything, and keeps reporting
 * from the machines, providers and groups it has; only a new one is refused.
 *
 * Refused requests answer a stable `too_many_*` code with the `limit`
 * (lib/api.ts), never a silent drop; the UI translates the code, and the
 * report endpoint adds a readable `message` for the clients' logs.
 */

export interface Quotas {
  /** Closed: `usage:machines` entries (provider:machine); multi: distinct machine ids (`machinesCounted`). */
  machines: number;
  providers: number;
  groups: number;
  /** Live (unrevoked) tokens. */
  tokens: number;
  /** Members, owner included; null where there are none (closed mode). */
  members: number | null;
  pendingInvites: number;
  /** Workspaces one user may own; null in closed mode. */
  ownedWorkspaces: number | null;
}

/**
 * This instance's quotas: per workspace in multi-tenant mode, the instance-wide caps when closed.
 * Built on each call, not at load: lib/tokens.ts and lib/invites.ts import this module back.
 */
export function workspaceQuotas(env: Record<string, string | undefined> = process.env): Quotas {
  if (isMultiTenant(env)) return { ...WORKSPACE_QUOTAS };
  return {
    machines: MAX_MACHINES,
    providers: MAX_PROVIDERS,
    groups: MAX_GROUPS,
    tokens: MAX_TOKENS,
    members: null,
    pendingInvites: MAX_PENDING_INVITES,
    ownedWorkspaces: null,
  };
}

/** What the machine quota counts: entries when closed (today's cap), distinct machines in multi-tenant mode. */
export type MachineCounting = "entries" | "machines";

export function machineCounting(env: Record<string, string | undefined> = process.env): MachineCounting {
  return isMultiTenant(env) ? "machines" : "entries";
}

/** The machine id of a `usage:machines` field (`providerId:machineId`); provider ids never hold a colon. */
export function machineIdOfField(field: string): string {
  return field.slice(field.indexOf(":") + 1);
}

/** How many machines `fields` (`usage:machines` field names) count as under `counting`. */
export function countMachines(fields: Iterable<string>, counting: MachineCounting): number {
  const list = [...fields];
  return counting === "entries" ? list.length : new Set(list.map(machineIdOfField)).size;
}

/** Whether going from `before` to `after` is refused under `limit`: only growth that ends over it. */
export function growsPast(before: number, after: number, limit: number): boolean {
  return after > before && after > limit;
}

/** The machine check: whether adding `added` fields to `existing` grows the machine count past `limit`. */
export function machinesGrowPast(
  existing: readonly string[],
  added: readonly string[],
  limit: number,
  counting: MachineCounting,
): boolean {
  const before = countMachines(existing, counting);
  const after = countMachines(new Set([...existing, ...added]), counting);
  return growsPast(before, after, limit);
}

/** The refusal codes a quota answers with (lib/api.ts ApiErrorCode). */
export type QuotaCode =
  | "too_many_machines"
  | "too_many_providers"
  | "too_many_groups"
  | "too_many_tokens"
  | "too_many_members"
  | "too_many_invites"
  | "too_many_workspaces";

/** One quota's use, for the settings page and the admin view. */
export interface QuotaUse {
  used: number;
  limit: number;
}
