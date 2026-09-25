# ui-shot.ps1 - drive a user's already-logged-in browser window via Win32
# UI automation and grab it with ffmpeg gdigrab. No debug port, no restart,
# no credentials: it only sends keystrokes/clicks to a window the user owns.
#
# SAFETY: this script clicks exactly where you tell it to. Never aim it at
# submit/commit/publish buttons (Create repository, Submit issue, Run
# workflow, Unpublish, Delete...). Expanding dropdowns, toggling a label on a
# draft issue, clicking empty page areas and Ctrl+W on tabs you opened are
# safe. Restore the session afterwards (CloseTab x N, ZoomReset, F11).
#
# Requirements: ffmpeg on PATH; PowerShell 5.1+ (run with -NoProfile -File).
#
# Examples (replace <substr> with a stable positive substring of your own
# window title, e.g. your logged-in username):
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> -Info
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> -EnterFullscreen
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> `
#       -Url 'https://github.com/<owner>/<repo>/settings/pages' -EnsureFs -Out page.png -Settle 9000
#   # inspect page.png, then click a dropdown at physical pixel (673,434):
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> `
#       -EnsureFs -ClickX 673 -ClickY 434 -Out page-open.png
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> -ZoomReset
#   powershell -NoProfile -File ui-shot.ps1 -WindowTitle <substr> -CloseTab
#
# Locate the target window by ONE of:
#   -Hwnd <int64>          explicit top-level window handle
#   -WindowTitle <substr>  POSITIVE substring match against a visible top-level
#                          window owned by -ProcessName (use something stable
#                          like the logged-in username; NEVER an exclusion rule,
#                          other tabs' titles change without notice)
# Handle is cached in ui-hwnd-<proc>.txt next to this script and reused while
# still visible.
param(
    [string]$ProcessName = 'msedge',
    [string]$WindowTitle = '',
    [int64]$Hwnd = 0,
    [string]$BrowserExe = '',
    [string]$Url = '',
    [string]$Out = '',
    [int]$Settle = 7000,
    [int]$ClickX = -1,
    [int]$ClickY = -1,
    [string]$Paste = '',
    [string]$PasteFile = '',
    [switch]$ClearField,
    [int]$ZoomOut = 0,
    [switch]$ZoomReset,
    [switch]$EnsureFs,
    [switch]$Info,
    [switch]$CloseTab,
    [switch]$EnterFullscreen,
    [switch]$ExitFullscreen
)
$ErrorActionPreference = 'Continue'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Ui {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint flags, IntPtr e);
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    public static IntPtr Find(uint pid, string include) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            string t = sb.ToString();
            if (t.Length > 0 && t.Contains(include)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static uint GetWindowThread(IntPtr h) {
        uint pid;
        return GetWindowThreadProcessId(h, out pid);
    }
    // relative mouse motion: dx/dy are signed but the P/Invoke signature is uint
    public static void MoveRel(int dx, int dy) {
        mouse_event(0x0001, unchecked((uint)dx), unchecked((uint)dy), 0, IntPtr.Zero);
    }
    // a background process often loses a plain SetForegroundWindow call;
    // attach to the foreground thread's input queue first
    public static void ForceForeground(IntPtr h) {
        if (IsIconic(h)) ShowWindow(h, 9);
        IntPtr fg = GetForegroundWindow();
        uint curTid = GetWindowThread(fg);
        uint tgtTid = GetWindowThread(h);
        if (curTid != tgtTid) {
            AttachThreadInput(curTid, tgtTid, true);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            AttachThreadInput(curTid, tgtTid, false);
        } else {
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
    }
}
"@

function Send-CtrlKey([byte]$vk, [int]$times = 1) {
    [Ui]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)   # VK_CONTROL down
    Start-Sleep -Milliseconds 60
    for ($i = 0; $i -lt $times; $i++) {
        [Ui]::keybd_event($vk, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [Ui]::keybd_event($vk, 0, 2, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 90
    }
    [Ui]::keybd_event(0x11, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 500
}
function Send-F11 {
    [Ui]::keybd_event(0x7A, 0, 0, [IntPtr]::Zero)   # VK_F11
    Start-Sleep -Milliseconds 80
    [Ui]::keybd_event(0x7A, 0, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 1300
}

[Ui]::SetProcessDPIAware() | Out-Null

# --- locate the target top-level window -------------------------------------
$hwndFile = Join-Path $PSScriptRoot ("ui-hwnd-{0}.txt" -f $ProcessName)
$h = [IntPtr]::Zero
if ($Hwnd -gt 0) {
    $h = [IntPtr]$Hwnd
} else {
    if (-not $WindowTitle) { throw 'Provide -Hwnd or -WindowTitle <substring>' }
    $proc = Get-Process $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { throw "No running process named '$ProcessName' with a window" }
    if (Test-Path $hwndFile) { $h = [IntPtr][int64](Get-Content $hwndFile -First 1).Trim() }
    if ($h -eq [IntPtr]::Zero -or -not [Ui]::IsWindowVisible($h)) {
        # several browser windows share one process; EnumWindows lists them
        # all, so pick by a POSITIVE title substring (see header warning)
        $h = [Ui]::Find([uint32]$proc.Id, $WindowTitle)
        if ($h -eq [IntPtr]::Zero) { throw "Window titled like '$WindowTitle' not found in $ProcessName" }
        Set-Content -Path $hwndFile -Value $h.ToInt64() -Encoding ascii
    }
}
Write-Host "[info] target hwnd=$h"

if ([Ui]::IsIconic($h)) { [Ui]::ShowWindow($h, 9) | Out-Null }
[Ui]::ForceForeground($h)
Start-Sleep -Milliseconds 1000

$screenW = [Ui]::GetSystemMetrics(0)
$screenH = [Ui]::GetSystemMetrics(1)

function Get-WinRect {
    $r = New-Object Ui+Rect
    [Ui]::GetWindowRect($h, [ref]$r) | Out-Null
    return $r
}
# F11 fullscreen means: covers the screen AND has no caption/thick frame.
# A maximized window with an auto-hidden taskbar also covers the screen, so a
# rectangle test alone lies.
function Test-Fullscreen {
    $r = Get-WinRect
    $style = [Ui]::GetWindowLong($h, -16)   # GWL_STYLE
    $covers = ($r.Left -le 0 -and $r.Top -le 0 -and $r.Right -ge $screenW -and $r.Bottom -ge $screenH)
    $noFrame = -not ($style -band 0x00C00000) -and -not ($style -band 0x00040000)
    return ($covers -and $noFrame)
}

if ($Info) {
    $r = Get-WinRect
    $style = [Ui]::GetWindowLong($h, -16)
    $cn = New-Object System.Text.StringBuilder 256
    [Ui]::GetClassName($h, $cn, 256) | Out-Null
    $fg = [Ui]::GetForegroundWindow()
    $fgTitle = New-Object System.Text.StringBuilder 256
    [Ui]::GetWindowText($fg, $fgTitle, 256) | Out-Null
    Write-Host ("[info] rect=({0},{1},{2},{3}) screen={4}x{5}" -f $r.Left,$r.Top,$r.Right,$r.Bottom,$screenW,$screenH)
    Write-Host ("[info] style=0x{0:X8} CAPTION={1} THICKFRAME={2} MAXIMIZE={3} POPUP={4} fullscreen={5} class={6}" -f $style, ([bool]($style -band 0x00C00000)), ([bool]($style -band 0x00040000)), ([bool]($style -band 0x01000000)), ([bool]($style -band 0x80000000)), (Test-Fullscreen), $cn.ToString())
    Write-Host ("[info] foreground={0} '{1}'" -f $fg, $fgTitle.ToString())
    exit 0
}

$isFullscreen = Test-Fullscreen

if ($EnterFullscreen -or $ExitFullscreen) {
    $wantFull = [bool]$EnterFullscreen
    if ($isFullscreen -eq $wantFull) {
        Write-Host "[ok] already in desired state (fullscreen=$isFullscreen)"
    } else {
        Send-F11
        Write-Host "[ok] F11 toggled -> fullscreen=$wantFull"
    }
    exit 0
}

if ($ZoomReset) {
    Send-CtrlKey 0x30 1   # VK_0 -> Ctrl+0: zoom back to 100%
    Write-Host '[ok] zoom reset'
    exit 0
}

if ($Url) {
    # Do NOT fake Ctrl+L / Ctrl+V / Enter with SendKeys: Chromium can swallow
    # the whole sequence silently. Delegating the URL on the command line to
    # the running browser instance reliably opens a new foreground tab.
    $exe = $BrowserExe
    if (-not $exe) {
        if ($ProcessName -eq 'msedge') {
            $candidates = @(
                'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
                'C:\Program Files\Microsoft\Edge\Application\msedge.exe')
        } else {
            $candidates = @(
                'C:\Program Files\Google\Chrome\Application\chrome.exe',
                'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe')
        }
        $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $exe -or -not (Test-Path $exe)) { throw "Browser executable not found; pass -BrowserExe" }
    Start-Process -FilePath $exe -ArgumentList $Url
    Write-Host "[info] new tab: $Url"
    Start-Sleep -Milliseconds $Settle
}

if ($CloseTab) {
    Send-CtrlKey 0x57 1   # VK_W -> Ctrl+W: close the active tab
    Write-Host '[ok] tab closed'
    exit 0
}

# a command-line new tab knocks Edge/Chrome out of F11 fullscreen; re-check
# and re-enter it, then click empty page space once so the fullscreen top
# chrome (tab strip / address bar slide-down) actually hides
if ($EnsureFs) {
    if (Test-Fullscreen) {
        Write-Host '[ok] still fullscreen'
    } else {
        [Ui]::ForceForeground($h)
        Start-Sleep -Milliseconds 400
        Send-F11
        Write-Host '[ok] re-entered fullscreen after navigation'
    }
}

[Ui]::ForceForeground($h)
Start-Sleep -Milliseconds 400

if ($ZoomOut -gt 0) {
    Send-CtrlKey 0xBD $ZoomOut   # OEM_MINUS -> Ctrl+- (2 clicks = 80%)
    Write-Host "[info] zoom out x$ZoomOut"
    Start-Sleep -Milliseconds 400
}

if ($ClickX -ge 0 -and $ClickY -ge 0) {
    # IMPORTANT: shoot a layout image first and measure coordinates from it;
    # blind clicks can land on links/buttons you never meant to touch
    [Ui]::SetCursorPos($ClickX, $ClickY) | Out-Null
    Start-Sleep -Milliseconds 300
    [Ui]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
    Start-Sleep -Milliseconds 100
    [Ui]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
    Write-Host "[info] clicked ($ClickX,$ClickY)"
    Start-Sleep -Milliseconds 1800
    [Ui]::ForceForeground($h)
    Start-Sleep -Milliseconds 400
}

if ($ClearField) {
    # Focus first (pass -ClickX/-ClickY); then select all and delete.
    Send-CtrlKey 0x41 1   # VK_A -> Ctrl+A
    Start-Sleep -Milliseconds 200
    [Ui]::keybd_event(0x2E, 0, 0, [IntPtr]::Zero)   # VK_DELETE down
    [Ui]::keybd_event(0x2E, 0, 2, [IntPtr]::Zero)   # VK_DELETE up
    Write-Host "[info] field cleared"
    Start-Sleep -Milliseconds 300
}

if ($PasteFile) {
    # Multi-line draft bodies: load the whole file (UTF-8) into the clipboard.
    Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 $PasteFile)
    Start-Sleep -Milliseconds 400
    Send-CtrlKey 0x56 1   # VK_V -> Ctrl+V
    Write-Host "[info] pasted file: $PasteFile"
    Start-Sleep -Milliseconds 700
}
elseif ($Paste) {
    # e.g. a Chinese draft title: clipboard paste bypasses the IME entirely.
    # The field must already have focus (issue title field does by default).
    Set-Clipboard -Value $Paste
    Start-Sleep -Milliseconds 400
    Send-CtrlKey 0x56 1   # VK_V -> Ctrl+V
    Write-Host "[info] pasted: $Paste"
    Start-Sleep -Milliseconds 600
}

# Action-only invocations (paste/click/keys without a frame) end here.
if (-not $Out) {
    Write-Host "[ok] action-only run, no screenshot"
    return
}

# park the cursor at the bottom (away from the top chrome) before shooting
[Ui]::SetCursorPos($screenW / 2, $screenH - 60) | Out-Null
Start-Sleep -Milliseconds 500
$r = Get-WinRect
$left = [Math]::Max(0, $r.Left)
$top  = [Math]::Max(0, $r.Top)
$w = [Math]::Min($r.Right - $left, $screenW - $left)
$hgt = [Math]::Min($r.Bottom - $top, $screenH - $top)
Write-Host "[info] crop ($left,$top) ${w}x${hgt}"

# gdigrab: shoot the DWM-composited desktop surface and crop to the window;
# title= cannot capture DirectComposition windows. If the frame comes back
# fully black (surface rebuild right after a tab switch), wait and re-shoot.
& ffmpeg -y -hide_banner -loglevel error -f gdigrab -framerate 1 -rtbufsize 100M `
    -offset_x $left -offset_y $top -video_size "${w}x${hgt}" `
    -i desktop -frames:v 1 -update 1 $Out
Write-Host "[ok] $Out exit=$LASTEXITCODE"
