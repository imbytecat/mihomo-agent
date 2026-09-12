import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { adaptConfig, curlConfig, downloadMirror, interfaces } from '../src/config';
import { quote, shellCommand, shellResult } from '../src/ufi';
import { selectRelease } from '../src/release';
import { disabledReason, emptyState, lifecycleAction, nextStep, parseState } from '../src/state';

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
  expect(interfaces('')).toBe('auto');
  expect(interfaces(' auto ')).toBe('auto');
  for (const name of ['lo', 'rmnet_data0', 'wlan0;reboot', '-i']) expect(() => interfaces(name)).toThrow();
  expect(() => curlConfig('file:///etc/passwd')).toThrow();
  expect(() => curlConfig('https://example.com/\noutput=/bad')).toThrow();
  expect(curlConfig('https://example.com/?key="x"')).toContain('\\"x\\"');
  expect(downloadMirror('')).toBe('');
  expect(downloadMirror('https://worker.example/')).toBe('https://worker.example');
  expect(() => downloadMirror('http://worker.example/')).toThrow();
  expect(() => downloadMirror('https://user:pass@worker.example/')).toThrow();
  expect(downloadMirror('https://ghfast.top/')).toBe('https://ghfast.top');
  expect(() => downloadMirror('https://github.com/MetaCubeX/mihomo/releases/download/v1/core.gz')).toThrow('前缀');
  expect(() => downloadMirror('https://ghfast.top/https://github.com/MetaCubeX/mihomo/releases/download/v1/core.gz')).toThrow('前缀');
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
  for (const name of ['routes', 'rules', 'ready', 'fw-4-mangle-PREROUTING', 'fw-4-nat-PREROUTING', 'fw-4-filter-INPUT', 'fw-6-filter-FORWARD']) {
    await writeFile(join(dir, name), '');
  }
  const network = await readFile('scripts/network.sh', 'utf8');
  const harness = await readFile('tests/fake-net.sh', 'utf8');
  const run = async () => {
    const script = `DIR=${quote(dir)}
${network}
${harness}
network_start`;
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    return { output: await new Response(proc.stdout).text(), code: await proc.exited };
  };
  await writeFile(join(dir, 'routes'), 'foreign route');
  const collision = await run();
  expect(collision.code).toBe(1);
  expect(await Bun.file(join(dir, 'network.calls')).exists()).toBe(false);
  await writeFile(join(dir, 'routes'), '');
  const ok = await run();
  expect(ok.code).toBe(0);
  const calls = await readFile(join(dir, 'network.calls'), 'utf8');
  expect(calls).toContain('-i wlan0 -p tcp ! --dport 53 -j TPROXY');
  expect(calls).toContain('-i rndis0 -p udp --dport 53 -j REDIRECT');
  expect(calls).toContain('-i wlan0 -j REJECT --reject-with icmp6-adm-prohibited');
  expect(calls).not.toContain('OUTPUT');
  expect(calls).not.toContain(' -F ');
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe('A\nwlan0 rndis0\n');
  await writeFile(join(dir, 'interfaces'), 'wlan0 rndis0 usb0\n');
  await writeFile(join(dir, 'fail-switch'), '');
  expect((await run()).code).toBe(1);
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe('A\nwlan0 rndis0\n');
  for (const name of ['fw-4-filter-UFI_MH_IN', 'fw-6-filter-UFI_MH6', 'fw-4-nat-UFI_MH_DNS', 'fw-4-mangle-UFI_MH']) {
    expect(await readFile(join(dir, name), 'utf8')).toMatch(/_A\n$/);
  }
  expect(await Bun.file(join(dir, 'network.pending')).exists()).toBe(false);
  expect((await run()).code).toBe(0);
  expect(await readFile(join(dir, 'network.active'), 'utf8')).toBe('B\nwlan0 rndis0 usb0\n');
  await rm(join(dir, 'ready'));
  expect((await run()).code).toBe(1);
});

