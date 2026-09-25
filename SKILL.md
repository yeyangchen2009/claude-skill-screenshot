---
name: screenshot
description: 在 Windows 机器上截图/截屏时使用。两类目标两条路径——浏览器内页面（网页、GitHub、本地站点、元素级取景）走 cdp-shot.js（CDP 无头浏览器）；浏览器外（任意软件窗口、终端、文件夹、桌面区域）走 shot-window.ps1（ffmpeg gdigrab）。触发词：截图、截屏、拍一张、窗口图、屏幕、网页截图、screenshot。
---

# 截图手册（Windows 11 · 本机）

本 skill 已**自包含**，脚本就在当前目录（标准安装位置 `~/.claude/skills/screenshot/`，即 `%USERPROFILE%\.claude\skills\screenshot`），换电脑整包拷走即可用。**第一次在新机器上使用，先读仓库根目录 README.md 的「克隆后配置清单」。**
- `shot-window.ps1` —— 浏览器外窗口截图（ffmpeg gdigrab，148 行）
- `ui-shot.ps1` —— 借用户已登录的浏览器窗口拍登录态页面（Win32 UI 自动化，见路径 C）
- `cdp-shot.js` —— 浏览器内页面截图（Node ≥22 内置 WebSocket，零 npm 依赖）
- `primer-21.0.7.css` —— 仅截本站 Gmeek 页面时给 headless 本地应答用

依赖：ffmpeg 在 PATH、Node ≥22、基于 Chromium 的浏览器（默认探测 Edge/Chrome 的标准安装路径；其他位置用 `--browser` 或环境变量 `CDP_BROWSER` 指定）。

## 决策树

```
要截的东西在浏览器里？
├─ 是
│   ├─ 页面要登录态，且用户明确同意借他已登录的日常浏览器窗口
│   │   → 路径 C：ui-shot.ps1（Win32 UI 自动化，不开调试端口、不碰凭据）
│   └─ 其他（公开网页/GitHub/本地服务/元素取景/模拟手机或暗色）
│       → cdp-shot.js
└─ 否（终端、资源管理器、桌面软件、文件夹、桌面任意区域）
    → shot-window.ps1（窗口）或 ffmpeg -i desktop（全屏/区域）
```

## 路径 A：窗口截图（shot-window.ps1）

```bash
# 1) 先列窗口，拿到 ProcessName 或标题
powershell -NoProfile -File ~/.claude/skills/screenshot/shot-window.ps1 -List
# 2) 按进程名抓（首选：标题会动态变化，进程名稳定）
powershell -NoProfile -File ~/.claude/skills/screenshot/shot-window.ps1 -ProcessName cmd -Out out.png
#    或按标题模糊匹配：-Title 关键字；不切前台：-NoForeground
```

脚本已内建：DPI 感知、屏幕边界 clamp、置前后 error 5 自动重试 3 次、`-framerate 1 -rtbufsize 100M`。

