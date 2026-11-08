# Окно-держатель на время установки обновления (R203). Cord закрывается, чтобы установщик заменил его файлы, а
# заставка не должна пропадать: это окно встаёт на её место — та же картинка, живой знак Cord и «Устанавливаем…» —
# и закрывается, когда новый Cord показал свою заставку (файл -Ready), или само через -TimeoutSec.
# Запускает `src/main/update/holder.ts` из копии в папке данных: папку программы установщик перезаписывает.
param(
  [Parameter(Mandatory = $true)][string]$Gif,
  [Parameter(Mandatory = $true)][string]$Ready,
  # Рамка заставки в физических пикселях экрана (`screen.dipToScreenRect`).
  [int]$X, [int]$Y, [int]$Width = 300, [int]$Height = 360,
  [string]$Text = 'Устанавливаем…',
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Физические пиксели и чёткая картинка на 125–200 %: без этого Windows растянула бы окно растром.
Add-Type -Namespace Cord -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Cord.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

# Строка состояния заставки (CSS-пиксели окна 300×360): render-update-holder.mjs.
$STATUS_TOP = 248; $STATUS_LEFT = 28; $STATUS_WIDTH = 244
$scale = $Width / 300.0

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.ClientSize = New-Object System.Drawing.Size($Width, $Height)
$form.BackColor = [System.Drawing.Color]::FromArgb(17, 20, 25)
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.Text = 'Cord'

$box = New-Object System.Windows.Forms.PictureBox
$box.Dock = [System.Windows.Forms.DockStyle]::Fill
$box.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$box.Image = [System.Drawing.Image]::FromFile($Gif)
$form.Controls.Add($box)

$label = New-Object System.Windows.Forms.Label
$label.Parent = $box
$label.BackColor = [System.Drawing.Color]::Transparent
$label.ForeColor = [System.Drawing.Color]::FromArgb(233, 236, 241)
# 13 CSS-пикселей заставки = 13 × масштаб физических; размер шрифта — в пикселях, а не в пунктах.
$label.Font = New-Object System.Drawing.Font('Segoe UI', [single](13 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$label.TextAlign = [System.Drawing.ContentAlignment]::TopCenter
$label.AutoSize = $false
$label.Location = New-Object System.Drawing.Point([int]($STATUS_LEFT * $scale), [int]($STATUS_TOP * $scale))
$label.Size = New-Object System.Drawing.Size([int]($STATUS_WIDTH * $scale), [int](40 * $scale))
$label.Text = $Text

$started = [DateTime]::UtcNow
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
  if ((Test-Path -LiteralPath $Ready) -or (([DateTime]::UtcNow - $started).TotalSeconds -gt $TimeoutSec)) {
    $timer.Stop()
    $form.Close()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
