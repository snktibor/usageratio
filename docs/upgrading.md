# Upgrading

Moving an existing deployment to this release. Most of it is a plain redeploy; this page lists the
steps that are not, in the order to do them, and then every behaviour change you may notice.

- [Before you deploy](#before-you-deploy)
- [Deploy the server, then the clients](#deploy-the-server-then-the-clients)
- [After the first deploy](#after-the-first-deploy)
- [Behaviour changes](#behaviour-changes)

## Before you deploy

**Migrate a pre-provider store.** This release removes the read fallback for stores from before
multi-provider support, whose keys carry no provider id (`usage:events:{group}` instead of
`usage:events:{provider}:{group}`). Run the migration against the production store first:

```bash
npm run migrate:legacy               # dry run: prints the plan, changes nothing
npm run migrate:legacy -- --apply
```

It is idempotent, so running it again is always safe, and a no-op on a store that already has
provider-prefixed keys. See [data-model.md § The legacy migration](data-model.md#the-legacy-migration)
for exactly what it changes.

**Add the new secrets.** Set these in the project's environment variables, then deploy:

| Variable | Why |
| --- | --- |
| `CRON_SECRET` | `vercel.json` now schedules `GET /api/cron/housekeeping` daily. Without the secret (at least 16 characters) that call answers `500` and does nothing. |
| `SECURITY_CSP=report` | Ships the new Content Security Policy in report-only mode for the first deploy; see below. |

`DEMO_MODE` must never be set on a real deployment: it swaps the store for an in-memory one with
synthetic data and disables the PIN.

## Deploy the server, then the clients

The server accepts reports from older clients unchanged. Every payload addition (`models`, `days`,
`hours`, `costs`/`modelCosts`, `mode`, `intervalMinutes`) is optional, so an installed client keeps
reporting after the server upgrade. It only misses the newer features (per-model charts, day and
hour placement, the manual-machine badge, cost estimates) until it is updated. Updating a client
is a re-run of its installer from a freshly generated Setup-page package; see
[clients.md § Updating](clients.md#updating).

## After the first deploy

**Check the time zone.** The cycle's reset time zone now lives in the settings document, and the
built-in default changed from `Europe/Budapest` to `UTC`. A settings document saved by an earlier
release has no time zone, so the app falls back to the `RESET_TIMEZONE` environment variable, and
to `UTC` when that is unset. Open the settings panel, check the zone shown under
[Reset and time zone](configuration.md#reset-and-time-zone), and save once; from then on it is
stored with the other settings.

**Switch the CSP to enforce.** Use the dashboard and the Setup page for a while, then look for
`csp.violation` lines in the logs. Once there are none, set `SECURITY_CSP=enforce` (or remove the
variable: enforce is the default) and redeploy. See
[security.md § Content Security Policy](security.md#content-security-policy).

**Let housekeeping run.** The daily run prunes dead index entries, old audit rows and long-revoked
tokens, and archives each finished cycle into the history, so the history no longer depends on
someone opening the dashboard during the following cycle. To preview what it would do:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://usageratio.example.com/api/cron/housekeeping?dryRun=1"
```

Self-hosting without Vercel's scheduler: see
[self-hosting.md § Housekeeping](self-hosting.md#housekeeping-the-daily-cron).

## Behaviour changes

- **Login.** `DASHBOARD_PIN` now accepts 5–64 characters, so it can be a passphrase; earlier
  releases required exactly five digits. An existing 5-digit PIN keeps working. The PIN form no
  longer submits on the fifth digit (`DASHBOARD_PIN_AUTOSUBMIT=1` brings that back for a numeric
  PIN). Changing `DASHBOARD_PIN` still logs every session out.
- **Lockout.** The global lockout that anyone could trigger is gone. Failed logins are throttled
  per IP, with escalating bans for repeat offenders, and the small global budget only applies to
  browsers without the new `usageratio_device` cookie, so a stranger cannot lock you out of your
  own browsers. See [security.md](security.md).
- **Sessions.** A session now ends after 7 days without use and after 30 days at most
  (`SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS`). Existing sessions are upgraded in place on their next
  use; nobody is logged out by the upgrade itself.
- **Re-entering the PIN.** Revealing the stored API token, issuing or revoking per-machine tokens,
  destructive management actions and a manual housekeeping run ask for the PIN again (valid for
  5 minutes).
- **Ingest limits.** `POST /api/usage` can now answer `429 rate_limited` (with `Retry-After`),
  `422 too_many_groups|too_many_providers|too_many_machines`, and `413` for oversized bodies. The
  clients already retry on the next scheduled run. See [api.md](api.md).
- **Error bodies.** Every API error is `{"error": "<code>", "requestId": "…"}`; `/api/setup`
  errors are JSON instead of plain text.
- **Audit trail.** New entries keep a hashed IP and a `/24` (IPv6 `/48`) prefix instead of the full
  address (`AUDIT_RAW_IP=1` keeps it). Older entries stay readable.
- **Token vault.** The sealed API-token copy is tagged with a key id, which enables key rotation
  through `TOKEN_ENCRYPTION_KEY_PREVIOUS`; see [security.md](security.md). Older sealed values
  still open.
- **Client `--tokens`.** The manual reporter's `--tokens` flag takes `provider=count` (for
  example `--tokens claude=1234`); a bare number is refused with a hint. See
  [clients.md § Flags and exit codes](clients.md#flags-and-exit-codes).
- **Default language.** The default locale is now English. A browser that prefers Hungarian or
  German is still redirected to `/hu` or `/de`.
- **No phantom provider.** A fresh install no longer shows an empty DeepSeek account; the
  dashboard shows a setup hint until the first report arrives.
