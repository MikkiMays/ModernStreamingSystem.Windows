param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sdkRoot = Join-Path $projectRoot '.local\dotnet'
$dotnet = Join-Path $sdkRoot 'dotnet.exe'
if (Test-Path -LiteralPath $dotnet) { if ((& $dotnet --version) -eq '10.0.400') { return } }
New-Item -ItemType Directory -Force -Path $sdkRoot | Out-Null
$archive = Join-Path $projectRoot '.local\dotnet-sdk.zip'
$expected = '9b8b88590e4da131bfd0da7aa089d0fc04d5418d5f8607ec13d55dc5a17b4399afd54d496c12657fa05c6c6546dc5eab930f26ac6c50f2d3a7712c0fb378c366'
if (!(Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $expected) {
  Invoke-WebRequest 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.400/dotnet-sdk-10.0.400-win-x64.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash.ToLowerInvariant() -ne $expected) { throw 'SDK checksum does not match.' }
Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot -Force
if ((& $dotnet --version) -ne '10.0.400') { throw 'Unexpected .NET SDK version.' }
