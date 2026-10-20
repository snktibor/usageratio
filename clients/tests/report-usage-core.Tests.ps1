<#
.SYNOPSIS
  Pester 5 tests for clients/shared/report-usage-core.ps1.

.DESCRIPTION
  Runs on Windows PowerShell 5.1 and PowerShell 7+, on Windows, macOS and
  Linux. report-usage-core.ps1 is always invoked as a real child process via
  -File (never dot-sourced, `&`-called or run through -Command/
  -EncodedCommand): it ends with `exit N`, and -File is the one invocation
  mode where that reliably becomes the child process's own exit code, which
  is what the tests below assert on. Dot-sourcing or `&`-calling it would
  instead tear down (or silently not propagate the exit code of) the Pester
  host itself.

  A temp "home" directory stands in for $env:USERPROFILE (so config/log
  files never touch the real machine), and a temp "tools" directory is put
  in front of PATH with a fake ccusage/npx: USAGERATIO_CCUSAGE=global makes
  report-usage-core.ps1 call the fake ccusage directly, and the fake npx
  always fails so that fallback path can never be silently used instead.
  Windows gets the .cmd shims; PowerShell 7 on macOS/Linux cannot run those,
  so it gets the extension-less shell script shims instead (report-usage-
  core.ps1's own `Get-Command ccusage.cmd` / `Get-Command ccusage` fallback
  already picks whichever exists).
#>

