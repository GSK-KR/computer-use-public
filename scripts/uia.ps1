# ============================================================================
# uia.ps1 -- general Windows UI Automation engine for the computer-use agent.
#   Generalizes probe_uia_kakao.ps1 into a reusable read/find/act tool.
#   UIA is the preferred channel: when an app exposes its
#   tree, we get accurate element text + SCREEN-pixel coords WITHOUT focus, and
#   can run buttons via InvokePattern WITHOUT moving the mouse. Vision/OCR is
#   the fallback for apps that don't (KakaoTalk = EVA custom, games, canvas).
#
#   All code is ASCII (no BOM trap). Output is UTF-8 (Korean element names ok).
#   No ConvertTo-Json (PS5.1 throws) -- JSON is built by hand.
#
# Target selectors (combine freely; AND semantics):
#   -Proc  <regex>   match by process name   (e.g. Notepad, chrome, Calc)
#   -Title <regex>   match by window title    (e.g. '계산기', 'Calculator')
#   -ProcId <int>    match by exact pid
#
# Commands:
#   list                              top-level windows (proc,pid,title,rect,class)
#   tree   [-Depth N] [-View v]       indented element tree w/ bbox + patterns
#   read   [-View v]                  flat text dump of the window (no focus)
#   find   -Query <rx> [-By f]        JSON of matching elements (+screen center)
#   invoke -Query <rx> [-By f] [-Index i]   run element: Invoke>Toggle>Select, else NEEDCLICK cx,cy
#   toggle -Query <rx> [-By f]        TogglePattern.Toggle()
#   settext -Query <rx> -Text <s>     ValuePattern.SetValue (focus first)
#   focus  -Query <rx> [-By f]        SetFocus on element (then caller can type)
#
#   -By  : name (default, regex on Name) | autoid (regex on AutomationId) | type (regex on ControlType)
#   -View: control (default) | content (read default) | raw
# ============================================================================
param(
  [Parameter(Mandatory=$true)][string]$Cmd,
  [string]$Proc = '',
  [string]$Title = '',
  [int]$ProcId = 0,
  [string]$Query = '',
  [string]$Text = '',
  [string]$TextFile = '',
  [string]$Expected = '',
  [string]$ExpectedFile = '',
  [ValidateSet('name','autoid','type')][string]$By = 'name',
  [ValidateSet('control','content','raw')][string]$View = '',
  [int]$Depth = 16,
  [int]$Max = 5000,
  [int]$Index = 0,
  [switch]$Json,
  [switch]$All,
  [string]$StateDir = ''
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
. (Join-Path $PSScriptRoot 'lib\path_config.ps1')
$cuConfig = Get-ComputerUseConfig
if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = $cuConfig.stateDirWin }

# STOP gate only matters for acting commands.
if (@('invoke','toggle','settext','focus') -contains $Cmd) {
  if (Test-Path (Join-Path $StateDir 'STOP')) { Write-Output "STOPPED: state\STOP present (Ctrl+Alt+Q). Clear it to resume."; exit 9 }
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public class UiaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
public class UiaFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static void Front(IntPtr h){
    IntPtr fg=GetForegroundWindow();
    uint t1=GetWindowThreadProcessId(fg,IntPtr.Zero); uint t2=GetWindowThreadProcessId(h,IntPtr.Zero);
    AttachThreadInput(t1,t2,true); ShowWindow(h,9); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(t1,t2,false);
  }
}
"@
[void][UiaDpi]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$A = [System.Windows.Automation.AutomationElement]
$W = [System.Windows.Automation.TreeWalker]

# pick walker
if ($View -eq '') { if ($Cmd -eq 'read') { $View = 'content' } else { $View = 'control' } }
switch ($View) {
  'raw'     { $walker = $W::RawViewWalker }
  'content' { $walker = $W::ContentViewWalker }
  default   { $walker = $W::ControlViewWalker }
}

# ---- pattern ids ----
$P_Invoke = [System.Windows.Automation.InvokePattern]::Pattern
$P_Value  = [System.Windows.Automation.ValuePattern]::Pattern
$P_Toggle = [System.Windows.Automation.TogglePattern]::Pattern
$P_Expand = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
$P_SelItm = [System.Windows.Automation.SelectionItemPattern]::Pattern
$patList  = @(@('Invoke',$P_Invoke),@('Value',$P_Value),@('Toggle',$P_Toggle),@('Expand',$P_Expand),@('Select',$P_SelItm))

