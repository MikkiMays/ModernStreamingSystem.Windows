param([Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$ok = $false
$detail = ''
try {
  $hash = (Get-FileHash -LiteralPath $plan.Package -Algorithm SHA256).Hash
  if ($hash -ne $plan.Sha256) { throw 'Installer SHA-256 mismatch.' }
  Set-Content -LiteralPath $plan.ReadyFile -Value 'ready' -Encoding ASCII
  $cordProcess = Get-Process -Id $plan.ProcessId -ErrorAction SilentlyContinue
  if ($cordProcess -and -not $cordProcess.WaitForExit(60000)) { throw 'Cord did not exit within 60 seconds.' }
  $hash = (Get-FileHash -LiteralPath $plan.Package -Algorithm SHA256).Hash
  if ($hash -ne $plan.Sha256) { throw 'Installer SHA-256 mismatch.' }
  $installArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL', '/CLOSEAPPLICATIONS', ('/DIR="' + $plan.InstallDirectory.TrimEnd('\') + '"'), ('/LOG="' + (Join-Path $plan.UpdateDirectory 'installer.log') + '"'))
  $setup = Start-Process -FilePath $plan.Package -ArgumentList $installArgs -PassThru -Wait
  if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)." }
  $ok = $true
} catch { $detail = $_.Exception.Message }
@{ ok = $ok; detail = $detail; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $plan.UpdateDirectory 'result.json') -Encoding UTF8
if (-not (Get-Process -Id $plan.ProcessId -ErrorAction SilentlyContinue)) {
  Start-Process -FilePath (Join-Path $plan.InstallDirectory 'Cord.exe') -WorkingDirectory $plan.InstallDirectory
}
