import { UfiClient } from './client';

declare const KANO_baseURL: string;
declare const common_headers: { authorization?: string | null };
declare const originFetch: typeof globalThis.fetch;

/** Current UFI classic-script lexical binding, preserved by renameGlobals:false. */
export const hostFetch: typeof globalThis.fetch = (input, init) => {
  if (typeof originFetch !== 'function')
    throw new Error('UFI 原始请求接口不可用，请更新 UFI-TOOLS 后刷新页面');
  return originFetch.call(globalThis, input, init);
};

export function createUfiHostClient(): UfiClient {
  if (typeof KANO_baseURL !== 'string' || typeof common_headers !== 'object' || common_headers === null)
    throw new Error('UFI 宿主接口不可用');
  const base = new URL(KANO_baseURL, location.href);
  if (!/^\/api\/?$/.test(base.pathname) || base.search || base.hash)
    throw new Error('UFI API 地址无效');
  return new UfiClient({ origin: base.origin, authorization: () => common_headers.authorization, fetch: hostFetch });
}
