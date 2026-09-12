import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { adaptConfig, curlConfig, downloadMirror, interfaces } from '../src/config';
import { quote, shellCommand, shellResult } from '../src/ufi';
import { selectRelease } from '../src/release';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
const sample = `# My policy
proxies: [{name: sample, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: private}]
proxy-groups: [{name: select, type: select, proxies: [sample]}]
rules: [MATCH,select]
dns: {nameserver: [https://223.5.5.5/dns-query], enhanced-mode: fake-ip}
tun: {enable: true, stack: mixed}
`;

test('adaptation preserves subscription policy and DNS choices', () => {
  const result = adaptConfig(sample);
  const config = parse(result);
  const original = parse(sample);
  for (const key of ['proxies', 'proxy-groups', 'rules']) expect(config[key]).toEqual(original[key]);
  expect(config.dns.nameserver).toEqual(original.dns.nameserver);
  expect(config.dns['enhanced-mode']).toBe('fake-ip');
  expect(config.dns.listen).toBe('0.0.0.0:1053');
  expect(config['tproxy-port']).toBe(7894);
  expect(config.tun.enable).toBe(false);
  expect(result).toContain('# My policy');
  expect(() => adaptConfig('<html>error</html>')).toThrow();
  expect(() => adaptConfig(sample + '\nrouting-mark: 6666')).toThrow('routing-mark');
  expect(() => adaptConfig(sample + '\nexternal-controller: 0.0.0.0:9090')).toThrow('secret');
  expect(() => adaptConfig(sample + '\ndns: {}')).toThrow();
});

test('input validation and shell results preserve the trust boundary', async () => {
  expect(interfaces('wlan0, rndis0 wlan0')).toBe('wlan0 rndis0');
  for (const name of ['lo', 'rmnet_data0', 'wlan0;reboot', '-i', '']) expect(() => interfaces(name)).toThrow();
  expect(() => curlConfig('file:///etc/passwd')).toThrow();
  expect(() => curlConfig('https://example.com/\noutput=/bad')).toThrow();
  expect(curlConfig('https://example.com/?key="x"')).toContain('\\"x\\"');
  expect(downloadMirror('')).toBe('');
  expect(downloadMirror('https://worker.example/')).toBe('https://worker.example');
  expect(() => downloadMirror('http://worker.example/')).toThrow();
  expect(() => downloadMirror('https://user:pass@worker.example/')).toThrow();
  const value = "a'b $(printf injected) `printf injected`\n中文";
  const proc = Bun.spawn(['sh', '-c', shellCommand(`printf '%s' ${quote(value)}`, 'TEST_')], { stdout: 'pipe' });
  expect(shellResult(await new Response(proc.stdout).text(), 'TEST_')).toBe(value);
  expect(await proc.exited).toBe(0);
  expect(() => shellResult('bad\nTEST_2', 'TEST_')).toThrow('bad');
  expect(() => shellResult('looks successful', 'TEST_')).toThrow('退出码');
});

test('invalid configuration leaves previous config; failed restart rolls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-test-'));
  temporary.push(dir);
  let source = await readFile('scripts/service.sh', 'utf8');
  source = source.replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`);
  // Exercise real apply control flow; replace process/network side effects only.
  source = source.replace('case "${1:-status}" in', `
alive() { [ "$1" = supervisor ]; }
stop_service() { echo stop >> "$DIR/actions"; }
start_service() { echo start >> "$DIR/actions"; ! grep -q runtime-bad "$DIR/config.yaml"; }
timeout() { shift; "$@"; }
case "\${1:-status}" in`);
  await writeFile(join(dir, 'service.sh'), source);
  await writeFile(join(dir, 'network.sh'), 'network_stop() { :; }\n');
  await writeFile(join(dir, 'mihomo'), '#!/bin/sh\nfor arg do config=$arg; done\n! grep -q invalid "$config"\n');
  await chmod(join(dir, 'mihomo'), 0o700);
  const run = async () => {
    const proc = Bun.spawn(['sh', join(dir, 'service.sh'), 'apply'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(proc.stdout).text() + await new Response(proc.stderr).text();
    return { code: await proc.exited, output };
  };
  await writeFile(join(dir, 'config.yaml'), 'original');
  await writeFile(join(dir, 'candidate.yaml'), 'invalid');
  expect((await run()).code).toBe(1);
  expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe('original');
  expect(await Bun.file(join(dir, 'actions')).exists()).toBe(false);
  await writeFile(join(dir, 'candidate.yaml'), 'runtime-bad');
  const rollback = await run();
  expect(rollback.code).toBe(1);
  expect(rollback.output).toContain('已回滚');
  expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe('original');
  await writeFile(join(dir, 'candidate.yaml'), 'valid-new');
  expect((await run()).code).toBe(0);
  expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe('valid-new');
});

test('network setup refuses foreign table and scopes interception to LAN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-network-'));
  temporary.push(dir);
  await writeFile(join(dir, 'interfaces'), 'wlan0 rndis0\n');
  const network = await readFile('scripts/network.sh', 'utf8');
  const run = async (collision: boolean) => {
    const script = `DIR=${quote(dir)}