test('built plugin is one classic script with HTML-safe boundaries', async () => {
  const output = await readFile('dist/ufi-mihomo.js', 'utf8');
  expect(output.startsWith('//<script>')).toBe(true);
  expect(output.trimEnd().endsWith('//</script>')).toBe(true);
  expect(output.match(/<\/script\s*>/gi)?.length).toBe(1);
  expect(output.length).toBeLessThan(5 * 1024 * 1024);
  expect(await readdir('dist')).toEqual(['ufi-mihomo.js']);
  expect(output).not.toContain('mockDeviceState');
  expect(output).not.toContain('react_dom_client');
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

test('auto LAN selection excludes cellular, VPN, upstream Wi-Fi and inactive links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-auto-'));
  temporary.push(dir);
  const source = await readFile('scripts/network.sh', 'utf8');
  const addresses = `1: lo inet 127.0.0.1/8 scope host lo
2: rmnet_data0 inet 10.20.30.40/24 scope global rmnet_data0
3: wlan0 inet 192.168.0.1/24 scope global wlan0
4: rndis0 inet 192.168.42.1/24 scope global rndis0
5: wlan1 inet 192.168.1.8/24 scope global wlan1
6: tun0 inet 10.0.0.1/24 scope global tun0
7: br-lan@eth0 inet 172.16.0.1/24 scope global br-lan
8: ap1 inet 203.0.113.1/24 scope global ap1`;
  const run = async (routes: string, addr = addresses, failure = false) => {
    const script = `DIR=${quote(dir)}\n${source}
ip() {
  case "$*" in
    '-4 route show table all') ${failure ? 'return 1' : `printf '%s\\n' ${quote(routes)}`};;
    '-6 route show table all') echo 'default via fe80::1 dev wlan1 table 1010';;
    '-o -4 addr show up scope global') printf '%s\\n' ${quote(addr)};;
    *) return 1;;
  esac
}
resolve_interfaces`;
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(proc.stderr).text();
    expect(error).toBe('');
    return { value: (await new Response(proc.stdout).text()).trim(), code: await proc.exited };
  };
  expect((await run('default dev rmnet_data0 table 1009')).value).toBe('br-lan rndis0 wlan0');
  expect((await run('default dev wlan0 table 1011')).value).toBe('br-lan rndis0');
  expect((await run('', '')).value).toBe('');
  expect((await run('', addresses, true)).code).toBe(1);
  await writeFile(join(dir, 'interfaces'), 'custom0\n');
  expect((await run('')).value).toBe('custom0');
});

test('network refresh tracks LAN changes and waits without restarting core', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-sync-'));
  temporary.push(dir);
  const source = await readFile('scripts/network.sh', 'utf8');
  const script = `DIR=${quote(dir)}\n${source}
resolve_interfaces() { printf '%s' "$desired"; }
listeners_ready() { return 0; }
active_interfaces() { cat "$DIR/interfaces.active" 2>/dev/null; }
network_ok() { return 0; }
network_stop() { echo stop; rm -f "$DIR/interfaces.active"; }
network_start() { echo "start:$desired"; printf '%s' "$desired" > "$DIR/interfaces.active"; }
desired=wlan0; network_sync
network_sync
desired='rndis0 wlan0'; network_sync
desired=''; network_sync
desired=wlan0; network_sync`;
  const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe' });
  expect(await new Response(proc.stdout).text()).toBe('start:wlan0\nstart:rndis0 wlan0\nstop\nstart:wlan0\n');
  expect(await proc.exited).toBe(0);
});

test('listener readiness requires all four core-owned sockets, not foreign listeners', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-listeners-'));
  temporary.push(dir);
  const procdir = join(dir, 'proc');
  await mkdir(join(procdir, '123/fd'), { recursive: true });
  await mkdir(join(procdir, 'net'));
  await writeFile(join(dir, 'core.pid'), '123');
  for (const inode of [11, 12, 13, 14]) await symlink(`socket:[${inode}]`, join(procdir, `123/fd/${inode}`));
  const row = (port: string, state: string, inode: number) => `0: 00000000:${port} 00000000:0000 ${state} 0 0 0 0 0 ${inode}\n`;
  await writeFile(join(procdir, 'net/tcp'), row('1ED6', '0A', 11) + row('041D', '0A', 12));
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13) + row('041D', '07', 14));
  await writeFile(join(procdir, 'net/tcp6'), '');
  await writeFile(join(procdir, 'net/udp6'), '');
  const source = (await readFile('scripts/network.sh', 'utf8')).replaceAll('/proc/', `${procdir}/`);
  const run = async () => {
    const proc = Bun.spawn(['sh', '-c', `DIR=${quote(dir)}\n${source}\nalive() { return 0; }\nlisteners_ready`]);
    return proc.exited;
  };
  expect(await run()).toBe(0);
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13) + row('041D', '07', 999));
  expect(await run()).toBe(1);
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13));
  expect(await run()).toBe(1);
});

