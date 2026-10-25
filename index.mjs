/**
 * dsh-workbuddy-out —— DSH 插件入口。
 *
 * 把任务派给 WorkBuddy 上的 CodeBuddy 专家，读回交接文档与产物。
 * 业务逻辑全在 lib/ 里（那部分不依赖宿主，CLI 也能直接用），这里只负责
 * 「注册成模型能调的工具」这一件事。
 *
 * ## 为什么不用 defineTool / Schemastery
 *
 * 本包是以目录方式（`file:`）挂进 profile 的，它的 realpath 就在插件目录本身，
 * 那里没有 node_modules。实测从该路径解析 `@deepseek-ai/schemastery` 会
 * ERR_MODULE_NOT_FOUND。虽然同类插件也 import 这些包且能跑，
 * 说明宿主有额外的解析机制，但那不是公开契约 —— 一旦它变了，插件会整体加载失败。
 *
 * 所以这里走 `ctx.tools.register()` 裸定义（dsh-sticky-notes-desktop 也是这么做的），
 * 参数校验由 validateArgs 自己承担。代价是几十行校验代码，换来的是零外部依赖。
 *
 * 配置同样不需要 Schemastery：可调项都在 `~/.dsh/workbuddy-out/config.json`
 * 和插件行 config 里，由 lib/config.mjs 统一读取，不引入第二套配置源。
 *
 * @module dsh-workbuddy-out
 */
import fs from 'node:fs';
import path from 'node:path';
import { listExperts } from './lib/experts.mjs';
import { executeJob, HANDOFF_FILE } from './lib/run.mjs';
import { doctor } from './lib/probe.mjs';
import { PKG_VERSION } from './lib/paths.mjs';
import { loadConfig, normalizeTimeout } from './lib/config.mjs';
import { formatBytes } from './lib/tmp-guard.mjs';

export const name = 'dsh-workbuddy-out';

/** 只要工具注册表；凭证、专家、CLI 都是本包自己的代码，不占宿主服务。 */
export const inject = ['tools'];

/** 返回给模型的单条字符串上限，防止一次产出把上下文撑爆。 */
const MAX_TEXT = 20000;
/** 交接文档回传上限：够读完四节，又不至于无节制。 */
const MAX_HANDOFF = 12000;

function clip(value) {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n…（已截断，原文 ${s.length} 字）` : s;
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * 所有工具共用的输出形状：`ok` + 给模型读的 `text`，外加各自的结构化字段。
 *
 * `render` **必须返回 ContentBlock 数组**。返回裸字符串在注册和投影阶段都不报错，
 * 但 `dsh-spill-policy` 的 tools/post-execute 监听器会对结果调 `.some(...)`，
 * 于是每次调用都在工具体执行完之后抛 `content.some is not a function` ——
 * 表面上像「活干成了，只是报告坏了」。这里统一收口，杜绝复现。
 */
function textOutput(extraProperties = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' }, ...extraProperties },
    },
    render: (args, value) => [{ type: 'text', text: clip(value?.text) }],
  };
}

/**
 * 把参数方言编译成真正的 JSON Schema —— 这一步不能省。
 *
 * 方言形式是「属性表」：`{ 名字: { type, required?, description } }`。它**不是**
 * JSON Schema：根节点没有 `type`，`required` 是属性上的布尔而不是根上的数组。
 * 宿主里的 `defineTool()` 会先过 `parameterSchemaSpecToJsonSchema()` 做这次编译，
 * 但我们不走 defineTool（见文件头），所以必须自己编译，否则 `parameters` 被原样
 * 送进 DeepSeek 的 tools[].function.parameters，根上 `type` 是 undefined，
 * 接口直接拒整个请求：
 *   Invalid schema for function 'xxx': schema must be a JSON Schema of
 *   'type': 'object', got 'type': null.
 * 一旦注册出一个这样的工具，会话里每一轮请求都会带着它 → 每轮都失败，
 * 表现为「宿主把自己写死了」。
 *
 * 编译规则与宿主保持一致：根固定 `type:'object'`，属性上的 `required: true`
 * 收集进根的 `required` 数组，并从属性自身剥掉（属性级的布尔 required 在
 * JSON Schema 里是另一个含义，留着会让校验器误判）。
 */
function paramSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, rule] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = rule;
    properties[key] = { ...rest };
    if (isRequired) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

/** 参数方言：`{ name: { type, required?, description } }`。 */
function validateArgs(spec, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const value = args[key];
    const present = value !== undefined && value !== null && value !== '';

    if (!present) {
      if (rule.required) return { ok: false, error: `缺少必填参数 ${key}（${rule.description}）` };
      continue;
    }
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') return { ok: false, error: `${key} 应该是字符串` };
        out[key] = value;
        break;
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) return { ok: false, error: `${key} 应该是数字` };
        out[key] = n;
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} 应该是布尔值` };
        out[key] = value;
        break;
      default:
        out[key] = value;
    }
    if (rule.maxLength && typeof out[key] === 'string' && out[key].length > rule.maxLength) {
      return { ok: false, error: `${key} 太长（上限 ${rule.maxLength} 字）` };
    }
  }
  return { ok: true, value: out };
}

