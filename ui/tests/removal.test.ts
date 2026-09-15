import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readDeviceState, readUninstallJob, uninstallAgent } from '../src/transport/ufi';

afterEach(() => vi.unstubAllGlobals());

test('native uninstall needs no readable state, recovers a lost response and verifies both directories', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'mihomoctl-removal-'));
  const root = join(folder, 'mihomoctl');
  await mkdir(root);
  await mkdir(root + '-bootstrap');
  await writeFile(join(root, 'mihomoctl'), `#!/bin/sh
case "$1" in
  status) echo 'state cannot be read'; exit 1;;
  uninstall)
    echo submitted >> "$REMOVAL_COUNT"
    printf '{"id":"%s","action":"uninstall","state":"running","phase":"removing","updated":"2026-09-15T00:00:00Z"}' "$3" > "$REMOVAL_ROOT/receipt"
    cat "$REMOVAL_ROOT/receipt";;
  job) cat "$REMOVAL_ROOT/receipt";;
  *) exit 1;;
esac
`, { mode: 0o700 });
  let lost = false;
  let rootAccess = true;
  vi.stubGlobal('KANO_baseURL', 'http://ufi.invalid/api');
  vi.stubGlobal('location', { href: 'http://ufi.invalid/' });
  vi.stubGlobal('common_headers', {});
  vi.stubGlobal('originFetch', async (request: Request) => {
    const { command } = await request.json() as { command: string };
    const child = spawnSync('sh', ['-c', command.replaceAll('/data/mihomoctl', root).replaceAll('$(id -u)', rootAccess ? '0' : '1000')], {
      env: { ...process.env, REMOVAL_ROOT: root, REMOVAL_COUNT: join(folder, 'submissions') },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.status).toBe(0);
    if (!lost && command.includes(' uninstall --id ')) {
      lost = true;
      throw new TypeError('response lost after submission');
    }
    return Response.json({ result: child.stdout });
  });
  try {
    await expect(readDeviceState()).rejects.toThrow('state cannot be read');
    const job = await uninstallAgent();
    expect(job.state).toBe('running');
    expect(await readFile(join(folder, 'submissions'), 'utf8')).toBe('submitted\n');
    await rm(root, { recursive: true });
    expect(await readUninstallJob(job)).toBeNull();
    await rm(root + '-bootstrap', { recursive: true });
    expect((await readUninstallJob(job))?.state).toBe('succeeded');
    rootAccess = false;
    await expect(uninstallAgent()).rejects.toThrow('请开启 UFI 高级功能');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