**目标窗口选择（重要）：**
- 首选经典 Win32 程序：conhost（`conhost.exe cmd.exe /k ...` 起独立经典控制台）、Notepad++ 等，一次一个准。
- **想跑 PowerShell 演示脚本别直接 `Start-Process powershell`**：本机默认终端是 Windows Terminal，会把新窗劫持成你正在用的 WT 里的一个新标签，污染现场。要显式 `Start-Process conhost -ArgumentList 'powershell.exe','-NoProfile','-NoExit','-File','x.ps1'` 才起独立经典控制台。误开进 WT 的子进程按其 PID 精确杀（`Get-CimInstance Win32_Process` 用 CommandLine 匹配脚本名，注意别把查询命令自身算进去）。
- **Win11 经典控制台用 shot-window.ps1 直抓会左切约 8px**（GetWindowRect 隐形边框外扩量在左/上不对称，标题栏图标和首行首字符被切掉）。可靠替代：`ffmpeg` 抓全屏 desktop，再用 **DWM 扩展框**取物理几何后 PIL 裁剪——`DwmGetWindowAttribute(h, 9 /*DWMWA_EXTENDED_FRAME_BOUNDS*/, out RECT, sz)`（比 GetWindowRect 大约一倍 DPI 边框量，实测 GetWindowRect 992×471 而 DWM 1470×697）。上缘圆角外阴影会带 1–2px 桌面残影，裁剪起点再内收 2px；右、下贴 DWM 边界杜绝背后窗口穿帮。
- **经典控制台演示脚本自身的两个设置坑**：先 `$ui.WindowSize=(120,26)` 再 `$ui.BufferSize=(120,26)`（缓冲与窗口等高），顺序反了或缓冲更高会出现水平/垂直滚动条吃掉首行首字符；缓冲高给 5000 这种值会超本机控制台上限直接报错。开头 `Clear-Host` 去掉 PowerShell 欢迎语噪音。**PS 5.1 用 Get-Content 读 UTF-8 数据文件（CLAUDE.md/MEMORY.md 等）必须显式 `-Encoding UTF8`**，否则按 GBK 解析中文乱码（这条管"读的数据文件"；脚本自身中文仍靠存 UTF-8 BOM 解决）。
- Windows Terminal、Win11 文件资源管理器主内容区、部分 UWP/XAML 界面是 DirectComposition/Mica 合成表面，GDI 抓取表现飘忽（纯黑、纯白+鼠标、或内容区透明露出背后窗口）；"设置"窗口却正常。看到怪图**先重拍一次**，不行就换经典窗口。
- 新版记事本寄宿在 Windows Terminal 标签页里，不要拿它当"普通窗口"演示目标。
- 最小化/缩到托盘的窗口 `MainWindowHandle` 消失，`-List` 里都看不到——先人工恢复，或脚本内 ShowWindow(9)。
- `-NoForeground` 抓到的是桌面最上层画面：目标被遮挡时会拍到遮挡者，仅在窗口已无遮挡时使用。

**全屏 / 自由区域（不经过 ps1）：**
```bash
ffmpeg -y -f gdigrab -framerate 1 -rtbufsize 100M -i desktop -frames:v 1 -update 1 full.png
# 区域裁剪：加 -offset_x N -offset_y N -video_size WxH（物理像素，矩形不得越屏）
```
ffmpeg 7 抓单帧**必须** `-update 1`，否则报图像序列模板错误。

**若要写新的 PowerShell 抓屏脚本，四个坑一个都不能省：**
1. 任何窗口 API 之前先 `SetProcessDPIAware()`：150% 缩放下非感知进程拿到逻辑坐标（本机 1280×720 vs 物理 1920×1080，恰为 ÷1.5），裁剪区整体偏左上。
2. `GetWindowRect` 含 Win11 不可见边框，右下会越界（实测下溢 8px），用 `GetSystemMetrics(0/1)` clamp。
3. 抓取前 `ShowWindow(SW_RESTORE=9)` + `SetForegroundWindow` + 等约 1.2s；error 5（ACCESS_DENIED）是前台动画锁 DC，重新置前重试即可。
4. gdigrab `title=` 是**全等匹配**（不是子串），且 DComp 窗口抓不到内容——统一抓 desktop 表面按矩形裁，别走 title=。
5. PowerShell 5.1 环境：含中文的 ps1 **必须存 UTF-8 with BOM**（否则按 GBK 解析，中文注释会污染 here-string/C# 块）；`$ErrorActionPreference='Stop'` 会把 ffmpeg 的 stderr warning 包装成终止错误，调用原生命令段临时切 `'Continue'`，只信 `$LASTEXITCODE`。

## 路径 B：浏览器页面截图（cdp-shot.js）

```bash
node ~/.claude/skills/screenshot/cdp-shot.js <url> <out.png> <width> <height> [选项]
# 常用选项：
#   --theme dark              写 localStorage(meek_theme=dark) 后重载（Gmeek 站）
#   --scheme dark             模拟 prefers-color-scheme（未登录 GitHub 等跟随系统的站点）
#   --scale 2                 高清（默认 2）
#   --full                    整页
#   --eval '<JS返回{x,y,width,height}>'  按元素矩形取景
#   --click '<selector>'      先点击（如手机端 ☰）
#   --settle 6500             渲染等待（GitHub 新版页骨架屏要 6–9 秒）
#   --css ~/.claude/skills/screenshot/primer-21.0.7.css --css-match '*Primer*primer.css*'
#                             headless 本站南科大镜像 primer.css 拉取失败时本地应答（必须两个参数成对）
#   --profile-dir Temp/prof  持久浏览器 profile（跨次保留登录 cookie，退出不删）
#   --proxy 127.0.0.1:<端口> 走指定 HTTP 代理（默认直连；Clash/v2ray 等 TUN 关了或 headless 不走系统代理时用）
#   --headed                 有头模式；--keep-open --done-flag <f> 截图后保活，标志文件出现才退出
```

