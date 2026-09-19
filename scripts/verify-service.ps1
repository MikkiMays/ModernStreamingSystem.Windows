param([string]$Publication, [string]$Service)
$ErrorActionPreference = 'Stop'
if (!$Service) { $Service = if ($env:CORD_VERIFY_SERVICE) { $env:CORD_VERIFY_SERVICE } else { 'https://meet.nikg.tech/' } }
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$Publication) { $Publication = Join-Path $projectRoot 'artifacts\Cord-win-x64' }
$Publication = [IO.Path]::GetFullPath($Publication)
$exe = Join-Path $Publication 'Cord.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Published Cord.exe is missing.' }
$previousProfile = $env:CORD_PROFILE_DIRECTORY
try {
  $profileDirectory = Join-Path $projectRoot ".local\service-probe\$([guid]::NewGuid().ToString('N'))"
  $env:CORD_PROFILE_DIRECTORY = $profileDirectory
  New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  # Cord has no default server: a fresh installation knows nothing and asks. So the profile is
  # written here — this is a machine on which the server has already been chosen, not a build
  # that knows one. Everything after this point is the real product path: saved server, saved
  # automatic connection, real handshake.
  $settings = @{
    serverUrl         = $Service
    theme             = 'system'
    compactSidebar    = $false
    showPing          = $false
    notificationSounds = $true
    servers           = @(@{ url = $Service; name = ''; autoConnect = $true })
  }
  [IO.File]::WriteAllText((Join-Path $profileDirectory 'settings.json'), ($settings | ConvertTo-Json -Depth 4))
  # The real WinUI/WebView2 opens its home page; no devices or meeting are started.
  $probe = Start-Process -FilePath $exe -ArgumentList '--verify-service', $Service -WorkingDirectory $Publication -PassThru
  if (!$probe.WaitForExit(65000)) { $probe.Kill(); throw 'Native production connection probe timed out.' }
  if ($probe.ExitCode -ne 0) { throw "Native production connection probe failed: $($probe.ExitCode)" }
  Write-Output "PASS: saved server $Service, public HTTPS, WebView2 desktop rendering, typed bridge and native favorites API."
} finally { $env:CORD_PROFILE_DIRECTORY = $previousProfile }
