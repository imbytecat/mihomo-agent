import { expect, expectTypeOf, test, vi } from 'vitest';
import {
  UfiClient, UfiDeviceError, UfiResponseError, HTTPError,
  authorizationFromPassword, signRequest, goformAD, goformLoginPassword,
  atCommand, rootShell, userShell, uploadFile, setSmsForwardEnabled, setOfficialPassword, setNickname, forwardMessage,
  setAdvancedMode, versionInfo, downloadApkStatus, setCustomHead, speedtest,
} from '../src/index';
import * as endpoints from '../src/endpoints';

const origin = 'http://192.168.0.1:2333';
const authorization = 'a'.repeat(64);
function client(fetch: typeof globalThis.fetch, token: string | (() => string) = authorization) {
  return new UfiClient({ origin, authorization: token, fetch });
}

test('signatures match independent HMAC/ SHA-256 vectors and ZTE uppercase challenges', () => {
  expect(authorizationFromPassword('admin')).toBe('8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918');
  expect(signRequest('POST', '/api/root_shell', 1718438543772)).toBe('d57c01c35d0533251eb632f12cab5fa239a640a5a82a620e73d4fae1713a3a25');
  expect(signRequest('GET', '/api/AT', 1718438543772)).toBe('a08bd7f005292d963e22c0f64612a2b7148f982bc5eca537773030e1bef28420');
  expect(signRequest('POST', '/api/proxy/--https://example.com/data', 1718438543772)).toBe('665fcb62013da47e3fe06a2a40e1ab1abf1910c2f331ee08b6e1fadfd66586fb');
  expect(goformLoginPassword('password123', 'LD123')).toBe('243D6A7A1C04BE75239D795E86CB7EC204F38787F68BD6E47E75A05A0E3F903F');
  expect(goformAD('inner', 'cr', 'RD123')).toBe('D1DFA3AA0435188ABB28662C2E72A68BC12581D859629B48825A8055812C46BB');
});

