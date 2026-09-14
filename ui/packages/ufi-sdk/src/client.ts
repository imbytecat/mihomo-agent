import ky, { type Options } from 'ky';
import { z } from 'zod';
import { signRequest } from './auth';
import type { Endpoint, Input, Output } from './endpoint';
import { fileName, scalar, uploadInput } from './schemas';

export type RequestOptions = { signal?: AbortSignal; timeout?: number | false };
export type ClientOptions = {
  origin: string;
  fetch: typeof globalThis.fetch;
  authorization?: string | (() => string | undefined | null);
};
type Arguments<E extends Endpoint> = undefined extends Input<E>
  ? [input?: Input<E>, options?: RequestOptions]
  : [input: Input<E>, options?: RequestOptions];
type Fields = Record<string, string | number | boolean>;
export type ForwardOptions = RequestOptions & {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
};
export type GoformOptions = RequestOptions & {
  method?: ForwardOptions['method'];
  query?: Fields;
  form?: Fields;
  cookie?: string;
};

export class UfiDeviceError extends Error {
  override name = 'UfiDeviceError';
  constructor(message: string, readonly path: string) { super(message); }
}

export class UfiResponseError extends Error {
  override name = 'UfiResponseError';
  constructor(readonly path: string, cause: unknown) {
    super(`UFI response does not match ${path}`, { cause });
  }
}

const fields = z.record(z.string(), scalar.optional());
function search(input: unknown): URLSearchParams {
  return new URLSearchParams(Object.entries(fields.parse(input))
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]));
}
function relativePath(path: string): string {
  if (!path || /[\\%\0?#]/.test(path) || path.startsWith('/') || path.split('/').some((part) => !part || part.includes('..')))
    throw new TypeError('A decoded relative UFI path is required');
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Fetch must be a standards-compliant transport, not UFI's wrapped fetch. */
export class UfiClient {
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #authorization: ClientOptions['authorization'];

  constructor(options: ClientOptions) {
    const url = new URL(options.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      throw new TypeError('UFI origin must be an HTTP(S) origin without credentials or path');
    if (typeof options.fetch !== 'function') throw new TypeError('A fetch implementation is required');
    this.#origin = url.origin;
    this.#fetch = options.fetch;
    this.#authorization = options.authorization;
  }

  get origin(): string { return this.#origin; }

  async request<E extends Endpoint>(endpoint: E, ...[input, options = {}]: Arguments<E>): Promise<Output<E>> {
    const parsed = endpoint.input.parse(input);
    let path = endpoint.path;
    const body: Pick<Options, 'json' | 'body'> = {};
    if (endpoint.encoding === 'query' && parsed !== undefined) {
      const query = search(parsed).toString();
      if (query) path += `?${query}`;
    } else if (endpoint.encoding === 'multipart') {
      const upload = uploadInput.parse(parsed);
      const form = new FormData();
      const filename = fileName.parse(upload.filename ?? (upload.file instanceof File ? upload.file.name : 'upload.bin'));
      form.append('file', upload.file, filename);
      body.body = form;
    } else if (parsed !== undefined) {
      if (endpoint.bodyLimit !== undefined && new TextEncoder().encode(JSON.stringify(parsed)).byteLength > endpoint.bodyLimit)
        throw new RangeError('UFI request body exceeds the endpoint size limit');
      body.json = parsed;
    }
    const request = this.#send(path, endpoint.method, endpoint.authenticated, { ...body, ...options, timeout: options.timeout ?? endpoint.timeout });
    if (endpoint.raw) return endpoint.output.parse(await request) as Output<E>;
    const value: unknown = await request.json();
    // OTA status has its own error field. A standalone error object represents
    // a failed API operation even when the device returned HTTP 200.
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'error' in value && typeof value.error === 'string')
      throw new UfiDeviceError(value.error, endpoint.path);
    const validated = endpoint.output.safeParse(value);
    if (!validated.success) throw new UfiResponseError(endpoint.path, validated.error);
    return validated.data as Output<E>;
  }

  readUpload(filename: string, options: RequestOptions = {}): Promise<Response> {
    return this.#send(`/api/uploads/${relativePath(filename)}`, 'GET', false, options);
  }

  readAsset(path: string, options: RequestOptions = {}): Promise<Response> {
    const relative = path === '' ? '' : relativePath(path);
    if (relative === 'api' || relative.startsWith('api/')) throw new TypeError('Use a typed endpoint for /api requests');
    return this.#send(`/${relative}`, 'GET', false, options);
  }

  /** The device forwards the request; the SDK returns the response stream. */
  forward(target: string, options: ForwardOptions = {}): Promise<Response> {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new TypeError('Forward target must be an HTTP(S) URL without credentials or fragment');
    const { method: requestedMethod = 'GET', ...init } = options;
    const method = requestedMethod.toUpperCase();
    if (init.body !== undefined && !['POST', 'PUT', 'PATCH'].includes(method))
      throw new TypeError('UFI forwards bodies only for POST, PUT and PATCH');
    return this.#send(`/api/proxy/--${url.href}`, method, true, init);
  }

  /** Firmware command names and result fields vary by device. No login or
   * interpretation of goform result strings is performed implicitly. */
  goform(path: string, options: GoformOptions = {}): Promise<Response> {
    if (!/^[\w./-]+$/.test(path)) throw new TypeError('A canonical goform path is required');
    const { method: requestedMethod = 'GET', query, form, cookie, ...init } = options;
    const method = requestedMethod.toUpperCase();
    if (form !== undefined && !['POST', 'PUT'].includes(method))
      throw new TypeError('UFI forwards goform bodies only for POST and PUT');
    const params = query === undefined ? '' : `?${search(query)}`;
    return this.#send(`/api/goform/${relativePath(path)}${params}`, method, true, {
      ...init,
      headers: cookie === undefined ? undefined : { 'kano-cookie': cookie },
      body: form === undefined ? undefined : search(form),
    });
  }

  #send(path: string, method: string, authenticated: boolean, options: Omit<Options, 'headers'> & { headers?: HeadersInit }) {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin || url.username || url.password || url.hash)
      throw new TypeError('UFI requests must stay on the configured origin');
    const headers = new Headers(options.headers);
    for (const name of ['authorization', 'kano-t', 'kano-sign']) {
      if (headers.has(name)) throw new TypeError(`SDK owns the ${name} header`);
    }
    if (authenticated) {
      const token = typeof this.#authorization === 'function' ? this.#authorization() : this.#authorization;
      if (token) headers.set('authorization', z.string().regex(/^[a-f0-9]{64}$/).parse(token));
      const timestamp = Date.now();
      headers.set('kano-t', String(timestamp));
      headers.set('kano-sign', signRequest(method, url.pathname, timestamp));
    }
    // Some GET endpoints mutate the device. Never retry by HTTP method, and
    // never follow a redirect carrying device authentication to another origin.
    return ky(url, { ...options, timeout: options.timeout ?? 30_000, method, headers, fetch: this.#fetch, credentials: 'omit', redirect: 'error', retry: 0 });
  }
}