BeforeAll {
    $script:OnWindows = $PSVersionTable.PSVersion.Major -le 5 -or $IsWindows
    # Nested: Windows PowerShell 5.1's Join-Path takes a single child path.
    $script:RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
    $script:CorePath = Join-Path $script:RepoRoot 'clients/shared/report-usage-core.ps1'
    $script:FixturesPath = Join-Path $PSScriptRoot 'fixtures'
    # The exact host (powershell.exe or pwsh) running this Pester suite, so the
    # child process we spawn per test exercises the same PowerShell edition.
    $script:HostExe = (Get-Process -Id $PID).Path

    if (-not (Test-Path -LiteralPath $script:CorePath)) {
        throw "report-usage-core.ps1 not found at $script:CorePath"
    }

    # --- A fake ccusage/npx on PATH ------------------------------------------
    $script:ToolsDir = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-ci-shim-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $script:ToolsDir -Force | Out-Null
    $shimSource = Join-Path $script:RepoRoot 'scripts/ci/shim'
    if ($script:OnWindows) {
        Copy-Item -LiteralPath (Join-Path $shimSource 'ccusage.cmd') -Destination $script:ToolsDir
        Copy-Item -LiteralPath (Join-Path $shimSource 'npx.cmd') -Destination $script:ToolsDir
        $script:CcusagePath = Join-Path $script:ToolsDir 'ccusage.cmd'
        $script:NpxPath = Join-Path $script:ToolsDir 'npx.cmd'
    } else {
        Copy-Item -LiteralPath (Join-Path $shimSource 'ccusage') -Destination $script:ToolsDir
        Copy-Item -LiteralPath (Join-Path $shimSource 'npx') -Destination $script:ToolsDir
        $script:CcusagePath = Join-Path $script:ToolsDir 'ccusage'
        $script:NpxPath = Join-Path $script:ToolsDir 'npx'
        # A comma-separated list here would be misparsed as a single literal
        # argument by the native-command tokenizer; pass them space-separated.
        & chmod +x $script:CcusagePath $script:NpxPath
    }

    # --- Environment: a temp home, log file and PATH -------------------------
    $script:OriginalPath = $env:PATH
    $script:OriginalUserProfile = $env:USERPROFILE
    $script:OriginalLogFile = $env:USAGERATIO_LOG_FILE
    $script:OriginalCcusageMode = $env:USAGERATIO_CCUSAGE
    $script:OriginalFixturesEnv = $env:USAGERATIO_CI_FIXTURES

    $script:HomeDir = Join-Path ([IO.Path]::GetTempPath()) ("usageratio-ci-home-" + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $script:HomeDir -Force | Out-Null
    $script:LogFile = Join-Path $script:HomeDir 'usageratio.log'

    # PATH in capitals: environment variable names are case-sensitive on macOS and Linux.
    $env:PATH = "$script:ToolsDir$([IO.Path]::PathSeparator)$env:PATH"
    $env:USERPROFILE = $script:HomeDir
    $env:USAGERATIO_LOG_FILE = $script:LogFile
    $env:USAGERATIO_CCUSAGE = 'global'
    $env:USAGERATIO_CI_FIXTURES = $script:FixturesPath

    # A config with just enough to pass validation for the -Providers/-Tokens
    # tests, which never read apiUrl/apiToken.
    $script:ConfigPath = Join-Path $script:HomeDir 'config.json'
    @{ machineId = 'test-machine'; groupId = 'Test Group' } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8

    # A config missing groupId, for the "bad config" case.
    $script:BadConfigPath = Join-Path $script:HomeDir 'config-missing-group.json'
    @{ machineId = 'test-machine' } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $script:BadConfigPath -Encoding UTF8

    # Runs report-usage-core.ps1 as a genuine child process, via -File, and
    # returns its exit code and combined stdout/stderr.
    #
    # This has to be a real child process: report-usage-core.ps1 ends with
    # `exit N`, and `exit` inside a script that is merely `&`-called (as
    # opposed to being the process's own top-level -File script) only sets
    # $LASTEXITCODE without terminating anything -- it would either kill this
    # Pester host (if dot-sourced/run in-process) or silently fail to surface
    # the real exit code (if run via -Command/-EncodedCommand). -File is the
    # one invocation mode where `exit N` reliably becomes the process's own
    # exit code, which is what $LASTEXITCODE below then captures.
    #
    # Windows PowerShell 5.1 needs two workarounds that pwsh does not:
    # - it passes a native argument's embedded double quotes through
    #   unescaped, so '{"claude":1}' would reach the child as {claude:1};
    #   they are escaped by hand there.
    # - it turns every redirected stderr line of a native command into an
    #   error record, which the `stop` preference GitHub Actions sets makes
    #   terminating; a powershell.exe child with redirected output can write
    #   progress to stderr as CLIXML. So the preference is relaxed here, and
    #   Output keeps stdout only.
    function Invoke-Core {
        param([string[]]$Arguments)
        $ErrorActionPreference = 'Continue'
        if ($PSVersionTable.PSVersion.Major -le 5) {
            $Arguments = @($Arguments | ForEach-Object { $_ -replace '"', '\"' })
        }
        $exeArgs = @('-NoProfile', '-NoLogo', '-NonInteractive', '-File', $script:CorePath) + $Arguments
        $output = & $script:HostExe @exeArgs 2>&1
        [PSCustomObject]@{
            ExitCode = $LASTEXITCODE
            Output   = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | Out-String)
        }
    }
}

