import ky, { isHTTPError, isNetworkError } from 'ky';

export type RequestContext = { step: string; target: string; hint: string };

export function requestFailure(context: RequestContext, reason: string): Error {
  return new Error(
    `${context.step}失败\n请求：${context.target}\n原因：${reason}\n建议：${context.hint}`,
  );
}

export function transportFailure(
  context: RequestContext,
  error: unknown,
): Error {
  if (isNetworkError(error)) error = error.cause;
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const reason =
    name === 'AbortError' || name === 'TimeoutError'
      ? '请求超时'
      : '未获得可读取的 HTTP 响应；网络、DNS、TLS 或浏览器限制均可能导致此错误';
  return requestFailure(context, `${reason}\n原始错误：${name}: ${message}`);
}

export async function request(
  url: string,
  options: RequestInit,
  context: RequestContext,
) {
  try {
    // UFI uploads are not idempotent. Never replay them automatically or impose
    // a second timeout over the host's own request lifecycle.
    return await ky(url, { ...options, retry: 0, timeout: false });
  } catch (error) {
    if (!isHTTPError(error)) throw transportFailure(context, error);
    const response = error.response;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0');
    throw requestFailure(
      context,
      `HTTP ${response.status}${rateLimited ? '（请求已被限流，请稍后重试）' : response.status === 401 ? '（认证失败，请重新登录）' : ''}`,
    );
  }
}

export async function responseJSON(
  response: Response,
  context: RequestContext,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw transportFailure(context, error);
    throw requestFailure(
      context,
      '响应不是有效 JSON，可能返回了登录页或错误页',
    );
  }
}