function formatExpertLine(e) {
  const desc = (e.description || '').replace(/\s+/g, ' ').slice(0, 70);
  return `- ${e.name}  (agent: ${e.agent ?? '未知'})  v${e.version}${desc ? `  — ${desc}` : ''}`;
}

/** 把 executeJob 的失败收敛成模型能听懂、能据此行动的话。 */
function explainFailure(error) {
  switch (error?.code) {
    case 'EXPERT_NOT_FOUND': {
      const hints = error.hints ?? [];
      return `找不到这个专家。${hints.length ? `相近的候选：${hints.join('、')}。` : ''}先用 workbuddy_list_experts 看本地装了哪些。`;
    }
    case 'EXPERT_NO_AGENT':
      return '这个专家包里没有可用的 agent 定义，换一个专家。';
    case 'TOKEN_EXPIRED':
      return 'WorkBuddy 登录已过期。需要在终端跑一次 `wb login`（或 `node bin/wb.mjs login`）重新开链接登录 —— 这是整条链路里唯一必须人工介入的一步。';
    case 'NO_TOKEN':
      return '还没有 WorkBuddy 登录凭证。请用户先跑一次 `wb login`。';
    case 'TOKEN_CORRUPT':
      return 'WorkBuddy 凭证文件损坏，需要重新 `wb login`。';
    case 'CLI_NOT_FOUND':
      return `找不到 WorkBuddy 的 CLI。确认 WorkBuddy 桌面端还装着，或用 WORKBUDDY_CLI 指定 bin/codebuddy 路径。${error.tried?.length ? `\n已尝试：\n${error.tried.join('\n')}` : ''}`;
    case 'NODE_NOT_FOUND':
      return '找不到可用于运行 CLI 的 node.exe（当前进程是 Electron，不能代替）。请安装 Node.js，或用 WORKBUDDY_NODE 指定路径。';
    case 'BAD_USAGE':
      return `调用参数有问题：${error.message}`;
    default:
      return `派活失败：${error?.message ?? String(error)}`;
  }
}

