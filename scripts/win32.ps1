# ============================================================================
# win32.ps1 -- 모든 Windows 앱에 쓰는 창 단위 기본 도구(JSON 출력).
#   UIA가 없는 앱(사용자 정의 컨트롤, 메신저, 게임)도 창 핸들(hwnd)로 다룬다.
#   원칙: 대상 창을 hwnd로 정확히 고르고, 앞으로 가져온 뒤 실제로 앞에 왔는지 확인한 다음에만 키를 보낸다.
#         앞으로 가져오기에 실패하면 우회하지 않고 FG_FAILED로 알린다(사람이 PC를 쓰는 중일 수 있다).
#
# Commands:
#   list [-Title 정규식] [-Proc 정규식] [-All]   최상위 창 목록(최소화 포함)
#   children -Hwnd N                             자식 컨트롤(클래스·글자·위치)
#   foreground                                   현재 앞에 있는 창
#   front -Hwnd N [-Force]                       앞으로 가져오고 확인(-Force: 맨 위 고정 토글 추가)
#   show -Hwnd N -State restore|minimize|maximize
#   capture -Hwnd N -Out 파일.png [-Restore]     포커스 없이 창 캡처(PrintWindow). 최소화·빈 화면 감지
#   click -Hwnd N -X x -Y y [-Relative] [-Double] [-Right]   확인된 전경 창에만 클릭
#   type -Hwnd N -TextFile 파일                  확인된 전경 창에 붙여넣기(한글 가능)
#   key -Hwnd N -Keys "{ENTER}"                  확인된 전경 창에만 키 전송
#   wheel -Hwnd N -Dir up|down [-Count 칸] [-X x -Y y -Relative]   확인된 전경 창 안에서 마우스 휠
#   gettext -Hwnd N                              컨트롤 글자 읽기(WM_GETTEXT, 실패는 null)
#   vscroll -Hwnd N -Pos bottom|top|pageup|pagedown|lineup|linedown [-Count n]   포커스 없이 세로 스크롤
#   snapshot -TitlePattern 제목 | -TitlePatternFile 목록.txt -OutDir 폴더 [-KeepDays 14]
#                                                예약 실행용: 창이 없거나 최소화면 MISSING 파일 기록
# ============================================================================
param(
  [Parameter(Mandatory = $true)][ValidateSet('list','children','foreground','front','show','capture','click','type','key','wheel','gettext','vscroll','snapshot')][string]$Cmd,
  [long]$Hwnd = 0,
  [string]$Title = '',
  [string]$Proc = '',
  [switch]$All,
  [switch]$Force,
  [ValidateSet('restore','minimize','maximize')][string]$State = 'restore',
  [string]$Out = '',
  [switch]$Restore,
  [int]$X = -1,
  [int]$Y = -1,
  [switch]$Relative,
  [switch]$Double,
  [switch]$Right,
  [string]$TextFile = '',
  [string]$Keys = '',
  [ValidateSet('bottom','top','pageup','pagedown','lineup','linedown')][string]$Pos = 'bottom',
  [ValidateSet('up','down')][string]$Dir = 'down',
  [ValidateRange(1,500)][int]$Count = 1,
  [string]$TitlePattern = '',
  [string]$TitlePatternFile = '',
  [string]$OutDir = '',
  [ValidateRange(1,3650)][int]$KeepDays = 14,
  [string]$StateDir = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = $cuConfig.stateDirWin }

function Out-Json($Value) {
  Write-Output ($Value | ConvertTo-Json -Depth 6 -Compress)
}

