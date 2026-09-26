# Upgrading

Steps for moving an existing deployment to a newer release. Most of this app upgrades with a plain
redeploy and no other action — this page calls out the exceptions.

- [Multi-provider data (pre-provider stores only)](#multi-provider-data-pre-provider-stores-only)
- [Time zone (settings documents with no `reset.timeZone`)](#time-zone-settings-documents-with-no-resettimezone)
- [Rolling out or changing the CSP](#rolling-out-or-changing-the-csp)
- [Adding `CRON_SECRET`](#adding-cron_secret)
- [Sessions](#sessions)
- [The PIN may now be a passphrase](#the-pin-may-now-be-a-passphrase)
- [Client `--tokens` flag](#client---tokens-flag)
- [Updating clients](#updating-clients)

## Multi-provider data (pre-provider stores only)

If the store predates multi-provider support (it only ever tracked one provider, with no
`providerId` in its keys), run the legacy migration **before** deploying a build whose
`lib/usage-store.ts` no longer has the old read fallback:

```bash
node --env-file-if-exists=.env.local --import tsx scripts/migrate-legacy.ts -- --apply
```

Run it without `--apply` first to see the plan; it's idempotent, so running it again (before or after
deploying) is always safe. See [data-model.md § The legacy migration](data-model.md#the-legacy-migration)
for exactly what it changes. If your store already has provider-prefixed keys (anything deployed in
the last several releases), this step is a no-op and can be skipped.

## Time zone (settings documents with no `reset.timeZone`)

A settings document saved by a much older release (`v1`/`v2`, before per-document time zones existed)
has no `reset.timeZone` field, so the effective time zone falls back to the deploy-time
`RESET_TIMEZONE` environment variable, or `UTC` if that's unset too — which may not be the time zone
you actually want the cycle to reset in. After upgrading, open the settings panel and either confirm
the time zone shown is correct or set it explicitly (this is a one-time save; it's stored from then
on). See [configuration.md § Reset and time zone](configuration.md#reset-and-time-zone).

## Rolling out or changing the CSP

Deploy a first release, or any change to the Content Security Policy, with:

```bash
SECURITY_CSP=report
```

Use the dashboard normally for a while, then check the logs for `csp.violation` lines — a legitimate
resource the new policy doesn't yet allow shows up there, blocked nowhere. Fix anything real, then
switch to `SECURITY_CSP=enforce` (or remove the variable, since that's the default) and redeploy. See
[security.md § Content Security Policy](security.md#content-security-policy).

## Adding `CRON_SECRET`

If housekeeping (stale-entry pruning, audit-trail retention, and archiving each finished cycle into
history) has never run because `CRON_SECRET` was never set, add it now (at least 16 characters) and
redeploy — `vercel.json`'s cron entry calls `GET /api/cron/housekeeping` once a day automatically once
the secret is present. Before this, a cycle's history was only archived on the first dashboard render
after it ended; the daily cron now archives it too, whichever happens first, so history no longer
depends on someone opening the dashboard. Self-hosting a scheduler yourself instead: see
[self-hosting.md § Housekeeping](self-hosting.md#housekeeping-the-daily-cron).

## Sessions

Existing sessions keep working across an upgrade without any action: a session record from before
rolling sessions existed (a bare `"1"` value) is read as freshly created and freshly seen, then
silently upgraded to the current `{c, s}` shape the next time it's touched. Nobody is logged out by
this change.

## The PIN may now be a passphrase

`DASHBOARD_PIN` has always accepted 5–64 characters; older documentation described it as a 5-digit
code only. No change is needed to keep an existing numeric PIN working — but on a public URL,
consider switching to a longer passphrase (12+ characters, letters and digits) for a meaningfully
larger guess space. Changing `DASHBOARD_PIN` logs every existing session out immediately.

## Client `--tokens` flag

The reporter's `--tokens` flag now takes `provider=count` (e.g. `--tokens claude=1234`), naming the
provider explicitly, rather than an older single-provider-implied form. Existing installed clients are
unaffected unless you're scripting `--tokens` directly yourself — check
[clients.md § Flags and exit codes](clients.md#flags-and-exit-codes) if you are.

## Updating clients

The server accepts reports from older clients unchanged — every payload addition (`models`, `days`,
`hours`, `costs`/`modelCosts`, `mode`, `intervalMinutes`) has always been optional, so an older
installed client keeps reporting correctly after a server upgrade; it just won't populate the newer
dashboard features (per-model charts, day/hour placement, cost estimates) until it's updated too.
Updating a client is a plain re-run of its installer from a freshly generated Setup-page package or
checkout — see [clients.md § Updating](clients.md#updating).