AfterAll {
    $env:PATH = $script:OriginalPath
    $env:USERPROFILE = $script:OriginalUserProfile
    $env:USAGERATIO_LOG_FILE = $script:OriginalLogFile
    $env:USAGERATIO_CCUSAGE = $script:OriginalCcusageMode
    $env:USAGERATIO_CI_FIXTURES = $script:OriginalFixturesEnv
    Remove-Item -LiteralPath $script:ToolsDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:HomeDir -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'report-usage-core.ps1 -DryRun' {
    It 'sends the given -Providers JSON straight through and prints machineId/groupId/providers' {
        $result = Invoke-Core -Arguments @('-DryRun', '-Providers', '{"claude":1234}', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 0
        $payload = $result.Output | ConvertFrom-Json
        $payload.machineId | Should -Be 'test-machine'
        $payload.groupId | Should -Be 'Test Group'
        $payload.providers.claude | Should -Be 1234
    }

    It 'turns -Tokens provider=count into a one-provider payload' {
        $result = Invoke-Core -Arguments @('-DryRun', '-Tokens', 'claude=5', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 0
        $payload = $result.Output | ConvertFrom-Json
        $payload.machineId | Should -Be 'test-machine'
        $payload.groupId | Should -Be 'Test Group'
        $payload.providers.claude | Should -Be 5
    }

    It 'rejects a -Tokens value without provider=count with exit code 3' {
        $result = Invoke-Core -Arguments @('-DryRun', '-Tokens', '5', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 3
    }

    It 'rejects malformed -Providers JSON with exit code 3' {
        $result = Invoke-Core -Arguments @('-DryRun', '-Providers', 'not-json', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 3
    }

    It 'rejects a config missing groupId/machineId with exit code 2' {
        $result = Invoke-Core -Arguments @('-DryRun', '-Providers', '{"claude":1}', '-ConfigPath', $script:BadConfigPath)

        $result.ExitCode | Should -Be 2
    }
}

Describe 'the fake ccusage/npx used above' {
    It 'the ccusage shim prints the daily and blocks fixtures as valid JSON' {
        $daily = & $script:CcusagePath 'daily' 2>&1 | Out-String
        $blocks = & $script:CcusagePath 'blocks' 2>&1 | Out-String

        { $daily | ConvertFrom-Json } | Should -Not -Throw
        { $blocks | ConvertFrom-Json } | Should -Not -Throw
        (($daily | ConvertFrom-Json).daily).Count | Should -BeGreaterThan 0
    }

    It 'the npx shim always fails, so the ccusage fallback path is never silently skipped' {
        # The shim's stderr line would be a terminating error on Windows PowerShell 5.1 (see Invoke-Core).
        $ErrorActionPreference = 'Continue'
        & $script:NpxPath '--yes' 'ccusage@latest' 'daily' 2>&1 | Out-Null

        $LASTEXITCODE | Should -Be 1
    }
}

Describe 'report-usage-core.ps1 with each provider''s own cycle start' {
    BeforeAll {
        # An HTTP stub of GET /api/usage, in a background job so the child process can reach it.
        $script:Port = Get-Random -Minimum 20000 -Maximum 40000
        $script:CycleJson = @{
            tokenMode = 'snapshot'
            providers = @('claude', 'openai')
            # The settings' cost estimate: the client prices its usage without a cost opt-in of its own.
            cost      = $true
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
        $port = $script:Port
        $body = $script:CycleJson
        $script:Server = Start-Job -ScriptBlock {
            $listener = [Net.HttpListener]::new()
            $listener.Prefixes.Add("http://localhost:$($using:port)/")
            $listener.Start()
            # Serves until AfterAll stops the job: on Windows, stopping http.sys right after a
            # response resets the connection before the client has read it.
            try {
                while ($true) {
                    $pending = $listener.GetContextAsync()
                    # Short waits, so Stop-Job can end the loop.
                    while (-not $pending.Wait(200)) { }
                    $context = $pending.Result
                    $bytes = [Text.Encoding]::UTF8.GetBytes($using:body)
                    $context.Response.ContentType = 'application/json'
                    $context.Response.ContentLength64 = $bytes.Length
                    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                    $context.Response.Close()
                }
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

    It 'prices its usage when the server''s cycle asks for it, without a cost opt-in of its own' {
        $env:USAGERATIO_API_URL = "http://localhost:$script:Port/api/usage"
        $env:USAGERATIO_API_TOKEN = 'test-token'
        $result = Invoke-Core -Arguments @('-DryRun', '-ConfigPath', $script:ConfigPath)

        $result.ExitCode | Should -Be 0
        $payload = $result.Output | ConvertFrom-Json
        $payload.costs.openai | Should -Be 0.5
        $payload.modelCosts.openai.'gpt-5-codex' | Should -Be 0.5
    }
}
