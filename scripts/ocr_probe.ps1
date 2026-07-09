# ============================================================================
# ocr_probe.ps1 — Local OCR via Windows.Media.Ocr (zero external install).
#   MUST run with -STA :  powershell -NoProfile -STA -ExecutionPolicy Bypass -File ocr_probe.ps1 [img] [lang]
#   - lists available OCR languages (stderr)
#   - OCRs the image (default: latest KakaoTalk shot) -> stdout (UTF-8)
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

# --- load WinRT projections ---
$null = [Windows.Media.Ocr.OcrEngine,                 Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile,                 Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode,              Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,      Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,     Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language,              Windows.Foundation, ContentType = WindowsRuntime]

# --- canonical AsTask reflection await ---
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask  = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

# --- pick image ---
if ([string]::IsNullOrEmpty($ImagePath)) {
  $latest = Get-ChildItem (Join-Path $cuConfig.shotsDirWin 'KakaoTalk_*.png') -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $latest) { throw "no KakaoTalk_*.png in shots/ and no ImagePath given" }
  $ImagePath = $latest.FullName
}
$full = (Resolve-Path $ImagePath).Path
[Console]::Error.WriteLine("IMAGE: $full")
[Console]::Error.WriteLine("OCR_LANGS: " + (([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', '))

# --- engine ---
$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Lang))) } catch {}
if ($null -eq $engine -and -not [string]::IsNullOrWhiteSpace($Lang)) {
  throw "Windows OCR language '$Lang' is not installed. See OCR_LANGS above."
}
if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if ($null -eq $engine) { throw "no OCR engine (install Korean OCR language pack)" }
[Console]::Error.WriteLine("ENGINE_LANG: " + $engine.RecognizerLanguage.LanguageTag)

# --- decode -> SoftwareBitmap -> OCR ---
$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

Write-Output "----- OCR TEXT -----"
Write-Output $result.Text
