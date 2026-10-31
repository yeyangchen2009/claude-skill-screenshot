#!/usr/bin/env node
/*
 * cdp-shot.js —— 零依赖无头浏览器截图器（Node ≥ 22，内置 WebSocket）
 *
 * 用法:
 *   cdp-shot <url> <out.png> <width> <height> [选项]
 *   node cdp-shot.js <url> <out.png> <width> <height> [选项]
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const pkg = require('./package.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const HELP = `cdp-shot ${pkg.version} —— 零依赖 CDP 网页截图器

用法:
  cdp-shot <url> <out.png> <width> <height> [选项]

选项:
  --theme <light|dark>   主题注入（dark 会写 localStorage 后重载，默认 light）
  --theme-key <key>      主题在 localStorage 的键名（默认 meek_theme）
  --theme-value <value>  暗色值（默认 dark）
  --scheme <dark|light>  模拟 prefers-color-scheme
  --scale <n>            deviceScaleFactor（默认 2）
  --full                 整页截图
  --hash <anchor>        导航后设置 location.hash
  --eval <js>            导航后执行 JS；返回 {x,y,width,height} 时按矩形取景
  --click <selector>     导航后点击元素
  --settle <ms>          导航/重载后等待时间（默认 3500）
  --wait <ms>            动作后等待时间（默认 1500）
  --timeout <ms>         单次 CDP 请求/求值超时（默认 180000）
  --css <file>           用本地 CSS 文件应答匹配 --css-match 的请求
  --css-match <pattern>  CDP URL 通配模式，须与 --css 成对使用
  --browser <path>       浏览器可执行文件；也可用 CDP_BROWSER 环境变量
  --proxy <host:port>    使用指定 HTTP 代理（默认直连）
  --insecure             忽略 TLS 证书错误（不安全，默认校验证书）
  --profile-dir <dir>    持久浏览器 profile，保留登录态，退出时不删除
  --headed               有头模式（配合 --profile-dir 手动登录）
  --keep-open            截图后保持浏览器，直到 --done-flag 文件出现
  --done-flag <path>     与 --keep-open 配合；标志文件出现后删除并退出
  --debug                输出滚动位置、主题属性、背景色等诊断信息
  --help, -h             显示帮助
  --version, -v          显示版本

环境变量:
  CDP_BROWSER            浏览器可执行文件路径
  CDP_SHOT_TEMP          自动临时 profile 的父目录（其次 TMPDIR、系统临时目录）

示例:
  cdp-shot https://example.com out.png 1440 900
  cdp-shot https://example.com full.png 1440 900 --full --scale 1
  cdp-shot https://example.com mobile.png 390 844 --scheme dark
  cdp-shot file:///D:/work/card.html card.png 1080 1440 --scale 1 --settle 600

只截网页内容，不截浏览器地址栏、桌面或其他软件窗口。`;

class UsageError extends Error {}

function numberOption(name, value, { integer = false, min = 0 } = {}) {
    const n = Number(value);
    if (value === undefined || value === '' || !Number.isFinite(n) || (min !== null && n < min) || (integer && !Number.isInteger(n))) {
        const range = min === null ? '任意' : min > 0 ? `≥ ${min}` : `≥ 0`;
        throw new UsageError(`${name} 必须是${integer ? '整数' : '有限数字'}，且 ${range}；收到: ${value}`);
    }
    return n;
}

function parseArgs(argv) {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) return { version: true };

    const [url, out, w, h] = argv;
    if (!url || !out || !w || !h) {
        throw new UsageError('用法: cdp-shot <url> <out.png> <width> <height> [选项]');
    }

    const withValue = new Set(['theme', 'theme-key', 'theme-value', 'scale', 'css',
        'css-match', 'browser', 'hash', 'eval', 'click', 'settle', 'wait', 'scheme',
        'profile-dir', 'done-flag', 'proxy', 'timeout']);
    const o = {
        url, out, scale: 2, settle: 3500, wait: 1500, timeout: 180000,
        theme: 'light', 'theme-key': 'meek_theme', 'theme-value': 'dark',
    };

    for (let i = 4; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) throw new UsageError('多余的位置参数: ' + tok);
        const key = tok.slice(2);
        if (withValue.has(key)) {
            if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
                throw new UsageError(`--${key} 缺少值`);
            }
            o[key] = argv[++i];
        } else if (key === 'full') o.full = true;
        else if (key === 'debug') o.debug = true;
        else if (key === 'headed') o.headed = true;
        else if (key === 'insecure') o.insecure = true;
        else if (key === 'keep-open') o.keepOpen = true;
        else throw new UsageError('未知选项: --' + key);
    }

    o.width = numberOption('width', w, { integer: true, min: 1 });
    o.height = numberOption('height', h, { integer: true, min: 1 });
    o.scale = numberOption('--scale', o.scale, { min: Number.EPSILON });
    o.settle = numberOption('--settle', o.settle, { integer: true });
    o.wait = numberOption('--wait', o.wait, { integer: true });
    o.timeout = numberOption('--timeout', o.timeout, { integer: true, min: 1 });

    if (!['light', 'dark'].includes(o.theme)) throw new UsageError('--theme 只支持 light 或 dark');
    if (o.scheme && !['light', 'dark'].includes(o.scheme)) throw new UsageError('--scheme 只支持 light 或 dark');
    if (!!o.css !== !!o['css-match']) throw new UsageError('--css 与 --css-match 必须成对使用');
    if (!!o.keepOpen !== !!o['done-flag']) throw new UsageError('--keep-open 与 --done-flag 必须成对使用');
    return o;
}

function validateInputFiles(opt) {
    if (opt.css) {
        let stat;
        try { stat = fs.statSync(opt.css); } catch { throw new UsageError('CSS 文件不存在: ' + opt.css); }
        if (!stat.isFile()) throw new UsageError('--css 不是文件: ' + opt.css);
    }
    if (opt.browser) {
        try { fs.accessSync(opt.browser, fs.constants.X_OK); } catch {
            throw new UsageError('浏览器不可执行: ' + opt.browser);
        }
    }
}

function resolveBrowser(cliPath, env = process.env, platform = process.platform) {
    if (cliPath) return cliPath;
    if (env.CDP_BROWSER) return env.CDP_BROWSER;
    const candidates = [];
    if (platform === 'win32') {
        const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA]
            .filter(Boolean);
        if (!roots.length) roots.push('C:/Program Files (x86)', 'C:/Program Files');
        for (const root of roots) {
            candidates.push(
                path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
                path.join(root, 'Google/Chrome/Application/chrome.exe'),
            );
        }
    } else if (platform === 'darwin') {
        candidates.push(
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
            path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        );
    } else {
        candidates.push('microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser');
        return candidates.find(name => spawnSync('which', [name], { stdio: 'ignore' }).status === 0) || null;
    }
    return candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function tempRoot(env = process.env) {
    return path.resolve(env.CDP_SHOT_TEMP || env.TMPDIR || os.tmpdir());
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getJson(port, urlPath, timeout) {
    const request = new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('CDP HTTP 响应不是 JSON: ' + e.message)); }
            });
        });
        req.on('error', reject);
    });
    return withTimeout(request, timeout, 'CDP HTTP 请求');
}

async function closeBrowser(port, timeout = 5000) {
    const version = await getJson(port, '/json/version', timeout);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    try {
        await withTimeout(new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('浏览器级 CDP 连接失败')), { once: true });
        }), timeout, '浏览器级 CDP 连接');
        await withTimeout(new Promise(resolve => {
            // 命令响应仅代表收到请求，socket 断开才代表浏览器已进入关闭完成路径。
            ws.addEventListener('close', resolve, { once: true });
            ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }));
        }), timeout, 'Browser.close');
    } finally {
        try { ws.close(); } catch { /* 已关闭 */ }
    }
}

