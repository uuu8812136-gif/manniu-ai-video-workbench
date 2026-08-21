$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$dist = Join-Path $projectRoot "dist"
[IO.Directory]::CreateDirectory($dist) | Out-Null

& (Join-Path $PSScriptRoot "package-source.ps1") `
  -ProjectRoot $projectRoot `
  -OutputPath (Join-Path $dist "ai-tool-source-$version.zip") `
  -ManifestPath (Join-Path $dist "SOURCE-MANIFEST-$version.sha256")
