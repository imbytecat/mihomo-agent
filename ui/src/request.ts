import ky, {
  isHTTPError,
  isNetworkError,
  SchemaValidationError,
  type StandardSchemaV1,
} from 'ky';
import { UfiDeviceError, UfiResponseError } from '@imbytecat/ufi-sdk';

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
  const network = isNetworkError(error) ? error : undefined;
  if (network) error = network.cause;
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const timeout = name === 'AbortError' || name === 'TimeoutError';
  const reason = timeout
    ? '请求超时'
    : network
      ? '网络请求失败；网络、DNS、TLS 或浏览器限制均可能导致此错误'
      : '请求执行异常，可能涉及 JavaScript 调用或 UFI 接口适配';
  return requestFailure(
    network || timeout
      ? context
      : { ...context, hint: '请根据原始错误检查插件调用与 UFI 接口。' },
    `${reason}\n原始错误：${name}: ${message}`,
  );
}

export async function requestJSON<Schema extends StandardSchemaV1>(
  url: string,
  options: RequestInit,
  context: RequestContext,
  schema: Schema,
  fetch?: typeof globalThis.fetch,
) {
  try {
    // UFI uploads are not idempotent. Never replay them automatically or impose
    // a second timeout over the host's own request lifecycle.
    return await ky(url, { ...options, fetch, retry: 0, timeout: false }).json(
      schema,
    );
  } catch (error) {
    throw requestError(context, error);
  }
}

export function requestError(context: RequestContext, error: unknown): Error {
  if (error instanceof UfiDeviceError) return requestFailure(context, error.message);
  if (error instanceof SyntaxError)
    return requestFailure(
      context,
      '响应不是有效 JSON，可能返回了登录页或错误页',
    );
  if (error instanceof SchemaValidationError || error instanceof UfiResponseError)
    return requestFailure(context, '响应内容不符合预期格式');
  if (!isHTTPError(error)) return transportFailure(context, error);
  const response = error.response;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get('x-ratelimit-remaining') === '0');
  return requestFailure(
    context,
    `HTTP ${response.status}${rateLimited ? '（请求已被限流，请稍后重试）' : response.status === 401 ? '（认证失败，请重新登录）' : ''}`,
  );
}
