// Shared by Vite development and the built-artifact browser harness. Never included in the plugin.
import { emptyState, type DeviceState } from '../src/state';
import { RELEASE_API } from '../src/release';

const ready = { ...emptyState, service: true, core: true, config: true, subscription: true };
const scenarios: Record<string, DeviceState> = {
  'missing-service': emptyState,
  'missing-core': { ...emptyState, service: true },
  'missing-config': { ...emptyState, service: true, core: true },
  ready,
  running: { ...ready, running: true, supervisor: true, listeners: true, network: true, capture: true },
  locked: { ...ready, locked: true },
};
const state = { ...(scenarios[new URL(location.href).searchParams.get('state') || ''] || emptyState) };
const commands: string[] = [];
const uploads: { name: string; text: string }[] = [];
const stored = { mirror: '', interfaces: 'auto' };
const flags = globalThis as typeof globalThis & {
  mockProbeError?: boolean; mockStopFailure?: boolean; mockUploadFailure?: boolean;
  mockUploadDelayMs?: number; mockApplyFailure?: boolean;
};

Object.assign(globalThis, {
  KANO_baseURL: '/api', common_headers: {}, mockDeviceState: state, mockCommands: commands, mockUploads: uploads, mockStored: stored,
  runShellWithRoot: async (command: string) => {
    commands.push(command);
    const marker = command.match(/UFI_EXIT_[a-zA-Z0-9_]+/)![0];
    let content = '';
    if (command.includes('inspect')) {
      if (flags.mockProbeError) return { success: false, content: '模拟连接失败' };
      content = JSON.stringify(state);
    } else if (command.includes('cat /data/ufi-mihomo/core-mirror')) content = stored.mirror;
    else if (command.includes('cat /data/ufi-mihomo/interfaces')) content = stored.interfaces;
    else if (command.includes('core-mirror.upload')) stored.mirror = uploads.filter(file => file.name === 'core-mirror').slice(-1)[0]?.text.trim() ?? '';
    else if (command.includes('interfaces.upload')) stored.interfaces = uploads.filter(file => file.name === 'interfaces').slice(-1)[0]?.text.trim() ?? 'auto';
    else if (command.includes('getprop ro.product.cpu.abi')) content = 'arm64-v8a';
    else if (command.includes('id -u')) content = '0';
    else if (command.includes('service.sh.upload')) state.service = true;
    else if (command.includes('subscription.curl.upload')) state.subscription = true;
    else if (command.includes('install-official')) state.core = true;
    else if (command.includes('uninstall')) {
      if (flags.mockStopFailure) return { success: true, content: `停止失败，文件未移除\n${marker}1` };
      Object.assign(state, emptyState);
      content = '服务已卸载，文件备份：/data/ufi-mihomo.uninstalled-mock';
    } else if (command.includes('ip -o')) content = 'wlan0 192.168.0.1/24';
    else if (command.includes('apply')) {
      if (flags.mockApplyFailure) return { success: true, content: `配置校验失败\n${marker}1` };
      state.config = true; content = '配置已更新';
    }
    else if (command.includes('fetch')) content = '订阅下载完成';
    else if (command.includes('boot-on')) state.boot = true;
    else if (command.includes('boot-off')) state.boot = false;
    else if (command.includes('stop')) Object.assign(state, { running: false, supervisor: false, listeners: false, network: false, capture: false });
    else if (command.includes('start')) Object.assign(state, { running: true, supervisor: true, listeners: true, network: true, capture: true });
    else if (command.includes('.result')) content = '0';
    return { success: true, content: `${content}\n${marker}0` };
  },
});

const nativeFetch = globalThis.fetch.bind(globalThis);
const mockFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/upload_img') {
    if (flags.mockUploadFailure) return Response.json({ error: '模拟上传失败' }, { status: 500 });
    const file = (init!.body as FormData).get('file') as File;
    uploads.push({ name: file.name, text: await file.text() });
    if (flags.mockUploadDelayMs) await new Promise(resolve => setTimeout(resolve, flags.mockUploadDelayMs));
    return Response.json({ url: `/uploads/${crypto.randomUUID()}.txt` });
  }
  if (url.startsWith('/api/uploads/')) return new Response('proxies: []\nrules: ["MATCH,DIRECT"]\ndns: {nameserver: [223.5.5.5]}\n');
  if (url === RELEASE_API) return Response.json({
    tag_name: 'v9.8.7', draft: false, prerelease: false,
    assets: [{ name: 'mihomo-android-arm64-v8-v9.8.7.gz', digest: `sha256:${'a'.repeat(64)}`,
      browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v9.8.7/mihomo-android-arm64-v8-v9.8.7.gz' }],
  });
  return nativeFetch(input, init);
};
globalThis.fetch = Object.assign(mockFetch, { preconnect: globalThis.fetch.preconnect });
