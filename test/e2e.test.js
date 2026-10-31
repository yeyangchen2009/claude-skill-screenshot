'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'cdp-shot.js');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/page.html'), 'utf8');
const injectedCss = path.join(__dirname, 'fixtures/injected.css');
let server;
let baseUrl;
let work;
let profileRoot;

function findBrowser() {
    if (process.env.CDP_BROWSER) return process.env.CDP_BROWSER;
    if (process.platform === 'win32') {
        const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
        for (const root of roots) {
            for (const relative of ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']) {
                const candidate = path.join(root, relative);
                if (fs.existsSync(candidate)) return candidate;
            }
        }
        return null;
    }
    if (process.platform === 'darwin') {
        return [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
            path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ].find(candidate => fs.existsSync(candidate)) || null;
    }
    for (const name of ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
        if (spawnSync('which', [name], { stdio: 'ignore' }).status === 0) return name;
    }
    return null;
}

const browser = findBrowser();
const browserTest = (name, fn) => test(name, { skip: browser ? false : '未安装 Edge/Chrome', timeout: 120000 }, fn);

function pngSize(filename) {
    const data = fs.readFileSync(filename);
    assert.equal(data.toString('ascii', 1, 4), 'PNG');
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function terminateChild(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    if (process.platform === 'win32') {
        return new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
            killer.once('error', resolve);
            killer.once('close', resolve);
        });
    }
    return new Promise(resolve => {
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('close', () => { clearTimeout(force); resolve(); });
        child.kill('SIGTERM');
    });
}

function run(args, { env = {}, timeout = 90000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], {
            cwd: root,
            env: { ...process.env, CDP_SHOT_TEMP: profileRoot, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => {
            timedOut = true;
            void terminateChild(child).finally(() => {
                reject(new Error('测试进程超时\n' + stdout + stderr));
            });
        }, timeout);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (!timedOut) resolve({ code, signal, stdout, stderr });
        });
    });
}

function shot(name, extra = [], env) {
    const out = path.join(work, name);
    return run([baseUrl + '/', out, '240', '160', '--settle', '80', '--wait', '0', '--timeout', '10000', ...extra], { env })
        .then(result => ({ ...result, out }));
}

function assertSuccess(result) {
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(fs.statSync(result.out).size > 500, '截图不应为空');
}

async function assertAutoProfilesClean() {
    for (let attempt = 0; attempt < 70; attempt++) {
        if (fs.readdirSync(profileRoot).length === 0) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.deepEqual(fs.readdirSync(profileRoot), [], '自动 profile 应在后台清理窗口内消失');
}

test.before(async () => {
    const tempBase = process.env.CDP_SHOT_TEMP || os.tmpdir();
    fs.mkdirSync(tempBase, { recursive: true });
    work = fs.mkdtempSync(path.join(tempBase, 'cdp-shot-e2e-'));
    profileRoot = path.join(work, 'profiles');
    fs.mkdirSync(profileRoot, { recursive: true });
    server = http.createServer((req, res) => {
        if (req.url.startsWith('/fixture.css')) {
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end('body { background: rgb(120, 20, 20); }');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fixture);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

browserTest('普通截图、默认 2x、scale 1 与嵌套输出目录', async () => {
    const one = await shot('nested/one.png', ['--scale', '1']);
    assertSuccess(one);
    assert.deepEqual(pngSize(one.out), { width: 240, height: 160 });

    const two = await shot('two.png');
    assertSuccess(two);
    assert.deepEqual(pngSize(two.out), { width: 480, height: 320 });
    await assertAutoProfilesClean();
});

browserTest('整页与元素 clip 使用正确尺寸', async () => {
    const full = await shot('full.png', ['--scale', '1', '--full']);
    assertSuccess(full);
    const size = pngSize(full.out);
    assert.equal(size.width, 240);
    assert.ok(size.height >= 1800, `整页高度只有 ${size.height}`);

    const clip = await shot('clip.png', ['--scale', '1', '--eval', '({x:0,y:0,width:120,height:80})']);
    assertSuccess(clip);
    assert.deepEqual(pngSize(clip.out), { width: 120, height: 80 });
});

browserTest('hash、scheme、click 与 CSS 本地应答生效', async () => {
    const actions = await shot('actions.png', [
        '--scale', '1', '--scheme', 'dark', '--hash', 'anchor', '--full',
        '--eval', `(()=>{if(location.hash!=='#anchor')throw new Error('hash 未设置');if(!matchMedia('(prefers-color-scheme: dark)').matches)throw new Error('scheme 未生效');if(getComputedStyle(document.body).backgroundColor!=='rgb(18, 52, 86)')throw new Error('CSS 本地应答未生效');})()`,
        '--click', '#button',
        '--css', injectedCss, '--css-match', '*fixture.css*',
    ]);
    assertSuccess(actions);
    const size = pngSize(actions.out);
    assert.equal(size.width, 240);
    assert.ok(size.height <= 1000, `click 未缩短页面，高度为 ${size.height}`);
});

browserTest('持久 profile 跨进程保留 localStorage 且不删除', async () => {
    const persistent = path.join(work, 'persistent-profile');
    const first = await shot('profile-first.png', [
        '--scale', '1', '--profile-dir', persistent,
        '--eval', `localStorage.setItem('cdp_shot_test','persisted')`,
    ]);
    assertSuccess(first);
    assert.ok(fs.existsSync(persistent));

    const second = await shot('profile-second.png', [
        '--scale', '1', '--profile-dir', persistent,
        '--eval', `(()=>{if(localStorage.getItem('cdp_shot_test')!=='persisted')throw new Error('profile 未持久化');return {x:0,y:0,width:120,height:80};})()`,
    ]);
    assertSuccess(second);
    assert.ok(fs.existsSync(persistent));
});

browserTest('JS 异常返回非零并清理自动 profile', async () => {
    const result = await shot('failure.png', ['--eval', 'throw new Error("expected failure")']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /expected failure/);
    assert.ok(!fs.existsSync(result.out));
    await assertAutoProfilesClean();
});

browserTest('永久 Promise 按 timeout 失败且不遗留 profile', async () => {
    const result = await shot('timeout.png', ['--timeout', '1200', '--eval', 'new Promise(()=>{})']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Runtime\.evaluate 超时/);
    await assertAutoProfilesClean();
});

test('浏览器启动失败返回非零并清理临时目录', { timeout: 60000 }, async () => {
    const result = await shot('launch-failure.png', ['--browser', process.execPath]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /DevTools|浏览器/);
    await assertAutoProfilesClean();
});
