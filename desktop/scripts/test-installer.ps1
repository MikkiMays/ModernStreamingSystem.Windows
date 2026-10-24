<#
.SYNOPSIS
Проверка установщика NSIS на раннере Windows (ADR 0001 §9, п. 5): тихая установка для пользователя
за ≤ 20 с (R105), папка %LOCALAPPDATA%\Programs\Cord, карточка «Установленных приложений» без ссылок
(T54), ярлыки на рабочем столе и в «Пуск» с AUMID (T15, R59), схема cord://, запуск установленного Cord
с заставкой, удаление; с -Screenshots — ещё и обычный запуск «одним окном» со снимками экрана.

.PARAMETER Release
Каталог с Cord-Setup-*.exe (вывод electron-builder).

.PARAMETER Metrics
Куда записать metrics.json (ADR 0001 §10): размер установщика и установленного, холодный старт
(заставка, главное окно, главная веба — медиана из -Runs запусков) и память в покое через 60 с после
главной. Без параметра — один короткий запуск, как раньше. Пороги ADR — предупреждения, не сбой:
на раннере нет GPU, цифры CI — нижняя граница.

.PARAMETER Runs
Сколько запусков для холодного старта (первый ещё и меряет память).

.PARAMETER Screenshots
Каталог для снимков обычного (не тихого) запуска установщика (R105, n04): окно выбора языка и окно с
полосой. Окно языка подтверждается программно (IDOK), время установки печатается. Сбой снимка —
предупреждение, не сбой: раннер без GPU и с чужим рабочим столом.
#>
param([string]$Release = 'release', [string]$Metrics = '', [int]$Runs = 5, [string]$Screenshots = '')
$ErrorActionPreference = 'Stop'

Add-Type -Namespace CordProbe -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@

$installer = Get-Item (Join-Path $Release 'Cord-Setup-*.exe') | Select-Object -First 1
if (-not $installer) { throw "Нет установщика в $Release" }
Write-Host "Установщик: $($installer.Name) ($([math]::Round($installer.Length / 1MB)) МБ)"
if ($installer.Length -gt 130MB) { Write-Warning "Установщик больше порога ADR (130 МБ)" }

