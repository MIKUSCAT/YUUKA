Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Stderr([string] $message) {
  [Console]::Error.WriteLine($message)
}

function Find-ServerExe() {
  $binDir = Join-Path $PSScriptRoot 'bin'
  $candidates = @(
    (Join-Path $binDir 'Sbroenne.WindowsMcp.exe'),
    (Join-Path $binDir 'win-x64\Sbroenne.WindowsMcp.exe'),
    (Join-Path $binDir 'win-arm64\Sbroenne.WindowsMcp.exe')
  )

  foreach ($p in $candidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }

  # Fallback: user may have extracted the release zip into a nested folder.
  if (Test-Path -LiteralPath $binDir) {
    try {
      $found = Get-ChildItem -LiteralPath $binDir -Recurse -Filter 'Sbroenne.WindowsMcp.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($found) { return $found.FullName }

      $foundAny = Get-ChildItem -LiteralPath $binDir -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*WindowsMcp*' } |
        Select-Object -First 1
      if ($foundAny) { return $foundAny.FullName }
    } catch {
      # ignore and fall through to null
    }
  }

  return $null
}

# 1) Prefer prebuilt standalone exe (no stdout noise, fastest startup)
$exe = Find-ServerExe
if ($exe) {
  & $exe
  exit $LASTEXITCODE
}

# 2) Bootstrap build from source (logs redirected to file to avoid breaking MCP stdio)
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
  Write-Stderr "windows_mcp: dotnet not found. Install the .NET SDK, or place Sbroenne.WindowsMcp.exe at `"$PSScriptRoot\bin\`"."
  exit 1
}

# If dotnet exists but no SDK is installed (runtime only), restore/publish will not work.
$sdks = & dotnet --list-sdks 2>$null
if (-not $sdks) {
  Write-Stderr "windows_mcp: Sbroenne.WindowsMcp.exe not found, and only the .NET runtime is installed (no SDK), so auto-build is unavailable. Place Sbroenne.WindowsMcp.exe at `"$PSScriptRoot\bin\win-x64\`"."
  exit 1
}

# Source root detection (string path) - avoid StrictMode uninitialized-variable edge cases.
$sourceRoot = $null
$sourceRootCandidates = @(
  (Join-Path $PSScriptRoot 'mcp-windows'),
  (Join-Path $PSScriptRoot '..\..\..\mcp-windows')
)

foreach ($candidate in $sourceRootCandidates) {
  $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction SilentlyContinue
  if ($resolved) {
    $sourceRoot = $resolved.Path
    break
  }
}

if (-not $sourceRoot) {
  Write-Stderr ("windows_mcp: Source folder mcp-windows not found. Tried: " + ($sourceRootCandidates -join ', ') + ". Or place the exe at `"$PSScriptRoot\bin\`".")
  exit 1
}

$projectPath = Join-Path $sourceRoot 'src\Sbroenne.WindowsMcp\Sbroenne.WindowsMcp.csproj'
if (-not (Test-Path $projectPath)) {
  Write-Stderr "windows_mcp: Project file not found: $projectPath"
  exit 1
}

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$rid = if ($arch -eq 'arm64') { 'win-arm64' } else { 'win-x64' }

$outDir = Join-Path $PSScriptRoot 'bin'
$outPath = Join-Path $outDir $rid
New-Item -ItemType Directory -Force -Path $outPath | Out-Null

$logPath = Join-Path $outDir 'build.log'

& dotnet restore $projectPath 1>> $logPath 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Stderr "windows_mcp: dotnet restore failed (exit=$LASTEXITCODE). Log: $logPath"
  exit $LASTEXITCODE
}

$publishArgs = @(
  'publish', $projectPath,
  '-c', 'Release',
  '-r', $rid,
  '-o', $outPath,
  '-p:SelfContained=true',
  '-p:PublishSingleFile=true',
  '-p:EnableCompressionInSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-p:PublishReadyToRun=false'
)

& dotnet @publishArgs 1>> $logPath 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Stderr "windows_mcp: dotnet publish failed (exit=$LASTEXITCODE). Log: $logPath"
  exit $LASTEXITCODE
}

$exePath = Join-Path $outPath 'Sbroenne.WindowsMcp.exe'
if (-not (Test-Path $exePath)) {
  Write-Stderr "windows_mcp: publish completed but exe not found: $exePath. Log: $logPath"
  exit 1
}

& $exePath
exit $LASTEXITCODE
