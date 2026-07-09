# ============================================================================
# foreground.ps1 <ProcName> — bring a window to the front (and report its rect).
#   Needed before BitBlt capture (capture_region) and before clicking, so the
#   target is unoccluded and clicks land on it.
#   Output: FRONT <proc> rect=L,T,R,B
# ============================================================================
param([Parameter(Mandatory=$true)][string]$ProcName)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Fgr {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public const int SW_RESTORE=9;
  public static void Front(IntPtr h){
    IntPtr fg=GetForegroundWindow();
    uint t1=GetWindowThreadProcessId(fg,IntPtr.Zero);
    uint t2=GetWindowThreadProcessId(h,IntPtr.Zero);
    AttachThreadInput(t1,t2,true);
    ShowWindow(h,SW_RESTORE); BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(t1,t2,false);
  }
}
"@
$p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($null -eq $p) { Write-Output "NO WINDOW for $ProcName"; exit 1 }
$h = $p.MainWindowHandle
[Fgr]::Front($h)
Start-Sleep -Milliseconds 350
$r = New-Object Fgr+RECT
[void][Fgr]::GetWindowRect($h, [ref]$r)
Write-Output "FRONT $ProcName rect=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)"
