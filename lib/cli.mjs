/**
 * WorkBuddy CLI 调用契约 —— 唯一允许拼 CLI 命令行的模块。
 *
 * 为什么要有这一层：
 * WorkBuddy 升级会替换 resources 下的 CLI，但「怎么调」这件事是稳定的。
 * 把参数、环境变量、输出解析冻结在这里，升级只需要改一个文件，
 * 通过 `probeCli()` 的自检发现问题，而不是让每个调用点各错各的。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { resolveCliScript, resolveNodeBinary } from './paths.mjs';
import { normalizeTimeout } from './config.mjs';

/** 退出码语义（跨脚本一致）。 */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  NO_TOKEN: 2,
  EXPIRED: 3,
  EXPERT_NOT_FOUND: 4,
  CLI_NOT_FOUND: 5,
  TIMEOUT: 6,
  RUN_FAILED: 7,
  ABORTED: 8,
});

/**
 * 调用 CLI 必须设置的进程环境变量。少一个都会以难懂的方式失败。
 */
export function cliEnv(extra = {}) {
  return {
    ...process.env,
    // 该安装只 ship dist/codebuddy-lite-wb.mjs，没设会 Cannot find module ../dist/codebuddy
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
    // 跳过 git bash 探测，否则每次多打一段 stderr 噪音
    CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
    // 便于解析纯文本输出
    NO_COLOR: '1',
    CI: '1',
    ...extra,
  };
}

/** 受管参数白名单：只有这里声明的才能被外部传入，避免拼错参数悄悄失效。 */
const OPTION_SPECS = Object.freeze({
  model: { flag: '--model', kind: 'value' },
  maxTurns: { flag: '--max-turns', kind: 'value' },
  effort: { flag: '--effort', kind: 'value' },
  jsonSchema: { flag: '--json-schema', kind: 'json' },
  systemPrompt: { flag: '--system-prompt', kind: 'value' },
  appendSystemPrompt: { flag: '--append-system-prompt', kind: 'value' },
  sessionId: { flag: '--session-id', kind: 'value' },
  resume: { flag: '--resume', kind: 'value' },
  addDir: { flag: '--add-dir', kind: 'repeat' },
  outputFormat: { flag: '--output-format', kind: 'value' },
  fallbackModel: { flag: '--fallback-model', kind: 'value' },
});

export const SUPPORTED_OPTIONS = Object.freeze(Object.keys(OPTION_SPECS));

/**
 * 组装 CLI 参数数组。
 * @param {object} opts
 * @param {string} opts.prompt           任务正文
 * @param {string} [opts.pluginDir]      专家包目录（--plugin-dir）
 * @param {string} [opts.agent]          专家 agent 名（--agent）
 * @param {string} [opts.cwd]            工作目录（由 spawn 的 cwd 承担，不进参数）
 * @param {Record<string, unknown>} [opts.options] 见 OPTION_SPECS
 */
export function buildCliArgs({
  prompt,
  pluginDir,
  agent,
  options = {},
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt 不能为空'), { code: 'BAD_USAGE' });
  }

  const args = [];

  if (pluginDir) {
    if (!fs.existsSync(pluginDir)) {
      throw Object.assign(new Error(`专家包目录不存在: ${pluginDir}`), { code: 'BAD_USAGE' });
    }
    args.push('--plugin-dir', pluginDir);
  }
  if (agent) args.push('--agent', agent);

  // -p / -y 是本契约的核心：非交互 + 跳过权限询问
  args.push('-p', prompt, '-y');

  const unknown = Object.keys(options).filter(k => !(k in OPTION_SPECS));
  if (unknown.length) {
    throw Object.assign(
      new Error(`不支持的参数: ${unknown.join(', ')}（支持: ${SUPPORTED_OPTIONS.join(', ')}）`),
      { code: 'BAD_USAGE' },
    );
  }

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null || value === '') continue;
    const spec = OPTION_SPECS[key];
    if (spec.kind === 'repeat') {
      const list = Array.isArray(value) ? value : [value];
      if (list.length) args.push(spec.flag, ...list.map(String));
      continue;
    }
    if (spec.kind === 'json') {
      args.push(spec.flag, typeof value === 'string' ? value : JSON.stringify(value));
      continue;
    }
    args.push(spec.flag, String(value));
  }

  // 输出格式放最后，避免被前面的值吞掉
  if (!('outputFormat' in options)) args.push('--output-format', 'text');

  return args;
}

/** stderr 里的已知无害噪音。 */
const NOISE_PATTERNS = [
  /not a mod directory/i,
  /^Note: Git Bash not detected/i,
  /^Git Bash-only features/i,
  /^To enable Git Bash features/i,
  /^\s*or set: CODEBUDDY_CODE_GIT_BASH_PATH=/,
  /^Suppress this notice with:/,
];

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function stripNoise(text) {
  if (!text) return '';
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter(line => !NOISE_PATTERNS.some(re => re.test(line)))
    .join('\n')
    .trim();
}

/**
 * 执行一次 CLI 调用。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, durationMs:number, timedOut:boolean, argv:string[]}>}
 */
export function runCli({
  prompt,
  pluginDir,
  agent,
  cwd = process.cwd(),
  accessToken,
  timeoutSec = 600,
  options = {},
  env = {},
  signal,
  onStdout,
  onStderr,
} = {}) {
  const cli = resolveCliScript();
  const node = resolveNodeBinary();
  const argv = buildCliArgs({ prompt, pluginDir, agent, options });

  if (!accessToken) {
    return Promise.reject(Object.assign(new Error('缺少 accessToken'), { code: 'NO_TOKEN' }));
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;

    // CLI 自己的生死线。归一化保证它永远是一个正数：
    // 传 0 / 负数 / NaN 会退回 fallback，绝不会变成「永不超时」。
    const hardTimeoutSec = normalizeTimeout(timeoutSec, 600);

    const child = spawn(node.path, [cli.path, ...argv], {
      cwd,
      env: cliEnv({ CODEBUDDY_AUTH_TOKEN: accessToken, ...env }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; onStdout?.(d); });
    child.stderr.on('data', d => { stderr += d; onStderr?.(d); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }, 5000).unref?.();
    }, hardTimeoutSec * 1000);

    // 外部取消（工具 exec.signal / Ctrl-C）必须真的干掉子进程，
    // 否则被中断的调用会留下一个仍在消耗额度的孤儿 CLI。
    const onAbort = () => {
      aborted = true;
      try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } }, 3000).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', err => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(err, { code: 'SPAWN_FAILED', argv }));
    });

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: stripNoise(stdout),
        rawStdout: stdout,
        stderr: stripNoise(stderr),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        timeoutSec: hardTimeoutSec,
        argv,
        cliPath: cli.path,
        cliSource: cli.source,
        nodePath: node.path,
      });
    });
  });
}

/** 只跑一次轻量命令，用来探测 CLI 是否可执行（不消耗模型额度）。 */
export async function cliVersion({ timeoutSec = 30 } = {}) {
  const cli = resolveCliScript();
  const node = resolveNodeBinary();
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(node.path, [cli.path, '--version'], {
      env: cliEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutSec * 1000);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, version: out.trim().split(/\r?\n/).pop() ?? '', stderr: stripNoise(err) });
    });
  });
}

/** 取 --help 全文（用于探测某个参数是否仍被支持）。 */
export async function cliHelp({ timeoutSec = 30 } = {}) {
  const cli = resolveCliScript();
  const node = resolveNodeBinary();
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const child = spawn(node.path, [cli.path, '--help'], {
      env: cliEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutSec * 1000);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out + '\n' + err);
    });
  });
}
