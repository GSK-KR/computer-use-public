# ============================================================================
# kakao_window.ps1 — exact-window capture/action primitives for KakaoTalk.
#   Used by kakao_openchat_scrape.sh so a visible comment button can be clicked
#   immediately while that scroll position is still on screen.
#
# Usage:
#   powershell -File kakao_window.ps1 capture -Hwnd 123 -OutPath C:\...\frame.png
#   powershell -File kakao_window.ps1 scroll  -Hwnd 123 -Notches 8 -Fx 0.5 -Fy 0.45
#   powershell -File kakao_window.ps1 click   -Hwnd 123 -X 1000 -Y 500
#   powershell -File kakao_window.ps1 key     -Hwnd 123 -Keys "{ESC}"
# ============================================================================
param(
  [Parameter(Mandatory=$true)][ValidateSet('list','rect','front','capture','scroll','click','doubleclick','key')][string]$Cmd,
  [long]$Hwnd = 0,
  [string]$ProcName = 'KakaoTalk',
  [string]$Title = '',
  [string]$OutPath = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Notches = 8,
  [double]$Fx = 0.5,
  [double]$Fy = 0.5,
  [string]$Keys = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
public class KakaoWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll", EntryPoint="GetWindowThreadProcessId")] public static extern uint GetWindowThreadProcessId2(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public const uint MEF_LD=0x0002, MEF_LU=0x0004, MEF_WHEEL=0x0800;
  public const int SW_RESTORE = 9;
  public static void Foreground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint t1 = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint t2 = GetWindowThreadProcessId(h, IntPtr.Zero);
    AttachThreadInput(t1, t2, true);
    ShowWindow(h, SW_RESTORE); BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(t1, t2, false);
  }
  public static string RectString(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return "";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }
  public static string WindowTitle(IntPtr h) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    StringBuilder sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string[] ListWindows(string procName, string titleFilter) {
    HashSet<uint> pids = new HashSet<uint>(
      Process.GetProcessesByName(procName).Select(p => (uint)p.Id)
    );
    List<string> lines = new List<string>();
    IntPtr foreground = GetForegroundWindow();
    EnumWindows(delegate(IntPtr wh, IntPtr lp) {
      if (!IsWindowVisible(wh)) return true;
      uint pid; GetWindowThreadProcessId2(wh, out pid);
      if (!pids.Contains(pid)) return true;
      string title = WindowTitle(wh);
      string rect = RectString(wh);
      if (String.IsNullOrEmpty(title) || String.IsNullOrEmpty(rect)) return true;
      if (!String.IsNullOrEmpty(titleFilter) &&
          title.IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0) return true;
      lines.Add("WINDOW hwnd=" + wh.ToInt64() + " pid=" + pid + " rect=" + rect + " foreground=" + (wh == foreground) + " title=" + title);
      return true;
    }, IntPtr.Zero);
    return lines.ToArray();
  }
  public static IntPtr FindWindow(string procName, string titleFilter) {
    HashSet<uint> pids = new HashSet<uint>(
      Process.GetProcessesByName(procName).Select(p => (uint)p.Id)
    );
    IntPtr exact = IntPtr.Zero, contains = IntPtr.Zero, largest = IntPtr.Zero;
    long largestArea = -1;
    EnumWindows(delegate(IntPtr wh, IntPtr lp) {
      if (!IsWindowVisible(wh)) return true;
      uint pid; GetWindowThreadProcessId2(wh, out pid);
      if (!pids.Contains(pid)) return true;
      string title = WindowTitle(wh);
      RECT rect;
      if (String.IsNullOrEmpty(title) || !GetWindowRect(wh, out rect)) return true;
      int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
      if (width <= 0 || height <= 0 || rect.Left <= -30000 || rect.Top <= -30000) return true;
      if (!String.IsNullOrEmpty(titleFilter)) {
        if (String.Equals(title, titleFilter, StringComparison.OrdinalIgnoreCase)) exact = wh;
        else if (contains == IntPtr.Zero && title.IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) >= 0) contains = wh;
        return true;
      }
      long area = (long)width * height;
      if (area > largestArea) { largestArea = area; largest = wh; }
      return true;
    }, IntPtr.Zero);
    if (exact != IntPtr.Zero) return exact;
    if (contains != IntPtr.Zero) return contains;
    return largest;
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
      if (!ok) { b.Dispose(); return false; }
    }
    b.Save(path, ImageFormat.Png); b.Dispose();
    return true;
  }
  public static void Wheel(IntPtr h, int notches, double fx, double fy) {
    RECT r; GetWindowRect(h, out r);
    int x = (int)(r.Left + (r.Right - r.Left)*fx);
    int y = (int)(r.Top + (r.Bottom - r.Top)*fy);
    SetCursorPos(x, y);
    mouse_event(MEF_WHEEL, 0, 0, 120*notches, UIntPtr.Zero);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(MEF_LD, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(25);
    mouse_event(MEF_LU, 0, 0, 0, UIntPtr.Zero);
  }
  public static void DoubleClick(int x, int y) {
    Click(x, y);
    System.Threading.Thread.Sleep(80);
    Click(x, y);
  }
}
"@

