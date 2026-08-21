param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
function ConvertFrom-CodePoint([int[]]$CodePoints) {
  return -join ($CodePoints | ForEach-Object { [char]$_ })
}

$projectRoot = if ($PSScriptRoot) {
  [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
} else {
  [IO.Path]::GetFullPath((Get-Location).Path)
}
if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Invalid delivery version: $Version"
}
$desktop = [IO.Path]::GetFullPath([Environment]::GetFolderPath("Desktop"))
$productName = "AI" + (ConvertFrom-CodePoint @(0x5DE5, 0x5177))
$deliveryFolderName = $productName + (ConvertFrom-CodePoint @(0x53D1, 0x8D27, 0x5305))
$installerLabel = ConvertFrom-CodePoint @(0x5B89, 0x88C5, 0x5305)
$oldFolderName = "ai" + (ConvertFrom-CodePoint @(0x6F2B, 0x5267, 0x5DE5, 0x4F5C, 0x6D41)) + "exe" + (ConvertFrom-CodePoint @(0x9006, 0x5411))
$oldFolder = [IO.Path]::GetFullPath((Join-Path $desktop $oldFolderName))
$deliveryFolder = [IO.Path]::GetFullPath((Join-Path $desktop $deliveryFolderName))
$source = [IO.Path]::GetFullPath((Join-Path $projectRoot "dist\ai-tool-setup-$Version-x64.exe"))
$target = [IO.Path]::GetFullPath((Join-Path $deliveryFolder "$productName-$Version-$installerLabel.exe"))

foreach ($path in @($oldFolder, $deliveryFolder, $target)) {
  if (-not $path.StartsWith($desktop, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Delivery path is outside the Desktop directory: $path"
  }
}
if (-not $source.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Installer source is outside the project directory: $source"
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Installer does not exist: $source"
}
if ((Test-Path -LiteralPath $oldFolder) -and (Test-Path -LiteralPath $deliveryFolder)) {
  throw "Both the legacy and current delivery directories exist"
}
if (Test-Path -LiteralPath $oldFolder) {
  Rename-Item -LiteralPath $oldFolder -NewName $deliveryFolderName
}
if (-not (Test-Path -LiteralPath $deliveryFolder -PathType Container)) {
  [IO.Directory]::CreateDirectory($deliveryFolder) | Out-Null
}

Get-ChildItem -LiteralPath $deliveryFolder -File | Remove-Item -Force
Copy-Item -LiteralPath $source -Destination $target -Force

$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$targetHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
if ($sourceHash -ne $targetHash) {
  throw "Delivery package SHA-256 verification failed"
}
$deliveryFiles = @(Get-ChildItem -LiteralPath $deliveryFolder -File)
if ($deliveryFiles.Count -ne 1 -or $deliveryFiles[0].FullName -ne $target) {
  throw "Delivery folder must contain exactly the current installer"
}

[PSCustomObject]@{
  DeliveryPackage = $target
  Bytes = (Get-Item -LiteralPath $target).Length
  SHA256 = $targetHash
  FilesInDeliveryFolder = $deliveryFiles.Count
} | ConvertTo-Json
