param([switch]$Publish, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'bootstrap.ps1')
$env:DOTNET_ROOT = Join-Path $projectRoot '.local\dotnet'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:TESTINGPLATFORM_TELEMETRY_OPTOUT = '1'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
Push-Location $projectRoot
try {
  if (!(Test-Path 'src\Cord.Windows\Assets\Cord.ico')) { & (Join-Path $PSScriptRoot 'create-icon.ps1') }
  if (!$SkipTests) {
    & $dotnet test --project tests/Cord.Core.Tests/Cord.Core.Tests.csproj
    if ($LASTEXITCODE -ne 0) { throw 'Core tests failed.' }
  }
  if ($Publish) {
    $output = Join-Path $projectRoot 'artifacts\Cord-win-x64'
    & $dotnet publish src/Cord.Windows/Cord.Windows.csproj -c Release -p:Platform=x64 --self-contained true -p:PublishTrimmed=false -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
    foreach ($resource in @('Cord.exe', 'Cord.pri', 'App.xbf', 'MainWindow.xbf', 'Assets\Cord.ico')) {
      $resourcePath = Join-Path $output $resource
      if (!(Test-Path -LiteralPath $resourcePath -PathType Leaf) -or (Get-Item -LiteralPath $resourcePath).Length -eq 0) {
        throw "Incomplete Windows publication: $resource is missing or empty."
      }
    }
    $archive = Join-Path $projectRoot 'artifacts\Cord-win-x64.zip'
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($output, $archive)
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Value "$hash  $([IO.Path]::GetFileName($archive))" -Encoding ascii
    Write-Output "Portable ZIP SHA-256: $hash"
  } else {
    & $dotnet build src/Cord.Windows/Cord.Windows.csproj -c Release -p:Platform=x64
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  }
} finally { Pop-Location }
