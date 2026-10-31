'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'cdp-shot.js');
const pkg = require('../package.json');

function run(args) {
    return spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
    });
}

test('--help 与 --version 不需要浏览器', () => {
    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--profile-dir/);
    assert.match(help.stdout, /--insecure/);

    const version = run(['--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), pkg.version);
});

test('cdps 短命令与 cdp-shot 兼容别名同时声明', () => {
    assert.deepEqual(pkg.bin, {
        cdps: './cdp-shot.js',
        'cdp-shot': './cdp-shot.js',
    });
});

test('缺少位置参数返回退出码 2', () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /用法:/);
});

const invalidCases = [
    ['未知选项', ['https://example.com', 'x.png', '100', '100', '--wat']],
    ['多余位置参数', ['https://example.com', 'x.png', '100', '100', 'extra']],
    ['选项缺值', ['https://example.com', 'x.png', '100', '100', '--scale']],
    ['选项值被下一选项占用', ['https://example.com', 'x.png', '100', '100', '--scale', '--full']],
    ['宽度为零', ['https://example.com', 'x.png', '0', '100']],
    ['宽度不是整数', ['https://example.com', 'x.png', '1.5', '100']],
    ['高度非法', ['https://example.com', 'x.png', '100', 'NaN']],
    ['scale 为零', ['https://example.com', 'x.png', '100', '100', '--scale', '0']],
    ['settle 为负', ['https://example.com', 'x.png', '100', '100', '--settle', '-1']],
    ['wait 不是整数', ['https://example.com', 'x.png', '100', '100', '--wait', '1.5']],
    ['timeout 为零', ['https://example.com', 'x.png', '100', '100', '--timeout', '0']],
    ['theme 非法', ['https://example.com', 'x.png', '100', '100', '--theme', 'sepia']],
    ['scheme 非法', ['https://example.com', 'x.png', '100', '100', '--scheme', 'auto']],
    ['CSS 未成对', ['https://example.com', 'x.png', '100', '100', '--css', 'x.css']],
    ['CSS match 未成对', ['https://example.com', 'x.png', '100', '100', '--css-match', '*x.css*']],
    ['keep-open 未成对', ['https://example.com', 'x.png', '100', '100', '--keep-open']],
    ['done-flag 未成对', ['https://example.com', 'x.png', '100', '100', '--done-flag', 'x.done']],
    ['CSS 文件不存在', ['https://example.com', 'x.png', '100', '100', '--css', 'missing.css', '--css-match', '*x*']],
    ['浏览器不可执行', ['https://example.com', 'x.png', '100', '100', '--browser', 'missing-browser']],
];

for (const [name, args] of invalidCases) {
    test(name, () => {
        const result = run(args);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.ok(result.stderr.trim(), '应输出错误原因');
    });
}
