param(
  [string]$InstallerPath = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  $InstallerPath = Join-Path $projectRoot "dist\ai-tool-setup-$version-x64.exe"
}
$installer = [IO.Path]::GetFullPath($InstallerPath)
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ".tmp-installed-smoke"))
$projectPrefix = $projectRoot.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
if (-not $smokeRoot.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Smoke directory must remain inside the project root: $smokeRoot"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Installer not found: $installer"
}

$installDirectory = Join-Path $smokeRoot "app"
$portableRoot = Join-Path $smokeRoot "portable-runtime"
$database = Join-Path $portableRoot "ai-tool-data\ai-tool.db"
$application = Join-Path $installDirectory "ai-tool.exe"
$process = $null
$previousPortableRoot = $env:PORTABLE_EXECUTABLE_DIR

try {
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
  [IO.Directory]::CreateDirectory($portableRoot) | Out-Null

  $installerProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDirectory") -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) { throw "Installer exited with code $($installerProcess.ExitCode)" }
  if (-not (Test-Path -LiteralPath $application -PathType Leaf)) { throw "Installed executable missing: $application" }

  $env:PORTABLE_EXECUTABLE_DIR = $portableRoot
  $process = Start-Process -FilePath $application -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while (-not (Test-Path -LiteralPath $database -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
  }
  if ($process.HasExited) { throw "Installed app exited during startup with code $($process.ExitCode)" }
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw "Installed app did not create SQLite: $database" }

  & taskkill.exe /PID $process.Id /T /F *> $null
  $process = $null
  Start-Sleep -Milliseconds 700
  $header = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($database), 0, 16)
  if ($header -ne "SQLite format 3`0") { throw "Installed database is not SQLite: $database" }

  $betterSqlite = Join-Path $projectRoot "node_modules\better-sqlite3"
  $legacyStateVerifier = Join-Path $projectRoot "scripts\smoke-installed-state.cjs"
  & node.exe $legacyStateVerifier seed $database $betterSqlite
  if ($LASTEXITCODE -ne 0) { throw "Failed to seed legacy Vidu account states" }

  $process = Start-Process -FilePath $application -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
  $legacyRows = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    $stateJson = & node.exe $legacyStateVerifier read $database $betterSqlite 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($stateJson)) { continue }
    $parsedRows = $stateJson | ConvertFrom-Json
    $candidateRows = @($parsedRows | ForEach-Object { Write-Output $_ })
    $credits = $candidateRows | Where-Object { $_.id -eq "00000000-0000-4000-8000-000000000021" }
    $expired = $candidateRows | Where-Object { $_.id -eq "00000000-0000-4000-8000-000000000022" }
    if ($credits.enabled -eq 1 -and $null -eq $credits.disabled_reason -and $expired.enabled -eq 0 -and $expired.disabled_reason -eq "login_expired") {
      $legacyRows = $candidateRows
      break
    }
  }
  if ($process.HasExited) { throw "Installed app exited during legacy-state recovery with code $($process.ExitCode)" }
  if ($null -eq $legacyRows) { throw "Installed app did not recover credits_exhausted while preserving login_expired" }

  & taskkill.exe /PID $process.Id /T /F *> $null
  $process = $null
  Start-Sleep -Milliseconds 700

  $uninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "Uninstaller not found in $installDirectory" }
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
  if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstallProcess.ExitCode)" }
  Start-Sleep -Milliseconds 700
  if (Test-Path -LiteralPath $application -PathType Leaf) { throw "Installed executable remained after uninstall: $application" }

  [PSCustomObject]@{
    status = "ok"
    installer = $installer
    installedExecutable = "ai-tool.exe"
    isolatedRuntimeData = "ai-tool-data"
    sqliteCreated = $true
    legacyCreditsRecovered = $true
    loginExpiredPreserved = $true
    uninstallCompleted = $true
  } | ConvertTo-Json
} finally {
  if ($process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F *> $null
  }
  $env:PORTABLE_EXECUTABLE_DIR = $previousPortableRoot
  Start-Sleep -Milliseconds 300
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
