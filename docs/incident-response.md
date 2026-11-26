# Incident response

> This is a working checklist, not legal advice. Check it against the Hungarian data protection
> authority's (NAIH) current guidance on personal data breaches before relying on it.

What to do when personal data on the public usageratio instance may have been exposed, changed or
lost: a personal data breach under the GDPR. The data controller is a private individual (see the
privacy notice, `/privacy`), who carries every step below personally: there is no team and no data
protection officer. Self-hosted instances have their own controller; the steps still apply, with
their own contact details and providers.

The clock starts when you become **aware** of a breach, meaning reasonably certain that one
happened, not when it happened: the authority must have the notification within **72 hours** of
that (GDPR Art. 33(1)). Write down the time at once (step 6).

- [1. Detect](#1-detect)
- [2. Contain](#2-contain)
- [3. Assess the risk](#3-assess-the-risk)
- [4. Notify the authority (NAIH) within 72 hours](#4-notify-the-authority-naih-within-72-hours)
- [5. Tell the people affected](#5-tell-the-people-affected)
- [6. Record it, even when nothing is notified](#6-record-it-even-when-nothing-is-notified)

## What the instance holds

What a breach can touch (the full list: [data-model.md](data-model.md), the privacy notice):

- **Accounts:** GitHub numeric id and login, when the account was created and last signed in. No
  e-mail address, no password, no GitHub access token.
- **Workspaces:** names, members and their roles, machine and group names chosen by the users,
  token usage figures, settings, **alert webhook URLs** (often a secret in themselves: whoever has
  one can post into that Slack, Discord or Teams channel).
- **Security data:** sessions (stored as hashes), machine tokens (hashes only), audit trails with a
  browser label and a hashed IP address (`AUDIT_RAW_IP=1` keeps the full address), short-lived
  rate-limit counters.
- **Elsewhere:** Vercel's runtime logs (request IP, path, user agent; **1 hour** on the Hobby
  plan, no log drain configured), Upstash backups taken before maintenance (at most 90 days), the
  error webhook (`ERROR_WEBHOOK_URL`) if set.

No special categories of data (Art. 9), no payment data.

## 1. Detect

Where a signal can come from:

| Source | What to look for |
| --- | --- |
| A report to `privacy@snktibor.hu`, or a private advisory on GitHub (`SECURITY.md`) | Anyone saying they saw data that was not theirs, or found a hole. Acknowledge it, ask for details, never ask for more personal data than needed. |
| Vercel runtime logs (`vercel logs`, the dashboard) | `csp.violation` (a script that should not be there), `api.unhandled`, `request.error`, bursts of `auth.login_failed`, `rate_limit.exceeded`, `signin.failed`, `housekeeping.tenant_failed`. **They are kept for one hour only: save what you need right away** (`vercel logs <deployment> > ~/.usageratio-ops/incidents/…`). |
| CSP reports (`POST /api/csp-report`) | Logged as `csp.violation` with the page and the blocked URL: an injected script, or a browser extension (usually harmless). |
| The error webhook (`ERROR_WEBHOOK_URL`) | Unhandled server errors, Upstash refusing commands (`storage.quota_exceeded`). |
| Upstash console | A spike in commands, bandwidth or storage; connections you do not recognise; a token you did not create. |
| Provider notices | Security e-mails from Vercel, Upstash, GitHub or Cloudflare about their own incidents; a GitHub notice that a secret was pushed to a repository. |
| The app itself | A workspace's audit trails (settings → tokens and destructive actions: who did what, with a hashed IP), the admin page's counts (`/admin`): workspaces or machines that should not be there. |

Not every signal is a breach. It is one when personal data was (or may have been) disclosed to
someone not entitled to it, changed without authority, or lost (Art. 4(12)): a leaked Upstash
token is one even if nobody is known to have used it yet.

## 2. Contain

Stop it getting worse first; investigate after. Keep what you find (logs, screenshots, the
attacker's requests) in `~/.usageratio-ops/incidents/`, never in the repository.

**One workspace is abused or compromised:** disable it on `/admin` (`PATCH
/api/admin/tenants/[id]`, `{"status": "disabled"}`). Its data stays, its members and machines are
refused at once (`tenant_disabled`). Enable it again once it is safe.

**Sessions:**

- One user: they sign out everywhere on the account page (`DELETE /api/account/sessions`).
- Everyone (multi-tenant): delete every `usage:session2:*` key in the Upstash console (Data
  Browser, or `redis-cli --scan --pattern 'usage:session2:*' | xargs redis-cli del` against the
  database). The `usage:user:*:sessions` index entries left behind point at nothing and are
  harmless.
- Single-user instance: change `DASHBOARD_PIN` and redeploy. A PIN session's key is derived from
  the PIN, so every existing session stops working.

**Rotate the secrets that may be known.** Each is an environment variable on Vercel (Project →
Settings → Environment Variables); a change takes effect with the next deployment, so redeploy
after each batch:

| Secret | How |
| --- | --- |
| GitHub OAuth secret (`GITHUB_CLIENT_SECRET`) | GitHub → Settings → Developer settings → OAuth Apps → the app → *Generate a new client secret*; set it on Vercel, redeploy, then delete the old secret on GitHub. |
| `TOKEN_ENCRYPTION_KEY` | The rotation runbook in [security.md](security.md#the-token-vault-and-key-rotation). If the key and a Redis copy both leaked, the sealed `USAGE_API_TOKEN` is exposed too: rotate that as well. Without `AUDIT_SALT` set, the audit IP hashes are keyed with this key: set `AUDIT_SALT` to a new value in the same deployment. |
| `CRON_SECRET` | `openssl rand -hex 32`, set it on Vercel, redeploy (Vercel Cron picks it up itself). |
| Upstash REST token (`KV_REST_API_TOKEN`, and the read-only one) | Upstash console → the database → reset its tokens / password. On Vercel the integration updates the variables; check that they did, and redeploy. Replace the read-only copy in `~/.usageratio-ops/prod-readonly.env`. |
| Machine tokens | The workspace's owner revokes or rotates them on the settings page (each is in the audit trail). On a single-user instance also change `USAGE_API_TOKEN` and update every client's config. |
| Alert webhook URLs | They belong to the users: tell the affected workspaces (step 5) to regenerate the webhook in Slack, Discord or Teams and save the new URL. |
| `ERROR_WEBHOOK_URL`, `ADMIN_GITHUB_IDS` | Regenerate the webhook if it leaked; remove any admin id you do not recognise. |

**Fix the cause:** a code fix goes through a pull request like any other (a private security
advisory on GitHub keeps it quiet until it ships); a misconfiguration is fixed on Vercel or Upstash.
If restoring data is needed, restore from the Upstash backup taken before the incident, and only
the keys that were damaged.

## 3. Assess the risk

Decide, and write down why (step 6), how likely and how severe the harm to the people affected is.
That decides steps 4 and 5:

| Risk | Authority (step 4) | People affected (step 5) |
| --- | --- | --- |
| Unlikely to result in any risk (for example: an encrypted copy without its key, data reached only by the controller) | Not notified | Not told |
| A risk | Notify within 72 hours | Not required |
| A **high** risk | Notify within 72 hours | Tell them without undue delay |

Questions that move the risk:

- **What data?** A GitHub login is public already; machine and group names can reveal a person's
  name or employer; usage figures show working habits; a **webhook URL lets the holder post into
  someone's channel** (high); session or token material that still works lets someone act as the
  user (high, until rotated).
- **Who got it, and can it be undone?** A trusted recipient who confirms deletion lowers the risk;
  a public leak or an unknown attacker raises it. Data changed or deleted: is a backup there?
- **How many people and workspaces?** Count them from the store (the admin page, the audit trails,
  the keys touched).
- **Is it still going on?** Containment (step 2) must be finished, or the risk stays high.

## 4. Notify the authority (NAIH) within 72 hours

Unless the breach is unlikely to result in a risk (step 3), notify the Hungarian authority, the
Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH, naih.hu), through its online data
breach notification form, **within 72 hours of becoming aware**. Later than that, the notification
must also say why it is late (Art. 33(1)).

The notification has to contain at least (Art. 33(3)):

1. the nature of the breach: what happened, when, how it was found; the **categories and
   approximate number** of people and of records concerned;
2. the name and contact details of whoever can give more information: the controller,
   `privacy@snktibor.hu`;
3. the likely consequences for the people affected;
4. the measures taken or proposed: what was contained, what was rotated, what is still to be done,
   and what was done to limit the harm.

What is not known yet may follow in phases (Art. 33(4)): send what you have within the 72 hours,
say what is still being investigated, and send the rest without further delay. Keep a copy of
everything sent, and its time.

## 5. Tell the people affected

When the risk is **high** (step 3), the people affected must be told without undue delay (Art.
34(1)), in clear and plain language, with points 2–4 of step 4: whom to contact, the likely
consequences, and what was done and what they should do (sign out everywhere, rotate their machine
tokens, regenerate their webhook).

The instance stores **no e-mail address**, so individual messages are not possible. Art. 34(3)(c)
allows a public communication instead when telling each person individually would take
disproportionate effort; it has to reach them as effectively. Use every channel there is:

- **In the app:** a notice that every signed-in user sees (on the dashboard and the sign-in
  screen) until the incident is closed, and on the affected workspaces' pages. It ships as an
  ordinary deployment, with its text in every locale (`messages/*.json`).
- **On the landing page** (the project's own site): the same notice, for people who no longer sign
  in.
- **GitHub:** a security advisory on the repository once the fix has shipped, and a pinned issue
  or a release note linking to it, for self-hosters and users who follow the project.

Telling people is not required when the data was made unintelligible to anyone without access (for
example, encrypted with a key that did not leak), or when the measures taken mean the high risk is
no longer likely (Art. 34(3)(a)–(b)). Write down which applied. The authority can still order the
communication.

## 6. Record it, even when nothing is notified

Every personal data breach goes into the controller's incident register, **including the ones not
notified** (Art. 33(5)): the authority can ask to see it, and it shows the decisions in step 3 were
made and why. Keep it privately, outside the repository: one file per incident in
`~/.usageratio-ops/incidents/`, named `YYYY-MM-DD-short-name.md`.

```markdown
# Incident YYYY-MM-DD — short name

| | |
| --- | --- |
| Became aware (date, time, time zone) | |
| How it was found | (report, log line, provider notice, …) |
| When it happened (or from–to) | |
| What happened | (the facts: what was accessed, changed or lost, and how) |
| Data concerned | (categories: accounts, workspace data, webhook URLs, sessions, logs, …) |
| People and records concerned | (approximate numbers; workspaces) |
| Likely consequences | |
| Risk (none / risk / high) and why | |
| Containment, with times | (disabled workspaces, sessions ended, secrets rotated, fix deployed) |
| NAIH notified? | (no, and why / yes: date, time, reference number; phased follow-ups) |
| People told? | (no, and why / yes: when, how: in-app notice, landing page, GitHub) |
| Evidence kept | (files next to this one) |
| Follow-up | (what changes so it does not happen again; issue or PR links) |
| Closed (date) | |
```
