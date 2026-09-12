export type RequestContext = { step: string; target: string; hint: string };

export function requestFailure(context: RequestContext, reason: string): Error {
  return new Error(`${context.step}失败\n请求：${context.target}\n原因：${reason}\n建议：${context.hint}`);
}

export function transportFailure(context: RequestContext, error: unknown): Error {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const reason = name === 'AbortError' || name === 'TimeoutError' ? '请求超时'
    : '未获得可读取的 HTTP 响应；网络、DNS、TLS 或浏览器限制均可能导致此错误';
  return requestFailure(context, `${reason}\n原始错误：${name}: ${message}`);
}

export async function request(url: string, options: RequestInit, context: RequestContext) {
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) { throw transportFailure(context, error); }
  if (!response.ok) {
    const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
    throw requestFailure(context, `HTTP ${response.status}${rateLimited ? '（请求已被限流，请稍后重试）' : response.status === 401 ? '（认证失败，请重新登录）' : ''}`);
  }
  return response;
}

export async function responseJSON(response: Response, context: RequestContext): Promise<unknown> {
  try { return await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw transportFailure(context, error);
    throw requestFailure(context, '响应不是有效 JSON，可能返回了登录页或错误页');
  }
}