**登录态页面的规矩（重要）：**
- **绝不代用户输账号密码/过 2FA**。需要登录的页面（设置页、建仓表单、后台）有三条路：请用户在自己日常浏览器里手动截图；经用户明确同意后用 `--profile-dir + --headed` 让用户自己在弹出的窗口登录一次；或用户日常浏览器已登录且明确同意你代操作时，走**路径 C（ui-shot.ps1）**直接借那个窗口拍。
- 用户不想当场操作时用**占位图工作法**：写一个暗色 HTML 卡片（虚线框+"配图待补"徽章+保存路径/目标 URL/画面要素/注意事项，多条数据用 `?i=N` 切换），cdp-shot 截 `file:///` 生成占位图先上线，文件名就定成最终目标名；用户补拍后替换同名文件，正文零改动。占位卡 HTML 放在工作项目的 `Temp/`（gitignore）目录，随用随写。
- node 的 headed 保活进程**不要用 run_in_background 启动**（会静默 exit 0、stderr 被吞）；用 `powershell Start-Process node -ArgumentList ... -WorkingDirectory ... -WindowStyle Minimized` 完全脱离 shell。
- Edge 全新 `--user-data-dir` 首启会弹"正在所有设备同步浏览数据"系统账户模态，挡住页面与自动化；专用实例与日常 Edge 靠 user-data-dir 隔离（无扩展，可据此辨认）。
- GitHub 注册页 `/signup` 对代理机房 IP 会直接"访问暂时受限"，这类页面放弃自动拍摄。

- 元素取景 eval 里**只取 `getBoundingClientRect()` + `scrollY` 绝对坐标，不要先 scrollIntoView**（会双重偏移）；`captureBeyondViewport` 无需真滚动。
- 手机视口用 390×844（≤1249 是本站断点）。
- GitHub 2026 新版页面：评论在 shadow DOM + 虚拟滚动，元素 clip 不可靠，统一截首屏视口（1440×1150，`--settle 6500`）。
- Git Bash 会把 `/post/26.html` 这类参数转义成 Windows 路径，命令前加 `MSYS_NO_PATHCONV=1`。
- 浏览器路径可用 `CDP_BROWSER` 环境变量覆盖。

### 重型运行时（mermaid 等）：别用固定 settle 赌

页面里的 mermaid 图靠运行时 JS 渲染，而本站 `mermaid.min.js` 约 **3.5MB，冷连接首下曾实测 60–90 秒**（curl 连接复用显示的 0.0002s 是假象）。固定 `--settle`（哪怕 25s）经常等不到；更坑的是自动加载器检测到图块会**先把源码 `<pre>` 节点移除**、库加载完才渲染——于是库没到时画面不是"显示代码"而是**一片空白**（`window.mermaid===undefined`、源码节点也没了）。正确打法：

1. **第一次用 `--profile-dir <dir>` 暖缓存**，之后同 profile 复用，3.5MB 走缓存秒开；
2. 不猜秒数，用 `--eval` 传**轮询 Promise，等到目标真出现再截**（返回非矩形时工具照常截视口/整页）：
   ```bash
   node ~/.claude/skills/screenshot/cdp-shot.js <url> out.png 1200 900 --scheme dark --full \
     --profile-dir Temp/prof --settle 5000 \
     --eval "new Promise(r=>{let n=0;const t=setInterval(()=>{n++;if(document.querySelector('[data-processed] svg')){clearInterval(t);r(1)}else if(n>220){clearInterval(t);r(0)}},500)})"
   ```
