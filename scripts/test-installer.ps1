param([string]$Installer)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (!$Installer) {
  [xml]$project = Get-Content -LiteralPath (Join-Path $projectRoot 'src\Cord.Windows\Cord.Windows.csproj')
  $Installer = Join-Path $projectRoot "artifacts\Cord-Setup-$($project.Project.PropertyGroup.Version)-x64.exe"
}
$Installer = [IO.Path]::GetFullPath($Installer)
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{E43CC1FC-827B-4F55-A8E8-C746D4BAE102}_is1'
if (Test-Path -LiteralPath $uninstallKey) { throw 'Cord is already installed for this user. Run the installer test in a clean Windows test account.' }
$runtimeKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$machine32 = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry32)
try {
  $machineRuntime = $machine32.OpenSubKey($runtimeKey)
  $userRuntime = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runtimeKey)
  try {
    $versions = @()
    if ($null -ne $machineRuntime) { $versions += $machineRuntime.GetValue('pv') }
    if ($null -ne $userRuntime) { $versions += $userRuntime.GetValue('pv') }
    if (!($versions | Where-Object { $_ -and $_ -ne '0.0.0.0' })) {
      throw 'This test requires an existing WebView2 Runtime; test first-time runtime installation in a clean VM.'
    }
  } finally {
    if ($null -ne $machineRuntime) { $machineRuntime.Dispose() }
    if ($null -ne $userRuntime) { $userRuntime.Dispose() }
  }
} finally { $machine32.Dispose() }
$testRoot = Join-Path $projectRoot ".local\installer-smoke\$([guid]::NewGuid().ToString('N'))"
$installRoot = [IO.Path]::GetFullPath((Join-Path $testRoot 'Cord тест'))
$relative = [IO.Path]::GetRelativePath($projectRoot, $installRoot)
if ($relative.StartsWith('..') -or [IO.Path]::IsPathRooted($relative)) { throw 'Test installation must stay within this project.' }
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
function Invoke-SetupProcess([string]$File, [string[]]$Arguments) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WindowStyle Hidden -PassThru
  if (!$process.WaitForExit(60000)) { throw 'Installer operation timed out; inspect the test log before cleanup.' }
  if ($process.ExitCode -ne 0) { throw "Installer operation failed: $($process.ExitCode)" }
}
$arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=""', "/DIR=`"$installRoot`"")
$installed = $false
try {
  Invoke-SetupProcess $Installer ($arguments + "/LOG=`"$(Join-Path $testRoot 'install.log')`"")
  $installed = $true
  & (Join-Path $PSScriptRoot 'verify-publication.ps1') -Publication $installRoot
  if (!(Test-Path -LiteralPath $uninstallKey)) { throw 'The uninstall registration was not created.' }
  $sentinel = Join-Path $installRoot 'user-preserved.txt'
  Set-Content -LiteralPath $sentinel -Value 'User file retained across upgrade and uninstall.'
  Invoke-SetupProcess $Installer ($arguments + "/LOG=`"$(Join-Path $testRoot 'upgrade.log')`"")
  & (Join-Path $PSScriptRoot 'verify-publication.ps1') -Publication $installRoot
  if (!(Test-Path -LiteralPath $sentinel)) { throw 'Upgrade removed a user file.' }
  # Exercise the same helper embedded in Cord, with an installation path containing spaces and Cyrillic.
  $helperScript = Join-Path $projectRoot 'src\Cord.Windows\Services\Update.ps1'
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($helperScript, [ref]$null, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
  $previousProfile = $env:CORD_PROFILE_DIRECTORY
  $env:CORD_PROFILE_DIRECTORY = Join-Path $testRoot 'profile'
  New-Item -ItemType Directory -Force $env:CORD_PROFILE_DIRECTORY | Out-Null
  $profileSentinel = Join-Path $env:CORD_PROFILE_DIRECTORY 'preserved.json'
  Set-Content -LiteralPath $profileSentinel -Value '{"favorites":["room"],"showPing":true}'
  try {
    foreach ($valid in @($false, $true, $true)) {
      $parent = Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 120"' -WindowStyle Hidden -PassThru
      $ready = Join-Path $testRoot "ready-$([guid]::NewGuid())"
      $result = Join-Path $testRoot 'result.json'
      if (Test-Path $result) { Remove-Item -LiteralPath $result }
      $planFile = Join-Path $testRoot 'update-plan.json'
      @{ ProcessId = $parent.Id; Package = $Installer; Sha256 = $(if ($valid) { (Get-FileHash $Installer -Algorithm SHA256).Hash } else { '0' * 64 }); InstallDirectory = $installRoot; UpdateDirectory = $testRoot; ReadyFile = $ready } | ConvertTo-Json | Set-Content -LiteralPath $planFile -Encoding UTF8
      $helper = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$helperScript`"", '-PlanFile', "`"$planFile`"") -WindowStyle Hidden -PassThru
      try {
        if ($valid) {
          $deadline = [DateTime]::UtcNow.AddSeconds(15)
          while (!(Test-Path -LiteralPath $ready) -and !$helper.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
          if (!(Test-Path -LiteralPath $ready)) { throw 'Update helper did not become ready.' }
          if (Test-Path $result) { throw 'Update ran while the parent app was alive.' }
          $parent.Kill(); $parent.WaitForExit()
        }
        if (!$helper.WaitForExit(90000)) { throw 'Update helper timed out.' }
        $outcome = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
        if ($outcome.ok -ne $valid) { throw "Unexpected update result: $($outcome.detail)" }
        if (!$valid -and $parent.HasExited) { throw 'Invalid package terminated the running app.' }
        if ((Get-Content -LiteralPath $profileSentinel -Raw).Trim() -ne '{"favorites":["room"],"showPing":true}') { throw 'Update changed the profile.' }
        if ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation.TrimEnd('\') -ne $installRoot) { throw 'Update changed the installation directory.' }
      } finally {
        if (!$parent.HasExited) { $parent.Kill() }
        if (!$helper.HasExited) { $helper.Kill() }
        # Close only Cord instances started from this test installation.
        Get-Process Cord -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $installRoot 'Cord.exe') } | Stop-Process -Force
      }
    }
  } finally { $env:CORD_PROFILE_DIRECTORY = $previousProfile }

} finally {
  if ($installed) {
    # This exact uninstaller belongs to the verified path beneath .local; no wildcard deletion.
    $uninstaller = Join-Path $installRoot 'unins000.exe'
    Invoke-SetupProcess $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $testRoot 'uninstall.log')`"")
  }
}
if (Test-Path -LiteralPath (Join-Path $installRoot 'Cord.exe')) { throw 'Uninstall left the application executable.' }
if (Test-Path -LiteralPath $uninstallKey) { throw 'Uninstall left its registration.' }
if (!(Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed an unowned user file.' }
Write-Output "Installer test passed: install, resource launch, repeated install, uninstall, user-file preservation. Logs: $testRoot"
