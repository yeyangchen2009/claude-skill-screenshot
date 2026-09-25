# screenshot — Windows 截图 skill（Claude Code 用户级）

在 Windows 上截图/截屏的一整套工具与实战经验。零 npm 依赖，三个脚本按场景分工：

| 要截什么 | 工具 | 原理 |
|---|---|---|
| 浏览器里的页面（网页、GitHub、本地服务、元素级取景、手机视口、暗色模拟） | `cdp-shot.js` | CDP（Chrome DevTools Protocol）驱动无头浏览器，Node ≥22 内置 WebSocket |
| 浏览器外的任意窗口（终端、文件夹、桌面软件） | `shot-window.ps1` | Win32 API 取窗口矩形 + ffmpeg gdigrab |
| 必须登录才能看的页面，借用你**本人已登录**的日常浏览器窗口 | `ui-shot.ps1` | Win32 UI 自动化（不开调试端口、不重启浏览器、不碰凭据） |

完整决策树、参数细节和踩坑记录都在 **`SKILL.md`**（Claude 使用时自动加载的手册）。本文件只解决一件事：**克隆到新机器后怎么配。**

## 一、前置依赖

| 依赖 | 检查命令 | 安装 |
|---|---|---|
| Node.js ≥ 22 | `node --version` | `winget install OpenJS.NodeJS` |
| ffmpeg（须在 PATH） | `ffmpeg -version` | `winget install Gyan.FFmpeg`（装完重开终端） |
| Edge 或 Chrome | — | 脚本自动探测标准安装路径，一般无需配置 |

平台：**Windows 11 + PowerShell 5.1** 实测。运行 ps1 一律 `powershell -NoProfile -File <脚本>`。

## 二、安装位置

把整个目录放到 Claude Code 的用户级 skill 目录：

```
%USERPROFILE%\.claude\skills\screenshot\
```

放好后**所有项目**里都能触发（说"截图/拍一张/网页截图"等即可），不限于某个仓库。

冒烟测试（Git Bash）：

```bash
node ~/.claude/skills/screenshot/cdp-shot.js https://example.com test.png 1000 700 --settle 1500
```

生成 `test.png` 即安装成功。

## 三、克隆后必须自己确认/修改的配置

仓库里**没有**任何机器特定配置，以下几项按你自己的环境填，别照抄任何人的示例值：

1. **浏览器可执行文件路径**
   cdp-shot.js 默认自动探测常见 Edge/Chrome 安装路径。探测不到时，两种方式指定：
   - 单次：命令加 `--browser 'C:/path/to/chrome.exe'`
   - 长期：设置环境变量 `CDP_BROWSER`
   - ui-shot.ps1 用 `-BrowserExe` 指定（默认找 Edge，进程名用 `-ProcessName chrome` 切换）。

2. **HTTP 代理**
   默认直连。无头浏览器不走系统代理时，手动加 `--proxy 127.0.0.1:<你的代理端口>`。端口以你自己代理软件的配置为准，常见值只是常见值。

3. **路径 C 的窗口标题子串**
   用 ui-shot.ps1 借窗时，`-WindowTitle` 必须是**你自己**窗口标题里的稳定**正向**子串（例如登录后页面上显示的你的用户名）。不要用排除法，不要用别人的示例值。

4. **`primer-21.0.7.css`（可删）**
   仅在截作者同款 Gmeek 博客站、且 headless 拉不到 Primer CSS 镜像时，用 `--css primer-21.0.7.css --css-match '*Primer/21.0.7/primer.css*'` 本地应答。没有同款站点，这个文件和相关参数直接忽略（文件约 813 KB，删掉不影响其他功能）。

5. **SKILL.md 中带"本站 / Gmeek"字样的段落**
   那是针对作者本人博客站的实战经验（主题注入、mermaid 大文件等待等），属于案例参考；其中的通用规律（重型运行时用 `--eval` 轮询而非固定等待、元素取景坐标取法等）对任何站点都适用。

## 四、安全边界（使用前必读，勿删）

- **绝不代用户输入账号密码或过 2FA**。需要登录的页面：用户自己操作，或经用户明确同意后用 `--profile-dir --headed` 让用户本人登录一次。
- 自动化点击**绝不指向提交类按钮**（Create repository、Submit issue、绿色 Run workflow、Commit/Delete/Publish 等）；展开下拉、勾选草稿标签等本地可逆操作除外。
- 借用用户日常浏览器窗口**必须经用户明确同意**，拍摄期间最小操作，拍完还原现场（关掉新开的标签、复位缩放、退出全屏）。
- 任何没拍过的页面：**先拍布局图，看图量准物理坐标后再二次操作，禁止盲点**。
- 拍完必须亲自打开图片验收（内容、黑/透明事故、误入镜头的敏感信息）。

## 五、文件清单

```
SKILL.md            Claude 使用手册（决策树 + 全部参数 + 踩坑记录）
README.md           本文件
cdp-shot.js         浏览器页面截图（CDP，零依赖）
shot-window.ps1     浏览器外窗口截图（ffmpeg gdigrab）
ui-shot.ps1         借本人已登录浏览器窗口拍登录态页面（Win32 UI 自动化）
primer-21.0.7.css   Gmeek 站专用本地 CSS 应答（不需要可删）
```
