# ============================================================================
# act.ps1 — desktop input primitives (mouse/keyboard) for the agent loop.
#   Screen-absolute coords, DPI-aware. Korean text via clipboard paste.
#   -Proc <name>: bring that window to front FIRST, in THIS same process
#                 (atomic foreground+act -> terminal can't reclaim focus between).
#   Honors state\STOP (Ctrl+Alt+Q via hud.ps1): refuses to act if STOP exists.
#
# Commands:
#   move|click|dblclick|rightclick  -X <sx> -Y <sy>   (pointer; coords required >=0)
#   type   -Text "..." | -TextFile <utf8 path>        (paste into focused field)
#   key    -Keys "{ENTER}" | "^a" | "%{F4}" ...
#   scroll -Dir up|down -Notches N [-X <sx> -Y <sy>]
# ============================================================================
param(
  [Parameter(Mandatory=$true)][string]$Cmd,
  [int]$X = -1, [int]$Y = -1,
  [string]$Text = '',
  [string]$TextFile = '',
  [string]$Keys = '',
  [ValidateSet('up','down')][string]$Dir = 'up',
  [int]$Notches = 3,
  [string]$Proc = '',
  [string]$StateDir = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = $cuConfig.stateDirWin }

# --- STOP gate (Ctrl+Alt+Q) ---
$stopFile = Join-Path $StateDir 'STOP'
if (Test-Path $stopFile) { Write-Output "STOPPED: state\STOP present (Ctrl+Alt+Q). Clear it to resume."; exit 9 }

Add-Type @"
using System; using System.Runtime.InteropServices;
public class InpAct {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,int d,UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public const uint MEF_LD=0x0002, MEF_LU=0x0004, MEF_RD=0x0008, MEF_RU=0x0010, MEF_WHEEL=0x0800;
  public static void Front(IntPtr h){
    IntPtr fg=GetForegroundWindow();
    uint t1=GetWindowThreadProcessId(fg,IntPtr.Zero); uint t2=GetWindowThreadProcessId(h,IntPtr.Zero);
    AttachThreadInput(t1,t2,true); ShowWindow(h,9); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(t1,t2,false);
  }
}
"@
[void][InpAct]::SetProcessDPIAware()

# --- atomic foreground of target (same process, right before acting) ---
if ($Proc -ne '') {
  $p = Get-Process -Name $Proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($null -eq $p) { Write-Output "NO WINDOW for $Proc"; exit 1 }
  [InpAct]::Front($p.MainWindowHandle)
  Start-Sleep -Milliseconds 250
}

function MoveTo($x,$y) { if ($x -ge 0 -and $y -ge 0) { [void][InpAct]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 40 } }
function LClick { [InpAct]::mouse_event([InpAct]::MEF_LD,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 20; [InpAct]::mouse_event([InpAct]::MEF_LU,0,0,0,[UIntPtr]::Zero) }
$sh = New-Object -ComObject WScript.Shell

# coord guard for pointer actions
if (@('move','click','dblclick','rightclick') -contains $Cmd) {
  if ($X -lt 0 -or $Y -lt 0) { Write-Output "REFUSED ${Cmd}: invalid coords X=$X Y=$Y (need >=0; locate target first)"; exit 2 }
}

switch ($Cmd) {
  'move'       { MoveTo $X $Y }
  'click'      { MoveTo $X $Y; LClick }
  'dblclick'   { MoveTo $X $Y; LClick; Start-Sleep -Milliseconds 70; LClick }
  'rightclick' { MoveTo $X $Y; [InpAct]::mouse_event([InpAct]::MEF_RD,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 20; [InpAct]::mouse_event([InpAct]::MEF_RU,0,0,0,[UIntPtr]::Zero) }
  'type' {
    if (-not [string]::IsNullOrEmpty($TextFile)) { $Text = Get-Content -Raw -Encoding UTF8 $TextFile }
    $prev = $null; try { $prev = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 80
    $sh.SendKeys('^v')
    Start-Sleep -Milliseconds 150
    if ($null -ne $prev) { try { Set-Clipboard -Value $prev } catch {} }
  }
  'key'        { $sh.SendKeys($Keys) }
  'scroll'     { $d = 120*$Notches; if ($Dir -eq 'down') { $d = -$d }; MoveTo $X $Y; [InpAct]::mouse_event([InpAct]::MEF_WHEEL,0,0,$d,[UIntPtr]::Zero) }
  default      { Write-Output "unknown cmd: $Cmd (move|click|dblclick|rightclick|type|key|scroll)"; exit 1 }
}
Write-Output "OK $Cmd X=$X Y=$Y proc=$Proc"
