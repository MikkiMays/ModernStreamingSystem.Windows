param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\Cord.Windows\Assets'
New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
$frames = [System.Collections.Generic.List[byte[]]]::new()
$sizes = @(16, 24, 32, 48, 64, 256)
foreach ($size in $sizes) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.ScaleTransform($size / 256.0, $size / 256.0)
  $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#3564F3'))
  $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $shape.AddArc(4, 4, 88, 88, 180, 90); $shape.AddArc(164, 4, 88, 88, 270, 90)
  $shape.AddArc(164, 164, 88, 88, 0, 90); $shape.AddArc(4, 164, 88, 88, 90, 90); $shape.CloseFigure()
  $graphics.FillPath($background, $shape)
  $graphics.TranslateTransform(128, 128); $graphics.RotateTransform(-15)
  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 22)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($pen, -44, -22, -44, 22); $graphics.DrawLine($pen, 0, -50, 0, 50); $graphics.DrawLine($pen, 44, -34, 44, 34)
  $buffer = [System.IO.MemoryStream]::new()
  $bitmap.Save($buffer, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames.Add($buffer.ToArray())
  $buffer.Dispose(); $pen.Dispose(); $shape.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$stream = [System.IO.File]::Create((Join-Path $assetRoot 'Cord.ico'))
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
for ($index = 0; $index -lt $frames.Count; $index++) {
  $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$frames[$index].Length); $writer.Write([uint32]$offset)
  $offset += $frames[$index].Length
}
foreach ($frame in $frames) { $writer.Write($frame) }
$writer.Dispose(); $stream.Dispose()