async function killBrowser(child, debug = false) {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
        // 主进程先退出时仍要继续清理其子进程树。
        await new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            killer.stdout.on('data', chunk => { output += chunk; });
            killer.stderr.on('data', chunk => { output += chunk; });
            const timer = setTimeout(() => { killer.kill(); }, 10000);
            killer.once('error', error => {
                clearTimeout(timer);
                if (debug) console.error('[cleanup] taskkill: ' + error.message);
                resolve();
            });
            killer.once('close', code => {
                clearTimeout(timer);
                if (debug) console.error(`[cleanup] taskkill pid=${child.pid} code=${code} ${output.trim()}`);
                resolve();
            });
        });
    } else if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* 已退出 */ }
    }
    child.stderr?.destroy();
    child.unref();
}

function quarantineForRemoval(profile) {
    const quarantined = `${profile}.delete-${process.pid}-${Date.now()}`;
    fs.renameSync(profile, quarantined);
    return quarantined;
}

function scheduleTempProfileCleanup(profile) {
    const script = `
        const fs = require('fs');
        let profile = process.argv[1];
        // Windows 可重命名仍被占用的目录；改名后再删可绕开根目录 EPERM。
        try {
            const quarantined = profile + '.delete-' + process.pid;
            fs.renameSync(profile, quarantined);
            profile = quarantined;
        } catch { /* 已改名、已删除或暂不能改名，继续重试原路径 */ }
        let attempts = 0;
        const retry = () => {
            try {
                fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
                if (!fs.existsSync(profile)) return;
            } catch { /* 等待浏览器/杀软释放句柄 */ }
            if (++attempts < 60) setTimeout(retry, 500);
        };
        retry();
    `;
    const cleaner = spawn(process.execPath, ['-e', script, profile], {
        detached: true, stdio: 'ignore', windowsHide: true,
    });
    cleaner.unref();
}

