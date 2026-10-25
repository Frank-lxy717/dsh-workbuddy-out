/**
 * WorkBuddy OAuth 登录（设备码式，纯 HTTP，无需浏览器回调端口）。
 *
 * 流程：POST /v2/plugin/auth/state 拿 state + authUrl
 *      → 用户在浏览器里登录
 *      → 轮询 GET /v2/plugin/auth/token?state=...
 *      → 拿到 accessToken，再取账号信息
 *
 * UA 里的 2.63.2 是 CodeBuddy 桌面客户端版本号（不是 CLI 版本），
 * 服务端据此识别调用方，改动需谨慎；实测 2.63.2 可用。
 */
import { randomUUID } from 'node:crypto';
import { loginStateFile } from './paths.mjs';
import { saveToken } from './token.mjs';
import fs from 'node:fs';

const ORIGIN = 'https://www.codebuddy.cn';
const LOGIN_BASE = 'https://www.workbuddy.cn';

const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: ORIGIN,
  Referer: ORIGIN + '/',
  'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** state 有效期 600s，轮询下限 3s，这里用 4s 保守一点。 */
const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 150;

/**
 * 发起登录并等待完成。
 * @param {object} opts
 * @param {(url:string)=>void} [opts.onUrl]  拿到授权链接时回调（默认打印到 stdout）
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{account:object|null, expiresIn:number, tokenFile:string}>}
 */
export async function login({ onUrl, onProgress, timeoutMs = 600_000 } = {}) {
  const stateRes = await fetch(`${LOGIN_BASE}/v2/plugin/auth/state?platform=workbuddy`, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: '{}',
    signal: AbortSignal.timeout(25_000),
  });
  const stateJson = await stateRes.json();
  if (stateJson.code !== 0 || !stateJson.data?.state) {
    throw Object.assign(
      new Error(`获取登录 state 失败: ${JSON.stringify(stateJson).slice(0, 300)}`),
      { code: 'AUTH_STATE_FAILED' },
    );
  }

  const state = stateJson.data.state;
  const url = new URL(stateJson.data.authUrl);
  // 某些后端不返回 loginSessionId，补一个，避免授权页报错
  if (!url.searchParams.has('loginSessionId')) url.searchParams.set('loginSessionId', randomUUID());

  try {
    fs.writeFileSync(
      loginStateFile(),
      JSON.stringify({ state, url: url.href, createdAt: Date.now() }, null, 2),
      'utf8',
    );
  } catch { /* 记录失败不影响登录 */ }

  (onUrl ?? (u => console.log(`\n请在浏览器打开下面的链接登录（10 分钟内有效）：\n\n  ${u}\n\n登录完成后无需操作，会自动接住。\n`)))(url.href);

  const deadline = Date.now() + timeoutMs;
  let polls = 0;

  while (Date.now() < deadline && polls < MAX_POLLS) {
    await sleep(POLL_INTERVAL_MS);
    polls++;

    try {
      const tokenRes = await fetch(
        `${LOGIN_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
        { headers: BASE_HEADERS, signal: AbortSignal.timeout(20_000) },
      );
      const tokenJson = await tokenRes.json();

      if (tokenJson.code === 0 && tokenJson.data?.accessToken) {
        let account = null;
        try {
          const accRes = await fetch(
            `${LOGIN_BASE}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
            {
              headers: { ...BASE_HEADERS, Authorization: `Bearer ${tokenJson.data.accessToken}` },
              signal: AbortSignal.timeout(20_000),
            },
          );
          account = (await accRes.json()).data ?? null;
        } catch { /* 取不到账号信息不影响 token 可用 */ }

        const file = saveToken({ token: tokenJson.data, account, obtainedAt: Date.now() });
        return { account, expiresIn: tokenJson.data.expiresIn ?? 0, tokenFile: file };
      }

      if (polls % 15 === 0) onProgress?.(`等待授权中…（已轮询 ${polls} 次）`);
    } catch {
      // 单次网络抖动忽略，继续轮询
    }
  }

  throw Object.assign(new Error('10 分钟内未完成授权，请重试'), { code: 'AUTH_TIMEOUT' });
}
