import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quote } from '../ui/src/transport/ufi';

test('bootstrap verifies bytes before execution and reports failures without losing status', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ufi-bootstrap-'));
  const id = 'a'.repeat(32),
    job = join(base, 'jobs', id);
  await mkdir(job, { recursive: true });
  const fixture = join(base, 'fixture'),
    marker = join(base, 'executed'),
    curl = join(base, 'curl');
  const script = join(job, 'bootstrap.sh');
  const binary = '#!/bin/sh\nprintf verified > "$UFI_TEST_EXEC_MARK"\n';
  await writeFile(fixture, binary);
  await writeFile(
    curl,
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then out=$2; break; fi; shift; done\ncp "$UFI_TEST_FIXTURE" "$out"\n',
    { mode: 0o700 },
  );
  const source = (await readFile('ui/src/transport/ufi-bootstrap.sh', 'utf8'))
    .replace('BASE=/data/mihomo-agent-bootstrap', 'BASE=' + quote(base))
    .replace(
      'CURL=/data/data/com.minikano.f50_sms/files/curl',
      'CURL=' + quote(curl),
    )
    .replace('umask 077', 'getprop() { echo arm64-v8a; }\numask 077');
  await writeFile(script, source);
  async function run(mode: string, digest = '') {
    const child = Bun.spawn(
      [
        'sh',
        script,
        mode,
        id,
        '',
        'https://fixture.invalid/agent',
        digest,
        '',
        '',
      ],
      {
        env: {
          ...process.env,
          UFI_TEST_FIXTURE: fixture,
          UFI_TEST_EXEC_MARK: marker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    return {
      output: await new Response(child.stdout).text(),
      code: await child.exited,
    };
  }
  try {
    expect((await run('worker', '0'.repeat(64))).code).not.toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(JSON.parse((await run('status')).output).state).toBe('failed');
    const digest = createHash('sha256').update(binary).digest('hex');
    expect((await run('worker', digest)).code).toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('verified');
    expect(JSON.parse((await run('status')).output).state).toBe('succeeded');
    expect(await Bun.file(join(job, 'agent')).exists()).toBe(false);
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
