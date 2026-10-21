<#
.SYNOPSIS
Проверка установщика NSIS на раннере Windows (ADR 0001 §9, п. 5): тихая установка для пользователя,
карточка «Установленных приложений» без ссылок (T54), ярлык на рабочем столе по умолчанию (T15),
схема cord://, запуск установленного Cord с заставкой, удаление.

.PARAMETER Release
Каталог с Cord-Setup-*.exe (вывод electron-builder).

.PARAMETER Metrics
Куда записать metrics.json (ADR 0001 §10): размер установщика и установленного, холодный старт
(заставка, главное окно, главная веба — медиана из -Runs запусков) и память в покое через 60 с после
главной. Без параметра — один короткий запуск, как раньше. Пороги ADR — предупреждения, не сбой:
на раннере нет GPU, цифры CI — нижняя граница.

.PARAMETER Runs
Сколько запусков для холодного старта (первый ещё и меряет память).
#>
param([string]$Release = 'release', [string]$Metrics = '', [int]$Runs = 5)
$ErrorActionPreference = 'Stop'

$installer = Get-Item (Join-Path $Release 'Cord-Setup-*.exe') | Select-Object -First 1
if (-not $installer) { throw "Нет установщика в $Release" }
Write-Host "Установщик: $($installer.Name) ($([math]::Round($installer.Length / 1MB)) МБ)"
if ($installer.Length -gt 130MB) { Write-Warning "Установщик больше порога ADR (130 МБ)" }

$target = Join-Path $env:LOCALAPPDATA 'Programs\Cord'
$process = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Тихая установка вернула код $($process.ExitCode)" }
if (-not (Test-Path (Join-Path $target 'Cord.exe'))) { throw "Cord.exe не найден в $target" }
# cord-native (ADR §4.6): модуль распакован рядом с asar — иначе utility-процесс его не загрузит.
$nativeModule = Join-Path $target 'resources\app.asar.unpacked\dist\native\cord-native.win32-x64-msvc.node'
if (-not (Test-Path $nativeModule)) { throw "Нативный модуль не найден: $nativeModule" }
Write-Host "cord-native: $([math]::Round((Get-Item $nativeModule).Length / 1KB)) КиБ"

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
$log = Join-Path $env:LOCALAPPDATA 'Cord\desktop\desktop.log'
$installedBytes = (Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum
$starts = @()
$appMemory = $null
$privateBytes = $null
$launches = if ($Metrics) { [Math]::Max(1, $Runs) } else { 1 }
for ($run = 1; $run -le $launches; $run++) {
  $file = Join-Path ([IO.Path]::GetTempPath()) "cord-metrics-$run.json"
  Remove-Item $file -ErrorAction SilentlyContinue
  if ($Metrics) {
    $env:CORD_METRICS_FILE = $file
    $env:CORD_METRICS_IDLE_MS = if ($run -eq 1) { '60000' } else { '0' }
  }
  $app = Start-Process -FilePath (Join-Path $target 'Cord.exe') -PassThru
  if ($Metrics) {
    # Cord пишет файл сам: через 60 с после главной (первый запуск) или сразу (остальные); не позже 150 с.
    $deadline = (Get-Date).AddSeconds(180)
    while (-not (Test-Path $file) -and (Get-Date) -lt $deadline) {
      if ($app.HasExited) { throw "Cord вышел с кодом $($app.ExitCode) (запуск $run)" }
      Start-Sleep -Milliseconds 500
    }
    if ($run -eq 1) { $privateBytes = (Get-Process Cord -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum }
    if (Test-Path $file) {
      $result = Get-Content $file -Raw | ConvertFrom-Json
      $starts += $result.coldStartMs
      if ($run -eq 1) { $appMemory = $result.memoryIdle }
      Write-Host "Запуск ${run}: $($result.coldStartMs | ConvertTo-Json -Compress)"
      # Главная не пришла (стенд недоступен) — каждый следующий запуск ждал бы 150 с впустую.
      if ($run -eq 1 -and $null -eq $result.coldStartMs.home) {
        Write-Warning 'Главная веба не открылась — остальные запуски пропущены'
        $launches = 1
      }
    } else {
      Write-Warning "Запуск ${run}: Cord не записал метрики за 180 с"
    }
  } else {
    Start-Sleep -Seconds 12
  }
  if ($app.HasExited) { throw "Cord вышел сразу с кодом $($app.ExitCode)" }
  if ($run -eq 1 -and (Test-Path $log)) { Get-Content $log | Select-Object -Last 10 | ForEach-Object { Write-Host "  log: $_" } }
  if ($run -eq 1) {
    # Установленный Cord обязан загрузить cord-native в utility-процессе (строка пишется при ответе ready).
    $nativeLine = if (Test-Path $log) { Get-Content $log | Where-Object { $_ -match 'native: ' } | Select-Object -Last 1 } else { $null }
    if (-not $nativeLine) { throw 'В журнале нет строки о cord-native: utility-процесс не ответил' }
    if ($nativeLine -notmatch 'native: загружен') { throw "cord-native не загрузился: $nativeLine" }
    Write-Host "cord-native в установленном Cord: $nativeLine"
  }
  Stop-Process -Id $app.Id -Force
  Get-Process Cord -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}
Remove-Item Env:CORD_METRICS_FILE, Env:CORD_METRICS_IDLE_MS -ErrorAction SilentlyContinue

if ($Metrics) {
  function Median([object[]]$values) {
    $list = @($values | Where-Object { $null -ne $_ } | Sort-Object)
    if ($list.Count -eq 0) { return $null }
    return $list[[Math]::Floor($list.Count / 2)]
  }
  $median = [ordered]@{
    splash = Median ($starts | ForEach-Object { $_.splash })
    main   = Median ($starts | ForEach-Object { $_.main })
    home   = Median ($starts | ForEach-Object { $_.home })
  }
  $installerMB = [Math]::Round($installer.Length / 1MB, 1)
  $installedMB = [Math]::Round($installedBytes / 1MB, 1)
  $privateMB = if ($privateBytes) { [Math]::Round($privateBytes / 1MB, 1) } else { $null }
  # Пороги ADR §10: установщик ≤ 130 МБ, на диске ≤ 400 МБ, память в покое ≤ 250 МБ, заставка ≤ 1 с, главная ≤ 3 с.
  $within = [ordered]@{
    installer = $installerMB -le 130
    installed = $installedMB -le 400
    memoryIdle = ($null -eq $privateMB) -or ($privateMB -le 250)
    splash = ($null -eq $median.splash) -or ($median.splash -le 1000)
    home = ($null -eq $median.home) -or ($median.home -le 3000)
  }
  $report = [ordered]@{
    commit = $env:GITHUB_SHA
    runner = 'windows-2022 (без GPU: цифры — нижняя граница, ADR §10)'
    installerMB = $installerMB
    installedMB = $installedMB
    coldStartMs = [ordered]@{ median = $median; runs = $starts }
    memoryIdle = [ordered]@{ privateMB = $privateMB; app = $appMemory }
    withinThresholds = $within
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -Path $Metrics -Encoding utf8
  Write-Host "metrics.json: $($report | ConvertTo-Json -Depth 6 -Compress)"
  foreach ($name in $within.Keys) { if (-not $within[$name]) { Write-Warning "Порог ADR §10 превышен: $name" } }
}

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
