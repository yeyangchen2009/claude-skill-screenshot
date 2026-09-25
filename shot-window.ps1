<#
.SYNOPSIS
    截取任意桌面软件窗口（ffmpeg gdigrab），是 cdp-shot.js 的"浏览器外"姊妹工具。

.DESCRIPTION
    cdp-shot.js 走 CDP，只能截浏览器页面；本脚本走 GDI 桌面表面，
    可以截资源管理器、记事本、终端等任意普通 Win32 窗口。

    四个内建处理（都是踩坑踩出来的，见博客番外三）：
    1) Windows Terminal 等 DirectComposition 窗口用 gdigrab title= 直抓只有白底，
       本脚本改抓 desktop 表面再按窗口矩形裁剪；
    2) 高分屏缩放：取窗口坐标前先 SetProcessDPIAware 拿物理像素；
    3) Win11 不可见边框会让矩形超出屏幕，按主屏尺寸裁剪；
    4) SetForegroundWindow 后瞬间 gdigrab 可能报 error 5，自动重新置前重试 3 次。

    已知边界：
    - 最小化/缩到托盘的窗口 MainWindowHandle 会消失，抓不到（先恢复窗口）；
    - GDI 桌面表面对 Mica/亚克力材质（Win11 文件资源管理器主内容区等）
      会抓到透明（直接露出背后窗口），请改用经典 Win32 窗口做目标；
    - 极少数硬件加速应用可能黑屏；只支持主屏（offset 为负的副屏不处理）。

.EXAMPLE
    powershell -File tools/shot-window.ps1 -List
    列出当前所有可抓的窗口标题。

.EXAMPLE
    powershell -File tools/shot-window.ps1 -Title 记事本 -Out note.png
    抓标题包含"记事本"的第一个窗口。

.EXAMPLE
    powershell -File tools/shot-window.ps1 -ProcessName WindowsTerminal -Out term.png
    按进程名抓窗口（标题会动态变化时用这个）。
#>
param(
    [string]$Title,
    [string]$ProcessName,
    [string]$Out = "window-shot.png",
    [switch]$List,
    [switch]$NoForeground
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinApiShot {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

# 必须在任何窗口 API 之前声明：否则系统按 DPI 缩放返回逻辑坐标，
# 而 gdigrab 按物理像素抓取，裁剪区会整体偏移缩小
[WinApiShot]::SetProcessDPIAware() | Out-Null

$windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }

if ($List) {
    $windows | Select-Object ProcessName, Id, MainWindowTitle | Format-Table -AutoSize -Wrap
    return
}

if (-not $Title -and -not $ProcessName) {
    Write-Error "Need -Title <keyword> or -ProcessName <name>. Use -List to see windows."
    exit 2
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "ffmpeg not found in PATH."
    exit 2
}

$cands = $windows
if ($ProcessName) { $cands = $cands | Where-Object { $_.ProcessName -ieq $ProcessName } }
if ($Title)       { $cands = $cands | Where-Object { $_.MainWindowTitle -like "*$Title*" } }
$cands = @($cands)

if ($cands.Count -eq 0) {
    Write-Error "No window matched (Title=$Title ProcessName=$ProcessName). Use -List."
    exit 1
}
$p = $cands[0]
if ($cands.Count -gt 1) {
    Write-Host "[warn] $($cands.Count) windows matched, using: $($p.MainWindowTitle)"
} else {
    Write-Host "[info] target: $($p.ProcessName) :: $($p.MainWindowTitle)"
}

# SW_RESTORE=9 防最小化；提到前台，确保桌面表面上有真实画面。
# 注意：桌面表面只能抓到 z-order 最上层，窗口被遮挡时会抓到遮挡者，所以必须置前。
if (-not $NoForeground) {
    [WinApiShot]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
    [WinApiShot]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 1200
}

$r = New-Object WinApiShot+Rect
[WinApiShot]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null

# 主屏边界 clamp（SM_CXSCREEN=0, SM_CYSCREEN=1）
$screenW = [WinApiShot]::GetSystemMetrics(0)
$screenH = [WinApiShot]::GetSystemMetrics(1)
$left = [Math]::Max(0, $r.Left)
$top  = [Math]::Max(0, $r.Top)
$w = [Math]::Min($r.Right - $left, $screenW - $left)
$h = [Math]::Min($r.Bottom - $top, $screenH - $top)
if ($w -le 0 -or $h -le 0) {
    Write-Error "Bad window rect ($left,$top ${w}x${h}); is the window minimized or on a secondary monitor?"
    exit 1
}
Write-Host "[info] crop: offset=($left,$top) ${w}x${h}, screen=${screenW}x${screenH}"

# gdigrab 直抓 title= 对 DirectComposition 窗口（如 Windows Terminal）只有白底，
# 所以统一抓 desktop 表面再按矩形裁剪；-update 1 让单帧输出到固定文件名。
# SetForegroundWindow 之后的瞬间桌面 DC 偶尔被锁（gdigrab 报 error 5），重试即可。
# PowerShell 5.1 在 Stop 模式下会把原生命令的 stderr warning 包装成终止错误，
# 而 ffmpeg/gdigrab 必然往 stderr 吐 probesize 之类提示，所以调用段临时切回 Continue，
# 只信 $LASTEXITCODE。
$code = 1
$prevEAP = $ErrorActionPreference
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $ErrorActionPreference = 'Continue'
    & ffmpeg -y -hide_banner -loglevel error `
        -f gdigrab -framerate 1 -rtbufsize 100M `
        -offset_x $left -offset_y $top -video_size "${w}x${h}" `
        -i desktop -frames:v 1 -update 1 $Out 2>$null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($code -eq 0 -and (Test-Path $Out)) { break }
    Write-Host "[warn] capture attempt $attempt failed (exit $code), retrying..."
    if (-not $NoForeground) {
        [WinApiShot]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    }
    Start-Sleep -Milliseconds 1500
}

if ($code -eq 0 -and (Test-Path $Out)) {
    $fi = Get-Item $Out
    Write-Host "[ok] saved: $($fi.FullName) ($([Math]::Round($fi.Length/1kb)) KB)"
} else {
    Write-Error "ffmpeg failed after 3 attempts (exit $code)"
    exit $code
}
