/**
 * Redis key layout — every key name the app uses, in one place. No other
 * module may spell a key: tests/redis-key-literals.test.ts fails on a string
 * that starts with `usage:` or `t:` anywhere else.
 *
 * Tenant keys. Every key below up to "Global keys" belongs to one tenant
 * (lib/tenant.ts) and is built by `tenantKeys(tenantId)` behind the tenant's
 * prefix: `usage:` for the `default` tenant (so a single-tenant instance keeps
 * exactly the key names it always had), `t:{tenantId}:usage:` for any other.
 * They are written below with the `default` tenant's names.
 *
 *   usage:settings                        STRING provider limits, shared reset/display settings, and providers' own reset moments (resetOverrides; an entry may carry source?: "report" | "reset", and with it anchorMs?: the instant its weekly cycles step from by whole weeks) and reset modes (resetModes)
 *   usage:providers                       HASH   providerId → first-seen ms
 *   usage:events:{providerId}:{groupId}   ZSET   score = report time (epoch ms)
 *                                                 member = {"m": machineId, "t": tokens, "ts": ms,
 *                                                           "b": {modelId: tokens}, "$": usd,
 *                                                           "$b": {modelId: usd}, "c": 1, "x": 1,
 *                                                           "s": cycleStartMs}
 *                                                 ("b", the split by model, only from clients that send one;
 *                                                 "$"/"$b", the cost estimate; "c" marks a
 *                                                 day's or hour's checkpoint, see lib/days.ts; "x" a
 *                                                 merged machine's carry-over, see lib/machine-merge.ts; "s" the cycle
 *                                                 start the client counted from, see lib/resets.ts dropStaleBasis
 *                                                 and lib/aggregate.ts STALE_BASIS_MS)
 *   usage:groups            HASH  groupId   → {"color": "#rrggbb", "ts": first-seen ms}
 *                                 (a bare ms number in entries older than group colours)
 *   usage:machines          HASH  providerId:machineId → {"g": groupId, "ts": ms, "t": tokens,
 *                                 "md": "manual", "iv": intervalMinutes} ("md"/"iv" only when not the default)
 *   usage:official           HASH  providerId, or providerId:subLimitId →
 *                                  {"raw": "45.5", "enteredAt": ms, "cycleStartMs": ms, "resetsAtMs": ms}
 *                                  (the ground-truth field on the dashboard; see lib/official-usage.ts;
 *                                  "cycleStartMs" is the start of the segment it was entered in,
 *                                  "resetsAtMs" only on a report: its window's reset)
 *   usage:resets             HASH  providerId → {"v": 1, "events": [ResetEvent…], "autoOffCycleStartMs": ms | null}
 *                                  (the provider's usage resets: keep resets of its current and
 *                                  previous cycle, restarts while their raw reports are kept,
 *                                  see lib/resets.ts; pruned by lib/housekeeping.ts)
 *
 *   usage:api-token          STRING {"v":1,"kid","iv","ct","tag","updatedAt"}: AES-256-GCM, key
 *                                   TOKEN_ENCRYPTION_KEY (see lib/secret-box.ts, lib/token-vault.ts)
 *   usage:api-token:audit    LIST   newest first, at most AUDIT_LIMIT entries: the shared token's
 *                                   audit trail (single-user instances):
 *                                   {"at","a","ua","ch","pf","s", "ip"|"iph"+"ipp"} (see lib/api-token.ts)
 *
 *   usage:tokens             HASH   sha256(token) → {"id","label","machineId","scope","createdAt",
 *                                   "lastUsedAt","revokedAt"}: per-machine API tokens, an
 *                                   alternative to the shared USAGE_API_TOKEN that can be
 *                                   individually revoked (see lib/tokens.ts); "scope" is
 *                                   "ingest" (absent in older entries), "read" or "official". The field is the
 *                                   token's own hash, never its plaintext, which is shown once at
 *                                   creation and not stored. "createdBy" is the userId who created
 *                                   it (multi-tenant mode). The record is written only when the
 *                                   token is created or revoked; "lastUsedAt" inside it is from
 *                                   before usage:tokens:lastused existed.
 *   usage:tokens:audit       LIST   newest first, at most AUDIT_LIMIT entries: the per-machine
 *                                   tokens' audit trail (created, revoked, rotated), the same record
 *                                   shape plus "tk"+"tl" (the token's id and label), "tn"? (a
 *                                   rotation's replacement id) and "by"? (the login, multi-tenant
 *                                   mode); written in the same transaction as the change
 *   usage:tokens:lock        STRING a random holder id, SET NX EX 10 — held while a token is
 *                                   revoked or rotated, so two of them cannot interleave
 *   usage:tokens:lastused    HASH   sha256(token) → last authenticated request (ms), refreshed at
 *                                   most hourly: kept apart from the record, so that refresh can
 *                                   never write back a copy of a token revoked meanwhile
 *
 *   usage:housekeeping:last  STRING {"at": ms, "report": HousekeepingReport} — the last run of
 *                                   lib/housekeeping.ts (see app/api/cron/housekeeping/route.ts)
 *
 *   usage:keys               SET    the tenant's key registry: the name of every dynamic key
 *                                   (events, history, all-time, alert guards) it has written,
 *                                   added in the same transaction as the write that creates the
 *                                   key. With the fixed keys (`fixedTenantKeys`) it lists every
 *                                   key the tenant owns without a SCAN, which deleting a tenant
 *                                   relies on. A name whose key has since expired or emptied may
 *                                   linger; it is harmless, and any later write registers it again.
 *                                   Housekeeping only drops the names of alert guards whose segment
 *                                   started more than a month plus their 70-day expiry ago: those are
 *                                   gone and can never be written again, so dropping them cannot race
 *                                   a write (lib/housekeeping.ts).
 *
 *   usage:alert:{providerId}:{segmentStartMs}:{threshold}
 *                             STRING "1", SET NX EX 70d — the guard that makes a threshold
 *                                   alert fire once per provider per segment of a cycle (the
 *                                   cycle's start while it has no keep reset, see lib/alerts.ts)
 *
 *   usage:history:{providerId}   ZSET  score = cycle start (epoch ms), member = a CycleSummary
 *                                       (JSON, see lib/history.ts), kept for the newest
 *                                       HISTORY_RETENTION cycles. The cycle right before the
 *                                       current one is written once it has ended, by the first
 *                                       dashboard render or the daily housekeeping run, whichever
 *                                       comes first (lib/archive.ts). Its official figure can be
 *                                       corrected later; the summary is then rewritten in place
 *                                       (`saveArchivedOfficial` in lib/usage-store.ts).
 *   usage:alltime:{providerId}   HASH  cycle start (epoch ms) → the same CycleSummary without its
 *                                       models and sub-limits (lib/all-time.ts `ledgerEntryOf`),
 *                                       for every cycle ever archived: never trimmed, so the
 *                                       all-time totals reach past HISTORY_RETENTION. Written
 *                                       with the history (`archiveCycle`, HSETNX: the summaries
 *                                       still in the history go in too, before its trim drops
 *                                       them), rewritten by a correction, deleted with it by a
 *                                       restart (`saveResetChange`).
 *
 * One time-ordered set per provider/group makes all filters native commands:
 * provider and group are in the key, a period is a score range. The reset
 * therefore needs no job and deletes nothing — the cycle is just the lower
 * bound of the query, and changing the reset time or the period re-slices
 * history. Members are unique per (provider, machine, tokens, time), so a
 * retried POST is a no-op.
 *
 * A report split by day (and hour) also leaves a checkpoint at the end of each
 * finished day and hour of its cycle: the machine's running total at that
 * moment. Every later report sends the same days again, so these are no-ops
 * too, until a day's total changes.
 *
 * Pre-provider data (a bare `usage:events:{groupId}` set, and `usage:machines`
 * fields without a `providerId:` prefix, both from before providers existed)
 * is no longer read here. Run `npm run migrate:legacy -- --apply`
 * (lib/migrate-legacy.ts) against the store once, before deploying a build
 * without this fallback, to fold it under the "deepseek" provider.
 *
 * The groups are a hash of their own rather than a list inside the settings
 * document because the machines all report at the top of the hour: a group
 * nobody defined has to be registered atomically. HSETNX does that inside the
 * report's transaction, and never touches a group that is already defined; a
 * read-modify-write of one JSON document would let concurrent reports (or a
 * save on the panel) overwrite each other.
 *
 * lib/housekeeping.ts prunes the index hashes above (machines, providers,
 * groups, official usage, resets), long-revoked tokens and old audit entries,
 * and archives the cycle that just ended; it never touches the event ZSETs,
 * which already self-prune on every report (`storeReport` in lib/usage-store.ts).
 *
 * Global keys (`GLOBAL_KEYS`), shared by every tenant:
 *
 *   usage:session:{sha256(sessionId:pin)}       STRING {"c": created ms, "s": last seen ms} — a PIN
 *                                                session (lib/auth.ts)
 *   usage:session:{sha256(sessionId:pin)}:sudo  STRING "1" EX 5 min — sudo on that session
 *   usage:auth:ip:{sha256(ip)[:32]}             STRING failed-guess counter per address
 *   usage:auth:ip:{sha256(ip)[:32]}:strikes     STRING lockout strikes per address (24h)
 *   usage:auth:global                           STRING guesses from unknown browsers (1h window)
 *   usage:auth:device:{sha256(deviceId)}        STRING "1" — a browser that has logged in before
 *   usage:rl:*                                  STRING fixed-window rate-limit counters
 *                                               (lib/rate-limit.ts), named in `GLOBAL_KEYS.rateLimit`
 *   usage:demo:seededAt, usage:demo:seeding     STRING demo mode's seed stamp and lock (lib/demo/seed.ts)
 *
 *   usage:tenant:{tenantId}      STRING {"v": 1, "name", "createdAt": ms, "status": "active" | "disabled" |
 *                                       "deleting", "statusAt"?: ms} — a tenant's own record
 *                                       (lib/tenants.ts). "disabled": an instance admin switched it off
 *                                       (data kept, nobody gets in); "deleting": lib/tenant-deletion.ts
 *                                       has started and housekeeping finishes it. A status the code
 *                                       does not know reads as "disabled". No tenant data key is named
 *                                       `tenant…`, so `usage:tenant:default` never meets the default
 *                                       tenant's `usage:` keys.
 *   usage:tenants                ZSET   tenantId → created ms: every tenant besides `default`, which
 *                                       always exists (lib/tenants.ts `listTenantIds`)
 *   usage:tenants:housekept      ZSET   tenantId → last housekeeping run ms: the cron run takes the
 *                                       tenants oldest first, so one it did not reach is first next time
 *   Users and sign-in (multi-tenant mode only, REGISTRATION=invite|open; see lib/users.ts):
 *
 *   usage:user:{userId}              STRING {"v": 1, "login", "createdAt", "lastLoginAt"}: a person
 *                                           (userId: "u_" + 22 base64url characters). No e-mail,
 *                                           no avatar, no GitHub token is ever stored.
 *   usage:user:{userId}:identities   SET    "github:{numericId}": how this user signs in
 *   usage:user:{userId}:tenants      HASH   tenantId → role ("owner" | "member"): the mirror of
 *                                           each tenant's members hash, for listing a user's tenants
 *   usage:user:{userId}:sessions     ZSET   sha256(sessionId) → created ms: the user's sessions,
 *                                           for "sign out everywhere"
 *   usage:identity:github:{id}       STRING userId (SET NX: one user per GitHub account, by its
 *                                           numeric id, never by the login, which can be renamed)
 *   usage:tenant:{tenantId}:members  HASH   userId → {"role", "joinedAt", "invitedBy"?}: one owner per
 *                                           tenant, any number of members (lib/members.ts)
 *   usage:tenant:{tenantId}:invites  HASH   inviteId → {"hash", "createdAt", "expiresAt", "createdBy",
 *                                           "login"?}: the tenant's pending invites, for listing and
 *                                           revoking (lib/invites.ts); expired ones are pruned by
 *                                           housekeeping
 *   usage:tenant:{tenantId}:lock     STRING a random holder id, SET NX EX 10 — held while the members
 *                                           change (remove, leave, transfer, an account leaving), so
 *                                           two changes cannot leave a tenant without its owner; only
 *                                           its holder deletes it
 *   usage:invite:{sha256(code)}      STRING {"tenantId", "inviteId", "createdBy", "login"?} EX =
 *                                           expiry: a workspace invite, GETDEL when it is accepted
 *   usage:session2:{sha256(sid)}     STRING {"v": 2, "u": userId, "t": tenantId | null, "c": created
 *                                           ms, "s": last seen ms, "a": last GitHub sign-in ms,
 *                                           "ua": browser/OS label} EX = the session's maximum
 *                                           lifetime (lib/user-session.ts). Its own prefix: a PIN
 *                                           session can never be read as one, nor the other way.
 *   usage:oauth:{sha256(state)}      STRING one sign-in attempt's state (lib/oauth-state.ts):
 *                                           {"nonceHash", "verifier", "purpose", "returnTo",
 *                                           "locale", "signup"?, "invite"?, "sid"?} EX 600, GETDEL in
 *                                           the callback
 *   usage:signup:{sha256(code)}      STRING {"codeId"} EX = expiry: an instance admin's sign-up
 *                                           code (lib/signup-codes.ts), GETDEL when it is used
 *   usage:signups                    HASH   codeId → {"hash", "createdAt", "expiresAt", "createdBy",
 *                                           "usedAt"?, "usedBy"?}: the codes, for listing and revoking
 *
 *   usage:tokenindex             HASH   sha256(token) → tenantId: which tenant a per-machine token
 *                                       belongs to (lib/tokens.ts `tokenTenant`). The token's record
 *                                       stays in that tenant's `tokens` hash; a token missing here is
 *                                       looked for in the default tenant (tokens issued before the
 *                                       index existed) and indexed on first use.
 */
