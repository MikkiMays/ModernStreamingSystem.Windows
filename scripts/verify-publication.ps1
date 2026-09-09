param([string]$Publication)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$Publication) { $Publication = Join-Path $projectRoot 'artifacts\Cord-win-x64' }
$Publication = [IO.Path]::GetFullPath($Publication)
$exe = Join-Path $Publication 'Cord.exe'
foreach ($resource in @('Cord.exe', 'Cord.pri', 'App.xbf', 'MainWindow.xbf', 'Assets\Cord.ico')) {
  if (!(Test-Path -LiteralPath (Join-Path $Publication $resource) -PathType Leaf)) { throw "Missing $resource" }
}
$previousProfile = $env:CORD_PROFILE_DIRECTORY
try {
  $env:CORD_PROFILE_DIRECTORY = Join-Path $projectRoot '.local\resource-probe-profile'
  # The app constructs its real XAML tree without activating a window, loading the web,
  # requesting devices or reading the real profile. No desktop input is injected.
  $probe = Start-Process -FilePath $exe -ArgumentList '--verify-resources' -WorkingDirectory $Publication -WindowStyle Hidden -PassThru
  if (!$probe.WaitForExit(20000)) { $probe.Kill(); throw 'Resource probe timed out.' }
  if ($probe.ExitCode -ne 0) { throw "Resource probe failed: $($probe.ExitCode)" }
  Write-Output 'Cord resource probe passed: self-contained runtime and MainWindow XAML loaded.'
} finally { $env:CORD_PROFILE_DIRECTORY = $previousProfile }