function Get-Pat($el, $patId) { $o = $null; if ($el.TryGetCurrentPattern($patId, [ref]$o)) { return $o }; return $null }
function Pats($el) {
  $r = New-Object System.Collections.Generic.List[string]
  foreach ($pp in $patList) { $o = $null; if ($el.TryGetCurrentPattern($pp[1], [ref]$o)) { $r.Add($pp[0]) } }
  return $r
}

function JsonEsc([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('\','\\').Replace('"','\"').Replace("`r",'').Replace("`n",'\n').Replace("`t",'\t')
}

function Prop($el, [string]$which) {
  $v = ''
  try {
    switch ($which) {
      'name'   { $v = [string]$el.Current.Name }
      'ct'     { $v = [string]$el.Current.ControlType.ProgrammaticName; $v = $v -replace '^ControlType\.','' }
      'cls'    { $v = [string]$el.Current.ClassName }
      'autoid' { $v = [string]$el.Current.AutomationId }
    }
  } catch {}
  if ($null -eq $v) { $v = '' }
  return $v
}

# element value text via ValuePattern, else TextPattern (read-only docs)
function Get-ElText($el) {
  $t = ''
  $vp = Get-Pat $el $P_Value
  if ($vp) { try { $t = [string]$vp.Current.Value } catch {} }
  if ([string]::IsNullOrEmpty($t)) {
    $o = $null
    try { if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { $t = [string]$o.DocumentRange.GetText(2000) } } catch {}
  }
  if ($null -eq $t) { $t = '' }
  return $t
}

# rect -> screen ints; returns $null if offscreen / empty
function RectOf($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { return $null }
    if ($r.Width -le 0 -or $r.Height -le 0) { return $null }
    return @{ l=[int][math]::Round($r.X); t=[int][math]::Round($r.Y); w=[int][math]::Round($r.Width); h=[int][math]::Round($r.Height) }
  } catch { return $null }
}

# ---- resolve target top-level windows ----
$pidset = @{}
if ($ProcId -gt 0) { $pidset[$ProcId] = $true }
elseif ($Proc -ne '') {
  foreach ($p in @(Get-Process | Where-Object { $_.ProcessName -match $Proc })) { $pidset[$p.Id] = $true }
}
$havePidFilter = ($pidset.Count -gt 0)

function Get-TopWindows {
  $root = $A::RootElement
  $cw   = $W::ControlViewWalker
  $res  = New-Object System.Collections.Generic.List[object]
  $c = $cw.GetFirstChild($root)
  while ($null -ne $c) {
    $cpid = 0; try { $cpid = [int]$c.Current.ProcessId } catch {}
    $tn = ''; try { $tn = [string]$c.Current.Name } catch {}
    $okPid   = (-not $havePidFilter) -or $pidset.ContainsKey($cpid)
    $okTitle = ($Title -eq '') -or ($tn -match $Title)
    # by default skip offscreen/minimized top windows (phantom UWP frames etc.)
    $onscr   = $All -or ((RectOf $c) -ne $null)
    if ($okPid -and $okTitle -and $onscr) { $res.Add($c) }
    $c = $cw.GetNextSibling($c)
  }
  return $res
}

# ---- LIST ----
if ($Cmd -eq 'list') {
  $root = $A::RootElement
  $cw   = $W::ControlViewWalker
  $rows = New-Object System.Collections.Generic.List[string]
  $c = $cw.GetFirstChild($root)
  while ($null -ne $c) {
    $cpid = 0; try { $cpid = [int]$c.Current.ProcessId } catch {}
    $tn = ''; try { $tn = [string]$c.Current.Name } catch {}
    $cl = ''; try { $cl = [string]$c.Current.ClassName } catch {}
    $pn = ''; try { $pn = (Get-Process -Id $cpid -ErrorAction SilentlyContinue).ProcessName } catch {}
    $hw = 0; try { $hw = [int]$c.Current.NativeWindowHandle } catch {}
    $okPid   = (-not $havePidFilter) -or $pidset.ContainsKey($cpid)
    $okTitle = ($Title -eq '') -or ($tn -match $Title)
    if (($okPid -and $okTitle) -and ($tn.Trim().Length -gt 0 -or -not $havePidFilter)) {
      $rc = RectOf $c
      if ($Json) {
        $rj = if ($rc) { "{`"l`":$($rc.l),`"t`":$($rc.t),`"w`":$($rc.w),`"h`":$($rc.h)}" } else { 'null' }
        $rows.Add("{`"proc`":`"$(JsonEsc $pn)`",`"pid`":$cpid,`"hwnd`":$hw,`"title`":`"$(JsonEsc $tn)`",`"cls`":`"$(JsonEsc $cl)`",`"rect`":$rj}")
      } else {
        $rs = if ($rc) { "$($rc.l),$($rc.t) $($rc.w)x$($rc.h)" } else { 'offscreen' }
        $rows.Add(("{0,-22} pid={1,-7} hwnd={2,-9} [{3}] {4}" -f $pn, $cpid, $hw, $rs, $tn))
      }
    }
    $c = $cw.GetNextSibling($c)
  }
  if ($Json) { Write-Output ('[' + ($rows -join ',') + ']') }
  else { foreach ($r in $rows) { Write-Output $r } ; [Console]::Error.WriteLine("WINDOWS: " + $rows.Count) }
  exit 0
}

