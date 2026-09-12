import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRequest, taskID } from '../src/ufi';
import { parseJob, parseState, type TaskAction } from '../src/state';
import sodium from 'libsodium-wrappers';

test('sealed browser intents run in a detached native worker; failed updates preserve config', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ufi-native-'));
  const root = join(folder, 'ufi-mihomo'), uploads = join(folder, 'uploads'), binary = join(folder, 'agent');
  await mkdir(uploads);
  let source = 'proxies: []\nrules: ["MATCH,DIRECT"]\nexternal-controller: 127.0.0.1:9999\n';
  let requested = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async () => {
    requested++;
    await Bun.sleep(200);
    return new Response(source);
  } });
  try {
    const build = Bun.spawn(['go', 'build', '-o', binary, '.'], { cwd: 'backend', stderr: 'inherit' });
    expect(await build.exited).toBe(0);
    async function cli(command: string, ...args: string[]) {
      const child = Bun.spawn([binary, command, '--root', root, '--uploads', uploads, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output);
    }
    await cli('install');
    const inspect = () => cli('inspect').then(value => parseState(JSON.stringify(value)));
    const initial = await inspect();
    expect(initial.service).toBe(true);
    expect(initial.publicKey).toHaveLength(44);
    const submit = async (action: TaskAction, value: string) => {
      const id = taskID();
      const { bytes, hash } = await sealRequest(initial.publicKey, { id, action, value });
      expect(new TextDecoder().decode(bytes)).not.toContain(value);
      const name = crypto.randomUUID() + '.bin';
      await writeFile(join(uploads, name), bytes);
      const job = parseJob(await cli('submit', name, hash));
      expect(job.id).toBe(id);
      // Submitter has exited. A fresh process can observe the durable task.
      for (let attempt = 0; attempt < 100; attempt++) {
        const observed = parseJob(await cli('job', id));
        if (!['queued', 'running'].includes(observed.state)) return observed;
        await Bun.sleep(30);
      }
      throw new Error('Worker did not finish');
    };
    expect((await submit('save-mirror', 'https://ghfast.top')).state).toBe('succeeded');
    expect((await inspect()).settings.mirror).toBe('https://ghfast.top');
    // Fake only mihomo validation; real Go performs HTTP, YAML, storage and job lifecycle.
    await writeFile(join(root, 'runtime/mihomo'), '#!/bin/sh\nexit 0\n');
    await chmod(join(root, 'runtime/mihomo'), 0o700);
    const url = server.url.href + '?token=fixture-secret';
    const accepted = await submit('update', url);
    expect(accepted.state).toBe('succeeded');
    expect(requested).toBe(1);
    const config = await readFile(join(root, 'runtime/current/config.yaml'), 'utf8');
    expect(config).toContain('tproxy-port: 7894');
    expect(config).toContain('MATCH,DIRECT');
    expect(config).toContain('external-controller: 0.0.0.0:9090');
    expect((await inspect()).controller?.applied).toBe(true);
    await sodium.ready;
    const keys = sodium.crypto_box_keypair();
    const encrypted = await cli('controller-secret', sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL));
    const secret = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL), keys.publicKey, keys.privateKey));
    expect(secret.length).toBe(64);
    expect(config).toContain(secret);
    expect(JSON.stringify(await inspect())).not.toContain(secret);
    expect(await cli('logs')).not.toContain(secret);
    expect((await submit('save-controller', JSON.stringify({ enabled: true, port: 9191, reset: true }))).state).toBe('succeeded');
    expect((await inspect()).controller?.port).toBe(9191);
    expect(requested).toBe(1); // Local settings apply from the saved source, not another subscription download.
    const current = await readlink(join(root, 'runtime/current'));
    source = '<html>subscription error</html>';
    const failed = await submit('update', url + '&new=1');
    expect(failed.state).toBe('failed');
    expect(failed.phase).toBe('adapt');
    expect(await readlink(join(root, 'runtime/current'))).toBe(current);
    expect(await readFile(join(root, 'runtime/current/source.json'), 'utf8')).toContain(url);
    expect(JSON.stringify(await inspect())).not.toContain('fixture-secret');
    expect(await cli('logs')).not.toContain('fixture-secret');
  } finally {
    server.stop(true);
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000);