export function buildTools(ctx, rowConfig) {
  const logger = typeof ctx?.logger === 'function' ? ctx.logger('workbuddy-out') : null;

  /** 每一行 config（cordis.yml 里该插件行的 config）+ config.json 的统一视图。 */
  const effectiveConfig = () => {
    const fileCfg = loadConfig();
    const row = rowConfig ?? {};
    return {
      defaultTimeoutSec: Number(row.defaultTimeoutSec) || fileCfg.defaultTimeoutSec || 900,
      defaultModel: (typeof row.defaultModel === 'string' && row.defaultModel) || fileCfg.defaultModel || '',
      handoff: typeof row.handoff === 'boolean' ? row.handoff : fileCfg.handoff !== false,
    };
  };

  return [
    {
      name: 'workbuddy_list_experts',
      description:
        'List the WorkBuddy expert agents installed on this machine. ' +
        'WorkBuddy experts are packaged CodeBuddy plugins — a PPT maker, an AI short-drama director, a speech/pitch coach, and so on — ' +
        "that run on the user's WorkBuddy account credits (daily check-in, free/night-free models) instead of this session's tokens. " +
        'Call this before workbuddy_run when you do not already know an expert name, or when a run reported an unknown expert.',
      parameters: paramSchema({
        search: {
          type: 'string',
          description: 'Optional case-insensitive filter over name, agent name, and description.',
        },
      }),
      output: textOutput({ experts: { type: 'array' } }),
      async execute(rawArgs) {
        const checked = validateArgs({ search: { type: 'string' } }, rawArgs);
        if (!checked.ok) return { ok: false, text: checked.error, experts: [] };
        const { search } = checked.value;

        const all = listExperts();
        if (all.length === 0) {
          return {
            ok: false,
            text:
              '本机没有已安装的 WorkBuddy 专家。\n' +
              '专家包缓存在 %USERPROFILE%\\.workbuddy\\plugins\\cache\\experts\\ —— 需要用户先在 WorkBuddy 桌面端的专家市场下载至少一个。',
            experts: [],
          };
        }

        const key = search ? search.trim().toLowerCase() : '';
        const hit = key
          ? all.filter(e =>
              e.name.toLowerCase().includes(key) ||
              (e.agent ?? '').toLowerCase().includes(key) ||
              (e.description ?? '').toLowerCase().includes(key))
          : all;

        if (hit.length === 0) {
          return {
            ok: true,
            text: `没有匹配「${search}」的专家。本地共有 ${all.length} 个：\n${all.map(formatExpertLine).join('\n')}`,
            experts: all,
          };
        }

        return {
          ok: true,
          text: [
            `本地已安装 ${hit.length} 个 WorkBuddy 专家${key ? `（过滤：${search}）` : ''}：`,
            '',
            ...hit.map(formatExpertLine),
            '',
            '派活：workbuddy_run({ expert: "<name>", task: "<要它做什么>" })',
          ].join('\n'),
          experts: hit,
        };
      },
    },

    {
      name: 'workbuddy_status',
      description:
        'Check whether the WorkBuddy outsourcing channel is usable right now: CLI found, node runtime found, login valid (and days left), ' +
        'how many experts are installed. Call this when a workbuddy_run failed with a CLI or authentication error, or before starting a batch of long jobs. ' +
        'Cheap — it does not consume model credits.',
      parameters: paramSchema({}),
      output: textOutput({ checks: { type: 'array' } }),
      async execute() {
        const report = await doctor({ includeHelp: false });
        const lines = [`WorkBuddy 外包通道 v${PKG_VERSION}`, ''];
        for (const c of report.checks) {
          lines.push(`${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? `\n    ${c.detail}` : ''}`);
        }
        lines.push('', report.ok ? '结论：可用。' : `结论：${report.summary.failed.length} 项不通过（${report.summary.failed.join(', ')}）。`);
        return { ok: report.ok, text: lines.join('\n'), checks: report.checks };
      },
    },

    {
      name: 'workbuddy_run',
      description:
        "Hand a task to a WorkBuddy expert agent and wait for it to finish. The expert works in its own CLI process on the user's WorkBuddy credits, " +
        'writes output files into the working directory, and is asked to write a `_handoff.md` covering what it did, the decisions it made and their costs, ' +
        'the artifact list, and open questions. That handoff is returned in this tool result so you can verify the work and decide whether to redo it — ' +
        "do not trust the expert's claims blindly, check the artifacts yourself.\n\n" +
        'Use it for work a specialist does better than you: slide decks, reports, storyboards, speech scripts, long-form writing. ' +
        'Do NOT use it for small edits you can do directly — it spends the user quota and takes minutes.\n\n' +
        'If it fails with an auth error, the user must run `wb login` once; that is the only manual step.',
      parameters: paramSchema({
        expert: {
          type: 'string',
          required: true,
          description: 'Expert name or agent name, e.g. "ppt-implement" or "ppt-creation-expert". Use workbuddy_list_experts to discover.',
        },
        task: {
          type: 'string',
          required: true,
          description: 'What the expert should produce. Be concrete: subject, audience, length, format, constraints. The expert sees only this text.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for the job. Omit to auto-create one under the plugin state directory; pass a real project path when the expert should see existing files.',
        },
        timeout_sec: {
          type: 'number',
          description:
            'Soft-to-hard timeout in seconds, binding both the CLI process and this tool call. Defaults to the configured value (900). ' +
            'Big decks or long reports may need 1800+. This is the ONLY limit that decides when the job is killed: there is no separate ' +
            'fixed cap on this tool, so a value here is honored end to end. Values <= 0 or > 86400 are clamped.',
        },
        model: {
          type: 'string',
          description: 'Optional WorkBuddy model id (auto, glm-5.1, deepseek-v3-2-volc, kimi-k2.5, ...). Omit to let WorkBuddy choose.',
        },
        handoff: {
          type: 'boolean',
          description: 'Whether to require the _handoff.md protocol. Defaults to true; set false only for a throwaway probe.',
        },
      }),
      output: textOutput({
        exitCode: { type: 'number' },
        durationMs: { type: 'number' },
        workDir: { type: 'string' },
        handoffPath: { type: 'string' },
        handoffMarkdown: { type: 'string' },
        artifacts: { type: 'array' },
      }),
      // 刻意不声明 timeoutMs —— 这不是遗漏，是必须。
      //
      // DSH 的工具超时策略（dsh-tool-call-timeout-policy）读到 `timeoutMs === undefined`
      // 时会直接放行，不武装任何外层 deadline。这里必须让它放行：
      // 一旦写死一个数字，它就成了一条比 timeout_sec 更早的死亡线。真实踩过——
      // 传 timeout_sec: 1800，而这里写着 1_200_000（20 分钟），于是 CLI 本该在 30 分钟
      // 才收手，工具却先在第 20 分钟被判定超时：产物全在盘上，结果却回不来。
      //
      // 生死线只留一条：lib/cli.mjs 按 timeout_sec 武装的 SIGTERM → 5s → SIGKILL。
      // 调用方传的 timeout_sec 因此是真的生效的，不是一个被忽略的提示。
      async execute(rawArgs, exec) {
        const checked = validateArgs({
          expert: { type: 'string', required: true, description: '专家名' },
          task: { type: 'string', required: true, description: '任务说明' },
          cwd: { type: 'string' },
          timeout_sec: { type: 'number' },
          model: { type: 'string' },
          handoff: { type: 'boolean' },
        }, rawArgs);
        if (!checked.ok) return { ok: false, text: checked.error, exitCode: -1 };
        const args = checked.value;

        const cfg = effectiveConfig();
        const timeoutSec = normalizeTimeout(args.timeout_sec, cfg.defaultTimeoutSec);
        const model = args.model ? args.model.trim() : (cfg.defaultModel || undefined);
        const handoff = args.handoff === undefined ? cfg.handoff : Boolean(args.handoff);

        let result;
        try {
          result = await executeJob({
            expert: args.expert,
            task: args.task,
            cwd: args.cwd ? args.cwd.trim() : undefined,
            timeoutSec,
            model,
            handoff,
            signal: exec?.signal,
          });
        } catch (error) {
          logger?.warn?.(`run failed: ${error?.code ?? 'UNKNOWN'} ${error?.message ?? ''}`);
          return { ok: false, text: explainFailure(error), exitCode: -1 };
        }

        const secs = Math.round(result.durationMs / 1000);
        const created = result.artifacts.created.map(a => `${a.file} (${humanBytes(a.size)})`);
        const modified = result.artifacts.modified.map(a => `${a.file} (${humanBytes(a.size)})`);

        let handoffText = '';
        if (result.hasHandoff) {
          try {
            const raw = fs.readFileSync(result.handoffPath, 'utf8');
            handoffText = raw.length > MAX_HANDOFF
              ? `${raw.slice(0, MAX_HANDOFF)}\n…（交接文档已截断，完整内容见 ${result.handoffPath}）`
              : raw;
          } catch (e) {
            handoffText = `（读取交接文档失败：${e.message}）`;
          }
        }

        const ok = result.exitCode === 0;
        const lines = [];
        lines.push(
          ok
            ? `✓ ${result.expert.name} 完成，用时 ${secs}s`
            : `✗ ${result.expert.name} 未正常结束（exit=${result.exitCode}，CLI exit=${result.code}，用时 ${secs}s）`,
        );
        if (result.aborted) lines.push('（本次调用被中断，子进程已终止）');
        if (result.timedOut) lines.push(`（超过 ${timeoutSec}s 被强制终止 —— 可以调大 timeout_sec 重试）`);
        lines.push('', `工作目录：${result.workDir}`);
        if (created.length) lines.push(`新增产物：\n${created.map(s => `  - ${s}`).join('\n')}`);
        if (modified.length) lines.push(`修改产物：\n${modified.map(s => `  - ${s}`).join('\n')}`);
        if (!created.length && !modified.length) {
          lines.push('产物：（工作目录内没有文件变化 —— 专家可能只给了对话回答，需要追问或重派）');
        }
        if (handoffText) lines.push('', `交接文档（${HANDOFF_FILE}）：`, '', handoffText);
        else if (handoff) lines.push('', `⚠ 专家没有写 ${HANDOFF_FILE}。过程说明缺失，需要自己看文件核对。`);

        if (result.archivedHandoff) {
          lines.push('', `（上一轮交接已归档为 ${path.basename(result.archivedHandoff)}，历史记录未丢）`);
        }
        if (result.restoredHandoff) {
          lines.push('', '（本轮没有产出新交接，上一轮的交接文档已恢复原位，历史未被破坏）');
        }

        // 临时目录结算：专家常把无头浏览器 profile / 脚本 / 截图留在 %TEMP%。
        const tmp = result.tmp;
        if (tmp && tmp.mode !== 'off' && (tmp.added?.length ?? 0) > 0) {
          const size = formatBytes(tmp.totalBytes);
          const base = p => path.basename(p);
          if (tmp.mode === 'auto') {
            const failedNote = tmp.failed.length ? `，${tmp.failed.length} 项删不掉已跳过` : '';
            lines.push('', `临时目录：回收 ${tmp.removed.length} 项 / ${size}${failedNote}`);
            if (tmp.removed.length) {
              const names = tmp.removed.slice(0, 6).map(base).join('、');
              lines.push(`  已删：${names}${tmp.removed.length > 6 ? ' …' : ''}`);
            }
            if (tmp.failed.length) {
              lines.push(`  残留：${tmp.failed.slice(0, 4).map(f => `${base(f.path)}（${f.reason}）`).join('、')}`);
            }
          } else {
            lines.push('', `临时目录：本次新增 ${tmp.added.length} 项 / ${size}，未清理（tmpCleanup=report）`);
            lines.push(`  清单：${tmp.added.slice(0, 8).map(base).join('、')}${tmp.added.length > 8 ? ' …' : ''}`);
            lines.push('  清理：wb clean');
          }
        }

        if (!ok && result.stderr) lines.push('', '--- 错误输出 ---', result.stderr.slice(0, 1500));
        if (!ok && result.stdout && !result.hasHandoff) lines.push('', '--- 标准输出 ---', result.stdout.slice(0, 1500));

        return {
          ok,
          text: lines.join('\n'),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          workDir: result.workDir,
          handoffPath: result.hasHandoff ? result.handoffPath : '',
          handoffMarkdown: handoffText,
          timeoutSec: result.timeoutSec ?? timeoutSec,
          tmp: {
            mode: result.tmp?.mode ?? 'off',
            added: result.tmp?.added?.length ?? 0,
            removed: result.tmp?.removed?.length ?? 0,
            bytes: result.tmp?.totalBytes ?? 0,
          },
          artifacts: [
            ...result.artifacts.created.map(a => ({ path: a.file, bytes: a.size, change: 'created' })),
            ...result.artifacts.modified.map(a => ({ path: a.file, bytes: a.size, change: 'modified' })),
          ],
        };
      },
    },
  ];
}

export function apply(ctx, rowConfig) {
  for (const definition of buildTools(ctx, rowConfig)) {
    // ctx.tools.register 自带 effect 语义：插件卸载时工具自动注销。
    ctx.tools.register(definition);
  }
}