$targets = Get-TopWindows
if ($targets.Count -eq 0) { Write-Output "NO WINDOW matching proc=/$Proc/ title=/$Title/ pid=$ProcId"; exit 1 }

# ---- FRONT (bring target window to foreground; works for Win32 + UWP via NativeWindowHandle) ----
if ($Cmd -eq 'front') {
  $t = $targets[0]
  $h = [IntPtr]([int]$t.Current.NativeWindowHandle)
  if ($h -eq [IntPtr]::Zero) { Write-Output "NO HWND for target (proc=/$Proc/ title=/$Title/)"; exit 1 }
  [UiaFg]::Front($h)
  Start-Sleep -Milliseconds 350
  $rc = RectOf $t
  if ($rc) { Write-Output "FRONT hwnd=$h rect=$($rc.l),$($rc.t),$($rc.l + $rc.w),$($rc.t + $rc.h)" }
  else     { Write-Output "FRONT hwnd=$h rect=unknown" }
  exit 0
}

# ---- matcher ----
function Matches($el) {
  if ($Query -eq '') { return $true }
  switch ($By) {
    'name'   { return ((Prop $el 'name')   -match $Query) }
    'autoid' { return ((Prop $el 'autoid') -match $Query) }
    'type'   { return ((Prop $el 'ct')     -match $Query) }
  }
  return $false
}

