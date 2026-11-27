# Runbooks

Step-by-step procedures for the jobs that are easy to get wrong under pressure: rotating a secret,
backing up and restoring the store, and switching a workspace off. Each one says how to check that
it worked and how to undo it. The [incident response](incident-response.md) checklist links here
for its containment steps.

- [Rotating secrets](#rotating-secrets)
  - [`GITHUB_CLIENT_SECRET`](#github_client_secret)
  - [`TOKEN_ENCRYPTION_KEY`](#token_encryption_key)
  - [`CRON_SECRET`](#cron_secret)
  - [The Upstash REST token](#the-upstash-rest-token)
  - [`USAGE_API_TOKEN`](#usage_api_token)
- [Backup and restore](#backup-and-restore)
- [Disabling and enabling a workspace](#disabling-and-enabling-a-workspace)

## Rotating secrets

Every secret here is an environment variable. **Where it lives:**

- **Vercel:** Project → Settings → Environment Variables (the *Production* environment), or
  `vercel env rm NAME production` then `printf %s "$VALUE" | vercel env add NAME production` (`printf`,
  not `echo`: a trailing newline becomes part of the value). A change reaches the app only with the
  **next deployment**: redeploy (Deployments → ⋯ → *Redeploy*, or `vercel redeploy <url>`). A
  deployment keeps the values it was built with, so Instant Rollback to an older one also brings
  back the values it had.
- **Docker:** `.env` next to `docker-compose.yml`. `docker compose up -d` recreates the containers
  whose settings changed; add `--force-recreate app` if you are not sure it noticed.

Generate a random value with `openssl rand -hex 32` (a key: `openssl rand -base64 32` works too).
Do one secret at a time and check it before the next. **Take a [backup](#backup-and-restore) first**
if a step below touches stored data (the vault, the store's token).

### `GITHUB_CLIENT_SECRET`

Multi-tenant mode. The secret is used only to exchange the one-time code at sign-in, so sessions
already signed in are not affected; a sign-in under way at the moment of the switch fails and is
simply started again. GitHub lets an OAuth App hold two client secrets at once, so there is no gap.

1. GitHub → Settings → Developer settings → OAuth Apps → the app → **Generate a new client secret**.
   Copy it (shown once). Do not delete the old one yet.
2. Set `GITHUB_CLIENT_SECRET` to the new value and redeploy (Docker: edit `.env`, `docker compose up -d`).
3. **Verify:** open the site in a private window and sign in with GitHub; you land in your
   workspace. A wrong secret shows the sign-in error page and logs `signin.failed` (the reason is in
   the log line).
4. Delete the old secret on GitHub (the app's page lists both with their last-used date).

**Rollback:** until step 4 the old secret still works: put it back and redeploy. After step 4,
generate another new one and repeat. If the secret leaked, do step 4 right after step 3, not later.

### `TOKEN_ENCRYPTION_KEY`

Single-user instances only (it seals the stored copy of `USAGE_API_TOKEN`). The procedure, with the
`TOKEN_ENCRYPTION_KEY_PREVIOUS` fallback and the re-seal, is
[security.md](security.md#the-token-vault-and-key-rotation); follow it as written. What it leaves out:

**1. The audit IP hashes change** when `AUDIT_SALT` is not set. The salt is then
`sha256(TOKEN_ENCRYPTION_KEY)`, so after a rotation the same visitor gets a different `ip` hash on the
token audit trail (`1e255dddc4e3` before, `3aa55c438af6` after, for the same address), and entries from
before and after cannot be matched. Pick one:

- *Routine rotation* — keep them comparable by pinning the salt to what it was. In the same
  deployment as the new key, set `AUDIT_SALT` to the SHA-256 of the **old key's text** (the value of
  the variable, not its decoded bytes):

  ```bash
  printf %s "$OLD_KEY" | shasum -a 256 | cut -d' ' -f1     # Linux: sha256sum
  ```

- *The key leaked* — the hash is keyed with it, so a salt derived from the leaked key is no longer
  secret: set `AUDIT_SALT` to a fresh random value instead (`openssl rand -hex 32`) and accept the
  break in comparability. Once `AUDIT_SALT` is set, later key rotations leave the hashes alone.

**2. Forgetting `TOKEN_ENCRYPTION_KEY_PREVIOUS` loses nothing.** With only the new key set, the vault
reports `unreadable` (`GET /api/api-token`; `409 token_unreadable` from reveal) and the stored
ciphertext stays untouched. Put the old key back as `TOKEN_ENCRYPTION_KEY_PREVIOUS` and redeploy and
it opens again. Or save the token afresh on the settings panel: that seals it with the current key.

**3. Verify** (settings panel open, or `GET /api/api-token` with a session): `needsReseal` was `true`
and becomes `false` after that one read (the read re-seals in the background); `keyId` is the new
key's fingerprint; *Copy token* still gives the token. Only then remove `TOKEN_ENCRYPTION_KEY_PREVIOUS`
and redeploy. **Rollback:** before that removal, swap the two keys back (the old one as current, the
new one as previous) and redeploy; the next read re-seals under the old key.

If the key and a copy of the Redis data both leaked, the sealed token is exposed: rotate
[`USAGE_API_TOKEN`](#usage_api_token) as well. Backups made earlier still hold the value sealed with
the old key.

### `CRON_SECRET`

At least 16 characters; without it the housekeeping endpoint refuses to run (`500 server_misconfigured`).
Vercel Cron sends it as `Authorization: Bearer …` on its own, from the deployment's environment.

1. Set `CRON_SECRET` to a new value; redeploy.
2. **Docker, with the bundled `housekeeping` profile** the container reads the same `.env` value:
   `docker compose --profile housekeeping up -d` recreates both it and the app. With your own
   scheduler (host cron, a timer), change the secret in its command line as well.
3. **Verify** (a dry run: reports, deletes nothing):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $OLD" "$SITE/api/cron/housekeeping?dryRun=1"   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $NEW" "$SITE/api/cron/housekeeping?dryRun=1"   # 200
   ```

   On Vercel the real run is at 03:00 UTC (`vercel.json`); the next morning `usage:housekeeping:last`
   (or the `housekeeping.*` log lines) shows it ran.

**Rollback:** set the old value and redeploy. Nothing else depends on the secret.

### The Upstash REST token

`KV_REST_API_TOKEN` (and `KV_REST_API_URL`), plus the **read-only token** if you keep one for
backups and inspection. Upstash has **no overlap**: resetting makes the old token fail at once, so
until the app has the new one every request answers `503 storage_unavailable` (the clients retry on
their next run and lose nothing). Do it at a quiet moment, with the new value ready.

On Vercel (the Marketplace integration manages the variables):

1. Take a [backup](#backup-and-restore) with the current token.
2. Upstash console → the database → reset the REST token / password. Copy the new token and the
   new read-only token.
3. Vercel: check Settings → Environment Variables. The integration normally updates `KV_REST_API_TOKEN`
   itself; if it did not, set it by hand. Redeploy straight away.
4. Replace your own copies of the read-only token (the `KV_REST_API_TOKEN` you use for
   `npm run backup`, your ops notes).
5. **Verify:** `curl -s "$SITE/api/health"` answers `"store":"ok"`; the dashboard loads; the next hourly
   report is accepted; `npm run backup -- check.json` with the new read-only token works.

**Rollback:** none for a reset token: the old one is gone. If the new value was mis-copied, take it
from the console again. If the database itself is damaged, restore from the backup of step 1.

On Docker the bundled REST proxy's token is `SRH_TOKEN`, shared by the `app` and `redis-rest` services:
change it in `.env` and run `docker compose up -d`, which recreates both together (a gap of seconds).
Verify with `curl -s http://localhost:3000/api/health`. Rollback: put the old value back.

### `USAGE_API_TOKEN`

Single-user instances. It is the bearer token of every client that has not been given a per-machine
token ([clients.md](clients.md#per-machine-tokens-vs-the-master-token)), and it also exists as the sealed copy the
settings panel's *Copy token* button reads. Per-machine tokens (including the menu bar app's) and
browser sessions are **not** affected by changing it.

**Without a gap:** in Settings → Tokens create a per-machine token for each machine, put it into that
client's config (`API_TOKEN=` in `~/.config/usageratio/config`, `apiToken` in
`%USERPROFILE%\.usageratio\config.json`), then do the steps below. Every use of the shared token is
logged as `api.master_token_used`; when those lines have stopped, nothing relies on it.

**Direct:**

1. Set `USAGE_API_TOKEN` to a new value (16 or more characters) and redeploy (Docker: `.env`,
   `docker compose up -d`). From now on the **old token is refused** on `POST /api/usage` (`401`):
   every client still holding it logs `Sync failed … HTTP 401` and is not reporting.
2. Give each client the new token: re-run its installer (it asks for the token, and keeps the machine
   id), or edit the `API_TOKEN` line of its config. A missed hour is made up by the next
   successful report in the default `snapshot` token mode.
3. Update the stored copy: settings panel → API token → paste the new value and save (`PUT
   /api/api-token`). Until then the panel shows that the stored copy does not match the server
   (`matchesServer: false`) and *Copy token* would hand out the old one.
4. **Verify:**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $OLD" -H 'Content-Type: application/json' -d "$REPORT" "$SITE/api/usage"   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $NEW" -H 'Content-Type: application/json' -d "$REPORT" "$SITE/api/usage"   # 201
   ```

   and `GET /api/api-token` shows `matchesServer: true`. Then check each machine's *last report* on
   the dashboard.

**Rollback:** set the old value back and redeploy; clients that already took the new one then fail
until they are switched back, so finish step 2 on all of them before relying on it. If the token
leaked, there is no reason to roll back: rotate it again.

## Backup and restore

`npm run backup` and `npm run restore` (`scripts/backup.ts`, `scripts/restore.ts`, logic in
`lib/store-backup.ts`) copy a whole Redis database over the REST API to one JSON file and back. They
read `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `.env.local`). They need no `redis-cli` or network
access beyond what the app itself uses, so they work on Upstash and on the Docker stack alike (there,
publish the REST proxy on `127.0.0.1` first; for Docker the volume backup in
[self-hosting.md](self-hosting.md#backups) is the simpler one).

**The file** is `{ takenAt, dbsize, keys: { key: { type, ttlMs, expiresAtMs, value } } }`: string, hash,
list, set and sorted set (a flat `[member, score, …]` list). It holds *everything*: sessions, token
hashes, the sealed API token, alert webhook URLs. Treat it like a secret: it is written `0600`, keep
it outside the repository (for example `~/.usageratio-ops/backups/`), and delete it when it has served
its purpose (the privacy notice promises at most 90 days). The older ops script's files (without
`expiresAtMs`, hashes as flat lists) restore too.

### Take a backup

```bash
npm run backup -- ~/.usageratio-ops/backups/2026-11-27.json
# {"saved":25,"dbsize":25,"types":{"string":2,"hash":10,"list":1,"zset":11,"set":1}}
```

It only reads, so Upstash's **read-only token** is enough. The cost is about three commands per key
against Upstash's quota. `saved` should equal `dbsize` (a key that expired meanwhile is the only
difference). Take one before a rotation that touches data, a migration (`migrate:tenant`,
`migrate:legacy`), an upgrade, and a destructive clean-up.

### Restore

Three rules the tool enforces: it **never writes without `--apply`**, it **never replaces a key that
exists unless `--force`**, and a key is built under a temporary name and moved into place, so it is
either there whole or not there (an interrupted run leaves at most a `restore-tmp:*` key: delete it,
backups ignore it). TTLs are restored as the *moment* the key was to expire, not as time left, so a
restore a day later does not hand every key a day more; a key whose time has already passed is skipped.

```bash
# 1. Always first: a dry run. Check the target host it prints, and the counts.
npm run restore -- backup.json
# Backup 2026-11-27T09:32:25.083Z: 25 keys {"string":2,"hash":10,…}
# Target 127.0.0.1:8079, dry run
#   would restore: 3 (0 replacing an existing key)
#   skipped, key exists (use --force): 22
#     usage:events:claude:Work   …

# 2. Then for real.
npm run restore -- backup.json --apply
```

- **Everything, into an empty database** (a new Upstash database after a loss; point
  `KV_REST_API_URL`/`KV_REST_API_TOKEN` at it, restore, then update the app's variables and
  redeploy): `npm run restore -- backup.json --apply`.
- **Only some keys:** `--only` takes an exact key, or a prefix ending in `*`; repeat it. A pattern that
  matches nothing in the file stops the run (exit 2): usually a typo.

  ```bash
  npm run restore -- backup.json --only=usage:settings --only='usage:events:claude:*' --only=usage:history:claude --apply
  ```

  Keys are listed at the top of [`lib/redis-keys.ts`](../lib/redis-keys.ts). In multi-tenant mode a
  workspace's keys all start with `t:{tenantId}:` (the `default` workspace's with `usage:`). A
  workspace's record and members are `usage:tenant:{tenantId}*`. The token index
  `usage:tokenindex` is one hash for every workspace: restoring it with `--force` would drop the
  entries of tokens created since the backup, so after restoring a deleted workspace issue its
  machines new tokens instead.
- **Replacing a key that exists** (it was corrupted, not deleted): add `--force`, with `--only` naming
  just that key. The key returns to its state at backup time: for an event sorted set that means the
  reports since then are gone (the machines' next snapshot reports fill the totals in again, but not
  the hours in between). Do it at a quiet moment; the clients write once an hour, near the top of it.
- **Sessions and rate-limit counters** (`usage:session:*`, `usage:session2:*`, `usage:auth:*`,
  `usage:rl:*`) are in the file. Restoring them brings back sessions that have since been ended on
  purpose (after an incident, "sign out everywhere"): after a security incident restore with
  `--only` for the data keys and leave these out.

### Verify a restore

1. The counts the run printed, and `dbsize` (`curl -s -X POST -H "Authorization: Bearer $TOKEN" -d
   '["DBSIZE"]' "$KV_REST_API_URL"`) match what you expect.
2. Take a second backup and compare it with the first (key set, types, values, TTLs; a hash's field
   order is not stable, so it is compared as a set):

   ```bash
   npm run backup -- after.json
   node -e '
   const fs=require("fs");const [a,b]=process.argv.slice(1).map(f=>JSON.parse(fs.readFileSync(f)));
   const norm=e=>JSON.stringify(e.type==="hash"?Object.entries(e.value).sort():e.value);
   const bad=[...new Set([...Object.keys(a.keys),...Object.keys(b.keys)])].filter(k=>{
     const x=a.keys[k],y=b.keys[k];
     return !x||!y||x.type!==y.type||norm(x)!==norm(y)||(x.ttlMs>=0&&Math.abs(x.expiresAtMs-y.expiresAtMs)>5000)});
   console.log(bad.length?bad:"identical")' backup.json after.json
   ```

   (After a partial restore into a live store, only the keys you restored are expected to match.)
3. `GET /api/health` says `"store":"ok"`, and the dashboard (or `GET /api/status` with a bearer token)
   shows the cycle and the usage you expect.

**Rollback:** a restore that was not forced only added keys; delete them. For a forced one, the
state before is what a backup taken just before it would have kept: take one first.

## Disabling and enabling a workspace

Multi-tenant instances. Use it to stop an abused or compromised workspace at once without deleting
anything (the first containment step in [incident-response.md](incident-response.md#2-contain)).
Only an instance admin (a GitHub account whose numeric id is in `ADMIN_GITHUB_IDS`) can; everyone
else gets `404`. The `default` workspace (a single-user instance's own data) cannot be disabled;
on such an instance change the [token](#usage_api_token) or the `DASHBOARD_PIN` instead.

**On the admin page:** sign in with the admin's GitHub account, open `/admin`, find the workspace
(its id, owners, counts and status are in the table) and press **Disable**; the status column then
reads *disabled* and the button says **Enable**.

**Through the API** (same-origin, so send an `Origin` that matches the site, with the admin's
session cookie, `__Host-ur_session` over HTTPS, from the browser's developer tools):

```bash
curl -s -H "Cookie: $ADMIN_COOKIE" "$SITE/api/admin" | jq '.overview.rows[] | {tenantId, status, machines}'
curl -s -X PATCH -H "Cookie: $ADMIN_COOKIE" -H "Origin: $SITE" -H 'Content-Type: application/json' \
  -d '{"status":"disabled"}' "$SITE/api/admin/tenants/$TENANT_ID"
# {"ok":true,"status":"disabled"}          (re-enable: {"status":"active"})
```

`400 invalid_payload` for any other status, `403 forbidden_origin` for a foreign origin, `404` for a
non-admin, the default workspace, an unknown id, or a workspace that is already being deleted (a
deletion, once started, is never undone).

**What happens, at once** (no redeploy; the change is read on every request):

| Who | What they get |
| --- | --- |
| Members, in the browser | Every session request is refused (`401 unauthorized` on the API), and the pages show "No workspace yet … the workspace may have been disabled" with the account page and *Sign out*. Their sessions are not ended; they work again the moment it is enabled. They cannot switch to it either. |
| Machines (clients) | `403 tenant_disabled` on `POST /api/usage`, `GET /api/status` and every other bearer call, before anything of the workspace is touched (not even a token's last-used time). A client logs `server answered HTTP 403: …` and retries at its next scheduled run; nothing is stored meanwhile. Tokens stay valid. |
| The data | Kept as it is. The tenant record gets `"status": "disabled"` and a `statusAt` time; that is the only trace (no audit entry): note it in the [incident register](incident-response.md#6-record-it-even-when-nothing-is-notified). |
| The admin page | Counts the workspace as disabled; the other workspaces are untouched. |

A disabled workspace whose last client request and whose disabling are both 365 days old is deleted
by the inactive-account clean-up ([security.md](security.md#inactive-accounts)): re-enable it, or
delete it on purpose, well before.

**Verify** (with the workspace's machine token `$TOKEN`, and a member's cookie if you have one):

```bash
curl -s -w ' -> %{http_code}\n' -H "Authorization: Bearer $TOKEN" "$SITE/api/status"
# {"error":"tenant_disabled",…} -> 403
```

Then check that `/admin` shows the status, and that a member's page shows the "No workspace yet"
screen. After **Enable**, the same call answers `200`, a member's page loads the dashboard again,
and the machine's next report is accepted (`201`).

**Rollback:** `{"status":"active"}` (or **Enable**). Nothing was deleted, so nothing needs
restoring; reports for the disabled hours were refused and are not recorded.