3. **判断图到底有没有渲染，不必读坐标**：整页 `--full` 截图的像素高度会随图渲染而增加（实测 12000→12960），对比有无即可；或 eval 里 `JSON.stringify` 诊断信息塞进一个红底浮层再截视口。
4. **mermaid 图型选择（本站 v11.17.2，文章页默认亮色）**：`sequenceDiagram` 的信号文字是浅色原生 `<text>`、**天生没有底色盒**，透明 SVG 透白页后不可读；加 `signalTextColor/labelBoxBkgColor` 等 directive 变量实测**无效**（v11 信号文本不吃这套）。`flowchart TD` 的节点是不透明深色填充、边标签有 `edgeLabelBackground` 深底盒，亮暗页面都清晰——**示意图优先 flowchart TD，慎用 sequenceDiagram**。

### 改图/改复杂前端：先本地 file:// 预检，再推线上

改 mermaid（或任何要靠构建才看得到效果的前端）时，"编辑 issue → 等 1–2 分钟构建 → 暖缓存重拍"一轮很贵。先在 `Temp/` 建一个单 HTML，引**本地** `mermaid.min.js`，用 cdp-shot 截 `file:///.../Temp/x.html`，语法和配色都对了再推线上。注意 **v11 UMD 不会自动初始化**，必须显式：
```html
<script src="mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:false});mermaid.run({querySelector:'.mermaid'}).catch(e=>document.title='ERR '+e.message);</script>
```
渲染失败时标签页标题会变成 `ERR ...`，截图里一眼可见（本地库可从线上 curl 一份放 Temp/，均 gitignore）。

### 第三方登录态 iframe：无头别死等，直接借窗

utterances 评论框、分享、登录挂件这类**跨站 iframe**，即使外层 URL `curl 200`，无头浏览器里也常卡在 loading（cookie/指纹/网络抖动），轮询再久也未必出。**不要在无头里耗**：公开但带登录按钮的外壳能截就截，真正的登录态内容直接走下面的**路径 C 借用户已登录窗口**。

## 路径 C：登录态页面，借用户日常浏览器（ui-shot.ps1）

**前提：用户明确同意**（如"我在用的 Edge 已登录，你自己去操作截图"）。适合建仓表单、Settings、issues/new 这类必须登录、专用 profile 又要重新登录/过设备验证的页面。不开 `--remote-debugging-port`、不重启浏览器、不碰凭据。

运行时脚本会在自己旁边写 `ui-hwnd-<进程名>.txt` 句柄缓存（已在 .gitignore 内）。定位窗口三选一：`-WindowTitle <稳定子串>`（默认在 msedge 进程里正向匹配，也可 `-ProcessName chrome`）、`-Hwnd <int64>`。标准序列：

```bash
UI=~/.claude/skills/screenshot/ui-shot.ps1
WT='-WindowTitle','<窗口标题里的稳定子串>'      # 例：登录后页面上显示的你的用户名；务必正向特征
powershell -NoProfile -File $UI @WT -Info                       # 先看 rect/style/fullscreen/前台标题
powershell -NoProfile -File $UI @WT -EnterFullscreen            # F11 全屏（幂等：已全屏不重复按）
# 导航=命令行委派新标签 + EnsureFs 自动补回全屏；先拍布局图，绝不盲点
powershell -NoProfile -File $UI @WT -Url '<url>' -EnsureFs -Out a.png -Settle 9000
# Read a.png 量好物理像素坐标后，再点开下拉/勾选，拍第二次
powershell -NoProfile -File $UI @WT -EnsureFs -ClickX 673 -ClickY 434 -Out b.png
# 长表单：-ZoomOut 2（Ctrl+- 两次到 80%）；中文文字：-Paste '中文'（剪贴板+Ctrl+V 绕 IME）
# 收尾：复位缩放、Ctrl+W 逐个关掉新开的标签、-Info 核验现场
powershell -NoProfile -File $UI @WT -ZoomReset
powershell -NoProfile -File $UI @WT -CloseTab   # 开了几个新标签就执行几次
```

参数：`-ProcessName`（默认 msedge）、`-BrowserExe`、`-WindowTitle`、`-Hwnd`、`-Url/-Out/-Settle/-ClickX/-ClickY/-Paste/-ZoomOut/-ZoomReset/-EnsureFs/-CloseTab/-EnterFullscreen/-ExitFullscreen/-Info`。权威脚本头部注释含完整 SAFETY 边界。

