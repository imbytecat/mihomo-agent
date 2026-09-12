import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionURL, githubProxyURL, interfaces } from '../src/config';
import { quote, shellCommand, shellResult, controllerURL } from '../src/ufi';
import { disabledReason, emptyState, lifecycleAction, nextStep, parseState, componentVersion, topTask, parseJob } from '../src/state';
import { request, responseJSON } from '../src/request';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function networkFunctions() {
  const source = await readFile('agent/internal/app/network.sh', 'utf8');
  return 'PROTECTED_PORTS=7894,1053\n' + source.slice(source.indexOf('MARK='), source.indexOf('\nPROTECTED_PORTS='));
}

test('input validation and shell results preserve the trust boundary', async () => {
  expect(interfaces('wlan0, rndis0 wlan0')).toBe('wlan0 rndis0');
  expect(interfaces('')).toBe('auto');
  expect(interfaces(' auto ')).toBe('auto');
  for (const name of ['lo', 'rmnet_data0', 'wlan0;reboot', '-i']) expect(() => interfaces(name)).toThrow();
  expect(() => subscriptionURL('file:///etc/passwd')).toThrow();
  expect(() => subscriptionURL('https://example.com/\noutput=/bad')).toThrow();
  expect(subscriptionURL('https://example.com/?key=x')).toContain('key=x');
  expect(githubProxyURL('')).toBe('');
  expect(githubProxyURL('https://worker.example/')).toBe('https://worker.example');
  expect(() => githubProxyURL('http://worker.example/')).toThrow();
  expect(() => githubProxyURL('https://user:pass@worker.example/')).toThrow();
  expect(githubProxyURL('https://ghfast.top/')).toBe('https://ghfast.top');
  expect(() => githubProxyURL('https://github.com/MetaCubeX/mihomo/releases/download/v1/core.gz')).toThrow('前缀');
  expect(() => githubProxyURL('https://ghfast.top/https://github.com/MetaCubeX/mihomo/releases/download/v1/core.gz')).toThrow('前缀');
  const value = "a'b $(printf injected) `printf injected`\n中文";
  const proc = Bun.spawn(['sh', '-c', shellCommand(`printf '%s' ${quote(value)}`, 'TEST_')], { stdout: 'pipe' });
  expect(shellResult(await new Response(proc.stdout).text(), 'TEST_')).toBe(value);
  expect(await proc.exited).toBe(0);
  expect(() => shellResult('bad\nTEST_2', 'TEST_')).toThrow('bad');
  expect(() => shellResult('looks successful', 'TEST_')).toThrow('完整响应');
});

test('network setup refuses foreign table and scopes interception to LAN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-network-'));
  temporary.push(dir);
  await writeFile(join(dir, 'interfaces'), 'wlan0 rndis0\n');
  for (const name of ['routes', 'rules', 'ready', 'fw-4-mangle-PREROUTING', 'fw-4-nat-PREROUTING', 'fw-4-filter-INPUT', 'fw-6-filter-INPUT', 'fw-6-filter-FORWARD']) {
    await writeFile(join(dir, name), '');
  }
  const network = await networkFunctions();
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

test('startup and missing-LAN states keep listener guards without capturing traffic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-guards-'));
  temporary.push(dir);
  for (const name of ['routes', 'rules', 'fw-4-mangle-PREROUTING', 'fw-4-nat-PREROUTING', 'fw-4-filter-INPUT', 'fw-6-filter-INPUT', 'fw-6-filter-FORWARD']) {
    await writeFile(join(dir, name), '');
  }
  const network = await networkFunctions();
  const harness = await readFile('tests/fake-net.sh', 'utf8');
  const run = async (action: string) => {
    const proc = Bun.spawn(['sh', '-c', `DIR=${quote(dir)}\n${network}\n${harness}\n${action}`], { stdout: 'pipe', stderr: 'pipe' });
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(error).toBe('');
  };
  await run('ACTION=prepare network_start');
  expect(await readFile(join(dir, 'fw-4-filter-UFI_MH_IN_A'), 'utf8')).toContain('--dports 7894,1053 -j REJECT');
  expect(await readFile(join(dir, 'fw-6-filter-UFI_MH_IN6_A'), 'utf8')).toContain('--dports 7894,1053 -j REJECT');
  expect(await readFile(join(dir, 'fw-4-mangle-UFI_MH_A'), 'utf8')).not.toContain('TPROXY');
  await writeFile(join(dir, 'ready'), '');
  await writeFile(join(dir, 'interfaces'), 'wlan0');
  await run('network_sync');
  await run('resolve_interfaces() { echo; }; network_sync');
  const slot = (await readFile(join(dir, 'network.active'), 'utf8')).trim();
  const guard = await readFile(join(dir, `fw-4-filter-UFI_MH_IN_${slot}`), 'utf8');
  expect(guard).toContain('-j REJECT');
  expect(guard).not.toContain('-i wlan0');
  expect(await readFile(join(dir, `fw-4-mangle-UFI_MH_${slot}`), 'utf8')).not.toContain('TPROXY');
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

