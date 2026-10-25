/**
 * 任务执行 —— 派活给专家、落盘交接文档、记录产物。
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, runCli } from './cli.mjs';
import { loadConfig, normalizeTimeout } from './config.mjs';
import { jobsDir, runsFile, stateDir, workbuddyWorkspace } from './paths.mjs';
import { resolveExpert, suggestExperts } from './experts.mjs';
import { readToken } from './token.mjs';
import { appendLedger, settleTmp, snapshotTmp } from './tmp-guard.mjs';

export const HANDOFF_FILE = '_handoff.md';

/**
 * 强制交接协议。
 * 这是整套方案的关键：专家把过程写出来，主 agent 才能读、校验、返工。
 */
export const DEFAULT_HANDOFF_PROTOCOL = `
---

【交接要求 · 必须遵守】
完成后，请在当前工作目录写入 ${HANDOFF_FILE}，包含以下四节：
1. 做了什么 —— 简要说明
2. 关键决策与取舍 —— 每个选择为什么这么定，代价是什么
3. 产物文件清单 —— 文件名 + 一句话说明（含完整路径）
4. 遗留问题与后续建议

另外两条硬性要求（来自真实的返工教训，不是客套）：
- **文档里出现的任何日期，必须是执行当时的真实日期。** 先真的取一次当前时间（例如 Windows 上
  \`powershell -c Get-Date\`、或 shell 里 \`date\`），按取到的值写。不要凭印象写日期——写错一个日期，
  整份交接文档的可信度都会被推翻。
- **凡是你给出的复现步骤、通关路线、验收结论，必须逐步自检每一步的前置条件在本轮是否真的成立。**
  例如写「第 2 轮可以拿到 X」，就先确认拿 X 所需的开关是不是在更早的轮次里已经打开；
  写「按 A→B→C 即可」，就确认 B 在 A 之后真的可选。写不通的路线比不写更糟。

同时把主产物本身也写入文件，不要只把结果留在对话里。
若某项事实你没有实际核实过，必须明确标注「未核实」，不要编造。`;

/** 目录快照（用于事后算产物增量）。 */
function snapshotDir(dir) {
  const out = new Map();
  const walk = (d, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else {
          const st = fs.statSync(full);
          out.set(full, { size: st.size, mtime: st.mtimeMs });
        }
      } catch { /* 忽略不可读项 */ }
    }
  };
  walk(dir);
  return out;
}

function diffSnapshot(before, after) {
  const created = [], modified = [];
  for (const [file, meta] of after) {
    const prev = before.get(file);
    if (!prev) created.push({ file, size: meta.size });
    else if (prev.size !== meta.size || prev.mtime !== meta.mtime) modified.push({ file, size: meta.size });
  }
  return { created, modified };
}

function appendRun(record) {
  try {
    fs.appendFileSync(runsFile(), JSON.stringify(record) + '\n', 'utf8');
  } catch { /* 记录失败不影响主流程 */ }
}

