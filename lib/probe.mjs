/**
 * 兼容性自检 —— 回答「现在还能不能用」以及「哪里坏了」。
 *
 * 这是「固化 CLI」的保险丝：WorkBuddy 升级后，如果关键参数没了、
 * dist 改名了、或者 node 换位置了，doctor 会明确指出，而不是等到跑任务才炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { cliHelp, cliVersion } from './cli.mjs';
import { listExperts } from './experts.mjs';
import {
  PKG_ROOT, PKG_VERSION, expertsDir, resolveCliScript, resolveNodeBinary, stateDir, workbuddyHome,
} from './paths.mjs';
import { inspectToken } from './token.mjs';

/** 契约依赖的 CLI 参数，缺任何一个都要报警。 */
const REQUIRED_FLAGS = ['--plugin-dir', '--agent', '-p', '--output-format', '--model', '-y'];
/** 契约依赖的安装内文件（相对安装根）。 */
const REQUIRED_FILES = [
  path.join('dist', 'codebuddy-lite-wb.mjs'),
];

function checkFile(p) {
  try {
    const st = fs.statSync(p);
    return { ok: st.isFile(), size: st.size };
  } catch {
    return { ok: false, size: 0 };
  }
}

/**
 * 完整自检。永不抛异常，失败信息都在返回值里。
 * @returns {Promise<{ok:boolean, checks:Array<{id:string, ok:boolean, label:string, detail:string}>, summary:object}>}
 */
export async function doctor({ includeHelp = true } = {}) {
  const checks = [];
  const push = (id, ok, label, detail) => checks.push({ id, ok, label, detail });

  // 1. 包自身
  push('pkg', fs.existsSync(path.join(PKG_ROOT, 'package.json')), '插件包完整', `${PKG_ROOT} (v${PKG_VERSION})`);

  // 2. WorkBuddy 用户数据
  const wbHome = workbuddyHome();
  push('wbHome', fs.existsSync(wbHome), 'WorkBuddy 数据目录', wbHome);

  // 3. CLI 脚本
  let cli = null;
  try {
    cli = resolveCliScript();
    push('cli', true, 'WorkBuddy CLI', `${cli.path}\n        来源: ${cli.source}`);
  } catch (e) {
    push('cli', false, 'WorkBuddy CLI', e.message);
  }

  // 4. node 运行时
  let node = null;
  let nodeVersion = '';
  try {
    node = resolveNodeBinary();
    nodeVersion = node.path === process.execPath ? process.version : '';
    push('node', true, 'Node 运行时', `${node.path}\n        来源: ${node.source}${nodeVersion ? ` (${nodeVersion})` : ''}`);
  } catch (e) {
    push('node', false, 'Node 运行时', e.message);
  }

  // 5. 安装内必需文件
  if (cli) {
    // CLI 脚本位于 <cli>/bin/codebuddy，dist 是 <cli>/dist 的兄弟目录
    const installRoot = path.resolve(path.dirname(cli.path), '..');
    for (const rel of REQUIRED_FILES) {
      const full = path.join(installRoot, rel);
      const r = checkFile(full);
      push(`file:${rel}`, r.ok, `安装文件 ${rel}`, r.ok ? `${(r.size / 1048576).toFixed(1)} MB` : `缺失: ${full}`);
    }
  }

  // 6. CLI 能跑 + 版本
  let version = null;
  if (cli && node) {
    try {
      const v = await cliVersion();
      if (v.code === 0 && v.version) {
        version = v.version;
        push('cliRun', true, 'CLI 可执行', `--version → ${v.version}`);
      } else {
        push('cliRun', false, 'CLI 可执行', `--version 退出码 ${v.code}${v.stderr ? `: ${v.stderr.slice(0, 200)}` : ''}`);
      }
    } catch (e) {
      push('cliRun', false, 'CLI 可执行', e.message);
    }
  }

  // 7. 参数契约仍然成立
  const missingFlags = [];
  if (includeHelp && cli && node && version) {
    try {
      const help = await cliHelp();
      for (const flag of REQUIRED_FLAGS) {
        if (!help.includes(flag)) missingFlags.push(flag);
      }
      push(
        'flags',
        missingFlags.length === 0,
        'CLI 参数契约',
        missingFlags.length === 0
          ? `必需参数全部存在（${REQUIRED_FLAGS.join(' ')}）`
          : `缺少参数: ${missingFlags.join(', ')} —— CLI 可能已升级，请检查 lib/cli.mjs`,
      );
    } catch (e) {
      push('flags', false, 'CLI 参数契约', `读 --help 失败: ${e.message}`);
    }
  }

  // 8. 凭证
  const token = inspectToken();
  push(
    'token',
    token.ok,
    '登录凭证',
    token.ok
      ? `${token.nickname ?? '(未知账号)'} · 剩余约 ${token.remainingDays ?? '?'} 天` +
        (token.expiresAt ? ` · 到期 ${new Date(token.expiresAt).toISOString().slice(0, 10)}` : '')
      : token.message,
  );

  // 9. 专家
  const experts = listExperts();
  const noAgent = experts.filter(e => !e.agent);
  push(
    'experts',
    experts.length > 0 && noAgent.length === 0,
    '本地专家',
    experts.length === 0
      ? `未发现专家（目录: ${expertsDir()}）`
      : `${experts.length} 个${noAgent.length ? ` · ${noAgent.length} 个缺 agent 名: ${noAgent.map(e => e.name).join(', ')}` : ''}`,
  );

  // 10. 状态目录可写
  let stateWritable = false;
  try {
    const probe = path.join(stateDir(), '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    stateWritable = true;
  } catch { /* 保持 false */ }
  push('state', stateWritable, '状态目录可写', stateDir());

  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0,
    checks,
    summary: {
      packageVersion: PKG_VERSION,
      cliPath: cli?.path ?? null,
      cliVersion: version,
      nodePath: node?.path ?? null,
      workbuddyHome: wbHome,
      experts: experts.length,
      missingFlags,
      failed: failed.map(c => c.id),
    },
  };
}

/** 把 doctor 结果渲染成人读的报告。 */
export function formatDoctorReport(report) {
  const lines = [];
  const mark = ok => (ok ? '✓' : '✗');
  lines.push(`WorkBuddy 外包通道自检 · v${report.summary.packageVersion}`);
  lines.push('─'.repeat(52));
  for (const c of report.checks) {
    lines.push(`${mark(c.ok)} ${c.label}`);
    if (c.detail) lines.push(`    ${c.detail}`);
  }
  lines.push('─'.repeat(52));
  lines.push(report.ok ? '结论：全部通过，可以派活。' : `结论：${report.checks.filter(c => !c.ok).length} 项未通过 —— ${report.summary.failed.join(', ')}`);
  return lines.join('\n');
}
