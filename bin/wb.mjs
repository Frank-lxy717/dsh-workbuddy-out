#!/usr/bin/env node
/**
 * wb —— WorkBuddy 专家外包通道的统一命令行入口。
 *
 * 用法：
 *   wb doctor [--json]                    自检：CLI / node / 凭证 / 专家 / 参数契约
 *   wb list [--search <关键词>] [--json]   列出本地已安装专家
 *   wb run --expert <名> --task "<任务>" [选项]   派活给专家
 *   wb login                              重新登录（token 过期时）
 *   wb status [--json]                     精简状态（适合脚本调用）
 *   wb clean [--dry]                       清理派活留下的临时文件
 *   wb version                            版本
 *
 * run 的选项：
 *   --cwd <目录>        工作目录（省略则自动建 state/jobs/<时间>-<专家>/）
 *   --timeout <秒>      超时，默认 900
 *   --model <模型>      指定模型，默认 auto
 *   --max-turns <n>     限制 agent 轮次
 *   --effort <级别>     minimal|low|medium|high|xhigh|max
 *   --no-handoff        不附加交接协议
 *   --json              机器可读输出
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../lib/cli.mjs';
import { doctor, formatDoctorReport } from '../lib/probe.mjs';
import { listExperts } from '../lib/experts.mjs';
import { executeJob } from '../lib/run.mjs';
import { inspectToken } from '../lib/token.mjs';
import { login } from '../lib/auth.mjs';
import { PKG_VERSION, resolveCliScript, resolveNodeBinary, stateDir } from '../lib/paths.mjs';
import { appendLedger, clearLedger, formatBytes, measureAll, readLedger, removePaths, tmpRoot } from '../lib/tmp-guard.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++; }
      else flags.set(key, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const out = text => process.stdout.write(text + '\n');
const err = text => process.stderr.write(text + '\n');
const die = (message, code = EXIT.USAGE) => { err(message); process.exit(code); };

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'help';
const asJson = flags.has('json');

function reportFailure(e) {
  if (asJson) {
    out(JSON.stringify({ ok: false, code: e.code ?? 'UNKNOWN', message: e.message, hints: e.hints ?? [] }, null, 2));
  } else {
    err(`✗ ${e.message}`);
  }
  process.exit(e.exitCode ?? EXIT.USAGE);
}

async function main() {
  switch (command) {
    case 'version': {
      out(`dsh-workbuddy-out v${PKG_VERSION}`);
      return EXIT.OK;
    }

    case 'doctor': {
      const report = await doctor({ includeHelp: flags.has('deep') });
      out(asJson ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return report.ok ? EXIT.OK : EXIT.RUN_FAILED;
    }

    case 'list': {
      const search = typeof flags.get('search') === 'string' ? flags.get('search').toLowerCase() : null;
      let experts = listExperts();
      if (search) {
        experts = experts.filter(e =>
          e.name.toLowerCase().includes(search) ||
          (e.agent ?? '').toLowerCase().includes(search) ||
          e.description.toLowerCase().includes(search));
      }
      if (asJson) { out(JSON.stringify(experts, null, 2)); return EXIT.OK; }
      if (experts.length === 0) {
        out('本地没有已安装的专家。');
        out('专家包缓存目录: ' + path.join(process.env.USERPROFILE ?? '', '.workbuddy', 'plugins', 'cache', 'experts'));
        return EXIT.OK;
      }
      const nameW = Math.max(...experts.map(e => e.name.length), 4);
      const agentW = Math.max(...experts.map(e => (e.agent ?? '').length), 5);
      out(`本地已安装专家 ${experts.length} 个\n`);
      for (const e of experts) {
        const desc = e.description.replace(/\s+/g, ' ').slice(0, 50);
        out(`  ${e.name.padEnd(nameW)}  ${(e.agent ?? '-').padEnd(agentW)}  v${e.version.padEnd(7)} ${desc}`);
      }
      out('');
      out('派活：wb run --expert <名字> --task "<任务>"');
      return EXIT.OK;
    }

    case 'status': {
      const token = inspectToken();
      let cli = null, node = null;
      try { cli = resolveCliScript(); } catch { /* 保持 null */ }
      try { node = resolveNodeBinary(); } catch { /* 保持 null */ }
      const status = {
        packageVersion: PKG_VERSION,
        cli: cli ? { path: cli.path, source: cli.source } : { error: '未找到' },
        node: node ? { path: node.path, source: node.source } : { error: '未找到' },
        auth: token.ok
          ? { ok: true, nickname: token.nickname, uid: token.uid, remainingDays: token.remainingDays }
          : { ok: false, code: token.code, message: token.message },
        experts: listExperts().length,
        stateDir: stateDir(),
      };
      if (asJson) { out(JSON.stringify(status, null, 2)); return EXIT.OK; }
      out(`WorkBuddy 外包通道 v${PKG_VERSION}`);
      out(`  CLI    : ${cli ? cli.path : '未找到'}`);
      out(`  Node   : ${node ? node.path : '未找到'}`);
      out(`  登录   : ${token.ok ? `${token.nickname ?? '已登录'} · 剩余约 ${token.remainingDays} 天` : token.message}`);
      out(`  专家   : ${status.experts} 个`);
      out(`  状态   : ${stateDir()}`);
      return EXIT.OK;
    }

    case 'clean': {
      const dry = flags.has('dry');
      const ledgerFile = path.join(stateDir(), 'tmp-ledger.jsonl');
      const recorded = readLedger(ledgerFile);
      const alive = p => { try { fs.statSync(p); return true; } catch { return false; } };
      const existing = recorded.filter(alive);

      if (!existing.length) {
        out(recorded.length
          ? '账本里记录的临时文件都已经不在了，账本已清空。'
          : '账本是空的 —— 没有待清理的临时文件。');
        clearLedger(ledgerFile);
        return EXIT.OK;
      }

      const { items, totalBytes } = measureAll(existing);
      out(`待清理 ${items.length} 项 / ${formatBytes(totalBytes)}`);
      out(`临时目录：${tmpRoot()}`);
      out('');
      for (const it of items.slice(0, 20)) {
        out(`  ${formatBytes(it.bytes).padStart(9)}  ${it.path}`);
      }
      if (items.length > 20) out(`  … 还有 ${items.length - 20} 项`);

      if (dry) { out('\n（--dry：仅预览，未删除）'); return EXIT.OK; }

      const { removed, failed } = removePaths(existing);
      out('');
      out(`已删除 ${removed.length} 项${failed.length ? `，失败 ${failed.length} 项` : ''}`);
      for (const f of failed.slice(0, 10)) out(`  失败：${f.path}（${f.reason}）`);

      const stillThere = recorded.filter(alive);
      clearLedger(ledgerFile);
      if (stillThere.length) appendLedger(ledgerFile, stillThere);

      return failed.length ? EXIT.RUN_FAILED : EXIT.OK;
    }

    case 'login': {
      const onUrl = url => {
        if (asJson) out(JSON.stringify({ event: 'auth_url', url }));
        else out(`\n请在浏览器打开下面的链接登录（10 分钟内有效）：\n\n  ${url}\n`);
      };
      const onProgress = msg => { if (!asJson) out(msg); };
      try {
        const result = await login({ onUrl, onProgress });
        if (asJson) {
          out(JSON.stringify({ ok: true, nickname: result.account?.nickname, uid: result.account?.uid, days: Math.round(result.expiresIn / 86400) }, null, 2));
        } else {
          out(`\n✓ 登录成功：${result.account?.nickname ?? '(未取到昵称)'}  uid=${result.account?.uid ?? '?'}`);
          out(`  有效期约 ${Math.round(result.expiresIn / 86400)} 天`);
          out(`  凭证已保存: ${result.tokenFile}`);
        }
        return EXIT.OK;
      } catch (e) {
        reportFailure(e);
        return EXIT.NO_TOKEN;
      }
    }

    case 'run': {
      const expert = flags.get('expert');
      const task = flags.get('task');
      if (typeof expert !== 'string' || typeof task !== 'string') {
        die('用法: wb run --expert <专家> --task "<任务>" [--cwd <目录>] [--timeout 900] [--model auto] [--json]');
      }
      const options = {};
      if (typeof flags.get('max-turns') === 'string') options.maxTurns = flags.get('max-turns');
      if (typeof flags.get('effort') === 'string') options.effort = flags.get('effort');

      const cwd = typeof flags.get('cwd') === 'string' ? flags.get('cwd') : undefined;
      const timeoutRaw = flags.get('timeout');
      const timeoutSec = typeof timeoutRaw === 'string' ? Number(timeoutRaw) || undefined : undefined;
      const model = typeof flags.get('model') === 'string' ? flags.get('model') : undefined;
      // 三态：显式 --no-handoff / 显式 --handoff / 不传（交给 config.json）
      const handoff = flags.has('no-handoff') ? false : (flags.has('handoff') ? true : undefined);

      if (!asJson) {
        out(`专家: ${expert}`);
        out(`超时: ${timeoutSec ?? '(配置默认)'}s${model ? ` · 模型: ${model}` : ''}`);
        out('开始执行…\n');
      }

      let result;
      try {
        result = await executeJob({
          expert, task, cwd, timeoutSec, model, options, handoff,
          onStdout: asJson ? undefined : (chunk => process.stderr.write(chunk)),
          onStderr: asJson ? undefined : undefined,
        });
      } catch (e) {
        reportFailure(e);
        return EXIT.USAGE;
      }

      if (asJson) {
        out(JSON.stringify({
          ok: result.exitCode === EXIT.OK,
          exitCode: result.exitCode,
          cliExitCode: result.code,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          expert: { name: result.expert.name, agent: result.expert.agent, version: result.expert.version },
          cwd: result.workDir,
          handoff: result.hasHandoff ? result.handoffPath : null,
          archivedHandoff: result.archivedHandoff ?? null,
          artifacts: result.artifacts,
          timeoutSec: result.timeoutSec,
          tmp: result.tmp
            ? { mode: result.tmp.mode, added: result.tmp.added.length, removed: result.tmp.removed.length, bytes: result.tmp.totalBytes }
            : null,
          output: result.stdout,
        }, null, 2));
        return result.exitCode;
      }

      const secs = Math.round(result.durationMs / 1000);
      out(`\n===== 结束 (exit=${result.code}, 用时 ${secs}s) =====\n`);
      out(result.stdout || '(无输出)');
      if (result.stderr) out(`\n--- stderr ---\n${result.stderr.slice(0, 1000)}`);
      out(`\n工作目录: ${result.workDir}`);
      if (result.hasHandoff) {
        out(`✓ 交接文档: ${result.handoffPath} (${fs.statSync(result.handoffPath).size} 字节)`);
      } else if (result.exitCode !== EXIT.OK) {
        out('⚠ 执行未正常结束，因此没有交接文档');
      } else if (handoff !== false) {
        out('⚠ 未生成 _handoff.md —— 专家可能遗漏了交接要求');
      }
      const created = result.artifacts.created.map(a => path.basename(a.file));
      const modified = result.artifacts.modified.map(a => path.basename(a.file));
      if (created.length) out(`  新增产物: ${created.join(', ')}`);
      if (modified.length) out(`  修改产物: ${modified.join(', ')}`);
      if (!created.length && !modified.length) out('  产物: (目录内无文件变化)');
      if (result.archivedHandoff) {
        out(`  已归档上一轮交接: ${path.basename(result.archivedHandoff)}`);
      }
      if (result.restoredHandoff) {
        out('  上一轮交接已恢复（本轮未产出新交接，历史未被破坏）');
      }

      const tmp = result.tmp;
      if (tmp && tmp.mode !== 'off' && (tmp.added?.length ?? 0) > 0) {
        if (tmp.mode === 'auto') {
          out(`  临时目录: 回收 ${tmp.removed.length} 项 / ${formatBytes(tmp.totalBytes)}`
            + (tmp.failed.length ? `（${tmp.failed.length} 项删不掉，已记账，可 wb clean）` : ''));
        } else {
          out(`  临时目录: 新增 ${tmp.added.length} 项 / ${formatBytes(tmp.totalBytes)}，`
            + `未清理（tmpCleanup=${tmp.mode}）→ wb clean`);
        }
      }

      if (result.exitCode === EXIT.TIMEOUT) {
        out(`\n⏰ 超时被终止（跑了 ${Math.round(result.durationMs / 1000)}s）`);
      }
      return result.exitCode;
    }

    case 'help':
    default: {
      out(`wb —— WorkBuddy 专家外包通道 v${PKG_VERSION}

用法:
  wb doctor [--json] [--deep]          自检（--deep 额外校验 CLI 参数契约）
  wb list [--search <词>] [--json]     列出本地专家
  wb status [--json]                   精简状态
  wb run --expert <名> --task "<任务>"  派活给专家
  wb clean [--dry]                     清理派活留在系统临时目录里的文件
  wb login                             重新登录
  wb version                           版本

wb run 选项:
  --cwd <目录>       工作目录（省略则 state/jobs/<时间>-<专家>/）
  --timeout <秒>     默认 900
  --model <模型>     auto | glm-5.1 | deepseek-v3-2-volc | ...
  --max-turns <n>
  --effort <级别>    minimal|low|medium|high|xhigh|max
  --no-handoff       不附加交接协议
  --json             机器可读输出

退出码: 0 成功 / 1 用法错 / 2 无凭证 / 3 凭证过期 / 4 无此专家 / 5 找不到 CLI / 6 超时 / 7 执行失败`);
      return command === 'help' ? EXIT.OK : EXIT.USAGE;
    }
  }
}

main()
  .then(code => process.exit(code ?? EXIT.OK))
  .catch(e => reportFailure(e));
