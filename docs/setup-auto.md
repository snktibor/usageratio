# Automatic setup

## Vercel

### Upstash variables: don't touch these

| Variable | What to do |
| --- | --- |
| `KV_REST_API_URL` | Leave unchanged |
| `KV_REST_API_TOKEN` | Leave unchanged; don't copy it into a client |
| `KV_REST_API_READ_ONLY_TOKEN` | Leave unchanged |
| `KV_URL` | Leave unchanged |
| `REDIS_URL` | Leave unchanged |

```text
Vercel → Project → Storage → Create Database → Upstash Redis → Frankfurt (eu-central-1) → Connect → Production
```

### Your own variables: create these two

| Variable | Value |
| --- | --- |
| `USAGE_API_TOKEN` | Generated automatically by the block below |
| `DASHBOARD_PIN` | The 5 digits you choose |

Run this in: **macOS → Terminal**, in the project's root directory.

```bash
cd "/path/to/usageratio"
```

Copy the whole block below into the Terminal. Nothing needs editing. `DASHBOARD_PIN` is entered while
it runs.

```bash
npm install --global vercel
vercel login
vercel link

USAGE_API_TOKEN="$(openssl rand -hex 32)"
printf 'DASHBOARD_PIN (5 digits): ' >&2
IFS= read -r -s DASHBOARD_PIN
printf '\n' >&2

printf '%s' "$USAGE_API_TOKEN" | vercel env add USAGE_API_TOKEN production --sensitive
printf '%s' "$DASHBOARD_PIN" | vercel env add DASHBOARD_PIN production --sensitive

vercel env ls production
vercel --prod
printf 'USAGE_API_TOKEN=%s\n' "$USAGE_API_TOKEN"
```

Copy the `USAGE_API_TOKEN` value printed on the last line into the `API_TOKEN` / `apiToken` field when
setting up a client.

Server–client mapping:

```text
Vercel USAGE_API_TOKEN → macOS API_TOKEN
Vercel USAGE_API_TOKEN → Windows apiToken
```

```text
Vercel setup: once, on one machine
USAGE_API_TOKEN: the same on every client machine
MACHINE_ID / machineId: different on every physical machine, and unchanged afterward
GROUP_ID / groupId: can be the same across machines in the same group
```

## macOS: Bash + Cron

```bash
mkdir -p "$HOME/.usageratio/auto" "$HOME/.usageratio/shared" "$HOME/.config/usageratio"
cp clients/auto/report-usage.sh "$HOME/.usageratio/auto/"
cp clients/shared/report-usage-core.sh clients/shared/ccusage-providers.cjs "$HOME/.usageratio/shared/"
chmod 700 "$HOME/.usageratio/auto/report-usage.sh" "$HOME/.usageratio/shared/report-usage-core.sh" "$HOME/.usageratio/shared/ccusage-providers.cjs"

printf 'USAGE_API_TOKEN: ' >&2
IFS= read -r -s USAGE_API_TOKEN
printf '\n' >&2
cat > "$HOME/.config/usageratio/config" <<EOF
API_URL="https://usageratio.example.com/api/usage"
API_TOKEN="$USAGE_API_TOKEN"
MACHINE_ID="mac-studio"
GROUP_ID="Personal"
EOF
chmod 600 "$HOME/.config/usageratio/config"

/bin/bash "$HOME/.usageratio/auto/report-usage.sh"
tail -n 5 "$HOME/Library/Logs/usageratio.log"
```

```bash
(crontab -l 2>/dev/null | grep -v '/\.usageratio/auto/report-usage\.sh'; printf '0 * * * * /bin/bash "%s/.usageratio/auto/report-usage.sh" >/dev/null 2>&1\n' "$HOME") | crontab -
crontab -l
```

## Windows: PowerShell + Task Scheduler

PowerShell started as Administrator:

```powershell
$root = Join-Path $env:USERPROFILE '.usageratio'
New-Item -ItemType Directory -Force -Path "$root\auto", "$root\shared" | Out-Null
Copy-Item -LiteralPath '.\clients\auto\report-usage.ps1', '.\clients\auto\install-task.ps1' -Destination "$root\auto" -Force
Copy-Item -LiteralPath '.\clients\shared\report-usage-core.ps1', '.\clients\shared\ccusage-providers.cjs' -Destination "$root\shared" -Force
Get-ChildItem -LiteralPath "$root\auto", "$root\shared" -Filter '*.ps1' | Unblock-File

$token = Read-Host 'USAGE_API_TOKEN'
@"
{
  "apiUrl": "https://usageratio.example.com/api/usage",
  "apiToken": "$token",
  "machineId": "win-desktop",
  "groupId": "Work"
}
"@ | Set-Content -LiteralPath "$root\config.json" -Encoding UTF8

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$root\auto\report-usage.ps1"
Get-Content -LiteralPath "$root\usageratio.log" -Tail 5

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\auto\install-task.ps1"
Start-ScheduledTask -TaskName 'usageratio-report'
Get-ScheduledTask -TaskName 'usageratio-report'
```

Uninstall:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.usageratio\auto\install-task.ps1" -Uninstall
```
