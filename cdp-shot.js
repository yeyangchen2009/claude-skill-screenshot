#!/usr/bin/env node
/*
 * cdp-shot.js —— 零依赖无头浏览器截图器（Node ≥ 22，内置 WebSocket）
 * 配套教程：static 部署 + CDP 原理见博客《番外·给博客拍证件照》
 *
 * 用法:
 *   node cdp-shot.js <url> <out.png> <width> <height> [选项]
 *
 * 选项:
 *   --theme <light|dark>   主题注入（Gmeek 站点 --theme dark 会写 meek_theme 后重载）
 *   --theme-key <key>      主题在 localStorage 的键名（默认 meek_theme，通用站可换）
 *   --theme-value <v>      暗色值（默认 dark）
 *   --scale <n>            deviceScaleFactor（默认 2，出 2x 高清图）
 *   --css <file>           用本地 CSS 文件应答匹配 --css-match 的请求（ Fetch 域拦截）
 *   --css-match <pattern>  CDP URL 通配模式，如 *Primer/21.0.7/primer.css*
 *   --browser <path>       本机浏览器可执行文件（默认探测常见 Edge/Chrome 路径，或用 CDP_BROWSER 环境变量）
 *   --proxy <host:port>    走指定 HTTP 代理（默认直连；如本机 Clash 代理 127.0.0.1:789x，端口按自己的配置填）
 *   --hash <anchor>       导航后设置 location.hash（用于触发平滑滚动/scrollspy）
 * --eval <js>             导航后执行 JS；若返回 {x,y,width,height} 即按返回矩形取景
 *   --click <selector>    手机端：导航后点击元素（如 ☰ 按钮）
 *   --scheme <dark|light> 模拟 prefers-color-scheme（截未登录站点的暗色页用）
 *   --full                整页截图（用 Page.getLayoutMetrics 取 CSS 像素尺寸）
 *   --settle <ms>         导航/重载后等待渲染的时间（默认 3500）
 *   --wait <ms>           动作后等待时间（默认 1500）
 *   --profile-dir <dir>  持久化浏览器 profile（保留登录 cookie；默认每次临时目录）
 *   --headed              有头模式（配合 --profile-dir 做首次手动登录）
 *   --keep-open          截图后保持浏览器不退出，直到 --done-flag 指定的文件出现
 *   --done-flag <path>   与 --keep-open 配合：该文件出现即优雅结束（文件会被删除）
 *   --debug               滚动位置、主题属性、背景色等诊断输出
 *
 * 示例:
 *   node cdp-shot.js https://example.com/ out.png 1440 900 --theme dark \
 *     --css primer.css --css-match '*Primer/21.0.7/primer.css*'
 *   node cdp-shot.js https://example.com/post/1 out.png 390 844 --theme dark \
 *     --click '.toc-mobile-icon'
 *   node cdp-shot.js https://example.com/post/1 out.png 1440 900 --theme dark \
 *     --eval '(()=>{const r=document.querySelector(".mermaid-wrap svg").getBoundingClientRect();
 *                   return {x:r.x-8,y:r.y+scrollY-8,width:r.width+16,height:r.height+16};})()'
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function parseArgs(argv) {
    const [url, out, w, h] = argv;
    if (!url || !out || !w || !h) {
        console.error('用法: node cdp-shot.js <url> <out.png> <width> <height> [选项]');
        process.exit(2);
    }
    const withValue = new Set(['theme', 'theme-key', 'theme-value', 'scale', 'css',
        'css-match', 'browser', 'hash', 'eval', 'click', 'settle', 'wait', 'scheme',
        'profile-dir', 'done-flag', 'proxy']);
    const o = { url, out, width: +w, height: +h, scale: 2, settle: 3500, wait: 1500,
        theme: 'light', 'theme-key': 'meek_theme', 'theme-value': 'dark' };
    for (let i = 4; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        const key = tok.slice(2);
        if (withValue.has(key)) { o[key] = argv[++i]; }
        else if (key === 'full') o.full = true;
        else if (key === 'debug') o.debug = true;
        else if (key === 'headed') o.headed = true;
        else if (key === 'keep-open') o.keepOpen = true;
        else { console.error('未知选项: --' + key); process.exit(2); }
    }
    o.scale = +o.scale;
    o.settle = +o.settle;
    o.wait = +o.wait;
    return o;
}

function resolveBrowser(cliPath) {
    if (cliPath) return cliPath;
    if (process.env.CDP_BROWSER) return process.env.CDP_BROWSER;
    if (process.platform === 'win32') {
        const wins = [
            'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ];
        return wins.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || wins[0];
    }
    if (process.platform === 'darwin') {
        const macs = [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];
        return macs.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || macs[0];
    }
    return 'microsoft-edge'; // Linux 走 PATH
}

function getJson(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchBrowser(browser, opt) {
    // --profile-dir 给持久目录（跨次保留登录态，退出不删）；否则每次用临时目录
    const persistent = !!opt.profileDir;
    const profile = opt.profileDir
        ? path.resolve(opt.profileDir)
        : fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-shot-'));
    fs.mkdirSync(profile, { recursive: true });
    const args = [
        '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        opt.proxy ? '--proxy-server=' + opt.proxy : '--no-proxy-server',
        '--ignore-certificate-errors',
        '--remote-debugging-port=0', '--remote-allow-origins=*',
        '--user-data-dir=' + profile, 'about:blank',
    ];
    if (!opt.headed) args.unshift('--headless=new');
    const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    // 端口 0 = 让浏览器自选端口，从 stderr 的 "DevTools listening on ws://127.0.0.1:PORT/..." 解析
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 DevTools 端口超时（浏览器启动失败？）')), 20000);
        child.stderr.on('data', d => {
            const m = String(d).match(/DevTools listening on ws:\/\/[^\s:]+:(\d+)\//);
            if (m) { clearTimeout(timer); resolve(+m[1]); }
        });
        child.on('exit', code => { clearTimeout(timer); reject(new Error('浏览器提前退出，code=' + code)); });
    });
    return { child, port, profile, persistent };
}

function killBrowser(child) {
    try { child.kill(); } catch { /* 已退出 */ }
    if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    const browser = resolveBrowser(opt.browser);
    const { child, port, profile, persistent } = await launchBrowser(browser, opt);

    try {
        const list = await getJson(port, '/json/list');
        const page = list.find(t => t.type === 'page');
        if (!page) throw new Error('/json/list 里找不到 page 目标');
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res);
            ws.addEventListener('error', rej);
        });

        let mid = 0;
        const pend = new Map();
        let localCss = null;
        if (opt.css) {
            localCss = fs.readFileSync(opt.css);
        }
        ws.addEventListener('message', e => {
            const m = JSON.parse(e.data);
            // 样式表请求被拦下：用本地文件直接应答，浏览器不再发起网络请求
            if (m.method === 'Fetch.requestPaused') {
                if (localCss) {
                    send('Fetch.fulfillRequest', {
                        requestId: m.params.requestId,
                        responseCode: 200,
                        responseHeaders: [{ name: 'Content-Type', value: 'text/css; charset=utf-8' }],
                        body: localCss.toString('base64'),
                    }).catch(() => {});
                } else {
                    send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
                }
                return;
            }
            if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++mid;
            pend.set(id, msg => (msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result)));
            ws.send(JSON.stringify({ id, method, params }));
        });
        const evalJs = async expr => {
            const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error('JS 执行失败: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
            return r.result.value;
        };

        await send('Page.enable');
        await send('Runtime.enable');
        if (localCss) {
            if (!opt['css-match']) { console.error('用 --css 时必须同时给 --css-match <URL 通配模式>'); process.exit(2); }
            await send('Fetch.enable', { patterns: [{ urlPattern: opt['css-match'] }] });
        }
        await send('Emulation.setDeviceMetricsOverride', {
            width: opt.width, height: opt.height,
            deviceScaleFactor: opt.scale,
            mobile: opt.width <= 1249, // 严格对齐 GmeekTOC/articletoc 的小屏断点
        });
        if (opt.scheme) {
            await send('Emulation.setEmulatedMedia', {
                features: [{ name: 'prefers-color-scheme', value: opt.scheme }],
            });
        }

        // 第一次导航：落到同源页面后才有资格写 localStorage
        await send('Page.navigate', { url: opt.url });
        await sleep(opt.settle); // 等运行时插件（tocbot/mermaid/归档渲染）完工

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
            const v = await evalJs(opt.eval);
            await sleep(opt.wait);
            if (v && typeof v === 'object' && 'width' in v && 'height' in v) clipRect = v;
        }
        if (opt.click) {
            await evalJs(`document.querySelector(${JSON.stringify(opt.click)}).click()`);
            await sleep(opt.wait);
        }

        if (opt.debug) {
            console.log('scrollY:', await evalJs(`window.scrollY+'/'+document.body.scrollHeight`));
            console.log('data-color-mode:', await evalJs(`document.documentElement.getAttribute('data-color-mode')`));
            console.log('body background:', await evalJs(`getComputedStyle(document.body).backgroundColor`));
        }

        const params = { format: 'png', fromSurface: true };
        if (clipRect) {
            params.captureBeyondViewport = true;
            params.clip = {
                x: clipRect.x, y: clipRect.y,
                width: Math.ceil(clipRect.width), height: Math.ceil(clipRect.height),
                scale: 1,
            };
        } else if (opt.full) {
            const m = await send('Page.getLayoutMetrics');
            const c = m.cssContentSize || m.contentSize;
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width: Math.ceil(c.width), height: Math.ceil(c.height), scale: 1 };
        }
        const shot = await send('Page.captureScreenshot', params);
        fs.writeFileSync(opt.out, Buffer.from(shot.data, 'base64'));
        console.log('saved', opt.out, fs.statSync(opt.out).size, 'bytes');

        ws.close();

        // --keep-open：截图后保持浏览器（典型场景：有头窗口里手动登录），
        // 轮询 done-flag 文件，出现即优雅结束并删除标志；持久 profile 此时早已落盘
        if (opt.keepOpen) {
            if (!opt['done-flag']) { console.error('--keep-open 必须配合 --done-flag <path>'); process.exit(2); }
            const flag = path.resolve(opt['done-flag']);
            try { fs.rmSync(flag, { force: true }); } catch { /* ignore */ }
            console.log('浏览器保持打开，完成操作后我会通过标志文件通知结束…');
            await new Promise(resolve => {
                const timer = setInterval(() => {
                    if (fs.existsSync(flag)) {
                        clearInterval(timer);
                        try { fs.rmSync(flag, { force: true }); } catch { /* ignore */ }
                        resolve();
                    }
                }, 1000);
            });
        }
    } finally {
        killBrowser(child);
        // Windows 下进程刚退出时文件句柄可能还没释放，删不掉就放弃（临时目录，无大碍）
        setTimeout(() => {
            if (!persistent) {
                try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            process.exit(0);
        }, 300);
    }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
