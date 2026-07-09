# ============================================================================
# wechat_window.ps1 -- exact-hwnd capture/click/scroll helper for WeChat backup.
# Coordinates are window-relative physical pixels. This helper never types.
# ============================================================================
param(
  [ValidateSet('capture','click','scroll')]
  [string]$Cmd = 'capture',
  [long]$Hwnd = 0,
  [string]$ProcName = 'Weixin',
  [string]$OutPath = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Notches = 3
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public class WeChatWindow {
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
  public const uint MEF_MOVE=0x0001, MEF_LD=0x0002, MEF_LU=0x0004, MEF_WHEEL=0x0800;
  public static void Foreground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint t1 = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint t2 = GetWindowThreadProcessId(h, IntPtr.Zero);
    AttachThreadInput(t1, t2, true);
    ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(t1, t2, false);
  }
  public static bool Capture(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = r.Right-r.Left, ht = r.Bottom-r.Top;
    if (w<=0||ht<=0) return false;
    Bitmap b = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(b)) {
      IntPtr hdc=g.GetHdc();
      bool ok = PrintWindow(h, hdc, 2u);
      g.ReleaseHdc(hdc);
      if(!ok) { b.Dispose(); return false; }
    }
    b.Save(path, ImageFormat.Png); b.Dispose();
    return true;
  }
  public static void Click(IntPtr h, int x, int y) {
    RECT r; GetWindowRect(h, out r);
    SetCursorPos(r.Left + x, r.Top + y);
    System.Threading.Thread.Sleep(50);
    mouse_event(MEF_LD, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(MEF_LU, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Wheel(IntPtr h, int x, int y, int notches) {
    RECT r; GetWindowRect(h, out r);
    SetCursorPos(r.Left + x, r.Top + y);
    System.Threading.Thread.Sleep(50);
    mouse_event(MEF_WHEEL, 0, 0, 120*notches, UIntPtr.Zero);
  }
}
"@

[WeChatWindow]::SetProcessDPIAware() | Out-Null

if ($Hwnd -ne 0) {
  $h = [IntPtr]$Hwnd
} else {
  $proc = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
          Select-Object -First 1
  if ($null -eq $proc) { Write-Output "NO WINDOW for $ProcName"; exit 1 }
  $h = $proc.MainWindowHandle
}

$rr = New-Object WeChatWindow+RECT
if (-not [WeChatWindow]::GetWindowRect($h, [ref]$rr)) {
  Write-Output "GetWindowRect failed hwnd=$Hwnd"
  exit 1
}

[WeChatWindow]::Foreground($h)
Start-Sleep -Milliseconds 200

switch ($Cmd) {
  'capture' {
    if ([string]::IsNullOrEmpty($OutPath)) {
      $stamp = (Get-Date -Format 'yyyyMMdd_HHmmss')
      . (Join-Path $PSScriptRoot 'lib\path_config.ps1')
      $cuConfig = Get-ComputerUseConfig
      $OutPath = Join-Path $cuConfig.shotsDirWin "wechat_window_$stamp.png"
    }
    $parent = Split-Path -Parent $OutPath
    if (-not [string]::IsNullOrEmpty($parent)) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (-not [WeChatWindow]::Capture($h, $OutPath)) {
      Write-Output "capture failed hwnd=$Hwnd"
      exit 1
    }
    Write-Output "OK capture hwnd=$h rect=$($rr.Left),$($rr.Top),$($rr.Right),$($rr.Bottom) file=$OutPath"
  }
  'click' {
    if ($X -lt 0 -or $Y -lt 0) { Write-Output "invalid click coords X=$X Y=$Y"; exit 2 }
    [WeChatWindow]::Click($h, $X, $Y)
    Write-Output "OK click hwnd=$h x=$X y=$Y"
  }
  'scroll' {
    if ($X -lt 0 -or $Y -lt 0) { Write-Output "invalid scroll coords X=$X Y=$Y"; exit 2 }
    [WeChatWindow]::Wheel($h, $X, $Y, $Notches)
    Write-Output "OK scroll hwnd=$h x=$X y=$Y notches=$Notches"
  }
}
