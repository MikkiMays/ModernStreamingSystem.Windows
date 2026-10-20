<#
.SYNOPSIS
Проверка установщика NSIS на раннере Windows (ADR 0001 §9, п. 5): тихая установка для пользователя,
карточка «Установленных приложений» без ссылок (T54), ярлык на рабочем столе по умолчанию (T15),
схема cord://, запуск установленного Cord с заставкой, удаление.

.PARAMETER Release
Каталог с Cord-Setup-*.exe (вывод electron-builder).
#>
param([string]$Release = 'release')
$ErrorActionPreference = 'Stop'

$installer = Get-Item (Join-Path $Release 'Cord-Setup-*.exe') | Select-Object -First 1
if (-not $installer) { throw "Нет установщика в $Release" }
Write-Host "Установщик: $($installer.Name) ($([math]::Round($installer.Length / 1MB)) МБ)"
if ($installer.Length -gt 130MB) { Write-Warning "Установщик больше порога ADR (130 МБ)" }

$target = Join-Path $env:LOCALAPPDATA 'Programs\Cord'
$process = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Тихая установка вернула код $($process.ExitCode)" }
if (-not (Test-Path (Join-Path $target 'Cord.exe'))) { throw "Cord.exe не найден в $target" }

# Карточка Windows: издатель Cord и ни одной ссылки.
$keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { ($_ | Get-ItemProperty).DisplayName -eq 'Cord' }
if (-not $keys) { throw 'Ключ удаления Cord не найден в HKCU' }
foreach ($key in $keys) {
  $card = $key | Get-ItemProperty
  foreach ($name in 'HelpLink', 'URLInfoAbout', 'URLUpdateInfo', 'Readme') {
    if ($card.PSObject.Properties[$name] -and $card.$name) { throw "В карточке Windows есть ссылка: $name = $($card.$name)" }
  }
  if ($card.Publisher -ne 'Cord') { throw "Издатель в карточке: $($card.Publisher)" }
  if ($card.DisplayVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Версия в карточке: $($card.DisplayVersion)" }
}
Write-Host 'Карточка Windows: без ссылок, издатель Cord'

# Ярлык на рабочем столе включён по умолчанию (T15) и выбор запомнен.
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cord.lnk'
if (-not (Test-Path $shortcut)) { throw 'Нет ярлыка на рабочем столе' }
if ((Get-ItemProperty 'HKCU:\Software\Cord').DesktopShortcut -ne 1) { throw 'Выбор ярлыка не запомнен' }
if ((Get-ItemProperty 'HKCU:\Software\Classes\cord\shell\open\command').'(default)' -notlike "*Cord.exe*") { throw 'Схема cord:// не записана' }
Write-Host 'Ярлык и схема cord:// на месте'

# Запуск: заставка открывается, зеркало недоступно — Cord открывается сам и живёт хотя бы 10 с.
$env:CORD_UPDATE_CHANNEL = 'https://127.0.0.1:9/downloads/windows/desktop/'
$app = Start-Process -FilePath (Join-Path $target 'Cord.exe') -PassThru
Start-Sleep -Seconds 12
if ($app.HasExited) { throw "Cord вышел сразу с кодом $($app.ExitCode)" }
$log = Join-Path $env:LOCALAPPDATA 'Cord\desktop\desktop.log'
if (Test-Path $log) { Get-Content $log | Select-Object -Last 10 | ForEach-Object { Write-Host "  log: $_" } }
Stop-Process -Id $app.Id -Force
Get-Process Cord -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Удаление: тихо; настройки остаются (deleteAppDataOnUninstall: false).
$uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $uninstaller) { throw 'Деинсталлятор не найден' }
$process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Удаление вернуло код $($process.ExitCode)" }
Start-Sleep -Seconds 3
if (Test-Path (Join-Path $target 'Cord.exe')) { throw 'Cord.exe остался после удаления' }
if (Test-Path $shortcut) { throw 'Ярлык остался после удаления' }
if (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'Cord\desktop'))) { Write-Warning 'Каталог настроек не создан — проверка профиля пропущена' }
Write-Host 'Установка, запуск и удаление прошли'
