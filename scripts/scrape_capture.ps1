# ============================================================================
# scrape_capture.ps1 — page through a chat window's history, capturing frames.
#   Foreground window, optionally scroll to bottom, then capture+scroll-up
#   repeatedly until the view stops changing (top reached) or MaxFrames.
#   Frames saved as frame_000.png ... in OutDir. Background capture (PrintWindow).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scrape_capture.ps1 [ProcName] [-MaxFrames N] [-Notches N] [-ToBottom] [-OutDir path]
# ============================================================================
param(
  [string]$ProcName = 'KakaoTalk',
  [long]$Hwnd = 0,                # target an exact window handle (e.g. a chat sub-window); 0 = use ProcName main window
  [int]$MaxFrames = 60,
  [int]$Notches = 8,
  [int]$LoadWaitMs = 600,         # wait after each scroll for lazy-loaded history to arrive
  [int]$SettleMs = 700,          # extra wait before concluding "top reached" (re-check, avoids false stop mid-load)
  [switch]$ToBottom,
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class ScrapeWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public const uint MEF_WHEEL = 0x0800;
  public const int SW_RESTORE = 9;
  public static void Foreground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint t1 = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint t2 = GetWindowThreadProcessId(h, IntPtr.Zero);
    AttachThreadInput(t1, t2, true);
    ShowWindow(h, SW_RESTORE); BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(t1, t2, false);
  }
  public static void Wheel(IntPtr h, int notches, double fx, double fy) {
    RECT r; GetWindowRect(h, out r);
    int x = (int)(r.Left + (r.Right - r.Left)*fx);
    int y = (int)(r.Top  + (r.Bottom - r.Top)*fy);
    SetCursorPos(x, y);
    mouse_event(MEF_WHEEL, 0, 0, 120*notches, UIntPtr.Zero);
  }
  public static bool Capture(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = r.Right-r.Left, ht = r.Bottom-r.Top;
    if (w<=0||ht<=0) return false;
    Bitmap b = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(b)) { IntPtr hdc=g.GetHdc(); PrintWindow(h, hdc, 2u); g.ReleaseHdc(hdc); }
    b.Save(path, ImageFormat.Png); b.Dispose();
    return true;
  }
}
"@

[ScrapeWin]::SetProcessDPIAware() | Out-Null
if ($Hwnd -ne 0) {
  $h = [IntPtr]$Hwnd
} else {
  $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($null -eq $proc) { Write-Output "NO WINDOW for $ProcName"; exit 1 }
  $h = $proc.MainWindowHandle
}

if ([string]::IsNullOrEmpty($OutDir)) {
  $stamp  = (Get-Date -Format 'yyyyMMdd_HHmmss')
  $OutDir = Join-Path $cuConfig.shotsDirWin "scrape_$stamp"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

[ScrapeWin]::Foreground($h)
Start-Sleep -Milliseconds 300
function FrameHash($p) { (Get-FileHash -Path $p -Algorithm MD5).Hash }

# Phase A: scroll to bottom (newest) until stable
if ($ToBottom) {
  $tmp = Join-Path $OutDir '_probe.png'; $prev = ''
  for ($i=0; $i -lt 50; $i++) {
    [ScrapeWin]::Wheel($h, [int](-$Notches), [double]0.5, [double]0.5); Start-Sleep -Milliseconds $LoadWaitMs
    [void][ScrapeWin]::Capture($h, $tmp); $hh = FrameHash $tmp
    if ($hh -eq $prev) { break }; $prev = $hh
  }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

# Phase B: capture, then scroll UP to load older messages; stop only when scrolling yields
#   no new content (top reached). Lazy-load aware: a matching capture is re-checked after
#   SettleMs before concluding "top", so a slow history load doesn't trigger a false stop.
$count = 0; $prevHash = ''
for ($i=0; $i -lt $MaxFrames; $i++) {
  $fp = Join-Path $OutDir ("frame_{0:D3}.png" -f $count)
  [void][ScrapeWin]::Capture($h, $fp)
  $hh = FrameHash $fp
  if ($hh -eq $prevHash) {
    Start-Sleep -Milliseconds $SettleMs                       # maybe still lazy-loading: give it a chance
    [void][ScrapeWin]::Capture($h, $fp); $hh = FrameHash $fp
    if ($hh -eq $prevHash) { Remove-Item $fp -Force; break }   # confirmed no change -> top
  }
  $prevHash = $hh; $count++
  [ScrapeWin]::Wheel($h, [int]$Notches, [double]0.5, [double]0.45)
  Start-Sleep -Milliseconds $LoadWaitMs
}

Write-Output ("FRAMES=$count DIR=$OutDir")