**一个坑都不能省（实测）：**
1. **多窗口定位**：同一 msedge.exe 多个窗口共享进程，`Get-Process` 只给一个 MainWindowHandle；脚本用 EnumWindows+GetWindowThreadProcessId 枚举同 PID 全部顶层窗口，标题用**正向包含**（如用户名）。**不要用排除法**——另一窗口的活动标签标题随时会变，曾因"不含 Anki"选错窗口把 F11 按到无关页面上。
2. **置前**：后台进程裸 SetForegroundWindow 常被拒，脚本用 AttachThreadInput+BringWindowToTop 包装。
3. **导航不要用 SendKeys 的 ^l/^v/~**（实测整段静默失效）；`Start-Process msedge.exe '<url>'` 会委派给现有实例新开前台标签（先 ForceForeground 保证落在目标窗口）。
4. **全屏判定看样式不只看 rect**：GetWindowRect 铺满 + GWL_STYLE 无 WS_CAPTION/WS_THICKFRAME 才算 F11（任务栏自动隐藏时最大化窗口也铺满，会骗过 rect 判断）。命令行新开标签会把 Edge 踢出 F11，`-EnsureFs` 导航后自动重判重按。
5. **全屏工具栏滑出条卡住不隐藏**：鼠标沉底、相对抖动都无效；**在网页空白处点一次即隐藏**。铁律：没拍过的页面先出布局图、Read 量准坐标再点——盲点曾点中"了解自定义域名"链接跳去 Docs 页。
6. **新标签切换瞬间 gdigrab 可能拍到纯黑**（DComp 合成表面重建），等 3 秒重拍即可，不是脚本坏了。
7. `mouse_event` 的 dx/dy 是 uint，PS 传不了负数；相对移动走脚本内 `MoveRel`（C# `unchecked((uint)dx)`）。
8. 安全边界：**绝不点 Create repository / Submit new issue / 绿色 Run workflow 等提交按钮**；展开下拉、勾选标签是草稿态本地操作，安全。拍完按上面收尾序列还原现场（标签、缩放、单标签、全屏）。
9. **`-CloseTab` 计数会漂移**：Ctrl+W 关闭与标签标题读取存在延迟，连续执行 N 次可能实际关掉 N+1 个（实测 4 次关了 5 个，连带误关用户原有标签）。对策：①每关一两个就 `-Info` 或裁一条标签栏顶条 Read 核验剩余标签，别一口气关完；②**一旦误关用户原标签，不要用 Ctrl+Shift+T 恢复**——重开是 LIFO，会把你自己借窗开的标签也按关闭顺序带回来，次数难控；改用 `Start-Process msedge.exe '<原 URL>'`（即再跑一次 `-Url`）把被误关的页面等价重开，最后裁标签栏确认恢复到开场那组标签（数量+标题+顺序）。开场前先 `-Info` 记好原有标签清单。

## 拍摄卫生（每次必做）

1. **先扫一眼桌面有没有敏感内容**（聊天窗口、文档、密码、个人文件夹名）。需要干净背景时枚举所有带 `MainWindowHandle` 的窗口 `ShowWindow(6)` 最小化——**不要依赖 Shell 的 MinimizeAll，它对 Windows Terminal 无效**。
2. 资源管理器快速访问/导航栏会暴露个人目录名，能不用就不用它当目标。
3. 收尾杀进程**按 PID 精确杀**（`taskkill //PID <pid> //F`）。禁止 `taskkill //IM conhost.exe //F` 这类按映像名批量杀——会连其他终端的 ConPTY 一起结束（一次误杀过 8 个）。
4. 给用户验收的图可放 `~/Desktop/`（即 `%USERPROFILE%\Desktop`）；项目资产放项目自己的图片目录；临时件放工作项目的 `Temp/`（gitignore）。

## 验收

拍完**必须用 Read 工具亲自看图**：内容对不对、有没有黑/透明事故、有没有拍到不该出现的窗口或文字。文件大小也是信号：DComp 黑屏通常只有几 KB。

## 禁止事项

- 不要使用 `powershell -ExecutionPolicy Bypass`（本机权限策略明确拒绝且已记录）；本地脚本直接 `powershell -NoProfile -File <path>` 即可运行。