test('logs redact URLs and credentials before the UFI root-shell response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-log-'));
  temporary.push(dir);
  const source = (await readFile('scripts/service.sh', 'utf8')).replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`);
  await writeFile(join(dir, 'service.sh'), source);
  await writeFile(join(dir, 'network.sh'), '');
  await writeFile(join(dir, 'core.log'), 'download https://example.com/private?token=abc\nsecret: sensitive\nPASSWORD=hidden\nordinary error\n');
  const proc = Bun.spawn(['sh', join(dir, 'service.sh'), 'logs'], { stdout: 'pipe' });
  const output = await new Response(proc.stdout).text();
  expect(output).toContain('ordinary error');
  expect(output).toContain('[URL hidden]');
  expect(output).not.toContain('example.com');
  expect(output).not.toContain('secret:');
  expect(output).not.toContain('PASSWORD=');
  expect(await proc.exited).toBe(0);
});

test('recycled core PID is not considered owned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-pid-'));
  temporary.push(dir);
  await mkdir(join(dir, 'proc/123'), { recursive: true });
  await writeFile(join(dir, 'core.pid'), '123');
  await writeFile(join(dir, 'network.sh'), '');
  const original = await readFile('scripts/service.sh', 'utf8');
  const functions = original.slice(0, original.indexOf('case "${1:-status}" in'))
    .replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`)
    .replaceAll('/proc/', `${dir}/proc/`);
  const run = async () => {
    const proc = Bun.spawn(['sh', '-c', `${functions}\nkill() { return 0; }\nalive core`]);
    return proc.exited;
  };
  await symlink('/system/bin/unrelated', join(dir, 'proc/123/exe'));
  expect(await run()).toBe(1);
  await rm(join(dir, 'proc/123/exe'));
  await symlink(`${dir}/mihomo`, join(dir, 'proc/123/exe'));
  expect(await run()).toBe(0);
});

