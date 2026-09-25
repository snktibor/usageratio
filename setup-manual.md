# Manual setup

```text
USAGE_API_TOKEN: the same on every client machine
MACHINE_ID / machineId: different on every physical machine, and unchanged afterward
GROUP_ID / groupId: can be the same across machines in the same group
```

## macOS: Bash + terminal alias

```bash
mkdir -p "$HOME/.usageratio/manual" "$HOME/.usageratio/shared" "$HOME/.config/usageratio"
cp clients/manual/report-usage.sh "$HOME/.usageratio/manual/"
cp clients/shared/report-usage-core.sh clients/shared/ccusage-providers.cjs "$HOME/.usageratio/shared/"
chmod 700 "$HOME/.usageratio/manual/report-usage.sh" "$HOME/.usageratio/shared/report-usage-core.sh" "$HOME/.usageratio/shared/ccusage-providers.cjs"

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

printf '\nalias sync-tokens='\''/bin/bash "$HOME/.usageratio/manual/report-usage.sh"'\''\n' >> "$HOME/.zshrc"
source "$HOME/.zshrc"
sync-tokens
```

## Windows: PowerShell + desktop shortcut

PowerShell:

```powershell
$root = Join-Path $env:USERPROFILE '.usageratio'
New-Item -ItemType Directory -Force -Path "$root\manual", "$root\shared" | Out-Null
Copy-Item -LiteralPath '.\clients\manual\report-usage.ps1' -Destination "$root\manual" -Force
Copy-Item -LiteralPath '.\clients\shared\report-usage-core.ps1', '.\clients\shared\ccusage-providers.cjs' -Destination "$root\shared" -Force
Get-ChildItem -LiteralPath "$root\manual", "$root\shared" -Filter '*.ps1' | Unblock-File

$token = Read-Host 'USAGE_API_TOKEN'
@"
{
  "apiUrl": "https://usageratio.example.com/api/usage",
  "apiToken": "$token",
  "machineId": "win-desktop",
  "groupId": "Work"
}
"@ | Set-Content -LiteralPath "$root\config.json" -Encoding UTF8

@'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.usageratio\manual\report-usage.ps1"
echo.
Pause
'@ | Set-Content -LiteralPath "$root\manual\sync-tokens.cmd" -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sync tokens.lnk'))
$shortcut.TargetPath = "$root\manual\sync-tokens.cmd"
$shortcut.WorkingDirectory = "$root\manual"
$shortcut.Save()

& "$root\manual\report-usage.ps1"
```
