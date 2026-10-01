# ============================================================================
# capture_screen.ps1 — capture the full virtual desktop (all monitors) to PNG.
#   DPI-aware (physical pixels). Reports ORIGIN so image pixel (px,py) maps to
#   screen coord (ORIGIN_X+px, ORIGIN_Y+py) for clicking.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File capture_screen.ps1 [OutPath]
# ============================================================================
param([string]$OutPath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig

Add-Type @"
using System; using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][Dpi]::SetProcessDPIAware()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ([string]::IsNullOrEmpty($OutPath)) {
  $stamp = (Get-Date -Format 'yyyyMMdd_HHmmss')
  $OutPath = Join-Path $cuConfig.shotsDirWin "screen_$stamp.png"
}
$bmp = New-Object System.Drawing.Bitmap([int]$vs.Width, [int]$vs.Height)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$vs.Left, [int]$vs.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "ORIGIN=$([int]$vs.Left),$([int]$vs.Top) SIZE=$([int]$vs.Width)x$([int]$vs.Height) FILE=$OutPath"
