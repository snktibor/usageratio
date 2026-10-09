# Per-provider budget cycle — reporting clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bash and PowerShell reporting clients count every provider from its own cycle start, using the `cycle.providers` map that `GET /api/usage` now returns.

**Architecture:** One `ccusage` run still covers every provider (the server's `cycle.sinceDate` is already the earliest start). The shared parser `clients/shared/ccusage-providers.cjs` gets the server's per-provider starts as one more argument of its parse commands and trims each provider: its days before its own start date drop to 0, and on its start date the hours before its start are taken off where `ccusage blocks` has them (Claude Code) — the same trimming that exists today for the one shared start, now per provider. Both shell cores only pass the extra argument.

**Tech Stack:** Node (dependency-free CommonJS parser), bash, PowerShell 5.1/7, Vitest (`tests/client-parser.test.ts`, `tests/setup-install.test.ts`), Pester 5 (`clients/tests/report-usage-core.Tests.ps1`).

**Spec:** `docs/superpowers/specs/2026-10-09-official-usage-report-design.md` (Part 1b). Builds on plan 1 (`docs/superpowers/plans/2026-10-09-per-provider-cycle-core.md`), already merged on this branch.

## Global Constraints

- `GET /api/usage` (from plan 1): `{ tokenMode, providers: string[], cycle: { start, end, sinceDate, timeZone, providers: { [providerId]: { start: string; end: string } } } }`; `start`/`sinceDate` are the earliest provider cycle's (the shared reset's included).
- A server without `cycle.providers` (older deployment), or a response without `cycle.start`, must give exactly today's result: no change for anyone who does not use per-provider resets.
- A missing or unreadable blocks file still only means "no hours"; a missing or unreadable cycle file only means "every provider uses the shared start".
- A provider whose whole reading falls before its own start is still reported, at 0 (a snapshot names it).
- The parser stays a single dependency-free file used by both shells; Windows PowerShell 5.1 drops empty native arguments, so no positional argument may be empty there.
- `npm run check` must pass at the end of every task; the Pester suite must pass for the PowerShell task (`pwsh` with Pester ≥ 5.5 is installed locally).
- Conventional Commits; never any AI attribution in commit messages.

---

### Task 1: per-provider trimming in the parser

**Files:**
- Modify: `clients/shared/ccusage-providers.cjs` (`applyHourly`, `collectUsage`, `readHourly`, `main`; new `startOf`, `trimToCycles`, `readJsonFile`, `readStarts`)
- Test: `tests/client-parser.test.ts`

**Interfaces:**
- Produces: the `hourly` input of `parseCcusageUsage` / `parseCcusageProviders` / `parseCcusageDays` becomes `{ blocks: unknown | null; cycleStartMs: number; timeZone: string; starts?: Record<string, number> }` (`starts`: provider → its own start, epoch ms).
- Produces (CLI): `parse | parse-models | parse-days | parse-costs <fallback providers> [<blocks file | "-"> <cycle start ISO> <time zone> [<cycle file>]]` — `<cycle file>` is a `GET /api/usage` response (only `cycle.providers[id].start` is read); `"-"` names no blocks file.

- [ ] **Step 1: Write the failing tests** — in `tests/client-parser.test.ts`, widen the `Hourly` type at the top:

```ts
type Hourly = { blocks: unknown; cycleStartMs: number; timeZone: string; starts?: Record<string, number> } | null;
```

