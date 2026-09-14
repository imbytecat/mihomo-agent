import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote, latestAgentAssets } from '../src/transport/ufi';
import { protocol } from '../src/state';

test('bootstrap verifies bytes before execution and reports failures without losing status', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ufi-bootstrap-'));
  const id = 'a'.repeat(32),
    job = join(base, 'jobs', id);
  await mkdir(job, { recursive: true });
  const fixture = join(base, 'fixture'),
    marker = join(base, 'executed'),
    curl = join(base, 'curl');
  const script = join(job, 'bootstrap.sh');
  const binary = `#!/bin/sh\nif [ "$1" = version ]; then printf '{"protocol":${protocol}}'; exit 0; fi\nprintf verified > "$UFI_TEST_EXEC_MARK"\n`;
  await writeFile(fixture, binary);
  await writeFile(
    curl,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$UFI_TEST_CURL_ARGS"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out=$2; break; fi; shift; done\ncp "$UFI_TEST_FIXTURE" "$out"\n',
    { mode: 0o700 },
  );
  const source = (await readFile('src/transport/ufi-bootstrap.sh', 'utf8'))
    .replace('BASE=/data/mihomo-agent-bootstrap', 'BASE=' + quote(base))
    .replace(
      'CURL=/data/data/com.minikano.f50_sms/files/curl',
      'CURL=' + quote(curl),
    )
    .replace('umask 077', 'getprop() { echo arm64-v8a; }\numask 077');
  await writeFile(script, source);
  async function run(mode: string, digest = '', expectedProtocol = protocol) {
    const child = spawnSync(
      'sh',
      [
        script,
        mode,
        id,
        'https://mirror.invalid/cache',
        'https://fixture.invalid/agent',
        digest,
        '',
        '',
        String(expectedProtocol),
      ],
      {
        env: {
          ...process.env,
          UFI_TEST_FIXTURE: fixture,
          UFI_TEST_CURL_ARGS: join(base, 'curl-args'),
          UFI_TEST_EXEC_MARK: marker,
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
    expect(await readFile(join(base, 'curl-args'), 'utf8')).toContain('https://mirror.invalid/cache/https://fixture.invalid/agent');
    expect(JSON.parse((await run('status')).output).state).toBe('succeeded');
    expect(existsSync(join(job, 'agent'))).toBe(false);
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

test('initial metadata honors the selected proxy and rejects malformed releases', async () => {
  const release = {
    tag_name: 'v9.8.7',
    draft: false,
    prerelease: false,
    assets: ['arm64', 'armv7'].map((arch) => ({
      name: `mihomo-agent-linux-${arch}`,
      browser_download_url: `https://github.com/imbytecat/mihomo-agent/releases/download/v9.8.7/mihomo-agent-linux-${arch}`,
      digest: 'sha256:' + 'a'.repeat(64),
    })),
  };
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(Response.json(release));
  const assets = await latestAgentAssets();
  expect(assets.arm64.url).toContain('/v9.8.7/');
  expect(assets.armv7.sha256).toBe('a'.repeat(64));
  expect((fetch.mock.calls[0]![0] as Request).url).toBe(
    'https://api.github.com/repos/imbytecat/mihomo-agent/releases/latest',
  );
  expect(
    (fetch.mock.calls[0]![0] as Request).headers.has('Authorization'),
  ).toBe(false);
  fetch.mockResolvedValueOnce(Response.json(release));
  await latestAgentAssets('https://mirror.invalid/cache/');
  const proxied = fetch.mock.calls[1]![0] as Request;
  expect(proxied.url).toBe('https://mirror.invalid/cache/https://api.github.com/repos/imbytecat/mihomo-agent/releases/latest');
  expect(proxied.headers.has('Authorization')).toBe(false);
  fetch.mockResolvedValueOnce(Response.json({ ...release, prerelease: true }));
  await expect(latestAgentAssets()).rejects.toThrow('预期格式');
  release.assets[0]!.digest = '';
  fetch.mockResolvedValueOnce(Response.json(release));
  await expect(latestAgentAssets()).rejects.toThrow('SHA-256');
  release.assets[0]!.digest = 'sha256:' + 'a'.repeat(64);
  release.assets[0]!.browser_download_url = 'https://proxy.invalid/agent';
  fetch.mockResolvedValueOnce(Response.json(release));
  await expect(latestAgentAssets()).rejects.toThrow('官方版本缺少');
});
