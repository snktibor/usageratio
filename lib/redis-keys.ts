/**
 * Redis key layout — every key name the app uses, in one place.
 *
 *   usage:settings                        STRING provider limits and shared reset/display settings
 *   usage:providers                       HASH   providerId → first-seen ms
 *   usage:events:{providerId}:{groupId}   ZSET   score = report time (epoch ms)
 *                                                 member = {"m": machineId, "t": tokens, "ts": ms,
 *                                                           "b": {modelId: tokens}, "c": 1}
 *                                                 ("b", the split by model, only from clients that send one;
 *                                                 "c" marks a day's checkpoint, see lib/days.ts)
 *   usage:groups            HASH  groupId   → {"color": "#rrggbb", "ts": first-seen ms}
 *                                 (a bare ms number in entries older than group colours)
 *   usage:machines          HASH  providerId:machineId → {"g": groupId, "ts": ms, "t": tokens}
 *   usage:official           HASH  providerId, or providerId:subLimitId →
 *                                  {"raw": "45.5", "enteredAt": ms, "cycleStartMs": ms}
 *                                  (the ground-truth field on the dashboard; see lib/official-usage.ts)
 *
 *   usage:api-token          STRING {"v":1,"kid","iv","ct","tag","updatedAt"}: AES-256-GCM, key
 *                                   TOKEN_ENCRYPTION_KEY (see lib/secret-box.ts, lib/token-vault.ts)
 *   usage:api-token:audit    LIST   newest first, at most AUDIT_LIMIT entries:
 *                                   {"at","a","ua","ch","pf","s", "ip"|"iph"+"ipp"} (see lib/api-token.ts)
 *
 *   usage:tokens             HASH   sha256(token) → {"id","label","machineId","createdAt",
 *                                   "lastUsedAt","revokedAt"}: per-machine API tokens, an
 *                                   alternative to the shared USAGE_API_TOKEN that can be
 *                                   individually revoked (see lib/tokens.ts). The field is the
 *                                   token's own hash, never its plaintext, which is shown once at
 *                                   creation and not stored.
 *
 *   usage:housekeeping:last  STRING {"at": ms, "report": HousekeepingReport} — the last run of
 *                                   lib/housekeeping.ts (see app/api/cron/housekeeping/route.ts)
 *
 *   usage:history:{providerId}   ZSET  score = cycle start (epoch ms), member = a CycleSummary
 *                                       (JSON, see lib/history.ts), kept for the newest
 *                                       HISTORY_RETENTION cycles. Written lazily on a dashboard
 *                                       read, once the cycle right before the current one falls
 *                                       out of the events' retention window (app/[locale]/page.tsx).
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
 * groups, official usage) and the audit list of entries nothing still points
 * to; it never touches the event ZSETs, which already self-prune on every
 * report (`storeReport` in lib/usage-store.ts).
 */
export const KEYS = {
  settings: "usage:settings",
  providers: "usage:providers",
  groups: "usage:groups",
  machines: "usage:machines",
  officialUsage: "usage:official",
  events: (providerId: string, groupId: string) => `usage:events:${providerId}:${groupId}`,
  history: (providerId: string) => `usage:history:${providerId}`,
  apiToken: "usage:api-token",
  apiTokenAudit: "usage:api-token:audit",
  housekeepingLast: "usage:housekeeping:last",
  tokens: "usage:tokens",
};