test('auto LAN selection excludes cellular, VPN, upstream Wi-Fi and inactive links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ufi-mihomo-auto-'));
  temporary.push(dir);
  const source = await networkFunctions();
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
  const source = await networkFunctions();
  const script = `DIR=${quote(dir)}\n${source}
resolve_interfaces() { printf '%s' "$desired"; }
listeners_ready() { return 0; }
active_interfaces() { cat "$DIR/interfaces.active" 2>/dev/null; }
network_ok() { return 0; }
network_stop() { echo stop; rm -f "$DIR/interfaces.active"; }
pause_capture() { echo pause; }
network_start() { echo "start:$desired"; printf '%s' "$desired" > "$DIR/interfaces.active"; }
desired=wlan0; network_sync
network_sync
desired='rndis0 wlan0'; network_sync
desired=''; network_sync
desired=wlan0; network_sync`;
  const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe' });
  expect(await new Response(proc.stdout).text()).toBe('start:wlan0\nstart:rndis0 wlan0\npause\nstart:\nstart:wlan0\n');
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
  const source = (await networkFunctions()).replaceAll('/proc/', `${procdir}/`);
  const run = async () => {
    const proc = Bun.spawn(['sh', '-c', `DIR=${quote(dir)}\n${source}\nalive() { return 0; }\nlisteners_ready`]);
    return proc.exited;
  };
  expect(await run()).toBe(0);
  await mkdir(join(dir, 'current'));
  await writeFile(join(dir, 'current/api-port'), '9090');
  expect(await run()).toBe(1);
  await symlink('socket:[15]', join(procdir, '123/fd/15'));
  await writeFile(join(procdir, 'net/tcp'), row('1ED6', '0A', 11) + row('041D', '0A', 12) + row('2382', '0A', 15));
  expect(await run()).toBe(0);
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13) + row('041D', '07', 999));
  expect(await run()).toBe(1);
  await writeFile(join(procdir, 'net/udp'), row('1ED6', '07', 13));
  expect(await run()).toBe(1);
});

