# ============================================================================
# ocr_lines.ps1 — Structured local OCR via Windows.Media.Ocr.
#   Outputs JSON array of {text,x,y,w,h} (line bounding boxes) to stdout (UTF-8).
#   MUST run with -STA :  powershell -NoProfile -STA -ExecutionPolicy Bypass -File ocr_lines.ps1 <img> [lang]
# ============================================================================
param(
  [string]$ImagePath = '',
  [string]$Lang = 'ko'
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,                 Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile,                 Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode,              Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,      Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,     Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language,              Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask  = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

if ([string]::IsNullOrEmpty($ImagePath)) {
  $latest = Get-ChildItem (Join-Path $cuConfig.shotsDirWin 'KakaoTalk_*.png') -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $latest) { throw "no image and no ImagePath" }
  $ImagePath = $latest.FullName
}
$full = (Resolve-Path $ImagePath).Path

$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Lang))) } catch {}
if ($null -eq $engine -and -not [string]::IsNullOrWhiteSpace($Lang)) {
  $available = ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', '
  throw "Windows OCR language '$Lang' is not installed. Available OCR languages: $available"
}
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "no OCR engine" }

$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

[Console]::Error.WriteLine("LINES: " + @($result.Lines).Count)

function JsonEsc([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('\','\\').Replace('"','\"').Replace("`r",'').Replace("`n",'\n').Replace("`t",'\t')
}

# Manual JSON build (ConvertTo-Json in PS5.1 throws ArgumentException on this input)
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('[')
$first = $true
$n = 0
foreach ($ln in $result.Lines) {
  $words = @($ln.Words)
  if ($words.Count -eq 0) { continue }
  $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0.0; $maxY = 0.0
  foreach ($w in $words) {
    $r = $w.BoundingRect
    if ($r.X -lt $minX) { $minX = $r.X }
    if ($r.Y -lt $minY) { $minY = $r.Y }
    if (($r.X + $r.Width)  -gt $maxX) { $maxX = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
  }
  if (-not $first) { [void]$sb.Append(',') }
  $first = $false
  $n++
  [void]$sb.Append('{"text":"')
  [void]$sb.Append((JsonEsc ([string]$ln.Text)))
  [void]$sb.Append('","x":'); [void]$sb.Append([int][math]::Round($minX))
  [void]$sb.Append(',"y":');  [void]$sb.Append([int][math]::Round($minY))
  [void]$sb.Append(',"w":');  [void]$sb.Append([int][math]::Round($maxX - $minX))
  [void]$sb.Append(',"h":');  [void]$sb.Append([int][math]::Round($maxY - $minY))
  [void]$sb.Append('}')
}
[void]$sb.Append(']')
[Console]::Error.WriteLine("PARSED: " + $n)
[Console]::Out.WriteLine($sb.ToString())
