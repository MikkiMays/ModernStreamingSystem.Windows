param([string]$Publication)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$Publication) { $Publication = Join-Path $projectRoot 'artifacts\Cord-win-x64' }
$Publication = [IO.Path]::GetFullPath($Publication)
$exe = Join-Path $Publication 'Cord.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Published Cord.exe is missing.' }
$previousProfile = $env:CORD_PROFILE_DIRECTORY
try {
  $env:CORD_PROFILE_DIRECTORY = Join-Path $projectRoot ".local\service-probe\$([guid]::NewGuid().ToString('N'))"
  # A fresh profile exercises the compiled production default, not a test-supplied URL.
  # The real WinUI/WebView2 opens its home page; no devices or meeting are started.
  $probe = Start-Process -FilePath $exe -ArgumentList '--verify-service' -WorkingDirectory $Publication -PassThru
  if (!$probe.WaitForExit(65000)) { $probe.Kill(); throw 'Native production connection probe timed out.' }
  if ($probe.ExitCode -ne 0) { throw "Native production connection probe failed: $($probe.ExitCode)" }
  Write-Output 'PASS: fresh Windows profile, public HTTPS, WebView2 desktop rendering, typed bridge and native favorites API.'
} finally { $env:CORD_PROFILE_DIRECTORY = $previousProfile }