function slugify(text, max = 40) {
  return String(text)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'job';
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 执行一次外包任务。
 * @param {object} opts
 * @param {string} opts.expert        专家名或 agent 名
 * @param {string} opts.task          任务描述
 * @param {string} [opts.cwd]         工作目录；省略则在 state/jobs/<时间戳>-<slug>/ 下新建
 * @param {number} [opts.timeoutSec]
 * @param {string} [opts.model]
 * @param {boolean} [opts.handoff]    是否附加交接协议（默认 true）
 * @param {Record<string,unknown>} [opts.options] 透传给 buildCliArgs 的其他受管参数
 * @param {(chunk:string)=>void} [opts.onStdout]
 */
export async function executeJob({
  expert,
  task,
  cwd,
  timeoutSec,
  model,
  handoff,
  options = {},
  onStdout,
  onStderr,
  env,
  signal,
} = {}) {
  if (!task || !String(task).trim()) {
    throw Object.assign(new Error('task 不能为空'), { code: 'BAD_USAGE', exitCode: EXIT.USAGE });
  }

  // config.json 提供默认值，显式实参 > 环境变量/配置 > 内置默认
  const cfg = loadConfig();
  // 超时完全跟随调用方传入的 timeout_sec；非法值收敛到配置默认，不会变成「永不超时」。
  const effectiveTimeout = normalizeTimeout(
    timeoutSec ?? process.env.WORKBUDDY_OUT_TIMEOUT,
    cfg.defaultTimeoutSec,
  );
  const effectiveModel = model || cfg.defaultModel || undefined;
  const effectiveHandoff = handoff === undefined ? cfg.handoff !== false : Boolean(handoff);

  const record = resolveExpert(expert);
  if (!record) {
    const hints = suggestExperts(expert);
    throw Object.assign(
      new Error(
        `找不到专家 "${expert}"。\n` +
        (hints.length ? `相近的候选: ${hints.join(', ')}\n` : '') +
        '用 `wb list` 查看本地已安装专家。',
      ),
      { code: 'EXPERT_NOT_FOUND', exitCode: EXIT.EXPERT_NOT_FOUND, hints },
    );
  }
  if (!record.agent) {
    throw Object.assign(
      new Error(`专家 "${record.name}" 的插件包里没有可用的 agent 定义。`),
      { code: 'EXPERT_NO_AGENT', exitCode: EXIT.EXPERT_NOT_FOUND },
    );
  }

  const token = readToken();

  const workDir = cwd
    ? path.resolve(cwd)
    : path.join(jobsDir(), `${timestamp()}-${slugify(expert)}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 同一个工作目录可能被反复派活。专家会直接覆盖 _handoff.md，
  // 上一轮的交接记录就此消失——实测中专家自己动手做了备份，但那纯属它自觉，
  // 不能把历史寄托在一个不受控的进程身上。所以在派活前先把旧交接归档。
  const handoffPath = path.join(workDir, HANDOFF_FILE);
  let archivedHandoff = null;
  if (fs.existsSync(handoffPath)) {
    const archived = path.join(workDir, `_handoff.${timestamp()}.md`);
    try {
      fs.renameSync(handoffPath, archived);
      archivedHandoff = archived;
    } catch {
      /* 归档失败就让专家覆盖，不为一个备份阻塞整次派活 */
    }
  }

  const prompt = effectiveHandoff === false ? task : `${task}\n${DEFAULT_HANDOFF_PROTOCOL}`;
  const before = snapshotDir(workDir);

  // 专家会把中间产物丢进系统临时目录（无头浏览器 profile、脚本、截图）。
  // 派活前拍一张顶层快照，结束后只回收「本次窗口内新增」的那部分。
  const tmpBefore = cfg.tmpCleanup === 'off' ? null : snapshotTmp();

  let result;
  let tmp;
  try {
    result = await runCli({
      prompt,
      pluginDir: record.dir,
      agent: record.agent,
      cwd: workDir,
      accessToken: token.accessToken,
      timeoutSec: effectiveTimeout,
      options: { ...(effectiveModel ? { model: effectiveModel } : {}), ...options },
      onStdout,
      onStderr,
      env,
      signal,
    });
  } finally {
    // 即使 CLI 抛错也要结算临时目录，否则失败的派活反而留下最多垃圾。
    tmp = settleTmp({ before: tmpBefore, mode: cfg.tmpCleanup });
  }

  // 没清掉的那部分（report 模式的新增项 + auto 模式下删失败的项）记账，
  // 交给 `wb clean` 收尾；不记账就只能盲扫整个 %TEMP%，那是错的。
  const pendingTmp = [
    ...(tmp?.mode === 'report' ? tmp.added : []),
    ...(tmp?.failed?.map(f => f.path) ?? []),
  ];
  if (pendingTmp.length) appendLedger(path.join(stateDir(), 'tmp-ledger.jsonl'), pendingTmp);

  const after = snapshotDir(workDir);
  const { created, modified } = diffSnapshot(before, after);
  const hasHandoff = fs.existsSync(handoffPath);

  // 归档了旧的、新的却没产出（超时/失败/专家没写）——把归档改回去，
  // 否则一次失败的派活会让「当前交接文档」凭空消失，只剩一个带时间戳的归档。
  let restoredHandoff = false;
  if (!hasHandoff && archivedHandoff) {
    try {
      fs.renameSync(archivedHandoff, handoffPath);
      archivedHandoff = null;
      restoredHandoff = true;
    } catch {
      /* 恢复失败就保留归档，至少数据还在 */
    }
  }

  const startedAt = Date.now() - result.durationMs;
  const runRecord = {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: result.durationMs,
    expert: record.name,
    agent: record.agent,
    expertVersion: record.version,
    cwd: workDir,
    model: effectiveModel ?? 'auto',
    exitCode: result.code,
    timedOut: result.timedOut,
    aborted: result.aborted === true,
    hasHandoff,
    archivedHandoff,
    restoredHandoff,
    created,
    modified,
    cliVersionSource: result.cliPath,
    timeoutSec: effectiveTimeout,
    tmp: {
      mode: tmp?.mode ?? 'off',
      added: tmp?.added?.length ?? 0,
      bytes: tmp?.totalBytes ?? 0,
      removed: tmp?.removed?.length ?? 0,
      failed: tmp?.failed?.length ?? 0,
    },
  };
  appendRun(runRecord);

  let exitCode = EXIT.OK;
  if (result.aborted) exitCode = EXIT.ABORTED;
  else if (result.timedOut) exitCode = EXIT.TIMEOUT;
  else if (result.code !== 0) exitCode = EXIT.RUN_FAILED;

  return {
    ...result,
    exitCode,
    expert: record,
    workDir,
    handoffPath,
    hasHandoff,
    archivedHandoff,
    restoredHandoff,
    timeoutSec: effectiveTimeout,
    tmp: tmp ?? { mode: 'off', added: [], totalBytes: 0, items: [], removed: [], failed: [] },
    artifacts: { created, modified },
    record: runRecord,
  };
}

/** 判断产物是否值得自动归档到 WorkBuddy 工作区。 */
export const artifactExtensions = new Set(['.docx', '.pptx', '.xlsx', '.pdf', '.md', '.html', '.csv', '.png', '.jpg']);

export function findArtifacts(dir) {
  return [...snapshotDirAny(dir)].filter(f => artifactExtensions.has(path.extname(f.file).toLowerCase()));
}

function* snapshotDirAny(dir) {
  const snap = snapshotDir(dir);
  for (const [file, meta] of snap) yield { file, ...meta };
}

export { workbuddyWorkspace };