test('70 fixed routes cover the official Kotlin registration, without duplicates', () => {
  const get = `baseDeviceInfo connInfo cellularUsage version_info device_id SELinux need_token usb_status volte_status vonr_status get_cookie is_weak_token get_res_server get_log_status get_data_limit get_official_web_password adb_wifi_setting adb_alive AT getSupportNrBandList smbPath disable_fota hasTTYD one_click_shell check_update download_apk_status plugins_store get_custom_head sms_forward_method sms_forward_mail sms_forward_curl sms_forward_enabled power_status_forward_enabled sms_forward_blacklist sms_forward_dingtalk list_tasks get_task get_theme speedtest`;
  const post = `accept_terms set_nickname volte_status vonr_status set_cookie set_token set_res_server set_log_status set_wakelock_status set_data_limit update_admin_pwd adb_wifi_setting user_shell root_shell download_apk install_apk set_custom_head sms_forward_mail sms_forward_curl sms_forward_enabled power_status_forward_enabled sms_forward_blacklist sms_forward_dingtalk do_forward_msg add_task remove_task clear_task upload_img delete_img delete_all_uploads_data set_theme`;
  const expected = [
    ...get.split(' ').map((path) => `GET /api/${path}`),
    ...post.split(' ').map((path) => `POST /api/${path}`),
  ].sort();
  expect(Object.values(endpoints).map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual(expected);
  expect(new Set(expected).size).toBe(70);
});

test('query, JSON, POST-query and raw Root Shell results preserve the wire contract', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1718438543772);
  const requests: Request[] = [];
  const sdk = client(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.includes('/AT?')) return Response.json({ result: '+CSQ: 25,99' });
    if (request.url.endsWith('/root_shell')) return Response.json({ result: 'output without an exit code' });
    return Response.json({ result: 'success' });
  });
  const at = await sdk.request(atCommand, { command: 'AT+CSQ', slot: 1 });
  expectTypeOf(at).toEqualTypeOf<{ result: string }>();
  expect(new URL(requests[0]!.url).searchParams.get('command')).toBe('AT+CSQ');
  expect(requests[0]!.headers.get('kano-sign')).toBe('a08bd7f005292d963e22c0f64612a2b7148f982bc5eca537773030e1bef28420');
  const shell = await sdk.request(rootShell, { command: 'printf fixture', timeout: 1200 });
  expectTypeOf(shell).toEqualTypeOf<{ result: string }>();
  expect(shell.result).toBe('output without an exit code');
  expect(await requests[1]!.json()).toEqual({ command: 'printf fixture', timeout: 1200 });
  expect(requests[1]!.headers.get('kano-sign')).toBe('d57c01c35d0533251eb632f12cab5fa239a640a5a82a620e73d4fae1713a3a25');
  await sdk.request(setSmsForwardEnabled, { enable: '1' });
  expect(requests[2]!.method).toBe('POST');
  expect(new URL(requests[2]!.url).search).toBe('?enable=1');
  expect(await requests[2]!.text()).toBe('');
  for (const request of requests) {
    expect(request.headers.get('authorization')).toBe(authorization);
    expect(request.redirect).toBe('error');
  }
  await sdk.request(setOfficialPassword, { password: '' });
  expect(await requests.at(-1)!.json()).toEqual({ password: '' });
  await sdk.request(setNickname, { nickname: 'x'.repeat(256) });
  expect((await requests.at(-1)!.json()).nickname).toHaveLength(256);
  await sdk.request(forwardMessage, { address: 'fixture', body: 'fixture', timestamp: -1 });
  expect((await requests.at(-1)!.json()).timestamp).toBe(-1);
  const count = requests.length;
  // @ts-expect-error SDK rejects undeclared request fields at compile time and runtime.
  await expect(sdk.request(rootShell, { command: 'fixture', extra: true })).rejects.toThrow();
  await expect(sdk.request(rootShell, { command: 'fixture', timeout: 100_001 })).rejects.toThrow();
  expect(requests).toHaveLength(count);
  await sdk.request(atCommand, { command: 'AT', slot: undefined });
  expect(new URL(requests.at(-1)!.url).searchParams.has('slot')).toBe(false);
});

test('multipart uploads preserve bytes, field name, filename and browser-generated boundary', async () => {
  const bytes = new Uint8Array([0, 255, 128, 42]);
  const sdk = client(async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await request.formData();
    expect([...form.keys()]).toEqual(['file']);
    const file = form.get('file') as File;
    expect(file.name).toBe('request.bin');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return Response.json({ url: '/uploads/fixture.bin' });
  });
  expect(await sdk.request(uploadFile, { file: new File([bytes], 'request.bin') })).toEqual({ url: '/uploads/fixture.bin' });
});

test('public routes omit authentication and credentials, while credentials refresh for private calls', async () => {
  const headers: Headers[] = [];
  let token = authorization;
  const sdk = client(async (input, init) => {
    const request = new Request(input, init);
    headers.push(request.headers);
    if (request.url.endsWith('/version_info'))
      return Response.json({ app_ver: '4.1.3', app_ver_code: '20260908', model: 'fixture', nickname: '', accept_terms: true });
    return Response.json({ result: 'fixture' });
  }, () => token);
  expect(JSON.stringify(client(async () => Response.json({}), authorization))).not.toContain(authorization);
  await sdk.request(versionInfo);
  expect(headers[0]!.has('authorization')).toBe(false);
  expect(headers[0]!.has('kano-sign')).toBe(false);
  expect(headers[0]!.has('kano-t')).toBe(false);
  await sdk.request(rootShell, { command: 'first' });
  token = 'b'.repeat(64);
  await sdk.request(rootShell, { command: 'second' });
  expect(headers[1]!.get('authorization')).toBe(authorization);
  expect(headers[2]!.get('authorization')).toBe(token);
});