# ---- TREE (indented, human/agent readable) ----
if ($Cmd -eq 'tree') {
  $script:nodes = 0
  $lines = New-Object System.Collections.Generic.List[string]
  function WalkTree($el, $lvl) {
    if ($null -eq $el -or $script:nodes -ge $Max) { return }
    $script:nodes++
    $name = Prop $el 'name'; $ct = Prop $el 'ct'; $aid = Prop $el 'autoid'; $cls = Prop $el 'cls'
    $rc = RectOf $el
    $ind = ('  ' * $lvl)
    $dn = $name; if ($dn.Length -gt 80) { $dn = $dn.Substring(0,80) + [char]0x2026 }
    $line = "$ind[$ct] `"$dn`""
    if ($aid -ne '') { $line += " #$aid" }
    if ($cls -ne '') { $line += " ($cls)" }
    if ($rc)         { $line += " @$($rc.l),$($rc.t) $($rc.w)x$($rc.h)" } else { $line += " @offscreen" }
    $pl = Pats $el
    if ($pl.Count -gt 0) { $line += " {" + ($pl -join ',') + "}" }
    $tx = Get-ElText $el
    if ($tx.Trim().Length -gt 0) { $dt = $tx.Trim(); if ($dt.Length -gt 60) { $dt = $dt.Substring(0,60) + [char]0x2026 }; $line += " =`"$dt`"" }
    $lines.Add($line)
    if ($lvl -ge $Depth) { return }
    try {
      $ch = $walker.GetFirstChild($el)
      while ($null -ne $ch) { WalkTree $ch ($lvl+1); if ($script:nodes -ge $Max) { break }; $ch = $walker.GetNextSibling($ch) }
    } catch {}
  }
  foreach ($t in $targets) {
    $tn = Prop $t 'name'
    $lines.Add("########## WINDOW pid=$([int]$t.Current.ProcessId) `"$tn`" ##########")
    WalkTree $t 0
  }
  foreach ($l in $lines) { Write-Output $l }
  [Console]::Error.WriteLine("NODES: $($script:nodes) (cap $Max)")
  exit 0
}

# ---- READ (flat text content of window, no focus) ----
if ($Cmd -eq 'read') {
  $script:nodes = 0
  $seen = New-Object System.Collections.Generic.List[string]
  $lastAdded = ''
  function WalkRead($el, $lvl) {
    if ($null -eq $el -or $script:nodes -ge $Max) { return }
    $script:nodes++
    $tx = Get-ElText $el
    if ([string]::IsNullOrEmpty($tx.Trim())) { $tx = Prop $el 'name' }
    $tx = ($tx -replace '\s+', ' ').Trim()
    if ($tx.Length -gt 0 -and $tx -ne $script:lastAdded) { $seen.Add($tx); $script:lastAdded = $tx }
    if ($lvl -ge $Depth) { return }
    try {
      $ch = $walker.GetFirstChild($el)
      while ($null -ne $ch) { WalkRead $ch ($lvl+1); if ($script:nodes -ge $Max) { break }; $ch = $walker.GetNextSibling($ch) }
    } catch {}
  }
  foreach ($t in $targets) { WalkRead $t 0 }
  foreach ($s in $seen) { Write-Output $s }
  [Console]::Error.WriteLine("LINES: $($seen.Count) NODES: $($script:nodes)")
  exit 0
}

# ---- collect matches (find/invoke/toggle/settext/focus) ----
$script:nodes = 0
$hits = New-Object System.Collections.Generic.List[object]
function WalkFind($el, $lvl) {
  if ($null -eq $el -or $script:nodes -ge $Max) { return }
  $script:nodes++
  if (Matches $el) { $hits.Add($el) }
  if ($lvl -ge $Depth) { return }
  try {
    $ch = $walker.GetFirstChild($el)
    while ($null -ne $ch) { WalkFind $ch ($lvl+1); if ($script:nodes -ge $Max) { break }; $ch = $walker.GetNextSibling($ch) }
  } catch {}
}
foreach ($t in $targets) { WalkFind $t 0 }

# ---- FIND (JSON) ----
if ($Cmd -eq 'find') {
  $rows = New-Object System.Collections.Generic.List[string]
  $i = 0
  foreach ($el in $hits) {
    $name = Prop $el 'name'; $ct = Prop $el 'ct'; $aid = Prop $el 'autoid'; $cls = Prop $el 'cls'
    $rc = RectOf $el
    $off = if ($rc) { 'false' } else { 'true' }
    $cx = if ($rc) { $rc.l + [int]($rc.w/2) } else { -1 }
    $cy = if ($rc) { $rc.t + [int]($rc.h/2) } else { -1 }
    $l=if($rc){$rc.l}else{-1}; $tt=if($rc){$rc.t}else{-1}; $w=if($rc){$rc.w}else{-1}; $h=if($rc){$rc.h}else{-1}
    $pl = Pats $el
    $pj = '[' + (($pl | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']'
    $rows.Add("{`"idx`":$i,`"name`":`"$(JsonEsc $name)`",`"type`":`"$(JsonEsc $ct)`",`"autoid`":`"$(JsonEsc $aid)`",`"cls`":`"$(JsonEsc $cls)`",`"l`":$l,`"t`":$tt,`"w`":$w,`"h`":$h,`"cx`":$cx,`"cy`":$cy,`"off`":$off,`"pat`":$pj}")
    $i++
  }
  Write-Output ('[' + ($rows -join ',') + ']')
  [Console]::Error.WriteLine("HITS: $($hits.Count) NODES: $($script:nodes)")
  exit 0
}

