# ============================================================================
# capture_region.ps1 — capture a screen rectangle via BitBlt (real screen px).
#   Works for UWP/hardware-accelerated apps where PrintWindow returns black.
#   Requires the region to be visible (not occluded). DPI-aware (physical px).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File capture_region.ps1 -X <sx> -Y <sy> -W <w> -H <h> [OutPath]
# ============================================================================
param(
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [Parameter(Mandatory=$true)][int]$W,
  [Parameter(Mandatory=$true)][int]$H,
  [string]$OutPath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Dpi2 { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][Dpi2]::SetProcessDPIAware()
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrEmpty($OutPath)) {
  $stamp = (Get-Date -Format 'yyyyMMdd_HHmmss')
  $OutPath = Join-Path $cuConfig.shotsDirWin "region_$stamp.png"
}
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "REGION x=$X y=$Y w=$W h=$H file=$OutPath"
