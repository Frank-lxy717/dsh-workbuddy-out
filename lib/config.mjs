/**
 * 运行时配置 —— <state>/config.json，全部字段可选。
 *
 * 只放「用户可能想改」的东西，不放内部状态。
 * 每次读取都重新解析，方便改完立即生效（文件很小）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 状态根目录（纯计算，不创建目录 —— 避免 import 时就产生副作用）。 */
export function resolveStateRoot() {
  if (process.env.WORKBUDDY_OUT_STATE) return path.resolve(process.env.WORKBUDDY_OUT_STATE);
  return path.join(os.homedir(), '.dsh', 'workbuddy-out');
}

export function configPath() {
  return path.join(resolveStateRoot(), 'config.json');
}

/** 超时秒数的硬上下限。上限只管住「手滑写错」的情况，不限制正常的长任务。 */
export const TIMEOUT_LIMITS = Object.freeze({ min: 1, max: 86_400 });

/** 默认值；config.json 里出现同名键就覆盖。 */
export const DEFAULTS = Object.freeze({
  /** WorkBuddy CLI 脚本的绝对路径。留空则自动探测安装目录。 */
  cliPath: null,
  /** 派活默认超时（秒）。 */
  defaultTimeoutSec: 900,
  /** 默认模型；null = CLI 的 auto。 */
  defaultModel: null,
  /** 是否默认附加交接协议。 */
  handoff: true,
  /**
   * 系统临时目录的处置方式：
   *   auto   —— 派活结束后自动删除本次窗口内新增的临时条目（默认）
   *   report —— 只报告，不删除
   *   off    —— 完全不检查
   * 只清理「新增」，不碰「改动」；只清理 tmpdir 直属子项，删不掉就跳过。
   */
  tmpCleanup: 'auto',
});

/**
 * 归一化一个超时秒数。
 *
 * 这里的取值直接决定 CLI 自己的生死线（CLI 到点会 SIGTERM → 5s 后 SIGKILL），
 * 所以非法值必须收敛到一个安全默认，而不是变成「永不超时」。
 *
 * @param {unknown} value 用户传入的原始值
 * @param {number} fallback 非法时使用的默认值
 * @returns {number} 已钳制到 [min, max] 的整数秒
 */
export function normalizeTimeout(value, fallback = DEFAULTS.defaultTimeoutSec) {
  const n = Number(value);
  const base = Number.isFinite(n) && n > 0 ? n : Number(fallback);
  const safe = Number.isFinite(base) && base > 0 ? base : DEFAULTS.defaultTimeoutSec;
  return Math.min(TIMEOUT_LIMITS.max, Math.max(TIMEOUT_LIMITS.min, Math.round(safe)));
}

/**
 * 读取配置（容错：文件缺失或损坏都退回默认值）。
 * @returns {typeof DEFAULTS & {loadedFrom: string|null, loadError: string|null}}
 */
export function loadConfig() {
  const file = configPath();
  let parsed = {};
  let loadError = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') loadError = e.message;
  }
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (parsed[key] !== undefined && parsed[key] !== null) merged[key] = parsed[key];
    else if (key === 'cliPath' && parsed[key] === null) merged[key] = null;
  }
  // 枚举值校验：写错了就退回默认，而不是让一个陌生字符串流进执行路径。
  if (!['auto', 'report', 'off'].includes(merged.tmpCleanup)) merged.tmpCleanup = DEFAULTS.tmpCleanup;
  merged.defaultTimeoutSec = normalizeTimeout(merged.defaultTimeoutSec, DEFAULTS.defaultTimeoutSec);
  return { ...merged, loadedFrom: fs.existsSync(file) ? file : null, loadError };
}

export function writeConfig(patch) {
  const root = resolveStateRoot();
  fs.mkdirSync(root, { recursive: true });
  const file = configPath();
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 忽略 */ }
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return file;
}
