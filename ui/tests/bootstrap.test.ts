import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote, latestAgentAssets, readBootstrap } from '../src/transport/ufi';
import { protocol } from '../src/state';

beforeEach(() => {
  vi.stubGlobal('originFetch', (...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
});
afterEach(() => vi.unstubAllGlobals());

test('missing native host fetch fails without using the signed wrapper', async () => {
  vi.stubGlobal('originFetch', undefined);
  const fetch = vi.spyOn(globalThis, 'fetch');
  await expect(latestAgentAssets()).rejects.toThrow('UFI 原始请求接口不可用');
  expect(fetch).not.toHaveBeenCalled();
});

test('bootstrap polling reads the real shell record by ID and latest pointer', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ufi-bootstrap-status-'));
  const id = 'a1'.repeat(16), job = join(base, 'jobs', id);
  const record = {
    id, action: 'bootstrap', state: 'succeeded', phase: 'done',
    updated: '2026-09-15T00:00:00Z', hash: '', started: new Date().toISOString(), downloaded: 0, total: 0, speed: 0, cancellable: false, cancelRequested: false, result: '', error: '',
  };
  try {
    await mkdir(job, { recursive: true });
    await writeFile(join(base, 'latest'), id);
    await writeFile(join(job, 'state.json'), JSON.stringify(record));
    await writeFile(join(job, 'bootstrap.sh'),
      (await readFile('src/transport/ufi-bootstrap.sh', 'utf8'))
        .replace('BASE=/data/mihomoctl-bootstrap', 'BASE=' + quote(base)));
    vi.stubGlobal('KANO_baseURL', 'http://ufi.invalid/api');
    vi.stubGlobal('location', { href: 'http://ufi.invalid/' });
    vi.stubGlobal('common_headers', {});
    vi.stubGlobal('originFetch', async (request: Request) => {
      const { command } = await request.json() as { command: string };
      // Execute the actual transport command against a private local fixture.
      const child = spawnSync('sh', ['-c', command.replaceAll('/data/mihomoctl-bootstrap', base)], {
        encoding: 'utf8', timeout: 10_000,
      });
      expect(child.status).toBe(0);
      return Response.json({ result: child.stdout });
    });
    expect(await readBootstrap(id)).toEqual(record);
    expect(await readBootstrap()).toEqual(record);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('bootstrap verifies bytes before execution and reports failures without losing status', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ufi-bootstrap-'));
  const id = 'a'.repeat(32),
    job = join(base, 'jobs', id);
  await mkdir(job, { recursive: true });
  const fixture = join(base, 'fixture'),
    marker = join(base, 'executed'),
    curl = join(base, 'curl');
  const script = join(job, 'bootstrap.sh');
  const binary = `#!/bin/sh\nif [ "$1" = version ]; then printf '{"protocol":${protocol}}'; exit 0; fi\nprintf verified > "$UFI_TEST_EXEC_MARK"\nprintf '%s\\n' "$@" > "$UFI_TEST_INSTALL_ARGS"\n`;
  await writeFile(fixture, binary);
  await writeFile(
    curl,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$UFI_TEST_CURL_ARGS"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out=$2; break; fi; shift; done\ncp "$UFI_TEST_FIXTURE" "$out"\n',
    { mode: 0o700 },
  );
  const source = (await readFile('src/transport/ufi-bootstrap.sh', 'utf8'))
    .replace('BASE=/data/mihomoctl-bootstrap', 'BASE=' + quote(base))
    .replace(
      'CURL=/data/data/com.minikano.f50_sms/files/curl',
      'CURL=' + quote(curl),
    )
    .replace('umask 077', 'getprop() { echo arm64-v8a; }\numask 077');
  await writeFile(script, source);
  async function run(mode: string, digest = '', expectedProtocol = protocol, proxy = '') {
    const child = spawnSync(
      'sh',
      [
        script,
        mode,
        id,
        'https://fixture.invalid/mihomoctl',
        digest,
        '',
        '',
        String(expectedProtocol),
        proxy,
        String(binary.length),
        String(binary.length),
      ],
      {
        env: {
          ...process.env,
          UFI_TEST_FIXTURE: fixture,
          UFI_TEST_CURL_ARGS: join(base, 'curl-args'),
          UFI_TEST_EXEC_MARK: marker,
          UFI_TEST_INSTALL_ARGS: join(base, 'install-args'),
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    return {
      output: child.stdout,
      code: child.status,
    };
  }
  try {
    expect((await run('worker', '0'.repeat(64))).code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse((await run('status')).output).state).toBe('failed');
    const digest = createHash('sha256').update(binary).digest('hex');
    expect((await run('worker', digest, protocol + 1)).code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect((await run('worker', digest)).code).toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('verified');
    expect(await readFile(join(base, 'curl-args'), 'utf8')).toContain('https://fixture.invalid/mihomoctl');
    expect(JSON.parse((await run('status')).output).state).toBe('succeeded');
    expect(existsSync(join(job, 'mihomoctl'))).toBe(false);
    expect((await run('worker', digest, protocol, 'https://mirror.example.com')).code).toBe(0);
    expect(await readFile(join(base, 'install-args'), 'utf8')).toBe('--platform\nufi\ninstall\n--release-proxy\nhttps://mirror.example.com\n');
    expect((await readFile(join(base, 'curl-args'), 'utf8')).split('\n')).not.toContain('-L');
    // Cancel the real bootstrap shell while its current curl child is running.
    await rm(marker);
    await writeFile(curl, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out=$2; break; fi; shift; done\ncp "$UFI_TEST_FIXTURE" "$out"\nexec sleep 3\n', { mode: 0o700 });
    const child = spawn('sh', [script, 'worker', id, 'https://fixture.invalid/mihomoctl', digest, '', '', String(protocol), '', String(binary.length), String(binary.length)], {
      env: { ...process.env, UFI_TEST_FIXTURE: fixture, UFI_TEST_EXEC_MARK: marker, UFI_TEST_INSTALL_ARGS: join(base, 'install-args') },
    });
    const exited = once(child, 'exit');
    await expect.poll(async () => JSON.parse(await readFile(join(job, 'state.json'), 'utf8')).phase).toBe('download');
    expect((await run('cancel')).code).toBe(0);
    expect((await exited)[0]).toBe(0);
    expect(JSON.parse((await run('status')).output).state).toBe('cancelled');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(job, 'mihomoctl'))).toBe(false);
    const stale = JSON.stringify({
      id,
      action: 'bootstrap',
      state: 'running',
      phase: 'download',
      updated: '2026-01-01T00:00:00Z',
    });
    await writeFile(join(job, 'state.json'), stale);
    await writeFile(join(job, 'worker.pid'), '99999999');
    const interrupted = JSON.parse((await run('status')).output);
    expect(interrupted.state).toBe('interrupted');
    expect(interrupted.updated).toBe('2026-01-01T00:00:00Z');
    expect(await readFile(join(job, 'state.json'), 'utf8')).toBe(stale);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('initial metadata uses official GitHub and rejects malformed releases', async () => {
  const release = {
    tag_name: 'v9.8.7',
    draft: false,
    prerelease: false,
    assets: ['arm64', 'armv7'].map((arch) => ({
      name: `mihomoctl-linux-${arch}`,
      size: 1048576,
      browser_download_url: `https://github.com/imbytecat/mihomoctl/releases/download/v9.8.7/mihomoctl-linux-${arch}`,
      digest: 'sha256:' + 'a'.repeat(64),
    })),
  };
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(Response.json(release));
  const assets = await latestAgentAssets();
  expect(assets.arm64.url).toContain('/v9.8.7/');
  expect(assets.armv7.sha256).toBe('a'.repeat(64));
  expect((fetch.mock.calls[0]![0] as Request).url).toBe(
    'https://api.github.com/repos/imbytecat/mihomoctl/releases/latest',
  );
  expect(
    (fetch.mock.calls[0]![0] as Request).headers.has('Authorization'),
  ).toBe(false);
  fetch.mockResolvedValueOnce(Response.json(release));
  const forwarded = await latestAgentAssets('https://mirror.example.com/');
  expect((fetch.mock.calls[1]![0] as Request).url).toBe(
    'https://mirror.example.com/' + encodeURIComponent('https://api.github.com/repos/imbytecat/mihomoctl/releases/latest'),
  );
  expect(forwarded.arm64.url).toBe(
    'https://mirror.example.com/' + encodeURIComponent(release.assets[0]!.browser_download_url),
  );
  expect((fetch.mock.calls[1]![0] as Request).redirect).toBe('error');
  fetch.mockResolvedValueOnce(Response.json({ ...release, prerelease: true }));
  await expect(latestAgentAssets()).rejects.toThrow('预期格式');
  release.assets[0]!.digest = '';
  fetch.mockResolvedValueOnce(Response.json(release));
  await expect(latestAgentAssets()).rejects.toThrow('SHA-256');
  release.assets[0]!.digest = 'sha256:' + 'a'.repeat(64);
  release.assets[0]!.browser_download_url = 'https://untrusted.invalid/mihomoctl';
  fetch.mockResolvedValueOnce(Response.json(release));
  await expect(latestAgentAssets()).rejects.toThrow('官方版本缺少');
});
