/**
 * 专家（CodeBuddy 插件包）发现与解析。
 *
 * WorkBuddy 的「专家」本质是 CodeBuddy 插件包：
 *   <experts>/<name>/<version>/ 下面有 .codebuddy-plugin/plugin.json + agents/*.md
 * 加载方式：--plugin-dir <包目录> --agent <agentName>
 */
import fs from 'node:fs';
import path from 'node:path';
import { expertsDir } from './paths.mjs';

const ENGINE_MANIFEST = path.join('.codebuddy-plugin', 'plugin.json');

/** 语义化版本比较，只认数字段，够用。 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 从 agents/*.md 推断 agent 名（没有 agentName 字段时的兜底）。 */
function inferAgentName(pkgDir, manifest) {
  if (manifest.agentName) return manifest.agentName;
  const list = Array.isArray(manifest.agents) ? manifest.agents : [];
  const first = list.map(p => String(p)).find(p => p.endsWith('.md'));
  if (first) return path.basename(first, '.md');
  // 最后兜底：扫 agents 目录
  const agentsDir = path.join(pkgDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    const md = fs.readdirSync(agentsDir).find(f => f.endsWith('.md'));
    if (md) return path.basename(md, '.md');
  }
  return null;
}

/**
 * 列出本地已安装专家（同名多版本只保留最高版本）。
 * @returns {Array<{name:string, agent:string|null, version:string, description:string, dir:string, category:string|null, hasSkills:boolean, hasHooks:boolean, hasMcp:boolean}>}
 */
export function listExperts() {
  const root = expertsDir();
  if (!fs.existsSync(root)) return [];

  const byName = new Map();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nameDir = path.join(root, entry.name);
    let versions;
    try {
      versions = fs.readdirSync(nameDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch { continue; }

    for (const version of versions) {
      const pkgDir = path.join(nameDir, version);
      const manifestPath = path.join(pkgDir, ENGINE_MANIFEST);
      if (!fs.existsSync(manifestPath)) continue;

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch { continue; }

      const record = {
        name: manifest.name ?? entry.name,
        agent: inferAgentName(pkgDir, manifest),
        version: manifest.version ?? version,
        description: manifest.description ?? '',
        dir: pkgDir,
        category: manifest.category ?? null,
        hasSkills: Array.isArray(manifest.skills) && manifest.skills.length > 0,
        hasHooks: Boolean(manifest.hooks),
        hasMcp: fs.existsSync(path.join(pkgDir, '.mcp.json')),
      };

      const prev = byName.get(record.name);
      if (!prev || cmpVersion(record.version, prev.version) > 0) byName.set(record.name, record);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 按专家 name 或 agent 名解析（两者都接受，避免调用方记两套名字）。
 * @returns {object|null}
 */
export function resolveExpert(identifier) {
  if (!identifier) return null;
  const all = listExperts();
  const key = String(identifier).toLowerCase();
  return (
    all.find(e => e.name.toLowerCase() === key)
    ?? all.find(e => (e.agent ?? '').toLowerCase() === key)
    ?? all.find(e => e.name.toLowerCase().includes(key))
    ?? null
  );
}

/** 供报错提示用：给出最接近的候选。 */
export function suggestExperts(identifier, limit = 5) {
  const key = String(identifier ?? '').toLowerCase();
  const all = listExperts();
  if (!key) return all.slice(0, limit).map(e => e.name);
  const scored = all
    .map(e => {
      const n = e.name.toLowerCase();
      let score = 0;
      if (n.startsWith(key)) score = 3;
      else if (n.includes(key)) score = 2;
      else if (key.includes(n)) score = 1;
      return { e, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.e.name);
}