[KakaoWin]::SetProcessDPIAware() | Out-Null

function Resolve-Hwnd {
  if ($Hwnd -ne 0) { return [IntPtr]$Hwnd }
  $resolved = [KakaoWin]::FindWindow($ProcName, $Title)
  if ($resolved -eq [IntPtr]::Zero -and $Title -eq '카카오톡') {
    $resolved = [KakaoWin]::FindWindow($ProcName, 'KakaoTalk')
  }
  if ($resolved -eq [IntPtr]::Zero) { Write-Output "NO WINDOW proc=$ProcName title=$Title"; exit 1 }
  return $resolved
}

if ($Cmd -eq 'list') {
  $lines = [KakaoWin]::ListWindows($ProcName, $Title)
  if ($lines.Count -eq 0) { Write-Output "NO WINDOWS proc=$ProcName title=$Title"; exit 1 }
  $lines | ForEach-Object { Write-Output $_ }
  exit 0
}

$h = Resolve-Hwnd
if (-not [KakaoWin]::IsWindow($h)) {
  Write-Output "INVALID_WINDOW hwnd=$h proc=$ProcName title=$Title"
  exit 1
}
if ($Cmd -ne 'rect') {
  [KakaoWin]::Foreground($h)
  Start-Sleep -Milliseconds 180
}

$rect = [KakaoWin]::RectString($h)
switch ($Cmd) {
  'rect' {
    Write-Output "RECT hwnd=$h rect=$rect"
  }
  'front' {
    Write-Output "FRONT hwnd=$h rect=$rect"
  }
  'capture' {
    if ([string]::IsNullOrEmpty($OutPath)) {
      $stamp = (Get-Date -Format 'yyyyMMdd_HHmmss')
      . (Join-Path $PSScriptRoot 'lib\path_config.ps1')
      $cuConfig = Get-ComputerUseConfig
      $OutPath = Join-Path $cuConfig.shotsDirWin "kakao_$stamp.png"
    }
    $ok = [KakaoWin]::Capture($h, $OutPath)
    if (-not $ok) { Write-Output "CAPTURE_FAILED hwnd=$h rect=$rect file=$OutPath"; exit 1 }
    Write-Output "CAPTURE hwnd=$h rect=$rect file=$OutPath"
  }
  'scroll' {
    [KakaoWin]::Wheel($h, $Notches, $Fx, $Fy)
    Write-Output "SCROLL hwnd=$h rect=$rect notches=$Notches fx=$Fx fy=$Fy"
  }
  'click' {
    if ($X -lt 0 -or $Y -lt 0) { Write-Output "REFUSED click invalid coords X=$X Y=$Y"; exit 2 }
    [KakaoWin]::Click($X, $Y)
    Write-Output "CLICK hwnd=$h rect=$rect x=$X y=$Y"
  }
  'doubleclick' {
    if ($X -lt 0 -or $Y -lt 0) { Write-Output "REFUSED doubleclick invalid coords X=$X Y=$Y"; exit 2 }
    [KakaoWin]::DoubleClick($X, $Y)
    Write-Output "DOUBLECLICK hwnd=$h rect=$rect x=$X y=$Y"
  }
  'key' {
    if ([string]::IsNullOrEmpty($Keys)) { Write-Output "REFUSED key empty Keys"; exit 2 }
    $sh = New-Object -ComObject WScript.Shell
    $sh.SendKeys($Keys)
    Write-Output "KEY hwnd=$h rect=$rect keys=$Keys"
  }
}
