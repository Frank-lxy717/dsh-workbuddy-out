/**
 * 凭证管理 —— 读 token.json、判断有效期、过期给出可操作提示。
 */
import fs from 'node:fs';
import { tokenFile } from './paths.mjs';
import { EXIT } from './cli.mjs';

/** 提前量：离过期不足这个秒数就当作过期，避免「跑到一半失效」。 */
const SAFETY_WINDOW_SEC = 600;

/**
 * @returns {{accessToken:string, expiresAt:number|null, ageDays:number, remainingDays:number|null}}
 * @throws 带 code=NO_TOKEN / TOKEN_EXPIRED 的错误
 */
export function readToken() {
  const file = tokenFile();
  if (!fs.existsSync(file)) {
    throw Object.assign(
      new Error(`没有凭证（${file}）。请先运行: wb login`),
      { code: 'NO_TOKEN', exitCode: EXIT.NO_TOKEN },
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw Object.assign(
      new Error(`凭证文件损坏（${file}）: ${e.message}。请重新运行: wb login`),
      { code: 'TOKEN_CORRUPT', exitCode: EXIT.NO_TOKEN },
    );
  }

  const accessToken = raw?.token?.accessToken;
  if (!accessToken) {
    throw Object.assign(
      new Error(`凭证里没有 accessToken（${file}）。请重新运行: wb login`),
      { code: 'TOKEN_CORRUPT', exitCode: EXIT.NO_TOKEN },
    );
  }

  const obtainedAt = Number(raw.obtainedAt ?? 0);
  const expiresIn = Number(raw?.token?.expiresIn ?? 0);
  const ageSec = obtainedAt ? (Date.now() - obtainedAt) / 1000 : 0;
  const expiresAt = obtainedAt && expiresIn ? obtainedAt + expiresIn * 1000 : null;
  const remainingSec = expiresIn ? expiresIn - ageSec : null;

  if (expiresIn > 0 && remainingSec <= SAFETY_WINDOW_SEC) {
    const days = Math.max(0, Math.round(remainingSec / 86400));
    throw Object.assign(
      new Error(
        `凭证已过期或即将过期（剩余约 ${days} 天，签发于 ${Math.round(ageSec / 86400)} 天前）。\n` +
        `请运行: wb login`,
      ),
      { code: 'TOKEN_EXPIRED', exitCode: EXIT.EXPIRED, expiresAt },
    );
  }

  return {
    accessToken,
    expiresAt,
    ageDays: Math.round(ageSec / 86400),
    remainingDays: remainingSec === null ? null : Math.floor(remainingSec / 86400),
    nickname: raw?.account?.nickname ?? null,
    uid: raw?.account?.uid ?? null,
  };
}

/** 不抛异常版本，用于 doctor / status。 */
export function inspectToken() {
  try {
    return { ok: true, ...readToken() };
  } catch (e) {
    return { ok: false, code: e.code ?? 'UNKNOWN', message: e.message };
  }
}

export function saveToken(payload) {
  const file = tokenFile();
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  return file;
}
