# ============================================================================
# fg_title.ps1 — print the FOREGROUND window's title + process (UTF-8).
#   Used as the see-before-act gate: confirm the focused window is the intended
#   target before sending keystrokes.
#   Output: FG_TITLE=<title> / FG_PROC=<proc> / FG_PID=<pid>
# ============================================================================
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Title() { var h=GetForegroundWindow(); var sb=new StringBuilder(1024); GetWindowText(h,sb,1024); return sb.ToString(); }
  public static uint Pid() { var h=GetForegroundWindow(); uint p; GetWindowThreadProcessId(h, out p); return p; }
}
"@

$t = [Fg]::Title()
$procId = [Fg]::Pid()
$pname = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
Write-Output ("FG_TITLE=" + $t)
Write-Output ("FG_PROC=" + $pname)
Write-Output ("FG_PID=" + $procId)