and add inside `describe("ccusage split by hour")`, after the existing cases (it reuses that block's `daily`, `blocks` and `block` fixtures: Claude on the 19th, 20th and 21st, Codex → openai on the 20th, Budapest time, shared start `2026-09-19T11:00:00Z`):

```ts
  describe("with each provider's own cycle start", () => {
    // 11:00 in Budapest on Sunday: the 08:00 UTC hour is before it, the 10:00 one after.
    const claudeStart = Date.parse("2026-09-20T09:00:00Z");
    const own = (starts: Record<string, number>, list: unknown[] | null = blocks): Hourly => ({
      blocks: list === null ? null : { blocks: list },
      cycleStartMs: Date.parse("2026-09-19T11:00:00Z"),
      timeZone: "Europe/Budapest",
      starts,
    });

    it("counts a provider from its own start: earlier days drop out, the start day loses its earlier hours", () => {
      expect(parseCcusageProviders(daily, [], own({ claude: claudeStart }))).toEqual({ claude: 100, openai: 10 });
      const days = parseCcusageDays(daily, own({ claude: claudeStart }));
      expect(days).not.toHaveProperty("2026-09-19");
      expect(days["2026-09-20"]).toEqual({
        providers: { claude: 20, openai: 10 },
        models: { claude: { "claude-opus-5": 20 }, openai: { "gpt-5-codex": 10 } },
        hours: { claude: { "2026-09-20T10:00:00Z": 20 } },
      });
    });

    it("drops whole days by date when there are no hours", () => {
      expect(parseCcusageProviders(daily, [], own({ claude: claudeStart }, null))).toEqual({ claude: 130, openai: 10 });
    });

    it("still names a provider whose every day is before its start, at 0", () => {
      expect(parseCcusageProviders(daily, [], own({ openai: Date.parse("2026-09-21T00:00:00Z") }, null))).toEqual({
        claude: 250,
        openai: 0,
      });
    });

    it("leaves a provider without its own start on the shared one", () => {
      expect(parseCcusageUsage(daily, [], own({}))).toEqual(parseCcusageUsage(daily, [], hourly()));
    });
  });

  it("reads each provider's start from the cycle file on the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "usageratio-starts-"));
    try {
      const blocksFile = join(dir, "blocks.json");
      const cycleFile = join(dir, "cycle.json");
      writeFileSync(blocksFile, JSON.stringify({ blocks }));
      writeFileSync(
        cycleFile,
        JSON.stringify({
          tokenMode: "snapshot",
          providers: ["claude", "openai"],
          cycle: {
            start: "2026-09-19T11:00:00.000Z",
            sinceDate: "2026-09-19",
            timeZone: "Europe/Budapest",
            providers: {
              claude: { start: "2026-09-20T09:00:00.000Z", end: "2026-09-27T09:00:00.000Z" },
              openai: { start: "2026-09-19T11:00:00.000Z", end: "2026-09-26T11:00:00.000Z" },
            },
          },
        }),
      );
      const run = (...args: string[]) =>
        execFileSync("node", [PARSER, ...args], { input: JSON.stringify(daily), encoding: "utf8" });
      const shared = ["2026-09-19T11:00:00.000Z", "Europe/Budapest"];

      expect(JSON.parse(run("parse", "claude", blocksFile, ...shared, cycleFile))).toEqual({ claude: 100, openai: 10 });
      // "-": no blocks file; the days are still cut by date.
      expect(JSON.parse(run("parse", "claude", "-", ...shared, cycleFile))).toEqual({ claude: 130, openai: 10 });
      // A missing or broken cycle file: every provider on the shared start, as before.
      expect(JSON.parse(run("parse", "claude", blocksFile, ...shared, join(dir, "none.json")))).toEqual({
        claude: 230,
        openai: 10,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
```

(The arithmetic: Claude's Saturday 120 → 0; Sunday 50 minus the 08:00 UTC hour's 30 → 20, opus scaled 50 → 20; Monday 80; total 100. Without blocks Sunday stays whole: 0 + 50 + 80 = 130.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/client-parser.test.ts`
Expected: FAIL — `starts` is ignored (claude 230 / 250), `"-"` is read as a missing blocks file that disables the whole `hourly` input.

- [ ] **Step 3: Implement** in `clients/shared/ccusage-providers.cjs`:

After `trimProvider`, add:

```js
/** When `provider`'s own cycle began: its start from the server (`hourly.starts`), else the shared one. */
function startOf(hourly, provider) {
  const own = hourly.starts && Object.hasOwn(hourly.starts, provider) ? hourly.starts[provider] : undefined;
  return own ?? hourly.cycleStartMs;
}

/**
 * Drops each provider's days before its own cycle's first day: `ccusage
 * --since` reads from the earliest start of them all (the server's
 * `cycle.sinceDate`), and a provider with a later reset must not count what
 * came before it. The provider stays in such a day at 0, so a snapshot still
 * names it; its split by model and cost for that day goes.
 */
function trimToCycles(days, hourly) {
  if (!hourly) return;
  for (const [date, usage] of days) {
    for (const provider of [...usage.providers.keys()]) {
      if (date >= localDate(startOf(hourly, provider), hourly.timeZone)) continue;
      usage.providers.set(provider, 0);
      usage.models.delete(provider);
      usage.costs.delete(provider);
      usage.modelCosts.delete(provider);
    }
  }
}
```

In `applyHourly`, replace the two lines

```js
  const blocks = hourly && hourlyBlocks(hourly.blocks, hourly.timeZone);
  if (!blocks) return hoursByDate;
  const firstDate = localDate(hourly.cycleStartMs, hourly.timeZone);
```

with

```js
  const blocks = hourly?.blocks && hourlyBlocks(hourly.blocks, hourly.timeZone);
  if (!blocks) return hoursByDate;
```

and inside the provider loop replace the `if (date === firstDate) {…}` block with

```js
      const startMs = startOf(hourly, provider);
      if (date === localDate(startMs, hourly.timeZone)) {
        const before = sumTokens(blockHours.filter((hour) => hour.startMs + HOUR_MS <= startMs));
        if (before > 0) trimProvider(usage, provider, before);
        hours = blockHours.filter((hour) => hour.startMs + HOUR_MS > startMs);
      }
```

Update `applyHourly`'s doc comment: "On the day each provider's own cycle starts (its `hourly.starts` entry, else the shared start), the hours before …".

In `collectUsage`, before the `return`, add `trimToCycles(days, hourly);` (the trim must run before `applyHourly`, which compares the blocks with what is left of the day).

Replace `readHourly` with:

```js
/** A JSON file's contents; null for "-", a missing path, or a file that does not parse. */
function readJsonFile(path) {
  if (!path || path === "-") return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** provider → its own cycle start (ms), from a GET /api/usage response's `cycle.providers`; {} without one. */
function readStarts(cyclePath) {
  const providers = asObject(asObject(asObject(readJsonFile(cyclePath))?.cycle)?.providers);
  const starts = {};
  for (const [rawProvider, entry] of Object.entries(providers || {})) {
    const provider = slug(rawProvider);
    const startMs = Date.parse(asObject(entry)?.start);
    if (provider && Number.isFinite(startMs)) starts[provider] = startMs;
  }
  return starts;
}

/**
 * The `hourly` input of the parse commands: the blocks (null without a
 * readable file, or "-"), the shared cycle start, the time zone and each
 * provider's own start. Null when the start or the time zone is missing or
 * unreadable: then nothing is trimmed at all.
 */
function readHourly(blocksPath, cycleStart, timeZone, cyclePath) {
  if (!cycleStart || !timeZone) return null;
  const cycleStartMs = Date.parse(cycleStart);
  if (!Number.isFinite(cycleStartMs)) return null;
  try {
    localDate(cycleStartMs, timeZone);
  } catch {
    return null;
  }
  return { blocks: readJsonFile(blocksPath), cycleStartMs, timeZone, starts: readStarts(cyclePath) };
}
```

In `main`, update the comment to `// parse, parse-models, parse-days, parse-costs: <fallback providers> [<blocks file | "-"> <cycle start> <time zone> [<cycle file>]]` and the call to `readHourly(process.argv[4], process.argv[5], process.argv[6], process.argv[7])`.

Update `parseCcusageUsage`'s doc comment: "`hourly` ({ blocks, cycleStartMs, timeZone, starts }, optional) trims each provider to its own cycle start and lays Claude Code's hours over the days: see trimToCycles and applyHourly."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/client-parser.test.ts`
Expected: PASS — the new cases and every existing one (a missing blocks file still gives `{ claude: 250, openai: 10 }`: with the shared start on the 19th, no day is before it).

- [ ] **Step 5: Run the checks and commit**

Run: `npm run check` — PASS.

```bash
git add clients/shared/ccusage-providers.cjs tests/client-parser.test.ts
git commit -m "feat(clients): count every provider from its own cycle start"
```

---

### Task 2: the bash client passes the cycle

**Files:**
- Modify: `clients/shared/report-usage-core.sh:147` (`hourly_args`)
- Test: `tests/setup-install.test.ts`

**Interfaces:**
- Consumes: the parser CLI of Task 1 (`<blocks file> <cycle start> <time zone> <cycle file>`).

- [ ] **Step 1: Write the failing test** — in `tests/setup-install.test.ts`:

1. Let `startServer` take the GET body: `async function startServer(cycleResponse: unknown = DEFAULT_CYCLE): Promise<Stub>` with

```ts
const DEFAULT_CYCLE = {
  tokenMode: "snapshot",
  providers: ["claude"],
  cycle: { sinceDate: "2026-09-21", timeZone: "Europe/Budapest" },
};
```

and the GET branch answering `JSON.stringify(cycleResponse)`.

2. Inside the per-OS `describe`, add:

```ts
    it("counts every provider from its own cycle start", async () => {
      await new Promise((resolve) => stub.server.close(resolve));
      stub = await startServer({
        tokenMode: "snapshot",
        providers: ["claude", "openai"],
        cycle: {
          start: "2026-09-20T22:00:00.000Z",
          end: "2026-09-27T22:00:00.000Z",
          sinceDate: "2026-09-21",
          timeZone: "Europe/Budapest",
          providers: {
            // Claude resets on Thursday at midnight in Budapest; OpenAI on Monday.
            claude: { start: "2026-09-23T22:00:00.000Z", end: "2026-09-30T22:00:00.000Z" },
            openai: { start: "2026-09-20T22:00:00.000Z", end: "2026-09-27T22:00:00.000Z" },
          },
        },
      });
      tool(
        "ccusage",
        `cat <<'JSON'\n${JSON.stringify({
          daily: [
            { date: "2026-09-21", agents: [{ agent: "claude", totalTokens: 1234 }, { agent: "codex", totalTokens: 50 }] },
            { date: "2026-09-24", agents: [{ agent: "claude", totalTokens: 100 }] },
          ],
        })}\nJSON`,
      );

      const result = await run(await unpack("auto", "Home"), env({ USAGERATIO_API_TOKEN: TOKEN }));

      expect(result.code).toBe(0);
      expect(stub.reports).toEqual([expect.objectContaining({ providers: { claude: 100, openai: 50 } })]);
    });
```

(The existing cases keep the default cycle without `start`/`providers`: they prove an older server still works unchanged.)

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/setup-install.test.ts`
Expected: FAIL — the report carries `claude: 1334`.

- [ ] **Step 3: Implement** — in `clients/shared/report-usage-core.sh`, replace

```bash
  hourly_args=("$blocks_file" "$cycle_start" "$cycle_timezone")
```

with

```bash
  # The cycle file also names each provider's own start (cycle.providers): the
  # parser counts every provider from its own, and the earliest from the shared one.
  hourly_args=("$blocks_file" "$cycle_start" "$cycle_timezone" "$cycle_file")
```

(`$cycle_file` is the GET response already saved at the top of `read_provider_tokens`; a server without `cycle.start` leaves `$cycle_start` empty and the parser trims nothing, as before.)

- [ ] **Step 4: Run the checks**

Run: `npx vitest run tests/setup-install.test.ts` — PASS. Then `npm run check` — PASS. If `shellcheck` is installed, `shellcheck clients/shared/report-usage-core.sh` — no new warnings.

- [ ] **Step 5: Commit**

```bash
git add clients/shared/report-usage-core.sh tests/setup-install.test.ts
git commit -m "feat(clients): pass each provider's cycle start to the parser (bash)"
```

---

### Task 3: the PowerShell client passes the cycle

**Files:**
- Modify: `clients/shared/report-usage-core.ps1` (`Read-ProviderUsage` and its caller around lines 278–290)
- Test: `clients/tests/report-usage-core.Tests.ps1`

**Interfaces:**
- Consumes: the parser CLI of Task 1. A `"-"` blocks argument stands for "no blocks file" (Windows PowerShell 5.1 drops empty native arguments).

- [ ] **Step 1: Write the failing test** — append to `clients/tests/report-usage-core.Tests.ps1`:

```powershell
Describe 'report-usage-core.ps1 with each provider''s own cycle start' {
    BeforeAll {
        # A one-request HTTP stub of GET /api/usage, in a background job so the child process can reach it.
        $script:Port = Get-Random -Minimum 20000 -Maximum 40000
        $script:CycleJson = @{
            tokenMode = 'snapshot'
            providers = @('claude', 'openai')
            cycle     = @{
                start     = '2026-01-05T00:00:00Z'
                end       = '2026-01-12T00:00:00Z'
                sinceDate = '2026-01-05'
                timeZone  = 'UTC'
                providers = @{
                    # After the fixture's only day (2026-01-05): Claude counts nothing yet.
                    claude = @{ start = '2026-01-06T00:00:00Z'; end = '2026-01-13T00:00:00Z' }
                    openai = @{ start = '2026-01-05T00:00:00Z'; end = '2026-01-12T00:00:00Z' }
                }
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $script:Server = Start-Job -ArgumentList $script:Port, $script:CycleJson -ScriptBlock {
            param($Port, $Body)
            $listener = [Net.HttpListener]::new()
            $listener.Prefixes.Add("http://localhost:$Port/")
            $listener.Start()
            try {
                $context = $listener.GetContext()
                $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
                $context.Response.ContentType = 'application/json'
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.Close()
            } finally { $listener.Stop() }
        }
        # Wait until the stub listens.
        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 200
            $client = [Net.Sockets.TcpClient]::new()
            try { $client.Connect('localhost', $script:Port); $listening = $true } catch { $listening = $false } finally { $client.Dispose() }
        } until ($listening -or (Get-Date) -gt $deadline)
    }

    AfterAll {
        Stop-Job -Job $script:Server -ErrorAction SilentlyContinue
        Remove-Job -Job $script:Server -Force -ErrorAction SilentlyContinue
        Remove-Item Env:USAGERATIO_API_URL, Env:USAGERATIO_API_TOKEN -ErrorAction SilentlyContinue
    }

    It 'trims every provider to its own start' {
        $env:USAGERATIO_API_URL = "http://localhost:$script:Port/api/usage"
        $env:USAGERATIO_API_TOKEN = 'test-token'
        $result = Invoke-Core -Arguments @('-DryRun', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 0
        $payload = $result.Output | ConvertFrom-Json
        $payload.providers.claude | Should -Be 0
        $payload.providers.openai | Should -Be 500
    }
}
```

(The shimmed `ccusage` prints `clients/tests/fixtures/daily.json`: on 2026-01-05 Claude used 2490 tokens and Codex — openai — 500; `blocks.json` is empty.) The connection probe in `BeforeAll` uses up the stub's one request only if it sends an HTTP request — a bare TCP connect does not reach `GetContext()`'s handler with a full request; if it does on some platform, make the job loop `while ($true)` over `GetContext()` and rely on `Stop-Job` in `AfterAll`.

- [ ] **Step 2: Run it to see it fail**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path clients/tests/report-usage-core.Tests.ps1 -Output Detailed"`
Expected: the new case FAILS with `claude` = 2490.

- [ ] **Step 3: Implement** in `clients/shared/report-usage-core.ps1`:

1. Add a helper before `Read-ProviderUsage`:

```powershell
# PowerShell 7 turns ISO date strings of a JSON response into DateTime values; 5.1 keeps the string.
function ConvertTo-IsoUtc {
  param($Value)
  if ($Value -is [DateTime]) {
    return $Value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
  }
  return [string]$Value
}
```

2. `Read-ProviderUsage` gets one more parameter, `$CycleProviders` (the response's `cycle.providers`, possibly `$null`):

```powershell
  param([string]$SinceDate, [string]$TimeZone, [string]$FallbackProviders, [string]$CycleStart, $CycleProviders, [bool]$Cost)
```

Next to `$blocksFile`, add `$cycleFile = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-cycle-{0}.json" -f [Guid]::NewGuid())`, add `$cycleFile` to the `Remove-Item` in `finally`, and replace

```powershell
    $hourlyArgs = @()
    if ($CycleStart -and (Test-Path -LiteralPath $blocksFile)) { $hourlyArgs = @($blocksFile, $CycleStart, $TimeZone) }
```

with

```powershell
    # Each provider's own cycle start (GET /api/usage's cycle.providers), for the
    # parser to count every provider from its own; the shared start stands in for the rest.
    $starts = [ordered]@{}
    if ($CycleProviders) {
      foreach ($entry in $CycleProviders.PSObject.Properties) {
        $starts[$entry.Name] = @{ start = (ConvertTo-IsoUtc $entry.Value.start) }
      }
    }
    [IO.File]::WriteAllText($cycleFile, (@{ cycle = @{ providers = $starts } } | ConvertTo-Json -Compress -Depth 5))
    $hourlyArgs = @()
    if ($CycleStart) {
      # "-": no blocks file. 5.1 drops an empty argument, which would shift the ones after it.
      $blocksArg = if (Test-Path -LiteralPath $blocksFile) { $blocksFile } else { '-' }
      $hourlyArgs = @($blocksArg, $CycleStart, $TimeZone, $cycleFile)
    }
```

3. In the caller, replace the `$cycleStart` lines with

```powershell
    $cycleStart = ConvertTo-IsoUtc $cycleResponse.cycle.start
    $providersJson = Read-ProviderUsage -SinceDate $sinceDate -TimeZone $timeZone -FallbackProviders $fallbackProviders -CycleStart $cycleStart -CycleProviders $cycleResponse.cycle.providers -Cost $cost
```

(Keep the "PowerShell 7 turns ISO date strings…" comment on the helper only.)

- [ ] **Step 4: Run the checks**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path clients/tests/report-usage-core.Tests.ps1 -Output Detailed"` — every case PASSES.
Run: `pwsh -NoProfile -Command "Invoke-ScriptAnalyzer -Path clients/shared/report-usage-core.ps1 -Settings PSScriptAnalyzerSettings.psd1"` (if PSScriptAnalyzer is installed) — no new findings.
Run: `npm run check` — PASS.

- [ ] **Step 5: Commit**

```bash
git add clients/shared/report-usage-core.ps1 clients/tests/report-usage-core.Tests.ps1
git commit -m "feat(clients): pass each provider's cycle start to the parser (PowerShell)"
```

---

### Task 4: docs

**Files:**
- Modify: `docs/upgrading.md` ("Per-provider reset"), `docs/clients.md`, `docs/api.md` (POST /api/usage `cycle` sentence), `app/api/usage/route.ts` (the `cycle.providers` comment), `lib/ingest.ts:34` (the `IngestResult.cycle` comment)

- [ ] **Step 1:** `docs/upgrading.md` "Per-provider reset": the clients now count every provider from its own start; a machine installed before this release keeps over-counting a provider with a later reset until the installer is re-run on it (download a fresh setup package from the settings page). Remove the "in a later release" wording plan 1 left there.
- [ ] **Step 2:** `docs/clients.md`: in the section that describes how a client reads the cycle and runs `ccusage`, add that `ccusage` runs from the earliest provider's start and each provider is then trimmed to its own (`cycle.providers`), days by date and Claude Code's hours by hour.
- [ ] **Step 3:** `app/api/usage/route.ts`: the `cycle.providers` comment becomes "Each provider's own: a client trims every provider to its start (clients/shared/ccusage-providers.cjs)."
- [ ] **Step 4:** `docs/api.md` POST /api/usage and `lib/ingest.ts` `IngestResult.cycle`: "the earliest of the shared reset's cycle and the report's providers' cycles" (the shared reset's counts too; plan 1's final review parked this).
- [ ] **Step 5:** `npm run check` — PASS. Commit:

```bash
git add docs app/api/usage/route.ts lib/ingest.ts
git commit -m "docs: describe how the clients count each provider from its own cycle"
```

---

### Task 5: final verification

- [ ] **Step 1:** `npm run check` — PASS.
- [ ] **Step 2:** `pwsh -NoProfile -Command "Invoke-Pester -Path clients/tests -Output Detailed"` — PASS.
- [ ] **Step 3:** `bash -n clients/shared/report-usage-core.sh` and, if available, `shellcheck clients/**/*.sh` — clean.
- [ ] **Step 4:** No push, no PR: the controller decides when this branch goes out.
