[CmdletBinding()]
param(
  [string]$RepoDir = "C:\JunVideo",
  [int]$Port = 8080,
  [switch]$SkipFirewall
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator and rerun this script."
  }
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machinePath;$userPath"
}

function Add-MachinePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $normalized = $Path.TrimEnd("\")
  $current = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $entries = @($current -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $normalized })) {
    $newPath = if ([string]::IsNullOrWhiteSpace($current)) { $normalized } else { "$current;$normalized" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "Machine")
  }
  Refresh-Path
}

function Get-WingetPath {
  $command = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

function Try-WingetInstall {
  param([Parameter(Mandatory = $true)][string]$PackageId)

  $winget = Get-WingetPath
  if (-not $winget) {
    return $false
  }

  Write-Host "Installing $PackageId with winget..."
  & $winget install --id $PackageId --exact --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -eq 0) {
    Refresh-Path
    return $true
  }
  Write-Warning "winget could not install $PackageId; using the official installer fallback."
  return $false
}

function Invoke-DownloadedInstaller {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList
  )

  Write-Host "Downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $FilePath
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode): $Uri"
  }
}

function Ensure-Git {
  Refresh-Path
  if (Get-Command git.exe -ErrorAction SilentlyContinue) {
    return
  }

  $installed = Try-WingetInstall -PackageId "Git.Git"
  Refresh-Path
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    $installer = Join-Path $script:TempDir "Git-64-bit.exe"
    Invoke-DownloadedInstaller `
      -Uri "https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe" `
      -FilePath $installer `
      -ArgumentList @("/VERYSILENT", "/NORESTART", "/SP-")
    Add-MachinePath -Path "C:\Program Files\Git\cmd"
    Add-MachinePath -Path "C:\Program Files\Git\bin"
  }

  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    throw "Git installation completed but git.exe is still unavailable. Open a new Administrator PowerShell and rerun this script."
  }
  Write-Host "Git is ready: $((git --version).Trim())"
}

function Ensure-Node {
  Refresh-Path
  if ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    return
  }

  $installed = Try-WingetInstall -PackageId "OpenJS.NodeJS.LTS"
  Refresh-Path
  if (-not ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue))) {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://nodejs.org/dist/index.json" |
      Where-Object { $_.lts -and ($_.files -contains "win-x64-msi") } |
      Select-Object -First 1
    if (-not $release) {
      throw "Could not find the current Node.js LTS Windows installer."
    }
    $version = [string]$release.version
    $installer = Join-Path $script:TempDir "node-$version-win-x64.msi"
    Invoke-DownloadedInstaller `
      -Uri "https://nodejs.org/dist/$version/node-$version-win-x64.msi" `
      -FilePath $installer `
      -ArgumentList @("/i", "`"$installer`"", "/qn", "/norestart")
    Add-MachinePath -Path "C:\Program Files\nodejs"
  }

  if (-not ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue))) {
    throw "Node.js installation completed but node/npm is still unavailable. Open a new Administrator PowerShell and rerun this script."
  }
  Write-Host "Node.js is ready: $((node --version).Trim())"
}

function Ensure-Ffmpeg {
  Refresh-Path
  if ((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -and (Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) {
    return
  }

  $installed = Try-WingetInstall -PackageId "Gyan.FFmpeg"
  Refresh-Path
  if (-not ((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -and (Get-Command ffprobe.exe -ErrorAction SilentlyContinue))) {
    $archive = Join-Path $script:TempDir "ffmpeg-release-essentials.zip"
    $extractDir = Join-Path $script:TempDir "ffmpeg-extracted"
    Invoke-WebRequest -UseBasicParsing `
      -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
      -OutFile $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $extractDir -Force
    $ffmpegSource = Get-ChildItem -LiteralPath $extractDir -Filter "ffmpeg.exe" -File -Recurse | Select-Object -First 1
    $ffprobeSource = Get-ChildItem -LiteralPath $extractDir -Filter "ffprobe.exe" -File -Recurse | Select-Object -First 1
    if (-not $ffmpegSource -or -not $ffprobeSource) {
      throw "The downloaded FFmpeg archive did not contain ffmpeg.exe and ffprobe.exe."
    }
    $ffmpegDir = "C:\Program Files\FFmpeg\bin"
    New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
    Copy-Item -LiteralPath $ffmpegSource.FullName -Destination (Join-Path $ffmpegDir "ffmpeg.exe") -Force
    Copy-Item -LiteralPath $ffprobeSource.FullName -Destination (Join-Path $ffmpegDir "ffprobe.exe") -Force
    Add-MachinePath -Path $ffmpegDir
  }

  if (-not ((Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -and (Get-Command ffprobe.exe -ErrorAction SilentlyContinue))) {
    throw "FFmpeg installation completed but ffmpeg.exe/ffprobe.exe is still unavailable. Open a new Administrator PowerShell and rerun this script."
  }
  Write-Host "FFmpeg is ready."
}

function Ensure-Repository {
  $gitDir = Join-Path $RepoDir ".git"
  if (Test-Path -LiteralPath $gitDir) {
    return
  }
  if (Test-Path -LiteralPath $RepoDir) {
    $existingItems = @(Get-ChildItem -Force -LiteralPath $RepoDir)
    if ($existingItems.Count -gt 0) {
      throw "$RepoDir exists and is not an empty Git checkout. Choose another -RepoDir or use an empty directory."
    }
  } else {
    New-Item -ItemType Directory -Path $RepoDir -Force | Out-Null
  }
  git clone https://github.com/ProgramYin/JunVideo.git $RepoDir
}

Assert-Administrator
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$script:TempDir = Join-Path ([IO.Path]::GetTempPath()) ("JunVideoBootstrap-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null

try {
  Ensure-Git
  Ensure-Node
  Ensure-Ffmpeg
  Ensure-Repository

  $installScript = Join-Path $RepoDir "deploy\windows\Install-JunVideoApi.ps1"
  if (-not (Test-Path -LiteralPath $installScript)) {
    throw "The repository checkout is missing $installScript."
  }
  Write-Host "Starting JunVideo API deployment..."
  & $installScript -RepoDir $RepoDir -Port $Port -SkipFirewall:$SkipFirewall
} finally {
  if (Test-Path -LiteralPath $script:TempDir) {
    Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
