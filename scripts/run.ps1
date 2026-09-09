param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $projectRoot 'artifacts\Cord-win-x64\Cord.exe'
if (!(Test-Path -LiteralPath $exe)) { & (Join-Path $PSScriptRoot 'build.ps1') -Publish }
# The user explicitly launches the visible desktop application.
Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
