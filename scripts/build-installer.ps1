param([switch]$SkipPublish)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$SkipPublish) { & (Join-Path $PSScriptRoot 'build.ps1') -Publish }
$publication = Join-Path $projectRoot 'artifacts\Cord-win-x64'
foreach ($required in @('Cord.exe', 'Cord.pri', 'App.xbf', 'MainWindow.xbf', 'Assets\Cord.ico')) {
  $candidate = Join-Path $publication $required
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf) -or (Get-Item -LiteralPath $candidate).Length -eq 0) {
    throw "Incomplete publication: $required. Run build.ps1 -Publish."
  }
}
$dependencies = Get-Content -LiteralPath (Join-Path $projectRoot 'installer\dependencies.json') -Raw | ConvertFrom-Json
$toolsRoot = Join-Path $projectRoot '.local\installer-tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
function Get-VerifiedDependency($dependency) {
  $path = Join-Path $toolsRoot $dependency.file
  if (!(Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dependency.sha256) {
    Invoke-WebRequest -Uri $dependency.url -OutFile $path
  }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dependency.sha256) { throw "Checksum mismatch: $($dependency.file)" }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*O=$($dependency.publisher)*") {
    throw "Untrusted publisher: $($dependency.file)"
  }
  return $path
}
$compilerSetup = Get-VerifiedDependency $dependencies.compiler
$null = Get-VerifiedDependency $dependencies.webview2
$compilerRoot = Join-Path $toolsRoot 'inno'
$compiler = Join-Path $compilerRoot 'ISCC.exe'
if (!(Test-Path -LiteralPath $compiler)) {
  $arguments = @('/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOICONS', '/TASKS=""', "/DIR=`"$compilerRoot`"")
  $process = Start-Process -FilePath $compilerSetup -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (!$process.WaitForExit(60000)) { throw 'Inno Setup installation timed out.' }
  if ($process.ExitCode -ne 0) { throw "Inno Setup installation failed: $($process.ExitCode)" }
}
$compilerHelp = & $compiler '--version'
if (($compilerHelp -join "`n") -notmatch '7\.1\.0') { throw 'Unexpected Inno Setup compiler version.' }
[xml]$project = Get-Content -LiteralPath (Join-Path $projectRoot 'src\Cord.Windows\Cord.Windows.csproj')
$version = [string]$project.Project.PropertyGroup.Version
$log = Join-Path $toolsRoot 'build.log'
& $compiler "--define=PublishRoot=$publication" "--define=RedistRoot=$toolsRoot" "--define=ArtifactRoot=$(Join-Path $projectRoot 'artifacts')" "--define=AppVersion=$version" (Join-Path $projectRoot 'installer\Cord.iss') *> $log
if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 30; throw 'Installer compilation failed.' }
$installer = Join-Path $projectRoot "artifacts\Cord-Setup-$version-x64.exe"
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$installer.sha256" -Value "$hash  $([IO.Path]::GetFileName($installer))" -Encoding ascii
Write-Output "Installer: $installer"
Write-Output "SHA-256: $hash"