test('UI gates actions by real prerequisites and keeps recovery actions accessible', () => {
  expect(disabledReason('install', null)).not.toBe('');
  expect(disabledReason('refresh', null)).toBe('');
  expect(disabledReason('install', emptyState)).toBe('');
  expect(disabledReason('uninstall', emptyState)).not.toBe('');
  const installed = { ...emptyState, service: true };
  expect(lifecycleAction(null)).toBe(null);
  expect(lifecycleAction(emptyState)).toBe('install');
  expect(lifecycleAction(installed)).toBe('uninstall');
  expect(disabledReason('install', installed)).toContain('已安装');
  expect(disabledReason('service-update', installed)).toBe('');
  expect(disabledReason('uninstall', null)).not.toBe('');
  expect(disabledReason('uninstall', installed, true)).not.toBe('');
  for (const action of ['start', 'restart', 'update', 'boot-on'] as const) expect(disabledReason(action, installed)).not.toBe('');
  expect(disabledReason('download', installed)).toBe('');
  expect(disabledReason('save', installed, false, 'https://example.com/sub')).toBe('');
  expect(disabledReason('save', installed)).toContain('订阅链接');
  expect(disabledReason('save-mirror', { ...installed, running: true })).toBe('');
  expect(disabledReason('save-interfaces', { ...installed, running: true })).toContain('停止');
  expect(nextStep(installed)).toContain('核心');
  const ready = { ...installed, core: true, config: true, subscription: true };
  expect(disabledReason('start', ready)).toBe('');
  expect(disabledReason('update', ready, false, 'https://new.example')).toContain('保存');
  expect(disabledReason('update', ready, false, '')).toBe('');
  expect(disabledReason('start', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('download', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('stop', { ...ready, running: true })).toBe('');
  expect(disabledReason('boot-off', { ...installed, boot: true })).toBe('');
  expect(disabledReason('uninstall', { ...ready, locked: true })).not.toBe('');
  expect(disabledReason('logs', { ...ready, locked: true })).toBe('');
  expect(() => parseState('{"service":true}')).toThrow();
  expect(parseState(JSON.stringify(ready))).toEqual(ready);
});

test('uninstall backs up only its installation and preserves files when stop fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ufi-mihomo-uninstall-'));
  temporary.push(root);
  const dir = join(root, 'installation');
  const boot = join(root, 'boot.sh');
  await mkdir(dir);
  await writeFile(join(dir, 'network.sh'), '');
  await writeFile(join(dir, 'config.yaml'), 'private config');
  await writeFile(join(root, 'other-plugin'), 'keep me');
  const original = (await readFile('scripts/service.sh', 'utf8'))
    .replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`)
    .replace('BOOT=/sdcard/ufi_tools_boot.sh', `BOOT=${quote(boot)}`);
  await writeFile(boot, 'other-plugin start\nsh /data/ufi-mihomo/service.sh start # ufi-mihomo\n');
  const run = async (stopSucceeds: boolean) => {
    await writeFile(join(dir, 'service.sh'), original.replace('case "${1:-status}" in',
      `stop_service() { return ${stopSucceeds ? 0 : 1}; }
sed() {
  if [ "$1" = -i ]; then command sed "$2" "$3" > "$3.next" && mv "$3.next" "$3";
  else command sed "$@"; fi
}
case "\${1:-status}" in`));
    const proc = Bun.spawn(['sh', join(dir, 'service.sh'), 'uninstall'], { stdout: 'pipe', stderr: 'pipe' });
    return { code: await proc.exited, output: await new Response(proc.stdout).text() + await new Response(proc.stderr).text() };
  };
  expect((await run(false)).code).toBe(1);
  expect(await readFile(join(dir, 'config.yaml'), 'utf8')).toBe('private config');
  const result = await run(true);
  expect(result).toMatchObject({ code: 0 });
  expect(result.output).toContain('服务已卸载');
  const backup = (await readdir(root)).find(name => name.startsWith('installation.uninstalled-'))!;
  expect(backup).toBeDefined();
  expect(await readFile(join(root, backup, 'config.yaml'), 'utf8')).toBe('private config');
  expect(await readFile(join(root, 'other-plugin'), 'utf8')).toBe('keep me');
  expect(await readFile(boot, 'utf8')).toBe('other-plugin start\n');
  expect(await Bun.file(join(dir, 'service.sh')).exists()).toBe(false);
  expect(await Bun.file(join(root, backup, 'lock/pid')).exists()).toBe(false);
});

test('device inspection reports installation prerequisites as booleans', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-inspect-'));
  temporary.push(dir);
  const source = (await readFile('scripts/service.sh', 'utf8'))
    .replace('DIR=/data/ufi-mihomo', `DIR=${quote(dir)}`)
    .replace('BOOT=/sdcard/ufi_tools_boot.sh', `BOOT=${quote(join(dir, 'boot'))}`);
  await writeFile(join(dir, 'service.sh'), source);
  await writeFile(join(dir, 'network.sh'), '');
  const run = async () => {
    const proc = Bun.spawn(['sh', join(dir, 'service.sh'), 'inspect'], { stdout: 'pipe' });
    const state = parseState(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    return state;
  };
  expect(await run()).toMatchObject({ service: true, core: false, config: false, running: false, locked: false });
  await writeFile(join(dir, 'mihomo'), '#!/bin/sh\nexit 0\n');
  await chmod(join(dir, 'mihomo'), 0o700);
  await writeFile(join(dir, 'config.yaml'), 'rules: []');
  await writeFile(join(dir, 'subscription.curl'), 'url = "https://example.com"');
  expect(await run()).toMatchObject({ core: true, config: true, subscription: true, listeners: false, network: false });
});
