import ky, {
  isHTTPError,
  isNetworkError,
  SchemaValidationError,
  type StandardSchemaV1,
} from 'ky';

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

export async function requestJSON<Schema extends StandardSchemaV1>(
  url: string,
  options: RequestInit,
  context: RequestContext,
  schema: Schema,
) {
  try {
    // UFI uploads are not idempotent. Never replay them automatically or impose
    // a second timeout over the host's own request lifecycle.
    return await ky(url, { ...options, retry: 0, timeout: false }).json(schema);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw requestFailure(
        context,
        '响应不是有效 JSON，可能返回了登录页或错误页',
      );
    if (error instanceof SchemaValidationError)
      throw requestFailure(context, '响应内容不符合预期格式');
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
