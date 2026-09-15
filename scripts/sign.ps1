#
# Authenticode signing, when this machine has been given a certificate to sign with.
#
# Without one the build produces exactly what it produced before: unsigned artifacts and a
# line in the log saying so. That is deliberate — a build must not start failing because a
# secret is missing, and an unsigned Cord is a working Cord that Windows warns about.
#
# With one, every published binary and the installer carry it. Nothing else about the build
# changes, so turning signing on is a matter of setting two secrets:
#
#   CORD_SIGN_PFX_BASE64   the .pfx, base64-encoded
#   CORD_SIGN_PASSWORD     its password (optional if the file has none)
#   CORD_SIGN_TIMESTAMP_URL  RFC 3161 timestamp service; defaults to DigiCert's
#
# A timestamp is not optional in practice: without it every signature stops verifying the
# day the certificate expires, including on copies people already installed.
#
param([Parameter(Mandatory)][string[]]$Path)
$ErrorActionPreference = 'Stop'

$encoded = $env:CORD_SIGN_PFX_BASE64
if ([string]::IsNullOrWhiteSpace($encoded)) {
  Write-Output 'Signing: no certificate configured, artifacts stay unsigned.'
  return
}

function Find-SignTool {
  $packages = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.nuget\packages' } else { $null }
  $roots = @('C:\Program Files (x86)\Windows Kits\10\bin')
  if ($packages) { $roots += (Join-Path $packages 'microsoft.windows.sdk.buildtools') }
  $candidates = @()
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      $candidates += Get-ChildItem -LiteralPath $root -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' }
    }
  }
  $newest = $candidates | Sort-Object -Property FullName -Descending | Select-Object -First 1
  if (!$newest) { throw 'signtool.exe was not found, but a signing certificate was configured.' }
  return $newest.FullName
}

$signtool = Find-SignTool
$timestamp = if ([string]::IsNullOrWhiteSpace($env:CORD_SIGN_TIMESTAMP_URL)) { 'http://timestamp.digicert.com' } else { $env:CORD_SIGN_TIMESTAMP_URL }
$certificate = Join-Path ([IO.Path]::GetTempPath()) ("cord-" + [Guid]::NewGuid().ToString('N') + '.pfx')
try {
  [IO.File]::WriteAllBytes($certificate, [Convert]::FromBase64String($encoded))
  $arguments = @('sign', '/fd', 'sha256', '/td', 'sha256', '/tr', $timestamp, '/f', $certificate)
  if (![string]::IsNullOrEmpty($env:CORD_SIGN_PASSWORD)) { $arguments += @('/p', $env:CORD_SIGN_PASSWORD) }
  foreach ($file in $Path) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Nothing to sign at $file" }
  }
  & $signtool @arguments @Path
  if ($LASTEXITCODE -ne 0) { throw "Signing failed with exit code $LASTEXITCODE" }
}
finally {
  # The certificate exists on disk for as long as one signtool call takes, and no longer.
  if (Test-Path -LiteralPath $certificate) { Remove-Item -LiteralPath $certificate -Force }
}

foreach ($file in $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid') { throw "Signature did not verify on $($file): $($signature.Status)" }
  Write-Output "Signed: $([IO.Path]::GetFileName($file)) by $($signature.SignerCertificate.Subject)"
}