import { assertTenantId, DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";

/** The key names of one tenant (see the layout above). */
export interface TenantKeys {
  /** `usage:` or `t:{tenantId}:usage:`: every key of the tenant starts with it. */
  prefix: string;
  settings: string;
  providers: string;
  groups: string;
  machines: string;
  officialUsage: string;
  resets: string;
  events: (providerId: string, groupId: string) => string;
  history: (providerId: string) => string;
  allTime: (providerId: string) => string;
  apiToken: string;
  apiTokenAudit: string;
  housekeepingLast: string;
  tokens: string;
  tokensLastUsed: string;
  tokensAudit: string;
  tokensLock: string;
  alert: (providerId: string, segmentStartMs: number, threshold: number) => string;
  registry: string;
}

/** The key prefix of `tenantId`: the `default` tenant keeps the bare `usage:` names. */
function tenantPrefix(tenantId: TenantId): string {
  assertTenantId(tenantId);
  return tenantId === DEFAULT_TENANT ? "usage:" : `t:${tenantId}:usage:`;
}

export function tenantKeys(tenantId: TenantId): TenantKeys {
  const p = tenantPrefix(tenantId);
  return {
    prefix: p,
    settings: `${p}settings`,
    providers: `${p}providers`,
    groups: `${p}groups`,
    machines: `${p}machines`,
    officialUsage: `${p}official`,
    resets: `${p}resets`,
    events: (providerId, groupId) => `${p}events:${providerId}:${groupId}`,
    history: (providerId) => `${p}history:${providerId}`,
    allTime: (providerId) => `${p}alltime:${providerId}`,
    apiToken: `${p}api-token`,
    apiTokenAudit: `${p}api-token:audit`,
    housekeepingLast: `${p}housekeeping:last`,
    tokens: `${p}tokens`,
    tokensLastUsed: `${p}tokens:lastused`,
    tokensAudit: `${p}tokens:audit`,
    tokensLock: `${p}tokens:lock`,
    alert: (providerId, segmentStartMs, threshold) => `${p}alert:${providerId}:${segmentStartMs}:${threshold}`,
    registry: `${p}keys`,
  };
}

/**
 * Every key of a tenant that has a fixed name; the dynamic ones are in its registry (`keys.registry`).
 * A tenant also has entries in global keys: its tokens' fields in `usage:tokenindex` (the fields of
 * its own `tokens` hash) and its member in `usage:tenants` / `usage:tenants:housekept`. Deleting a
 * tenant must clear those too.
 */
export function fixedTenantKeys(keys: TenantKeys): string[] {
  return [
    keys.settings,
    keys.providers,
    keys.groups,
    keys.machines,
    keys.officialUsage,
    keys.resets,
    keys.apiToken,
    keys.apiTokenAudit,
    keys.housekeepingLast,
    keys.tokens,
    keys.tokensLastUsed,
    keys.tokensAudit,
    keys.tokensLock,
    keys.registry,
  ];
}

/** Glob patterns matching a tenant's dynamic keys: only for scripts that may SCAN (the demo seed's wipe, migrations). */
export function dynamicTenantKeyPatterns(keys: TenantKeys): string[] {
  const p = keys.prefix;
  return [`${p}events:*`, `${p}history:*`, `${p}alltime:*`, `${p}alert:*`];
}

/**
 * The segment start in an alert guard's name, when `name` is one of `keys`' alert guards (see
 * `tenantKeys(…).alert`); null for any other key. Housekeeping uses it to forget expired guards.
 */
export function alertGuardSegmentMs(keys: TenantKeys, name: string): number | null {
  const prefix = `${keys.prefix}alert:`;
  if (!name.startsWith(prefix)) return null;
  const parts = name.slice(prefix.length).split(":");
  if (parts.length < 3) return null;
  const segmentMs = Number(parts[parts.length - 2]);
  return Number.isSafeInteger(segmentMs) ? segmentMs : null;
}

/** Keys shared by every tenant (see "Global keys" above). */
export const GLOBAL_KEYS = {
  pinSession: (hash: string) => `usage:session:${hash}`,
  authIp: (ipHash: string) => `usage:auth:ip:${ipHash}`,
  authIpStrikes: (ipHash: string) => `usage:auth:ip:${ipHash}:strikes`,
  authGlobal: "usage:auth:global",
  authDevice: (deviceHash: string) => `usage:auth:device:${deviceHash}`,
  rateLimit: {
    unauth: (ipHash: string) => `usage:rl:unauth:${ipHash}`,
    cycle: (tokenId: string) => `usage:rl:cycle:${tokenId}`,
    ingestMachine: (hash: string) => `usage:rl:ingest:${hash}`,
    ingestGlobal: (hourBucket: string) => `usage:rl:ingest:global:${hourBucket}`,
    status: (tokenId: string) => `usage:rl:status:${tokenId}`,
    official: (tokenId: string) => `usage:rl:official:${tokenId}`,
    alertsTest: "usage:rl:alerts-test",
    oauth: (ipHash: string) => `usage:rl:oauth:${ipHash}`,
  },
  tenantRecord: (tenantId: string) => `usage:tenant:${tenantId}`,
  tenantMembers: (tenantId: string) => `usage:tenant:${tenantId}:members`,
  tenantInvites: (tenantId: string) => `usage:tenant:${tenantId}:invites`,
  tenantLock: (tenantId: string) => `usage:tenant:${tenantId}:lock`,
  invite: (hash: string) => `usage:invite:${hash}`,
  user: (userId: string) => `usage:user:${userId}`,
  userIdentities: (userId: string) => `usage:user:${userId}:identities`,
  userTenants: (userId: string) => `usage:user:${userId}:tenants`,
  userSessions: (userId: string) => `usage:user:${userId}:sessions`,
  githubIdentity: (githubId: number) => `usage:identity:github:${githubId}`,
  userSession: (hash: string) => `usage:session2:${hash}`,
  oauthState: (hash: string) => `usage:oauth:${hash}`,
  signupCode: (hash: string) => `usage:signup:${hash}`,
  signupCodes: "usage:signups",
  tenants: "usage:tenants",
  tenantsHousekept: "usage:tenants:housekept",
  tokenIndex: "usage:tokenindex",
  demoSeededAt: "usage:demo:seededAt",
  demoSeeding: "usage:demo:seeding",
  demoPattern: "usage:demo:*",
};

/** The pre-provider layout lib/migrate-legacy.ts migrates from (the `default` tenant's only). */
export const LEGACY_KEYS = {
  events: (groupId: string) => `usage:events:${groupId}`,
};