${network}
ipt() { printf 'iptables %s\\n' "$*"; case " $* " in *' -S '*|*' -C '*) return 1;; esac; }
ip6t() { printf 'ip6tables %s\\n' "$*"; case " $* " in *' -S '*|*' -C '*) return 1;; esac; }
ip() {
  case "$*" in
    '-4 route show table 2026') ${collision ? "echo 'foreign route'" : ':'};;
    '-4 rule show') :;;
    *'rule del'*) return 1;;
    *) printf 'ip %s\\n' "$*";;
  esac
}
network_start`;
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    return { output: await new Response(proc.stdout).text(), code: await proc.exited };
  };
  const collision = await run(true);
  expect(collision.code).toBe(1);
  expect(collision.output).not.toContain('iptables');
  const ok = await run(false);
  expect(ok.code).toBe(0);
  expect(ok.output).toContain('-i wlan0 -p tcp ! --dport 53 -j TPROXY');
  expect(ok.output).toContain('-i rndis0 -p udp --dport 53 -j REDIRECT');
  expect(ok.output).toContain('-i wlan0 -j REJECT --reject-with icmp6-adm-prohibited');
  expect(ok.output).not.toContain('OUTPUT');
  expect(ok.output).not.toContain(' -F ');
});

test('built plugin is one classic script with HTML-safe boundaries', async () => {
  const output = await readFile('dist/ufi-mihomo.js', 'utf8');
  expect(output.startsWith('//<script>')).toBe(true);
  expect(output.trimEnd().endsWith('//</script>')).toBe(true);
  expect(output.match(/<\/script\s*>/gi)?.length).toBe(1);
  expect(output.length).toBeLessThan(5 * 1024 * 1024);
  expect(() => new Function(output)).not.toThrow();
});

test('official download rejects incorrect digest without executing or replacing core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-digest-'));
  temporary.push(dir);
  let source = await readFile('scripts/service.sh', 'utf8');
  source = source.replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`)
    .replace('CURL=/data/data/com.minikano.f50_sms/files/curl', 'CURL=fake_curl')
    .replace('case "${1:-status}" in', `
getprop() { echo arm64-v8a; }
fake_curl() { printf 'tampered' > "$DIR/mihomo.gz.next"; }
sha256sum() { echo 'wrong-digest file'; }
case "\${1:-status}" in`);
  await writeFile(join(dir, 'network.sh'), 'network_stop() { :; }\n');
  await writeFile(join(dir, 'service.sh'), source);
  await writeFile(join(dir, 'mihomo'), 'original-core');
  await writeFile(join(dir, 'core-release'), `v9.8.7\narm64-v8a\n${'a'.repeat(64)}\n`);
  const proc = Bun.spawn(['sh', join(dir, 'service.sh'), 'install-official'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(proc.stderr).text()).toContain('SHA-256 不匹配');
  expect(await proc.exited).toBe(1);
  expect(await readFile(join(dir, 'mihomo'), 'utf8')).toBe('original-core');
  expect(await Bun.file(join(dir, 'mihomo.next')).exists()).toBe(false);
});

test('latest stable selection follows release metadata and matches architecture/digest', () => {
  const release = {
    tag_name: 'v9.8.7', draft: false, prerelease: false,
    assets: ['arm64-v8', 'armv7'].map(arch => ({
      name: `mihomo-android-${arch}-v9.8.7.gz`,
      browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v9.8.7/mihomo-android-${arch}-v9.8.7.gz`,
      digest: `sha256:${(arch === 'armv7' ? 'b' : 'a').repeat(64)}`,
    })),
  };
  expect(selectRelease(release, 'arm64-v8a').version).toBe('v9.8.7');
  expect(selectRelease(release, 'armeabi-v7a').manifest).toContain('b'.repeat(64));
  expect(() => selectRelease(release, 'x86')).toThrow('架构');
  expect(() => selectRelease({ ...release, prerelease: true }, 'arm64-v8a')).toThrow('稳定版');
  expect(() => selectRelease({ ...release, assets: [] }, 'arm64-v8a')).toThrow('SHA-256');
  release.assets[0]!.digest = '';
  expect(() => selectRelease(release, 'arm64-v8a')).toThrow('SHA-256');
  release.assets[0]!.digest = `sha256:${'a'.repeat(64)}`;
  release.assets[0]!.browser_download_url = 'https://untrusted.example/core.gz';
  expect(() => selectRelease(release, 'arm64-v8a')).toThrow();
});
