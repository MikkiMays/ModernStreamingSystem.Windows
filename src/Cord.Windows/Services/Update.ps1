param([Parameter(Mandatory=$true)][string]$PlanFile)
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page.
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$journal = Join-Path $plan.UpdateDirectory 'update.log'
function Write-Journal([string]$Text) {
  try { Add-Content -LiteralPath $journal -Value ('{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $Text) -Encoding UTF8 } catch { }
}
function Get-PackageHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
# Every process started from the installation directory holds its files open. The Cord that asked
# for the update has already exited; another window of Cord, or one whose window closed but whose
# process never ended, would make the installer fail on files in use - and the next start would be
# the old version again, which is exactly what it looked like from outside.
function Get-Holders {
  $root = [IO.Path]::GetFullPath($plan.InstallDirectory).TrimEnd('\') + '\'
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -ne $PID -and $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
  })
}
function Close-Holders {
  $holders = Get-Holders
  if (-not $holders.Count) { return }
  foreach ($holder in $holders) {
    Write-Journal ('asking {0} ({1}) to close' -f $holder.Id, $holder.Path)
    try { [void]$holder.CloseMainWindow() } catch { }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and (Get-Holders).Count) { Start-Sleep -Milliseconds 250 }
  foreach ($holder in Get-Holders) {
    Write-Journal ('stopping {0}' -f $holder.Id)
    try { Stop-Process -Id $holder.Id -Force -ErrorAction Stop; $holder.WaitForExit(10000) | Out-Null } catch { }
  }
}
$ok = $false
$stage = 'verify'
$code = $null
$detail = ''
$installed = ''
Write-Journal ('update to {0} requested by process {1}' -f $plan.Version, $plan.ProcessId)
try {
  $hash = Get-PackageHash $plan.Package
  if ($hash -ne $plan.Sha256) { throw 'Installer SHA-256 mismatch.' }
  Set-Content -LiteralPath $plan.ReadyFile -Value 'ready' -Encoding ASCII
  $stage = 'wait'
  # The Cord that asked for the update has closed its window. If its process lingers after that,
  # it holds every file the installer must replace, so it is stopped rather than waited on forever.
  $cordProcess = Get-Process -Id $plan.ProcessId -ErrorAction SilentlyContinue
  if ($cordProcess -and -not $cordProcess.WaitForExit(30000)) {
    Write-Journal ('process {0} did not exit in 30 seconds; stopping it' -f $plan.ProcessId)
    Stop-Process -Id $plan.ProcessId -Force -ErrorAction SilentlyContinue
    if (-not $cordProcess.WaitForExit(15000)) { throw 'Cord did not exit within 45 seconds.' }
  }
  $hash = Get-PackageHash $plan.Package
  if ($hash -ne $plan.Sha256) { throw 'Installer SHA-256 mismatch.' }
  $stage = 'close'
  Close-Holders
  $stage = 'install'
  $installArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/CLOSEAPPLICATIONS', ('/DIR="' + $plan.InstallDirectory.TrimEnd('\') + '"'), ('/LOG="' + (Join-Path $plan.UpdateDirectory 'installer.log') + '"'))
  # A second attempt after clearing the directory again: antivirus scanners and a slow exit can
  # hold a freshly released file for a moment, and one retry is cheaper than a failed update.
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $setup = Start-Process -FilePath $plan.Package -ArgumentList $installArgs -PassThru -Wait
    $code = $setup.ExitCode
    Write-Journal ('installer attempt {0} exited with {1}' -f $attempt, $code)
    if ($code -eq 0) { break }
    Start-Sleep -Seconds 3
    Close-Holders
  }
  if ($code -ne 0) { throw "Installer exited with code $code." }
  # Exit code 0 is the installer's word; the file on disk is the fact.
  $stage = 'check'
  $file = [Version](Get-Item -LiteralPath (Join-Path $plan.InstallDirectory 'Cord.exe')).VersionInfo.FileVersion
  $installed = '{0}.{1}.{2}' -f $file.Major, $file.Minor, $file.Build
  if ($plan.Version -and $installed -ne $plan.Version) { throw "Installed version is $installed, expected $($plan.Version)." }
  $ok = $true
} catch {
  $detail = $_.Exception.Message
  Write-Journal ('failed at {0}: {1}' -f $stage, $detail)
}
$tail = ''
if (-not $ok) {
  $log = Join-Path $plan.UpdateDirectory 'installer.log'
  if (Test-Path -LiteralPath $log) { $tail = (Get-Content -LiteralPath $log -Tail 15 -ErrorAction SilentlyContinue) -join "`n" }
}
@{ ok = $ok; stage = $stage; code = $code; detail = $detail; version = $plan.Version; installed = $installed; tail = $tail; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $plan.UpdateDirectory 'result.json') -Encoding UTF8
if (-not (Get-Process -Id $plan.ProcessId -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath (Join-Path $plan.InstallDirectory 'Cord.exe') -WorkingDirectory $plan.InstallDirectory
}
