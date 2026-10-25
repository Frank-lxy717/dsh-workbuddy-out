/**
 * 超时跟随 + 临时目录卫生的针对性测试。
 *
 * 这两件事都是线上真踩过的：
 *   1. 工具曾写死 timeoutMs，导致 timeout_sec 传到 1800 时外层先死；
 *   2. 一次重度派活在 %TEMP% 留下 25 MB，没人回收。
 *
 * 跑法：node test/timeout-and-tmp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTools } from '../index.mjs';
import { DEFAULTS, TIMEOUT_LIMITS, normalizeTimeout } from '../lib/config.mjs';
import {
  diffTmp,
  formatBytes,
  measureAll,
  measurePath,
  removePaths,
  snapshotTmp,
  settleTmp,
} from '../lib/tmp-guard.mjs';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✘ ${name}\n    ${e.message}`);
  }
};

// ── 1. 超时归一化 ────────────────────────────────────────────────
test('normalizeTimeout 对非法值退回默认，不会变成永不超时', () => {
  for (const bad of [0, -1, NaN, null, undefined, '', 'abc', Infinity]) {
    const v = normalizeTimeout(bad, 900);
    assert.equal(v, 900, `输入 ${String(bad)} 应退回 900，实际 ${v}`);
  }
});

test('normalizeTimeout 尊重合法值（这就是 timeout_sec 生效的证据）', () => {
  assert.equal(normalizeTimeout(1800, 900), 1800);
  assert.equal(normalizeTimeout(60, 900), 60);
  assert.equal(normalizeTimeout(43200, 900), 43200);
});

test('normalizeTimeout 把越界值钳制在 [min, max]', () => {
  assert.equal(normalizeTimeout(999999, 900), TIMEOUT_LIMITS.max);
  assert.equal(normalizeTimeout(0.4, 900), TIMEOUT_LIMITS.min);
});

// ── 2. 工具定义不再有固定超时 ────────────────────────────────────
test('workbuddy_run 不声明 timeoutMs（否则会盖掉 timeout_sec）', () => {
  const tools = buildTools({}, null);
  const run = tools.find(t => t.name === 'workbuddy_run');
  assert.ok(run, '找不到 workbuddy_run');
  assert.equal(
    Object.prototype.hasOwnProperty.call(run, 'timeoutMs'),
    false,
    'timeoutMs 必须是 undefined/缺失 —— DSH 只有在这个字段缺失时才放行，让 CLI 自己决定生死',
  );
});

test('workbuddy_run 的 timeout_sec 描述里承诺了「唯一决定生死」', () => {
  const tools = buildTools({}, null);
  const run = tools.find(t => t.name === 'workbuddy_run');
  const desc = run.parameters.properties.timeout_sec.description ?? '';
  assert.match(desc, /ONLY limit/i);
});

// ── 3. 临时目录卫生 ──────────────────────────────────────────────
const makeSandbox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbout-test-'));
  return root;
};

test('diffTmp 只报告新增，不报告改动', () => {
  const root = makeSandbox();
  try {
    fs.writeFileSync(path.join(root, 'preexisting.txt'), 'old');
    const before = snapshotTmp(root);

    fs.writeFileSync(path.join(root, 'preexisting.txt'), 'changed!!'); // 改动
    fs.writeFileSync(path.join(root, 'brand-new.mjs'), 'x');           // 新增
    fs.mkdirSync(path.join(root, 'sr7profile'));                       // 新增目录
    fs.writeFileSync(path.join(root, 'sr7profile', 'Cache'), 'y'.repeat(100));

    const after = snapshotTmp(root);
    const { added } = diffTmp(before, after);
    const names = added.map(p => path.basename(p)).sort();

    assert.deepEqual(names, ['brand-new.mjs', 'sr7profile']);
    assert.ok(!names.includes('preexisting.txt'), '改动的文件不应进入清理候选');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshotTmp 跳过 DSH / 浏览器 profile 前缀，避免误伤别人的东西', () => {
  const root = makeSandbox();
  try {
    for (const n of ['dsh-live', 'vscode-types', 'scoped_dir1234', 'chrome_abc']) {
      fs.mkdirSync(path.join(root, n));
    }
    fs.mkdirSync(path.join(root, 'sr7profile'));
    const snap = snapshotTmp(root);
    const names = [...snap.keys()].map(p => path.basename(p));
    assert.deepEqual(names, ['sr7profile']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removePaths 拒绝删除临时目录之外的东西', () => {
  const root = makeSandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wbout-outside-'));
  try {
    const victim = path.join(outside, 'do-not-delete.txt');
    fs.writeFileSync(victim, 'keep me');

    const { removed, failed } = removePaths([victim], root);
    assert.equal(removed.length, 0);
    assert.equal(failed.length, 1);
    assert.match(failed[0].reason, /越界/);
    assert.ok(fs.existsSync(victim), '临时目录外的文件必须原样存在');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('settleTmp(auto) 真的删掉本次新增的目录并统计体积', () => {
  const root = makeSandbox();
  try {
    const before = snapshotTmp(root);
    const leftover = path.join(root, 'sr7profile');
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'Cache'), 'y'.repeat(2048));

    const r = settleTmp({ before, mode: 'auto', root });
    assert.equal(r.added.length, 1);
    assert.ok(r.totalBytes >= 2048, `应统计到至少 2048 字节，实际 ${r.totalBytes}`);
    assert.equal(r.removed.length, 1);
    assert.equal(fs.existsSync(leftover), false, '新增目录应已被删除');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settleTmp(report) 只报告不删除', () => {
  const root = makeSandbox();
  try {
    const before = snapshotTmp(root);
    const leftover = path.join(root, 'leftover.txt');
    fs.writeFileSync(leftover, 'x');

    const r = settleTmp({ before, mode: 'report', root });
    assert.equal(r.added.length, 1);
    assert.equal(r.removed.length, 0);
    assert.ok(fs.existsSync(leftover), 'report 模式不得删除任何东西');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settleTmp(off) 完全不动作', () => {
  const r = settleTmp({ before: null, mode: 'off' });
  assert.deepEqual(r.added, []);
  assert.equal(r.totalBytes, 0);
});

test('formatBytes / measurePath 基本正确', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2 KB');
  const root = makeSandbox();
  try {
    fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(1024));
    assert.equal(measurePath(root), 1024);
    const { totalBytes } = measureAll([root]);
    assert.equal(totalBytes, 1024);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('默认配置里 tmpCleanup 是 auto', () => {
  assert.equal(DEFAULTS.tmpCleanup, 'auto');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
