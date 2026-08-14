[CmdletBinding()]
param(
  [string]$RepoDir = "C:\JunVideo",
  [int]$Port = 8080,
  [switch]$SkipFirewall
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found. Install it and rerun this script."
  }
}

function Set-EnvLineIfMissing {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $text = [System.IO.File]::ReadAllText($Path)
  if ($text -notmatch "(?m)^$([regex]::Escape($Name))=") {
    $suffix = if ($text.EndsWith("`n")) { "" } else { "`r`n" }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, "$text$suffix$Name=$Value`r`n", $encoding)
  }
}

function Has-PlaceholderValue {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Name
  )

  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name))=(.*)$")
  return (-not $match.Success) -or [string]::IsNullOrWhiteSpace($match.Groups[1].Value) -or $match.Groups[1].Value.Contains("<")
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run PowerShell as Administrator and rerun this script."
}

Require-Command git
Require-Command node
Require-Command npm

if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
  if (Test-Path $RepoDir) {
    $existingItems = @(Get-ChildItem -Force -LiteralPath $RepoDir)
    if ($existingItems.Count -gt 0) {
      throw "$RepoDir exists and is not a Git checkout. Choose another -RepoDir or empty this directory first."
    }
  } else {
    New-Item -ItemType Directory -Path $RepoDir -Force | Out-Null
  }
  git clone https://github.com/ProgramYin/JunVideo.git $RepoDir
}

Set-Location -LiteralPath $RepoDir

if (-not (Test-Path ".env.domestic-api")) {
  Copy-Item ".env.domestic-api.example" ".env.domestic-api"
  Write-Host "Created $RepoDir\.env.domestic-api. Fill DATABASE_URL and JWT_SECRET, then rerun this script."
  exit 0
}

$envFile = Join-Path $RepoDir ".env.domestic-api"
$envText = [System.IO.File]::ReadAllText($envFile)
if (Has-PlaceholderValue -Text $envText -Name "DATABASE_URL" -or Has-PlaceholderValue -Text $envText -Name "JWT_SECRET") {
  throw "Fill DATABASE_URL and JWT_SECRET in $envFile before starting the production API."
}

if (-not (Test-Path "bin\yt-dlp.exe")) {
  npm run setup:ytdlp
}
if (-not (Test-Path "bin\yt-dlp.exe")) {
  throw "yt-dlp was not created at $RepoDir\bin\yt-dlp.exe."
}

$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
$ffprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
if (-not $ffmpeg -or -not $ffprobe) {
  throw "Install FFmpeg first and ensure both ffmpeg.exe and ffprobe.exe are on PATH."
}

Set-EnvLineIfMissing -Path $envFile -Name "NODE_ENV" -Value "production"
Set-EnvLineIfMissing -Path $envFile -Name "PORT" -Value ([string]$Port)
Set-EnvLineIfMissing -Path $envFile -Name "SERVE_CLIENT" -Value "false"
Set-EnvLineIfMissing -Path $envFile -Name "PARSER_MODE" -Value "yt-dlp"
Set-EnvLineIfMissing -Path $envFile -Name "YTDLP_PATH" -Value "bin/yt-dlp.exe"
Set-EnvLineIfMissing -Path $envFile -Name "FFMPEG_PATH" -Value $ffmpeg.Source
Set-EnvLineIfMissing -Path $envFile -Name "FFPROBE_PATH" -Value $ffprobe.Source

npm ci
npm run build:api

if (-not $SkipFirewall) {
  $ruleName = "JunVideo API TCP $Port"
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
  }
}

$nodePath = (Get-Command node.exe).Source
$entrypoint = Join-Path $RepoDir "dist\server\src\index.js"
$taskName = "JunVideo API"
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"{0}"' -f $entrypoint) -WorkingDirectory $RepoDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5

$health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 20
if ($health.StatusCode -ne 200) {
  throw "JunVideo API health check returned HTTP $($health.StatusCode)."
}

Write-Host "JunVideo API is running on http://127.0.0.1:$Port/api/health"
Write-Host "Task Scheduler entry: $taskName"
Write-Host "For the Cloudflare Pages same-origin proxy, set API_ORIGIN to http://<server-ip-with-dashes>.sslip.io:$Port"
