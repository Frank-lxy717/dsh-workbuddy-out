/**
 * 路径解析 —— 所有「东西在哪」的问题只在这里回答。
 *
 * 设计：全部惰性求值 + 带缓存，调用方永远不要自己拼路径。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveStateRoot } from './config.mjs';

const __filename = fileURLToPath(import.meta.url);
export const PKG_ROOT = path.resolve(path.dirname(__filename), '..');
export const PKG_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};
export const clearCache = () => cache.clear();

/** WorkBuddy 桌面端用户数据目录。 */
export const workbuddyHome = () =>
  memo('wbHome', () => {
    const override = process.env.WORKBUDDY_HOME;
    if (override && fs.existsSync(override)) return override;
    return path.join(os.homedir(), '.workbuddy');
  });

/** 已安装专家包缓存目录：<home>/plugins/cache/experts/<name>/<version>/ */
export const expertsDir = () => memo('expertsDir', () => path.join(workbuddyHome(), 'plugins', 'cache', 'experts'));

/**
 * 本插件自己的运行时状态（token、配置、任务记录），与代码严格分离。
 *
 * 放 ~/.dsh/workbuddy-out 而不是插件目录里，理由：
 *   1. 源码目录要能安全地进 git / 被快照，token 混进去极易误提交
 *   2. 与 DSH 其它插件惯例一致（.dsh/bili-duty、.dsh/rss-digest、.dsh/wxbridge）
 *   3. 插件升级/重装时状态不会被连带清掉
 * 可用 WORKBUDDY_OUT_STATE 覆盖（测试或多账号场景）。
 */
export const stateDir = () => memo('stateDir', () => {
  const d = resolveStateRoot();
  fs.mkdirSync(d, { recursive: true });
  return d;
});

export const logsDir = () => {
  const d = path.join(stateDir(), 'logs');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

export const jobsDir = () => {
  const d = path.join(stateDir(), 'jobs');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** WorkBuddy 默认工作区（生成 docx/pptx/xlsx 的落地处）。 */
export const workbuddyWorkspace = () => memo('wbWorkspace', () => {
  const candidates = [
    process.env.WORKBUDDY_WORKSPACE,
    path.join(os.homedir(), 'WorkBuddy', 'workbuddy'),
    path.join(os.homedir(), 'WorkBuddy'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0] ?? path.join(os.homedir(), 'WorkBuddy', 'workbuddy');
});

const CLI_REL = path.join('resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy');

/** 从注册表/安装信息里猜 WorkBuddy 安装根，宁缺毋滥。 */
function guessInstallRoots() {
  const roots = [];
  // 1) 从正在运行的 WorkBuddy 进程推断（最可靠：就是它自己）
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    ).trim();
    if (out) roots.push(path.dirname(out));
  } catch { /* 忽略：进程没跑 */ }
  // 2) 常见安装位置
  for (const base of ['C:', 'D:', 'E:', 'F:']) roots.push(path.join(base + path.sep, 'WorkBuddy'));
  return roots;
}

/**
 * 解析 WorkBuddy CLI 可执行脚本（一个 node 脚本，需用 node 解释执行）。
 * 查找顺序：显式配置 > 环境变量 > 运行中进程 > 常见安装位置。
 */
export const resolveCliScript = () => memo('cliScript', () => {
  const explicit = process.env.WORKBUDDY_CLI ?? loadConfig().cliPath ?? undefined;

  const tried = [];
  const candidates = [];
  if (explicit) candidates.push({ src: '配置/环境变量', p: explicit });
  for (const root of guessInstallRoots()) candidates.push({ src: '安装目录探测', p: path.join(root, CLI_REL) });

  for (const { src, p } of candidates) {
    if (!p) continue;
    tried.push(`${src}: ${p}`);
    if (fs.existsSync(p)) return { path: p, source: src, tried };
  }
  const err = new Error(
    '找不到 WorkBuddy CLI。\n' +
    '请确认 WorkBuddy 已安装，或用环境变量 WORKBUDDY_CLI 指定 bin/codebuddy 的路径。\n' +
    '已尝试:\n  ' + tried.join('\n  '),
  );
  err.code = 'CLI_NOT_FOUND';
  err.tried = tried;
  throw err;
});

/**
 * 解析用哪个 node 跑 CLI。
 * 关键：在 DSH 插件进程里 process.execPath 是 Electron，跑 WorkBuddy CLI 会挂，
 * 所以必须优先找真正的 node.exe。
 */
export const resolveNodeBinary = () => memo('nodeBin', () => {
  const tried = [];
  const candidates = [
    { src: '环境变量 WORKBUDDY_NODE', p: process.env.WORKBUDDY_NODE },
    {
      src: 'PATH 中的 node',
      p: (() => {
        try {
          const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which',
            ['node'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
          return out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        } catch { return undefined; }
      })(),
    },
    { src: '默认安装路径', p: process.platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')
      : '/usr/local/bin/node' },
  ];

  for (const { src, p } of candidates) {
    if (!p) continue;
    tried.push(`${src}: ${p}`);
    if (fs.existsSync(p)) return { path: p, source: src, tried };
  }

  // 兜底：如果当前进程本身是真 node 可用；如果是 Electron 则明确报错而不是静默失败。
  const isElectron = Boolean(process.versions.electron);
  if (!isElectron) {
    tried.push(`当前进程: ${process.execPath}`);
    return { path: process.execPath, source: '当前进程', tried };
  }
  const err = new Error(
    '找不到可用于运行 WorkBuddy CLI 的 node.exe（当前进程是 Electron，不能代替）。\n' +
    '请安装 Node.js，或用环境变量 WORKBUDDY_NODE 指定 node.exe 路径。\n' +
    '已尝试:\n  ' + tried.join('\n  '),
  );
  err.code = 'NODE_NOT_FOUND';
  err.tried = tried;
  throw err;
});

export const tokenFile = () => path.join(stateDir(), 'token.json');
export const configFile = () => path.join(stateDir(), 'config.json');
export const loginStateFile = () => path.join(stateDir(), 'login-state.json');
export const runsFile = () => path.join(stateDir(), 'runs.jsonl');
