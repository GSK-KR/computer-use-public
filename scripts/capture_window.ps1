# ============================================================================
# capture_window.ps1 — capture ONE window (default: KakaoTalk) to a PNG.
# Uses PrintWindow(PW_RENDERFULLCONTENT) so it grabs only the target window,
# without stealing foreground / regardless of z-order occlusion.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File capture_window.ps1 [ProcName] [OutPath]
# ============================================================================
param(
  [string]$ProcName = 'KakaoTalk',
  [string]$OutPath  = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string Capture(IntPtr h, string path) {
    RECT r; if(!GetWindowRect(h, out r)) return "GetWindowRect failed";
    int w = r.Right - r.Left; int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return ("bad size " + w + "x" + ht);
    Bitmap bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(h, hdc, 2u); // PW_RENDERFULLCONTENT
      g.ReleaseHdc(hdc);
      if(!ok) { bmp.Dispose(); return "PrintWindow returned false"; }
    }
    bmp.Save(path, ImageFormat.Png);
    string res = ("saved " + w + "x" + ht);
    bmp.Dispose();
    return res;
  }
}
"@

[WinCap]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
if ($null -eq $proc) { Write-Output "NO WINDOW for $ProcName"; exit 1 }

if ([string]::IsNullOrEmpty($OutPath)) {
  $stamp   = (Get-Date -Format 'yyyyMMdd_HHmmss')
  $OutPath = Join-Path $cuConfig.shotsDirWin "${ProcName}_$stamp.png"
}

$h   = $proc.MainWindowHandle
$msg = [WinCap]::Capture($h, $OutPath)
$rr  = New-Object WinCap+RECT
[void][WinCap]::GetWindowRect($h, [ref]$rr)
# rect = window outer top-left in physical screen px; screen(x,y) = rect.Left/Top + ocr(x,y)
Write-Output "RESULT hwnd=$h title=[$($proc.MainWindowTitle)] msg=[$msg] rect=$($rr.Left),$($rr.Top),$($rr.Right),$($rr.Bottom) file=$OutPath"
