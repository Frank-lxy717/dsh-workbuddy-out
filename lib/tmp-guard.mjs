/**
 * 临时目录卫生 —— 专家（WorkBuddy 子进程）经常把中间产物丢进系统临时目录：
 * 无头浏览器 profile、抓取脚本、验收截图……任务结束后没人回收，一次重度派活
 * 实测能在 %TEMP% 留下 25 MB。这些文件既不在交付目录里，也不在任何人的视野里。
 *
 * 这里负责三件事：
 *   1. 派活前后各做一次「顶层快照」（只 stat 顶层，不递归，成本极低）
 *   2. 差分出本次派活窗口内**新增**的条目
 *   3. 按配置清理（auto）或只报告（report）或完全不动（off）
 *
 * 设计原则：宁可少删，不可错删。
 *   - 只清理 added，不碰 changed（改动的可能是别人正在用的文件）
 *   - 只清理 tmpRoot 直属子项，realpath 后必须仍在 tmpRoot 内
 *   - 跳过 DSH / 系统常见的临时目录前缀
 *   - 任何一步失败都只记录，不抛错，绝不影响主流程
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 顶层扫描时跳过的名字。 */
const SKIP_NAMES = new Set(['node_modules']);

/**
 * 跳过的前缀（正则）。这些通常是别的程序/会话正在使用的临时目录，
 * 即使它们在本次派活窗口内被创建，也不该由我们负责回收。
 */
const SKIP_PREFIXES = [
  /^dsh/i,            // DSH 自身
  /^\.dsh/i,
  /^pnpm/i,           // 包管理器
  /^npm/i,
  /^yarn/i,
  /^vscode/i,
  /^electron/i,
  /^scoped_dir/i,     // Chrome / Edge 沙盒目录
  /^chrome_/i,
  /^edge_/i,
  /^Crashpad/i,
  /^wct/i,            // Windows
  /^Microsoft/i,
  /^Temp_/i,
];

export function tmpRoot() {
  return path.resolve(os.tmpdir());
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function shouldSkipName(name) {
  if (SKIP_NAMES.has(name.toLowerCase())) return true;
  return SKIP_PREFIXES.some(re => re.test(name));
}

/**
 * 顶层快照：路径 → { size, mtimeMs, isDir }。
 * 目录不递归统计大小（留到真正需要报告时再算），避免每次派活都扫盘。
 */
export function snapshotTmp(root = tmpRoot()) {
  const out = new Map();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (shouldSkipName(e.name)) continue;
    const full = path.join(root, e.name);
    const st = statSafe(full);
    if (!st) continue;
    out.set(full, { size: e.isDirectory() ? null : st.size, mtimeMs: st.mtimeMs, isDir: e.isDirectory() });
  }
  return out;
}

/**
 * 差分：只返回**新增**项。改动的项不进结果——它可能是别人正在写的文件。
 * @returns {{added: string[]}}
 */
export function diffTmp(before, after) {
  const added = [];
  for (const p of after.keys()) {
    if (!before.has(p)) added.push(p);
  }
  return { added };
}

/** 递归统计已存在路径的体积（失败返回 0）。 */
export function measurePath(p) {
  let total = 0;
  const walk = (target, depth) => {
    if (depth > 8) return;
    let st;
    try {
      st = fs.lstatSync(target);
    } catch {
      return;
    }
    if (!st.isDirectory()) {
      total += st.size;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) walk(path.join(target, e.name), depth + 1);
  };
  walk(p, 0);
  return total;
}

/** 批量统计：返回 [{path, bytes}] 与总和。 */
export function measureAll(paths) {
  const items = paths.map(p => ({ path: p, bytes: measurePath(p) }));
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);
  return { items, totalBytes };
}

/**
 * 删除指定路径。安全闸：每个路径 realpath 后必须仍在 root 内，且不能等于 root 本身。
 * @returns {{removed: string[], failed: Array<{path:string, reason:string}>}}
 */
export function removePaths(paths, root = tmpRoot()) {
  const removed = [];
  const failed = [];
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return { removed, failed: paths.map(p => ({ path: p, reason: 'tmpRoot 不可解析' })) };
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;

  for (const p of paths) {
    try {
      const real = fs.realpathSync(p);
      if (real === realRoot || !real.startsWith(prefix)) {
        failed.push({ path: p, reason: '越界（不在临时目录内）' });
        continue;
      }
      fs.rmSync(real, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      failed.push({ path: p, reason: e?.code ?? e?.message ?? '未知错误' });
    }
  }
  return { removed, failed };
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 整数就别显示 "2.0 KB"；小数在 ≥10 时取整，否则保留一位。
  let shown;
  if (Number.isInteger(v)) shown = String(v);
  else if (v >= 10) shown = String(Math.round(v));
  else shown = v.toFixed(1);
  return `${shown} ${units[i]}`;
}

/**
 * 「待清理线索」账本。
 *
 * 只在两种情况下写入：report 模式下新增的项，以及 auto 模式下删失败的项。
 * 目的是让 `wb clean` 有据可依，而不是去盲扫整个 %TEMP%。
 */
export function appendLedger(file, paths) {
  if (!Array.isArray(paths) || !paths.length) return;
  try {
    const stamp = new Date().toISOString();
    const lines = paths.map(p => JSON.stringify({ at: stamp, path: p })).join('\n');
    fs.appendFileSync(file, lines + '\n', 'utf8');
  } catch {
    /* 账本写不了不影响主流程 */
  }
}

/** 读账本，返回去重后的路径列表（不校验存在性）。 */
export function readLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.path === 'string') seen.add(row.path);
    } catch {
      /* 坏行忽略 */
    }
  }
  return [...seen];
}

export function clearLedger(file) {
  try {
    fs.writeFileSync(file, '', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 派活窗口的完整卫生流程（在 executeJob 里调用）。
 *
 * @param {object} opts
 * @param {Map<string,{mtimeMs:number,size:number|null,isDir:boolean}>} opts.before 派活前快照
 * @param {'auto'|'report'|'off'} [opts.mode] 处置模式
 * @returns {{mode:string, added:string[], totalBytes:number, items:Array<{path:string,bytes:number}>, removed:string[], failed:Array<{path:string,reason:string}>}}
 */
export function settleTmp({ before, mode = 'auto', root = tmpRoot() }) {
  const result = { mode, added: [], totalBytes: 0, items: [], removed: [], failed: [] };
  if (mode === 'off' || !(before instanceof Map)) return result;

  const after = snapshotTmp(root);
  const { added } = diffTmp(before, after);
  result.added = added;
  if (!added.length) return result;

  const { items, totalBytes } = measureAll(added);
  result.items = items;
  result.totalBytes = totalBytes;

  if (mode === 'auto') {
    // 只清「本次新增」，且清完再复查一次——删不掉的留给用户。
    const { removed, failed } = removePaths(added, root);
    result.removed = removed;
    result.failed = failed;
  }
  return result;
}