test('UI gates actions by real prerequisites and keeps recovery actions accessible', () => {
  expect(disabledReason('install', null)).not.toBe('');
  expect(disabledReason('refresh', null)).toBe('');
  expect(disabledReason('install', emptyState)).toBe('');
  expect(disabledReason('uninstall', emptyState)).not.toBe('');
  const installed = { ...emptyState, agent: true, service: true, controller: { enabled: true, port: 9090, applied: false } };
  expect(lifecycleAction(null)).toBe(null);
  expect(lifecycleAction(emptyState)).toBe('install');
  expect(lifecycleAction(installed)).toBe('uninstall');
  expect(disabledReason('install', installed)).toContain('已安装');
  expect(disabledReason('update-agent', installed)).toBe('');
  expect(disabledReason('uninstall', null)).not.toBe('');
  expect(disabledReason('uninstall', installed, true)).not.toBe('');
  for (const action of ['start', 'restart', 'update', 'boot-on'] as const) expect(disabledReason(action, installed)).not.toBe('');
  expect(disabledReason('download', installed)).toBe('');
  expect(disabledReason('save-github-proxy', { ...installed, running: true })).toBe('');
  expect(disabledReason('save-interfaces', { ...installed, running: true })).toContain('停止');
  expect(nextStep(installed)).toContain('内核');
  const ready = { ...installed, core: true, config: true, subscription: true };
  expect(disabledReason('start', ready)).toBe('');
  expect(disabledReason('update', ready, false, 'https://new.example')).toBe('');
  expect(disabledReason('update', { ...ready, subscription: false }, false, '')).toContain('订阅');
  expect(disabledReason('update', ready, false, '')).toBe('');
  expect(disabledReason('start', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('download', { ...ready, running: true })).not.toBe('');
  expect(disabledReason('stop', { ...ready, running: true })).toBe('');
  expect(disabledReason('boot-off', { ...installed, boot: true })).toBe('');
  expect(disabledReason('uninstall', { ...ready, locked: true })).not.toBe('');
  expect(disabledReason('logs', { ...ready, locked: true })).toBe('');
  expect(() => parseState('{"service":true}')).toThrow();
  expect(parseState(JSON.stringify(ready))).toEqual(ready);
  expect(disabledReason('save-controller', { ...ready, controller: null })).toContain('更新 Mihomo Agent');
  expect(disabledReason('update-agent', null)).toBe('');
  expect(disabledReason('stop', null)).toBe('');
  expect(lifecycleAction({ ...emptyState, agent: true })).toBe('uninstall');
  expect(disabledReason('uninstall', { ...emptyState, agent: true })).toBe('');
  expect(disabledReason('open-dashboard', ready)).toContain('安装面板');
  const panel = { ...ready, controller: { enabled: true, port: 9090, applied: true }, dashboard: { installed: true, ready: true, version: 'v1.0.0' } };
  expect(disabledReason('open-dashboard', panel)).toContain('启动');
  expect(disabledReason('open-dashboard', { ...panel, running: true, listeners: true })).toBe('');
  expect(controllerURL('https://user:pass@192.168.0.1:8080/api?token=private#x', 9090)).toBe('http://192.168.0.1:9090/ui/');
  expect(() => controllerURL('http://192.168.0.1/', 0)).toThrow();
});

test('request errors identify network, timeout, HTTP and malformed response stages', async () => {
  const context = { step: '查询最新版本', target: '管理浏览器 GET https://api.github.com/releases/latest', hint: 'GitHub Proxy不代理版本查询' };
  const fetch = spyOn(globalThis, 'fetch');
  try {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await request('https://api.github.com/releases/latest', {}, context).catch(error => error as Error);
    if (!(error instanceof Error)) throw new Error('Expected a request failure');
    expect(error.message).toContain('查询最新版本失败');
    expect(error.message).toContain('api.github.com');
    expect(error.message).toContain('TypeError: Failed to fetch');
    expect(error.message).toContain('GitHub Proxy不代理版本查询');
    fetch.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(request('https://api.github.com/releases/latest', {}, context)).rejects.toThrow('请求超时');
    fetch.mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await expect(request('https://api.github.com/releases/latest', {}, context)).rejects.toThrow('HTTP 403（请求已被限流');
    await expect(responseJSON(new Response('<html>login</html>'), context)).rejects.toThrow('响应不是有效 JSON');
    fetch.mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(request('/api/upload_img', {}, { step: '上传到 F50', target: 'F50 /api/upload_img', hint: '重新登录 UFI' })).rejects.toThrow('认证失败');
  } finally { fetch.mockRestore(); }
});

test('component versions and task placement stay consistent', () => {
  expect(componentVersion(true, 'v1.19.30')).toBe('v1.19.30');
  expect(componentVersion(true, '')).toBe('版本未知');
  expect(componentVersion(false, 'v1.19.30')).toBe('未安装');
  expect(componentVersion(undefined, '')).toBe('状态未知');
  const job = parseJob({ id: 'a'.repeat(32), action: 'download', state: 'succeeded', phase: 'done', updated: '', hash: '' });
  expect(topTask(job)).toBe(false);
  expect(topTask({ ...job, state: 'running' })).toBe(false);
  expect(topTask({ ...job, state: 'failed' })).toBe(true);
  expect(topTask({ ...job, action: 'update', state: 'running' })).toBe(true);
  expect(topTask({ ...job, action: 'update' })).toBe(false);
  expect(lifecycleAction({ ...emptyState, agent: true })).toBe('uninstall');
  expect(disabledReason('uninstall', { ...emptyState, agent: true })).toBe('');
});