async function removeTempProfile(profile) {
    if (!profile) return;
    let target = profile;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            if (!fs.existsSync(target)) return;
            throw new Error('目录仍存在');
        } catch (e) {
            if (process.platform === 'win32' && target === profile && fs.existsSync(target)) {
                try { target = quarantineForRemoval(target); } catch { /* 下轮继续尝试 */ }
            }
            if (attempt === 3) {
                if (process.platform === 'win32') scheduleTempProfileCleanup(target);
                else console.error(`警告：临时 profile 未能删除，可稍后手动清理: ${target} (${e.message})`);
                return;
            }
            await sleep(250);
        }
    }
}

async function launchBrowser(browser, opt) {
    if (!browser) {
        throw new Error('未找到 Edge/Chrome；请用 --browser <path> 或 CDP_BROWSER 指定浏览器');
    }
    const persistent = Boolean(opt['profile-dir']);
    let profile;
    if (persistent) {
        profile = path.resolve(opt['profile-dir']);
    } else {
        fs.mkdirSync(tempRoot(), { recursive: true });
        profile = fs.mkdtempSync(path.join(tempRoot() + path.sep, 'cdp-shot-'));
    }
    fs.mkdirSync(profile, { recursive: true });

    const args = [
        '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--user-data-dir=' + profile, 'about:blank',
    ];
    args.push(opt.proxy ? '--proxy-server=' + opt.proxy : '--no-proxy-server');
    if (opt.insecure) args.push('--ignore-certificate-errors');
    if (!opt.headed) args.unshift('--headless=new');

    let child;
    try {
        child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        const port = await new Promise((resolve, reject) => {
            let stderr = '';
            let settled = false;
            const timer = setTimeout(() => finish(new Error('等待 DevTools 端口超时（浏览器启动失败？）')), 20000);
            function finish(error, value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.off('error', onError);
                child.off('exit', onExit);
                if (error) reject(error); else resolve(value);
            }
            function onError(error) { finish(new Error('浏览器启动失败: ' + error.message)); }
            function onExit(code) {
                finish(new Error(`浏览器提前退出，code=${code}${stderr ? '\n' + stderr.slice(-2000) : ''}`));
            }
            child.on('error', onError);
            child.on('exit', onExit);
            child.stderr.on('data', data => {
                stderr += String(data);
                const match = String(data).match(/DevTools listening on ws:\/\/[^\s:]+:(\d+)\//);
                if (match) finish(null, Number(match[1]));
            });
        });
        return { child, port, profile, persistent };
    } catch (error) {
        await killBrowser(child);
        await sleep(300);
        if (!persistent) await removeTempProfile(profile);
        throw error;
    }
}

async function createCdpClient(port, opt) {
    const list = await getJson(port, '/json/list', opt.timeout);
    const page = list.find(target => target.type === 'page');
    if (!page) throw new Error('/json/list 里找不到 page 目标');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await withTimeout(new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    }), opt.timeout, 'CDP WebSocket 连接');

    let mid = 0;
    const pending = new Map();
    const localCss = opt.css ? fs.readFileSync(opt.css) : null;
    let closed = false;

    function rejectPending(error) {
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(error);
        }
        pending.clear();
    }

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP WebSocket 未连接'));
        const id = ++mid;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method} 超时（${opt.timeout}ms）`));
        }, opt.timeout);
        pending.set(id, { resolve, reject, timer, method });
        try { ws.send(JSON.stringify({ id, method, params })); } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
        }
    });

    ws.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.method === 'Fetch.requestPaused') {
            const action = localCss
                ? send('Fetch.fulfillRequest', {
                    requestId: message.params.requestId,
                    responseCode: 200,
                    responseHeaders: [{ name: 'Content-Type', value: 'text/css; charset=utf-8' }],
                    body: localCss.toString('base64'),
                })
                : send('Fetch.continueRequest', { requestId: message.params.requestId });
            action.catch(error => console.error('CSS 请求处理失败: ' + error.message));
            return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(item.method + ': ' + JSON.stringify(message.error)));
        else item.resolve(message.result);
    });
    ws.addEventListener('close', () => {
        closed = true;
        rejectPending(new Error('CDP WebSocket 已关闭'));
    });
    ws.addEventListener('error', () => rejectPending(new Error('CDP WebSocket 错误')));

    const evalJs = async expression => {
        const result = await send('Runtime.evaluate', {
            expression, awaitPromise: true, returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error('JS 执行失败: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        }
        return result.result.value;
    };

    const close = () => {
        if (closed) return;
        closed = true;
        rejectPending(new Error('CDP 客户端正在关闭'));
        try { ws.close(); } catch { /* 已关闭 */ }
    };
    return { send, evalJs, close };
}

function interruptError(signal = 'SIGINT') {
    const error = new Error(`操作被 ${signal} 中断`);
    error.exitCode = signal === 'SIGTERM' ? 143 : 130;
    return error;
}

function waitForDoneFlag(filename) {
    const flag = path.resolve(filename);
    fs.rmSync(flag, { force: true });
    console.log('浏览器保持打开；创建标志文件后退出: ' + flag);
    let timer;
    let rejectWait;
    const promise = new Promise((resolve, reject) => {
        rejectWait = reject;
        timer = setInterval(() => {
            try {
                if (fs.existsSync(flag)) {
                    clearInterval(timer);
                    fs.rmSync(flag, { force: true });
                    resolve();
                }
            } catch (error) {
                clearInterval(timer);
                reject(error);
            }
        }, 1000);
    });
    return {
        promise,
        cancel(error) {
            clearInterval(timer);
            rejectWait(error);
        },
    };
}

async function capture(opt) {
    let launched;
    let client;
    let interrupted = false;
    let interruptSignal;
    let cancelWait;
    let browserClosed = false;
    let browserKill;
    const stopBrowser = () => {
        if (launched?.child && !browserKill) browserKill = killBrowser(launched.child, opt.debug);
        return browserKill;
    };
    const onInterrupt = signal => {
        if (interrupted) return;
        interrupted = true;
        interruptSignal = signal;
        cancelWait?.(interruptError(signal));
        client?.close();
        void stopBrowser();
    };
    const onSigint = () => onInterrupt('SIGINT');
    const onSigterm = () => onInterrupt('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    try {
        launched = await launchBrowser(resolveBrowser(opt.browser), opt);
        if (interrupted) throw interruptError();
        client = await createCdpClient(launched.port, opt);
        const { send, evalJs } = client;

        await send('Page.enable');
        await send('Runtime.enable');
        if (opt.css) {
            await send('Fetch.enable', { patterns: [{ urlPattern: opt['css-match'] }] });
        }
        await send('Emulation.setDeviceMetricsOverride', {
            width: opt.width, height: opt.height,
            deviceScaleFactor: opt.scale,
            mobile: opt.width <= 1249,
        });
        if (opt.scheme) {
            await send('Emulation.setEmulatedMedia', {
                features: [{ name: 'prefers-color-scheme', value: opt.scheme }],
            });
        }

        await send('Page.navigate', { url: opt.url });
        await sleep(opt.settle);
        if (interrupted) throw interruptError();

        if (opt.theme === 'dark') {
            await evalJs(`localStorage.setItem(${JSON.stringify(opt['theme-key'])},${JSON.stringify(opt['theme-value'])})`);
            await send('Page.reload', { ignoreCache: true });
            await sleep(opt.settle);
        }

        let clipRect = null;
        if (opt.hash !== undefined) {
            await evalJs(`location.hash=${JSON.stringify(opt.hash)}`);
            await sleep(opt.wait);
        }
        if (opt.eval !== undefined) {
            const value = await evalJs(opt.eval);
            await sleep(opt.wait);
            if (value && typeof value === 'object' && 'width' in value && 'height' in value) clipRect = value;
        }
        if (opt.click) {
            await evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(opt.click)});if(!el)throw new Error('click 选择器未匹配到元素');el.click();})()`);
            await sleep(opt.wait);
        }
        if (interrupted) throw interruptError();

        if (opt.debug) {
            console.log('scrollY:', await evalJs(`window.scrollY+'/'+document.body.scrollHeight`));
            console.log('data-color-mode:', await evalJs(`document.documentElement.getAttribute('data-color-mode')`));
            console.log('body background:', await evalJs(`getComputedStyle(document.body).backgroundColor`));
        }

        const params = { format: 'png', fromSurface: true };
        if (clipRect) {
            const rect = {
                x: numberOption('--eval 返回的 x', clipRect.x, { min: null }),
                y: numberOption('--eval 返回的 y', clipRect.y, { min: null }),
                width: numberOption('--eval 返回的 width', clipRect.width, { min: Number.EPSILON }),
                height: numberOption('--eval 返回的 height', clipRect.height, { min: Number.EPSILON }),
            };
            params.captureBeyondViewport = true;
            params.clip = { ...rect, width: Math.ceil(rect.width), height: Math.ceil(rect.height), scale: 1 };
        } else if (opt.full) {
            const metrics = await send('Page.getLayoutMetrics');
            const content = metrics.cssContentSize || metrics.contentSize;
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 };
        }
        const shot = await send('Page.captureScreenshot', params);
        fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true });
        fs.writeFileSync(opt.out, Buffer.from(shot.data, 'base64'));
        console.log('saved', opt.out, fs.statSync(opt.out).size, 'bytes');
        if (opt.keepOpen) {
            const waiting = waitForDoneFlag(opt['done-flag']);
            cancelWait = waiting.cancel;
            try { await waiting.promise; } finally { cancelWait = null; }
        }
        // 页面 CDP 保持连接时发送浏览器级关闭命令，让 profile 正常落盘。
        try {
            await closeBrowser(launched.port, Math.min(opt.timeout, 5000));
            browserClosed = true;
            await sleep(500);
        } catch { /* finally 按 PID 兜底 */ }
    } finally {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        client?.close();
        if (!browserClosed) await stopBrowser();
        await sleep(300);
        if (launched && !launched.persistent) await removeTempProfile(launched.profile);
        if (interrupted) throw interruptError(interruptSignal);
    }
}

async function main(argv = process.argv.slice(2)) {
    const opt = parseArgs(argv);
    if (opt.help) { console.log(HELP); return; }
    if (opt.version) { console.log(pkg.version); return; }
    validateInputFiles(opt);
    await capture(opt);
}

main().catch(error => {
    console.error(error.message || error);
    if (!(error instanceof UsageError)) console.error('使用 --help 查看命令说明');
    process.exitCode = error.exitCode || (error instanceof UsageError ? 2 : 1);
});