test('device errors, invalid schemas and OTA task errors remain distinct', async () => {
  expect(userShell.timeout).toBeGreaterThan(300_000);
  const sdk = client(async () => Response.json({ error: 'operation failed' }));
  await expect(sdk.request(rootShell, { command: 'fixture' })).rejects.toBeInstanceOf(UfiDeviceError);
  const malformed = client(async () => Response.json({ result: { done: true, content: 'not the current root response' } }));
  await expect(malformed.request(rootShell, { command: 'fixture' })).rejects.toBeInstanceOf(UfiResponseError);
  const user = client(async () => Response.json({ result: { done: false, content: 'failed' } }));
  expect((await user.request(userShell, { command: 'fixture' })).result.done).toBe(false);
  const ota = client(async () => Response.json({ status: 'error', percent: 0, error: 'download failed' }));
  expect((await ota.request(downloadApkStatus)).status).toBe('error');
});

test('mutating GET calls never retry, and cancellation reaches the transport', async () => {
  let calls = 0;
  const failing = client(async () => { calls++; return new Response('unavailable', { status: 503 }); });
  await expect(failing.request(setAdvancedMode, { enable: '1' })).rejects.toBeInstanceOf(HTTPError);
  expect(calls).toBe(1);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = client((input, init) => new Promise<Response>((_resolve, reject) => {
    const request = new Request(input, init);
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    started();
  }));
  const operation = blocked.request(rootShell, { command: 'fixture' }, { signal: controller.signal });
  const rejected = expect(operation).rejects.toThrow('cancel fixture');
  await ready;
  controller.abort(new Error('cancel fixture'));
  await rejected;
});

test('binary and generic routes stay streaming and confined to the UFI origin', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1718438543772);
  const requests: Request[] = [];
  const sdk = client(async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(new Uint8Array([1, 2, 3]));
  });
  const stream = await sdk.request(speedtest, { ckSize: 1 });
  expectTypeOf(stream).toEqualTypeOf<Response>();
  expect(stream.bodyUsed).toBe(false);
  await stream.body!.cancel();
  const upload = await sdk.readUpload('fixture.bin');
  await upload.body!.cancel();
  const asset = await sdk.readAsset('script/main.js');
  await asset.body!.cancel();
  expect(requests[1]!.headers.has('authorization')).toBe(false);
  expect(requests[2]!.headers.has('authorization')).toBe(false);
  const forwarded = await sdk.forward('https://example.com/data?q=1', { method: 'POST', body: 'payload', headers: { 'kano-Authorization': 'explicit-upstream-token' } });
  await forwarded.body!.cancel();
  expect(requests[3]!.url).toBe(`${origin}/api/proxy/--https://example.com/data?q=1`);
  expect(requests[3]!.headers.get('kano-sign')).toBe('665fcb62013da47e3fe06a2a40e1ab1abf1910c2f331ee08b6e1fadfd66586fb');
  const goform = await sdk.goform('goform_set_cmd_process', { method: 'POST', cookie: 'session=fixture', form: { goformId: 'FIXTURE', isTest: false } });
  await goform.body!.cancel();
  expect(requests[4]!.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  expect(await requests[4]!.text()).toBe('goformId=FIXTURE&isTest=false');
  expect(() => sdk.readAsset('api/AT')).toThrow();
  expect(() => sdk.readUpload('../private')).toThrow();
  expect(() => sdk.goform('%2e%2e/other')).toThrow();
  expect(() => sdk.forward('file:///etc/passwd')).toThrow();
  expect(() => sdk.forward('https://example.com', { method: 'DELETE', body: 'lost' })).toThrow();
  expect(() => sdk.forward('https://example.com', { headers: { authorization: 'override' } })).toThrow();
});

test('plugin body limit accounts for JSON escaping before any request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sdk = client(fetch);
  await expect(sdk.request(setCustomHead, { text: '"'.repeat(3 * 1024 * 1024) })).rejects.toBeInstanceOf(RangeError);
  expect(fetch).not.toHaveBeenCalled();
});