if (@('front','show','click','type','key','wheel','vscroll') -contains $Cmd) {
  if (Test-Path (Join-Path $StateDir 'STOP')) { Out-Json ([ordered]@{ ok = $false; code = 'stopped'; error = '중지 파일(state\STOP)이 있어 조작 명령을 거부합니다.' }); exit 9 }
}

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public class CuWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);

  public static List<IntPtr> Top() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static int[] Rect(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return new int[] { 0, 0, 0, 0 }; return new int[] { r.Left, r.Top, r.Right, r.Bottom }; }

  // 같은 최상위 소유 창(대화상자 포함)이 앞에 있으면 전경으로 본다.
  public static bool IsForeground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return false;
    if (fg == h) return true;
    IntPtr a = GetAncestor(fg, 3);
    IntPtr b = GetAncestor(h, 3);
    return a != IntPtr.Zero && a == b;
  }

  public static bool Front(IntPtr h, bool force) {
    if (IsIconic(h)) ShowWindow(h, 9);
    IntPtr fg = GetForegroundWindow();
    uint ignored;
    uint me = GetCurrentThreadId();
    uint fgThread = GetWindowThreadProcessId(fg, out ignored);
    uint target = GetWindowThreadProcessId(h, out ignored);
    bool a1 = fgThread != me && fgThread != 0 && AttachThreadInput(me, fgThread, true);
    bool a2 = target != me && target != 0 && AttachThreadInput(me, target, true);
    BringWindowToTop(h);
    if (force) {
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
      SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    }
    SetForegroundWindow(h);
    if (a1) AttachThreadInput(me, fgThread, false);
    if (a2) AttachThreadInput(me, target, false);
    System.Threading.Thread.Sleep(300);
    if (IsForeground(h) || !force) return IsForeground(h);
    // 강제 모드: 시스템 설정을 바꾸거나 키 입력을 주입하지 않는 방법만 차례로 쓴다.
    SwitchToThisWindow(h, true);
    System.Threading.Thread.Sleep(350);
    if (IsForeground(h)) return true;
    ShowWindow(h, 6);
    System.Threading.Thread.Sleep(150);
    ShowWindow(h, 9);
    System.Threading.Thread.Sleep(400);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(250);
    return IsForeground(h);
  }

  public static string GetText(IntPtr h) {
    IntPtr len;
    if (SendMessageTimeoutW(h, 0x000E, IntPtr.Zero, IntPtr.Zero, 0x0002, 1500, out len) == IntPtr.Zero) return null;
    int n = Math.Max(0, (int)len) + 2;
    var sb = new StringBuilder(n);
    IntPtr copied;
    if (SendMessageTimeoutW(h, 0x000D, new IntPtr(n), sb, 0x0002, 1500, out copied) == IntPtr.Zero) return null;
    return sb.ToString();
  }

  public static void Click(int x, int y, bool dbl, bool right) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    uint down = right ? 0x0008u : 0x0002u;
    uint up = right ? 0x0010u : 0x0004u;
    mouse_event(down, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(30); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    if (dbl) { System.Threading.Thread.Sleep(70); mouse_event(down, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(30); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }

  // PrintWindow(PW_RENDERFULLCONTENT) 캡처. 결과: "w,h,uniformRatio"
  public static string Capture(IntPtr h, string path) {
    RECT r; if (!GetWindowRect(h, out r)) return "error:GetWindowRect";
    int w = r.Right - r.Left; int ht = r.Bottom - r.Top;
    if (w <= 0 || ht <= 0) return "error:size " + w + "x" + ht;
    using (var bmp = new Bitmap(w, ht, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        bool ok = PrintWindow(h, hdc, 2u);
        g.ReleaseHdc(hdc);
        if (!ok) return "error:PrintWindow";
      }
      // 한 가지 색이 대부분이면 빈 화면(검정·흰색) 캡처로 본다.
      var counts = new Dictionary<int, int>();
      int samples = 0;
      int stepX = Math.Max(1, w / 40); int stepY = Math.Max(1, ht / 40);
      for (int yy = 0; yy < ht; yy += stepY) for (int xx = 0; xx < w; xx += stepX) {
        int c = bmp.GetPixel(xx, yy).ToArgb() & 0x00F0F0F0;
        int v; counts.TryGetValue(c, out v); counts[c] = v + 1; samples++;
      }
      int max = 0; foreach (var v in counts.Values) if (v > max) max = v;
      bmp.Save(path, ImageFormat.Png);
      return w + "," + ht + "," + (samples == 0 ? 1.0 : (double)max / samples).ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
    }
  }
}
"@
[void][CuWin]::SetProcessDPIAware()

function Get-ProcName([uint32]$ProcessId) {
  try { return (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-WindowInfo([IntPtr]$H) {
  $r = [CuWin]::Rect($H)
  $procId = [CuWin]::Pid($H)
  return [ordered]@{
    hwnd = [long]$H
    pid = [int]$procId
    proc = Get-ProcName $procId
    title = [CuWin]::Text($H)
    cls = [CuWin]::Cls($H)
    rect = @($r[0], $r[1], $r[2], $r[3])
    w = $r[2] - $r[0]
    h = $r[3] - $r[1]
    visible = [CuWin]::IsWindowVisible($H)
    minimized = [CuWin]::IsIconic($H)
    maximized = [CuWin]::IsZoomed($H)
    foreground = [CuWin]::IsForeground($H)
  }
}

function Require-Hwnd {
  if ($Hwnd -le 0) { Out-Json ([ordered]@{ ok = $false; code = 'no_target'; error = '-Hwnd가 필요합니다. list로 창을 먼저 찾으세요.' }); exit 2 }
  $h = [IntPtr]$Hwnd
  if (-not [CuWin]::IsWindow($h)) { Out-Json ([ordered]@{ ok = $false; code = 'not_found'; error = "창이 없습니다(닫혔거나 핸들이 바뀜): $Hwnd" }); exit 2 }
  return $h
}

function Ensure-Front([IntPtr]$H) {
  if ([CuWin]::IsForeground($H)) { return $true }
  return [CuWin]::Front($H, [bool]$Force)
}

function Fail-Front([IntPtr]$H) {
  $fg = [CuWin]::GetForegroundWindow()
  Out-Json ([ordered]@{
    ok = $false
    code = 'FG_FAILED'
    error = '대상 창을 앞으로 가져오지 못해 입력을 보내지 않았습니다. 사람이 PC를 쓰는 중이면 잠시 뒤 다시 시도하거나, 필요하면 --force를 사용하세요.'
    target = Get-WindowInfo $H
    foreground = if ($fg -ne [IntPtr]::Zero) { Get-WindowInfo $fg } else { $null }
  })
  exit 4
}

switch ($Cmd) {
  'list' {
    $rows = New-Object System.Collections.ArrayList
    foreach ($h in [CuWin]::Top()) {
      if (-not $All -and -not [CuWin]::IsWindowVisible($h)) { continue }
      $t = [CuWin]::Text($h)
      if (-not $All -and [string]::IsNullOrWhiteSpace($t)) { continue }
      $info = Get-WindowInfo $h
      if ($Title -ne '' -and $info.title -notmatch $Title) { continue }
      if ($Proc -ne '' -and $info.proc -notmatch $Proc) { continue }
      [void]$rows.Add($info)
    }
    Out-Json ([ordered]@{ ok = $true; count = $rows.Count; windows = $rows })
  }
  'children' {
    $h = Require-Hwnd
    $rows = New-Object System.Collections.ArrayList
    foreach ($c in [CuWin]::Children($h)) {
      $r = [CuWin]::Rect($c)
      [void]$rows.Add([ordered]@{ hwnd = [long]$c; cls = [CuWin]::Cls($c); text = [CuWin]::Text($c); rect = @($r[0], $r[1], $r[2], $r[3]); visible = [CuWin]::IsWindowVisible($c) })
      if ($rows.Count -ge 400) { break }
    }
    Out-Json ([ordered]@{ ok = $true; parent = [long]$h; count = $rows.Count; children = $rows })
  }
  'foreground' {
    $fg = [CuWin]::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { Out-Json ([ordered]@{ ok = $false; error = '앞에 있는 창이 없습니다.' }); exit 1 }
    Out-Json ([ordered]@{ ok = $true; window = Get-WindowInfo $fg })
  }
  'front' {
    $h = Require-Hwnd
    $ok = Ensure-Front $h
    if (-not $ok) { Fail-Front $h }
    Out-Json ([ordered]@{ ok = $true; code = 'FG_OK'; window = Get-WindowInfo $h })
  }
  'show' {
    $h = Require-Hwnd
    $n = switch ($State) { 'minimize' { 6 } 'maximize' { 3 } default { 9 } }
    [void][CuWin]::ShowWindow($h, $n)
    Start-Sleep -Milliseconds 250
    Out-Json ([ordered]@{ ok = $true; state = $State; window = Get-WindowInfo $h })
  }
  'capture' {
    $h = Require-Hwnd
    if ([string]::IsNullOrWhiteSpace($Out)) { $Out = Join-Path $cuConfig.shotsDirWin ("window_{0}.png" -f (Get-Date -Format 'yyyyMMdd_HHmmss')) }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
    $wasMin = [CuWin]::IsIconic($h)
    if ($wasMin -and -not $Restore) {
      Out-Json ([ordered]@{ ok = $false; code = 'minimized'; error = '창이 최소화되어 있어 캡처하면 빈 조각만 나옵니다. --restore로 잠시 복원해 캡처하거나 창을 연 뒤 다시 시도하세요.'; window = Get-WindowInfo $h })
      exit 3
    }
    if ($wasMin) { [void][CuWin]::ShowWindow($h, 4); Start-Sleep -Milliseconds 500 }
    $res = [CuWin]::Capture($h, $Out)
    if ($wasMin) { [void][CuWin]::ShowWindow($h, 6) }
    if ($res.StartsWith('error:')) { Out-Json ([ordered]@{ ok = $false; code = 'capture_failed'; error = $res.Substring(6); window = Get-WindowInfo $h }); exit 1 }
    $parts = $res.Split(',')
    $w = [int]$parts[0]; $hh = [int]$parts[1]; $uniform = [double]::Parse($parts[2], [System.Globalization.CultureInfo]::InvariantCulture)
    $warnings = @()
    if ($w -lt 120 -or $hh -lt 80) { $warnings += "창 크기가 너무 작습니다(${w}x${hh}). 최소화 조각이거나 접힌 창일 수 있습니다." }
    if ($uniform -ge 0.97) { $warnings += '거의 한 가지 색입니다. 하드웨어 가속 창이면 화면 캡처(see --screen)를 사용하세요.' }
    $r = [CuWin]::Rect($h)
    Out-Json ([ordered]@{ ok = ($warnings.Count -eq 0); file = $Out; w = $w; h = $hh; rect = @($r[0], $r[1], $r[2], $r[3]); uniformRatio = $uniform; restoredForCapture = $wasMin; warnings = $warnings })
    if ($warnings.Count -gt 0) { exit 3 }
  }
  'click' {
    $h = Require-Hwnd
    if ($X -lt 0 -or $Y -lt 0) { Out-Json ([ordered]@{ ok = $false; error = '-X, -Y 좌표가 필요합니다.' }); exit 2 }
    if (-not (Ensure-Front $h)) { Fail-Front $h }
    $r = [CuWin]::Rect($h)
    $sx = $X; $sy = $Y
    if ($Relative) { $sx = $r[0] + $X; $sy = $r[1] + $Y }
    if ($sx -lt $r[0] -or $sx -ge $r[2] -or $sy -lt $r[1] -or $sy -ge $r[3]) {
      Out-Json ([ordered]@{ ok = $false; code = 'outside_window'; error = "클릭 좌표($sx,$sy)가 대상 창 밖입니다. 이웃 창을 누를 수 있어 거부합니다."; rect = @($r[0], $r[1], $r[2], $r[3]) })
      exit 2
    }
    [CuWin]::Click($sx, $sy, [bool]$Double, [bool]$Right)
    Out-Json ([ordered]@{ ok = $true; clicked = @($sx, $sy); double = [bool]$Double; right = [bool]$Right; hwnd = [long]$h })
  }
  'type' {
    $h = Require-Hwnd
    if ([string]::IsNullOrWhiteSpace($TextFile) -or -not (Test-Path -LiteralPath $TextFile)) { Out-Json ([ordered]@{ ok = $false; error = '-TextFile이 필요합니다.' }); exit 2 }
    $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $TextFile
    if (-not (Ensure-Front $h)) { Fail-Front $h }
    $prev = $null
    try { $prev = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
    Set-Clipboard -Value $text
    Start-Sleep -Milliseconds 80
    if (-not [CuWin]::IsForeground($h)) { Fail-Front $h }
    (New-Object -ComObject WScript.Shell).SendKeys('^v')
    Start-Sleep -Milliseconds 200
    if ($null -ne $prev) { try { Set-Clipboard -Value $prev } catch {} }
    Out-Json ([ordered]@{ ok = $true; typedChars = $text.Length; hwnd = [long]$h })
  }
  'key' {
    $h = Require-Hwnd
    if ([string]::IsNullOrWhiteSpace($Keys)) { Out-Json ([ordered]@{ ok = $false; error = '-Keys가 필요합니다. 예: "{ENTER}"'; }); exit 2 }
    if (-not (Ensure-Front $h)) { Fail-Front $h }
    (New-Object -ComObject WScript.Shell).SendKeys($Keys)
    Start-Sleep -Milliseconds 120
    Out-Json ([ordered]@{ ok = $true; keys = $Keys; hwnd = [long]$h })
  }
  'wheel' {
    $h = Require-Hwnd
    if (-not (Ensure-Front $h)) { Fail-Front $h }
    $r = [CuWin]::Rect($h)
    $sx = [int](($r[0] + $r[2]) / 2); $sy = [int](($r[1] + $r[3]) / 2)
    if ($X -ge 0 -and $Y -ge 0) { if ($Relative) { $sx = $r[0] + $X; $sy = $r[1] + $Y } else { $sx = $X; $sy = $Y } }
    if ($sx -lt $r[0] -or $sx -ge $r[2] -or $sy -lt $r[1] -or $sy -ge $r[3]) {
      Out-Json ([ordered]@{ ok = $false; code = 'outside_window'; error = "휠 위치($sx,$sy)가 대상 창 밖입니다."; rect = @($r[0], $r[1], $r[2], $r[3]) })
      exit 2
    }
    [void][CuWin]::SetCursorPos($sx, $sy)
    Start-Sleep -Milliseconds 60
    $delta = 120; if ($Dir -eq 'down') { $delta = -120 }
    for ($i = 0; $i -lt $Count; $i++) { [CuWin]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
    Out-Json ([ordered]@{ ok = $true; hwnd = [long]$h; dir = $Dir; count = $Count; at = @($sx, $sy) })
  }
  'gettext' {
    $h = Require-Hwnd
    $text = [CuWin]::GetText($h)
    Out-Json ([ordered]@{ ok = ($null -ne $text); hwnd = [long]$h; cls = [CuWin]::Cls($h); text = $text; readable = ($null -ne $text) })
    if ($null -eq $text) { exit 1 }
  }
  'vscroll' {
    $h = Require-Hwnd
    $code = switch ($Pos) { 'lineup' { 0 } 'linedown' { 1 } 'pageup' { 2 } 'pagedown' { 3 } 'top' { 6 } default { 7 } }
    for ($i = 0; $i -lt $Count; $i++) {
      [void][CuWin]::PostMessageW($h, 0x0115, [IntPtr]$code, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    [void][CuWin]::PostMessageW($h, 0x0115, [IntPtr]8, [IntPtr]::Zero)
    Out-Json ([ordered]@{ ok = $true; hwnd = [long]$h; pos = $Pos; count = $Count; note = '스크롤 메시지를 보냈습니다. 실제 위치는 캡처나 글자로 확인하세요.' })
  }
  'snapshot' {
    $patterns = New-Object 'System.Collections.Generic.List[string]'
    if (-not [string]::IsNullOrWhiteSpace($TitlePattern)) { $patterns.Add($TitlePattern) }
    if (-not [string]::IsNullOrWhiteSpace($TitlePatternFile)) {
      foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath $TitlePatternFile)) { if (-not [string]::IsNullOrWhiteSpace($line)) { $patterns.Add($line.Trim()) } }
    }
    if ($patterns.Count -eq 0) { Out-Json ([ordered]@{ ok = $false; error = '-TitlePattern 또는 -TitlePatternFile이 필요합니다.' }); exit 2 }
    if ([string]::IsNullOrWhiteSpace($OutDir)) { $OutDir = Join-Path $cuConfig.shotsDirWin 'window-snapshots' }
    $day = Get-Date -Format 'yyyyMMdd'
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $dayDir = Join-Path $OutDir $day
    New-Item -ItemType Directory -Force -Path $dayDir | Out-Null
    $tops = @([CuWin]::Top() | Where-Object { [CuWin]::IsWindowVisible($_) })
    $results = New-Object System.Collections.ArrayList
    foreach ($pattern in $patterns) {
      $safe = ($pattern -replace '[\\/:*?"<>| ]', '_')
      $exact = @($tops | Where-Object { [CuWin]::Text($_) -eq $pattern })
      $hits = if ($exact.Count -gt 0) { $exact } else { @($tops | Where-Object { [CuWin]::Text($_).Contains($pattern) }) }
      if ($hits.Count -ne 1) {
        $why = if ($hits.Count -eq 0) { 'not_open' } else { 'ambiguous' }
        $marker = Join-Path $dayDir ("MISSING_{0}_{1}.txt" -f $safe, $stamp)
        [System.IO.File]::WriteAllText($marker, "$why pattern=$pattern count=$($hits.Count)", (New-Object System.Text.UTF8Encoding $false))
        [void]$results.Add([ordered]@{ pattern = $pattern; ok = $false; reason = $why; marker = $marker })
        continue
      }
      $h = $hits[0]
      if ([CuWin]::IsIconic($h)) {
        $marker = Join-Path $dayDir ("MISSING_{0}_{1}.txt" -f $safe, $stamp)
        [System.IO.File]::WriteAllText($marker, "minimized pattern=$pattern", (New-Object System.Text.UTF8Encoding $false))
        [void]$results.Add([ordered]@{ pattern = $pattern; ok = $false; reason = 'minimized'; marker = $marker })
        continue
      }
      $png = Join-Path $dayDir ("{0}_{1}.png" -f $safe, $stamp)
      $res = [CuWin]::Capture($h, $png)
      if ($res.StartsWith('error:')) {
        [void]$results.Add([ordered]@{ pattern = $pattern; ok = $false; reason = $res })
        continue
      }
      $parts = $res.Split(',')
      $small = ([int]$parts[0] -lt 120 -or [int]$parts[1] -lt 80)
      [void]$results.Add([ordered]@{ pattern = $pattern; ok = (-not $small); file = $png; w = [int]$parts[0]; h = [int]$parts[1]; reason = if ($small) { 'stub_size' } else { '' } })
    }
    # 날짜 폴더(yyyyMMdd)만 보존 기간에 따라 정리한다. 다른 파일은 건드리지 않는다.
    $removed = 0
    Get-ChildItem -LiteralPath $OutDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
      $removed++
    }
    $failed = @($results | Where-Object { -not $_.ok }).Count
    Out-Json ([ordered]@{ ok = ($failed -eq 0); outDir = $dayDir; results = $results; removedOldDays = $removed })
    if ($failed -gt 0) { exit 3 }
  }
}