$target = Join-Path $env:LOCALAPPDATA 'Programs\Cord'
# Установка «одним окном» (R105) — быстро: порог 20 с на раннере, превышение — предупреждение.
$clock = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
$clock.Stop()
$installSeconds = [Math]::Round($clock.Elapsed.TotalSeconds, 1)
if ($process.ExitCode -ne 0) { throw "Тихая установка вернула код $($process.ExitCode)" }
Write-Host "Тихая установка: $installSeconds с"
if ($installSeconds -gt 20) { Write-Warning "Установка дольше 20 с (R105): $installSeconds с" }
if (-not (Test-Path (Join-Path $target 'Cord.exe'))) { throw "Cord.exe не найден в $target" }
# В режиме «одним окном» electron-builder назвал бы папку по имени пакета — installer.nsh ставит в Programs\Cord.
if (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\cord-desktop')) { throw 'Установлено в Programs\cord-desktop вместо Programs\Cord' }
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

# Ярлык на рабочем столе — всегда (T15, R105: страницы «Ярлыки» больше нет); прежний выбор галочки
# (DesktopShortcut, до 1.0.6) после установки убран — ярлыками ведает electron-builder.
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cord.lnk'
if (-not (Test-Path $shortcut)) { throw 'Нет ярлыка на рабочем столе' }
if ($null -ne (Get-ItemProperty 'HKCU:\Software\Cord' -ErrorAction SilentlyContinue).DesktopShortcut) { throw 'Старое значение DesktopShortcut не убрано' }
if ((Get-ItemProperty 'HKCU:\Software\Classes\cord\shell\open\command').'(default)' -notlike "*Cord.exe*") { throw 'Схема cord:// не записана' }
Write-Host 'Ярлык и схема cord:// на месте'

# AUMID ярлыков = appId из electron-builder.yml (R59): иначе уведомления Windows не показываются.
$appId = (Get-Content (Join-Path $PSScriptRoot '..\electron-builder.yml') | Where-Object { $_ -match '^appId:\s*(\S+)' } | ForEach-Object { $Matches[1] } | Select-Object -First 1)
if (-not $appId) { throw 'appId не найден в electron-builder.yml' }
$shellApp = New-Object -ComObject Shell.Application
foreach ($link in @($shortcut, (Join-Path ([Environment]::GetFolderPath('Programs')) 'Cord.lnk'))) {
  if (-not (Test-Path $link)) { throw "Нет ярлыка $link" }
  $item = $shellApp.Namespace((Split-Path $link)).ParseName((Split-Path $link -Leaf))
  $aumid = $item.ExtendedProperty('System.AppUserModel.ID')
  if ($aumid -ne $appId) { throw "AUMID ярлыка $link — '$aumid', ожидался '$appId'" }
}
Write-Host "AUMID ярлыков: $appId"

# Язык мастера записан для приложения (R64): LCID одного из восьми языков Cord.
$languageValue = (Get-ItemProperty 'HKCU:\Software\Cord' -ErrorAction SilentlyContinue).Language
if ("$languageValue" -notmatch '^(1049|1033|3082|1036|1040|2052|1031|1046)$') { throw "Язык установщика в HKCU: '$languageValue'" }
Write-Host "Язык установщика в HKCU: $languageValue"

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
    # Крестик прячет Cord в трей (R57): WM_CLOSE главному окну — процесс жив, окна не видно.
    $owner = Get-Process Cord -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $owner) { throw 'Главное окно Cord не найдено для проверки крестика' }
    $hwnd = $owner.MainWindowHandle
    [CordProbe.Win32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Seconds 5
    if ($app.HasExited) { throw 'Крестик завершил Cord вместо сворачивания в трей' }
    if ([CordProbe.Win32]::IsWindowVisible($hwnd)) { throw 'После крестика главное окно осталось видимым' }
    Write-Host 'Крестик: Cord жив, окно спрятано в трей'
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
  # Пороги ADR §10: установщик ≤ 130 МБ, на диске ≤ 400 МБ, память в покое ≤ 250 МБ, заставка ≤ 1 с, главная ≤ 3 с;
  # R105: тихая установка ≤ 20 с.
  $within = [ordered]@{
    installer = $installerMB -le 130
    install = $installSeconds -le 20
    installed = $installedMB -le 400
    memoryIdle = ($null -eq $privateMB) -or ($privateMB -le 250)
    splash = ($null -eq $median.splash) -or ($median.splash -le 1000)
    home = ($null -eq $median.home) -or ($median.home -le 3000)
  }
  $report = [ordered]@{
    commit = $env:GITHUB_SHA
    runner = 'windows-2022 (без GPU: цифры — нижняя граница, ADR §10)'
    installerMB = $installerMB
    installSeconds = $installSeconds
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

# Обычный запуск, как у человека (R105, n04): окно выбора языка → окно с полосой → Cord запускается сам.
if ($Screenshots) {
  New-Item -ItemType Directory -Force -Path $Screenshots | Out-Null
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  function Save-Screen([string]$name) {
    try {
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
      $path = Join-Path $Screenshots $name
      $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bitmap.Dispose()
      Write-Host "Снимок: $path"
    } catch {
      Write-Warning "Снимок $name не снят: $($_.Exception.Message)"
    }
  }
  function Wait-Window($run, [IntPtr]$except, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline -and -not $run.HasExited) {
      $run.Refresh()
      if ($run.MainWindowHandle -ne [IntPtr]::Zero -and $run.MainWindowHandle -ne $except) { return $run.MainWindowHandle }
      Start-Sleep -Milliseconds 100
    }
    return [IntPtr]::Zero
  }
  $run = Start-Process -FilePath $installer.FullName -PassThru
  try {
    $language = Wait-Window $run ([IntPtr]::Zero) 30
    if ($language -eq [IntPtr]::Zero) {
      Write-Warning 'Окно выбора языка не появилось за 30 с'
    } else {
      Start-Sleep -Milliseconds 500
      Save-Screen 'installer-1-language.png'
      $clock = [Diagnostics.Stopwatch]::StartNew()
      # «OK» окна языка: WM_COMMAND с IDOK.
      [CordProbe.Win32]::PostMessage($language, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
      if ((Wait-Window $run $language 20) -ne [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 300
        Save-Screen 'installer-2-progress.png'
      } else {
        Write-Warning 'Окно с полосой не поймано: установка закончилась раньше снимка или окно не появилось'
      }
      if (-not $run.WaitForExit(120000)) { Write-Warning 'Установщик не закончил за 120 с' }
      $clock.Stop()
      Write-Host "Обычная установка после выбора языка: $([Math]::Round($clock.Elapsed.TotalSeconds, 1)) с, код $($run.ExitCode)"
      if (-not (Test-Path (Join-Path $target 'Cord.exe'))) { Write-Warning "После обычной установки нет Cord.exe в $target" }
      if (-not (Test-Path $shortcut)) { Write-Warning 'После обычной установки нет ярлыка на рабочем столе' }
    }
  } finally {
    if (-not $run.HasExited) { Stop-Process -Id $run.Id -Force -ErrorAction SilentlyContinue }
    # runAfterFinish запускает Cord сам — закрыть его и удалить установку.
    Start-Sleep -Seconds 3
    Get-Process Cord -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $uninstaller = Get-ChildItem $target -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($uninstaller) { Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait | Out-Null }
  }
}
Write-Host 'Установка, запуск и удаление прошли'
