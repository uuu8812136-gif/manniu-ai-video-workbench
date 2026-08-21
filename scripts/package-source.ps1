param(
  [string]$ProjectRoot = "",
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Split-Path $PSScriptRoot -Parent
}
$project = [IO.Path]::GetFullPath($ProjectRoot)
$output = [IO.Path]::GetFullPath($OutputPath)
$temporary = "$output.tmp"
$archiveRoot = "ai-tool"
$package = [IO.File]::ReadAllText((Join-Path $project "package.json")) | ConvertFrom-Json
$packageVersion = [string]$package.version
if ($packageVersion -notmatch "^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$") {
  throw "package.json must contain a valid semantic version"
}
$fixedTimestamp = [DateTimeOffset]::new(2020, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$allowedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@("audit", "src", "scripts", "tests", "vendor") |
  ForEach-Object { [void]$allowedDirectories.Add($_) }
$allowedRootFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@(
  ".gitignore",
  "electron-builder.yml",
  "electron.vite.config.ts",
  "ORIGINAL-PARITY-AUDIT-$packageVersion.md",
  "package.json",
  "PACKAGING.md",
  "pnpm-lock.yaml",
  "README.md",
  "REQUIREMENTS.md",
  "tsconfig.node.json",
  "tsconfig.web.json",
  "vitest.config.ts"
) | ForEach-Object { [void]$allowedRootFiles.Add($_) }
$excludedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@("node_modules", "out", "dist", "release", "coverage", ".git", ".cache", ".vite", "__pycache__", "tmp", "temp") |
  ForEach-Object { [void]$excludedDirectories.Add($_) }
$requiredSourceFiles = @(
  "vendor/inference-skill/CLAUDE.md",
  "vendor/inference-skill/verify_split_extreme.py"
)

function Test-Excluded([string]$RelativePath) {
  $parts = $RelativePath -split "[\\/]"
  if ($parts.Count -eq 1) {
    if ($allowedRootFiles.Contains($parts[0])) { return $false }
    return -not ($parts[0] -like "AI*-$packageVersion.md")
  }
  if (-not $allowedDirectories.Contains($parts[0])) { return $true }
  # Audit reports and top-level evidence JSON are source artifacts. Nested
  # directories are runtime captures and can contain machine-specific paths.
  if ($parts[0] -ieq "audit") {
    if ($parts[1] -ieq "evidence" -and $parts.Count -gt 3) { return $true }
    if ($parts[1] -ine "evidence" -and $parts.Count -gt 2) { return $true }
  }
  foreach ($part in $parts) {
    if ($excludedDirectories.Contains($part)) { return $true }
  }
  $name = [IO.Path]::GetFileName($RelativePath)
  $extension = [IO.Path]::GetExtension($name).ToLowerInvariant()
  if ($RelativePath -eq "tests/original-runtime-differential.test.ts") { return $true }
  if ($name -match "^\.env($|\.)" -and $name -notmatch "\.example$") { return $true }
  if ($name -ieq ".npmrc") { return $true }
  if ($name -match "^(Thumbs\.db|\.DS_Store)$") { return $true }
  if ($name -match "^(~|\.~|\.tmp-)" -or $name -match "\.(tmp|temp|log|bak|swp|swo)$") { return $true }
  if ($extension -in @(".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".pem", ".pfx", ".p12", ".key", ".pyc")) { return $true }
  if ($name -match "^(credentials?|secrets?|tokens?|api[-_]?keys?)(\..+)?$") { return $true }
  return $false
}

function Assert-NoEmbeddedSecret([object[]]$SourceFiles) {
  $textExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  @(".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml") |
    ForEach-Object { [void]$textExtensions.Add($_) }
  $safeMarker = "(?i)(example|fake|placeholder|redacted|secret|should-never|test|xxx)"
  foreach ($file in $SourceFiles) {
    $extension = [IO.Path]::GetExtension($file.FullName)
    if (-not $textExtensions.Contains($extension) -or $file.Length -gt 10MB) { continue }
    $content = [IO.File]::ReadAllText($file.FullName)
    if ($content -match "(?im)^\s*(?:_authToken|//[^:]+/:_authToken)\s*=") {
      throw "Source archive secret preflight failed: npm auth in $($file.Relative)"
    }
    if ($content -match "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----") {
      throw "Source archive secret preflight failed: private key in $($file.Relative)"
    }
    if ($content -match "(?i)Bearer\s+[A-Za-z0-9._-]{24,}" -and $Matches[0] -notmatch $safeMarker) {
      throw "Source archive secret preflight failed: bearer token in $($file.Relative)"
    }
    foreach ($match in [regex]::Matches($content, "(?i)\bsk-[A-Za-z0-9_-]{20,}\b")) {
      if ($match.Value -notmatch $safeMarker) {
        throw "Source archive secret preflight failed: API key in $($file.Relative)"
      }
    }
  }
}

$files = Get-ChildItem -LiteralPath $project -Recurse -Force -File |
  ForEach-Object {
    $relative = $_.FullName.Substring($project.TrimEnd("\", "/").Length).TrimStart("\", "/").Replace("\", "/")
    if (-not (Test-Excluded $relative)) {
      [PSCustomObject]@{
        FullName = $_.FullName
        Relative = $relative
        Length = $_.Length
        Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      }
    }
  } |
  Sort-Object Relative

if ($files.Count -eq 0) { throw "No source files found under $project" }
if (-not ($files.Relative -contains "README.md")) { throw "README.md is required in the source archive" }
if (-not ($files.Relative -contains "pnpm-lock.yaml")) { throw "pnpm-lock.yaml is required in the source archive" }
foreach ($requiredSourceFile in $requiredSourceFiles) {
  if (-not ($files.Relative -contains $requiredSourceFile)) {
    throw "$requiredSourceFile is required in the source archive"
  }
}
Assert-NoEmbeddedSecret $files

$manifestLines = @(
  "# ai-tool deterministic source manifest"
  "# sha256  bytes  path"
) + ($files | ForEach-Object { "$($_.Sha256)  $($_.Length)  $($_.Relative)" })
$manifestText = ($manifestLines -join "`n") + "`n"
$utf8 = [Text.UTF8Encoding]::new($false)

$outputDirectory = Split-Path $output -Parent
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $output -Force -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$archive = $null
try {
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  foreach ($file in $files) {
    $entry = $archive.CreateEntry("$archiveRoot/$($file.Relative)", [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTimestamp
    $input = [IO.File]::OpenRead($file.FullName)
    $entryStream = $entry.Open()
    try { $input.CopyTo($entryStream) }
    finally {
      $entryStream.Dispose()
      $input.Dispose()
    }
  }
  $manifestEntry = $archive.CreateEntry("$archiveRoot/SOURCE-MANIFEST.sha256", [IO.Compression.CompressionLevel]::Optimal)
  $manifestEntry.LastWriteTime = $fixedTimestamp
  $manifestStream = $manifestEntry.Open()
  try {
    $manifestBytes = $utf8.GetBytes($manifestText)
    $manifestStream.Write($manifestBytes, 0, $manifestBytes.Length)
  } finally {
    $manifestStream.Dispose()
  }
} finally {
  if ($archive) { $archive.Dispose() }
  $stream.Dispose()
}

Move-Item -LiteralPath $temporary -Destination $output
if ($ManifestPath) {
  $manifestOutput = [IO.Path]::GetFullPath($ManifestPath)
  [IO.Directory]::CreateDirectory((Split-Path $manifestOutput -Parent)) | Out-Null
  [IO.File]::WriteAllText($manifestOutput, $manifestText, $utf8)
}

$archiveHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[PSCustomObject]@{
  archive = $output
  sha256 = $archiveHash
  files = $files.Count + 1
  bytes = (Get-Item -LiteralPath $output).Length
} | ConvertTo-Json