# ---- ASSERT (read-back verification: does a matched element's text match -Expected regex?) ----
if ($Cmd -eq 'assert') {
  if (-not [string]::IsNullOrEmpty($ExpectedFile)) { $Expected = Get-Content -Raw -Encoding UTF8 $ExpectedFile }
  $Expected = $Expected.TrimEnd("`r","`n")
  if ($hits.Count -eq 0) { Write-Output "MISMATCH notfound -By $By -Query /$Query/ want=/$Expected/"; exit 1 }
  $pool = @($hits | Where-Object { (RectOf $_) -ne $null }); if ($pool.Count -eq 0) { $pool = @($hits) }
  $gotAll = New-Object System.Collections.Generic.List[string]
  foreach ($el in $pool) {
    $tx = Get-ElText $el; if ([string]::IsNullOrEmpty($tx)) { $tx = Prop $el 'name' }
    $tx = ($tx -replace '\s+', ' ').Trim()
    $gotAll.Add($tx)
    if ($tx -match $Expected) { Write-Output "VERIFIED got=[$tx] ~ /$Expected/"; exit 0 }
  }
  Write-Output ("MISMATCH got=[" + ($gotAll -join ' | ') + "] want=/$Expected/"); exit 1
}

# acting commands need a chosen element
if ($hits.Count -eq 0) { Write-Output "NO MATCH for -By $By -Query /$Query/ (nodes=$($script:nodes))"; exit 2 }
# prefer onscreen match at requested Index among onscreen; fallback to raw Index
$onscreen = @($hits | Where-Object { (RectOf $_) -ne $null })
$pool = if ($onscreen.Count -gt 0) { $onscreen } else { @($hits) }
if ($Index -ge $pool.Count) { $Index = 0 }
$target = $pool[$Index]
$tName = Prop $target 'name'; $tCt = Prop $target 'ct'
$rc = RectOf $target
$cx = if ($rc) { $rc.l + [int]($rc.w/2) } else { -1 }
$cy = if ($rc) { $rc.t + [int]($rc.h/2) } else { -1 }

if ($Cmd -eq 'focus') {
  try { $target.SetFocus(); Write-Output "OK focus [$tCt] `"$tName`" cx=$cx cy=$cy" } catch { Write-Output "FOCUS FAIL: $($_.Exception.Message) cx=$cx cy=$cy" }
  exit 0
}

if ($Cmd -eq 'settext') {
  if (-not [string]::IsNullOrEmpty($TextFile)) { $Text = Get-Content -Raw -Encoding UTF8 $TextFile }
  $vp = Get-Pat $target $P_Value
  if ($null -eq $vp) { Write-Output "NOVALUE [$tCt] `"$tName`" has no ValuePattern. Use: focus then 'type'. cx=$cx cy=$cy"; exit 3 }
  try { $target.SetFocus() } catch {}
  try { $vp.SetValue($Text); Write-Output "OK settext [$tCt] `"$tName`" <= `"$Text`"" } catch { Write-Output "SETTEXT FAIL: $($_.Exception.Message)"; exit 3 }
  exit 0
}

if ($Cmd -eq 'toggle') {
  $tp = Get-Pat $target $P_Toggle
  if ($null -eq $tp) { Write-Output "NOTOGGLE [$tCt] `"$tName`" cx=$cx cy=$cy"; exit 3 }
  try { $tp.Toggle(); Write-Output "OK toggle [$tCt] `"$tName`" -> $($tp.Current.ToggleState)" } catch { Write-Output "TOGGLE FAIL: $($_.Exception.Message)"; exit 3 }
  exit 0
}

if ($Cmd -eq 'invoke') {
  $ip = Get-Pat $target $P_Invoke
  if ($ip) { try { $ip.Invoke(); Write-Output "OK invoke [$tCt] `"$tName`" cx=$cx cy=$cy"; exit 0 } catch { Write-Output "INVOKE FAIL: $($_.Exception.Message)"; exit 3 } }
  $tp = Get-Pat $target $P_Toggle
  if ($tp) { try { $tp.Toggle(); Write-Output "OK toggle [$tCt] `"$tName`" -> $($tp.Current.ToggleState)"; exit 0 } catch {} }
  $sp = Get-Pat $target $P_SelItm
  if ($sp) { try { $sp.Select(); Write-Output "OK select [$tCt] `"$tName`""; exit 0 } catch {} }
  # no actionable pattern -> tell caller to mouse-click the center (cu will do it)
  if ($cx -ge 0) { Write-Output "NEEDCLICK [$tCt] `"$tName`" cx=$cx cy=$cy" ; exit 10 }
  Write-Output "NOACTION [$tCt] `"$tName`" no pattern, no rect"; exit 3
}

Write-Output "unknown cmd: $Cmd (list|tree|read|find|invoke|toggle|settext|focus)"
exit 1
