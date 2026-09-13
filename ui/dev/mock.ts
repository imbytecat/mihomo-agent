// Development-only persistent task mock; never included in the plugin.
import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parse } from 'shell-quote';
import { version } from '../agent-bootstrap.json';
import {
  emptyState,
  type DeviceState,
  type DeviceJob,
  type TaskAction,
  type TaskParams,
} from '../src/state';

const ready = {
  ...emptyState,
  agent: true,
  version,
  service: true,
  core: true,
  coreVersion: 'v1.19.30',
  config: true,
  subscription: true,
  controller: { enabled: true, port: 9090, applied: true },
};
const scenarios: Record<string, DeviceState> = {
  'missing-service': emptyState,
  'missing-core': {
    ...ready,
    core: false,
    coreVersion: '',
    config: false,
    subscription: false,
  },
  'missing-config': { ...ready, config: false, subscription: false },
  ready,
  'managed-linux': {
    ...ready,
    platform: 'linux',
    capabilities: {
      coreInstall: false,
      agentUpdate: false,
      autostart: false,
      interfaces: false,
      capture: false,
    },
    running: true,
    supervisor: true,
    listeners: true,
  },
  running: {
    ...ready,
    running: true,
    supervisor: true,
    listeners: true,
    network: true,
    capture: true,
    dashboard: { installed: true, ready: true, version: 'v3.26.0' },
  },
};
const scenario =
  new URL(location.href).searchParams.get('state') || 'missing-service';
const storageKey = 'ufi-mock-' + scenario;
type Intent = {
  id: string;
  action: TaskAction | 'bootstrap';
  params: TaskParams;
};
type Pending = { intent: Intent; end: number; failure: string };
const persisted = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
const state: DeviceState =
  persisted?.state || structuredClone(scenarios[scenario] || emptyState);
let controllerSecret =
  persisted?.controllerSecret || 'mock-controller-key-not-a-real-secret';
let pending: Pending | null = persisted?.pending || null;
const jobs: Record<string, DeviceJob> = persisted?.jobs || {};
const commands: string[] = [],
  intents: Intent[] = [],
  requests: string[] = [];
const uploads: { name: string; bytes: Uint8Array }[] = [];
const keys = sodium.ready.then(() => sodium.crypto_box_keypair());
const flags = globalThis as typeof globalThis & {
  mockProbeError?: boolean;
  mockUploadFailure?: boolean;
  mockUploadDelayMs?: number;
  mockTaskDelayMs?: number;
  mockTaskFailure?: string;
};
const save = () =>
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ state, pending, jobs, controllerSecret }),
  );
function advance() {
  if (!pending || Date.now() < pending.end) return;
  const { intent, failure } = pending;
  const job = jobs[intent.id]!;
  job.state = failure ? 'failed' : 'succeeded';
  job.error = failure;
  job.phase = failure ? 'download' : 'done';
  job.updated = new Date().toISOString();
  state.locked = false;
  if (!failure) {
    if (intent.params.githubProxy !== undefined)
      state.settings.githubProxy = intent.params.githubProxy;
    switch (intent.action) {
      case 'bootstrap':
      case 'install':
        state.agent = state.service = true;
        state.version = version;
        state.controller = { enabled: true, port: 9090, applied: false };
        state.settings.githubProxy =
          intent.params.githubProxy ?? state.settings.githubProxy;
        job.result = 'Mihomo 服务已安装';
        break;
      case 'update-agent':
        state.version = version;
        job.result = 'Mihomo Agent 已是最新版本';
        break;
      case 'save-github-proxy':
        state.settings.githubProxy =
          intent.params.githubProxy ?? state.settings.githubProxy;
        job.result = 'GitHub Proxy已保存';
        break;
      case 'save-interfaces':
        state.settings.interfaces =
          !intent.params.interfaces || intent.params.interfaces === 'auto'
            ? []
            : intent.params.interfaces.split(' ');
        job.result = '接口已保存';
        break;
      case 'download':
        state.core = true;
        state.coreVersion = 'v9.8.7';
        state.settings.githubProxy =
          intent.params.githubProxy ?? state.settings.githubProxy;
        job.result = '内核 v9.8.7 已安装，校验通过';
        break;
      case 'update':
        state.config = state.subscription = true;
        state.controller!.applied = true;
        state.dashboard.ready =
          state.dashboard.installed && state.controller!.enabled;
        job.result = '配置已更新';
        break;
      case 'save-controller': {
        const value = intent.params.controller!;
        state.controller = {
          enabled: value.enabled,
          port: value.port,
          applied: state.config,
        };
        if (value.reset) controllerSecret = 'mock-regenerated-controller-key';
        else if (value.secret) controllerSecret = value.secret;
        state.dashboard.ready =
          state.dashboard.installed && state.config && value.enabled;
        job.result = '面板设置已应用';
        break;
      }
      case 'download-dashboard':
        state.dashboard = {
          installed: true,
          ready: state.config && !!state.controller?.enabled,
          version: 'v3.26.0',
        };
        job.result = 'Zashboard v3.26.0 已安装';
        break;
      case 'boot-on':
        state.boot = true;
        job.result = '开机启动已开启';
        break;
      case 'boot-off':
        state.boot = false;
        job.result = '开机启动已关闭';
        break;
      case 'start':
      case 'restart':
        Object.assign(state, {
          running: true,
          supervisor: true,
          listeners: true,
          network: true,
          capture: true,
        });
        job.result = '代理已启动';
        break;
      case 'stop':
        Object.assign(state, {
          running: false,
          supervisor: false,
          listeners: false,
          network: false,
          capture: false,
        });
        job.result = '代理已停止';
        break;
      case 'uninstall':
        Object.assign(state, structuredClone(emptyState));
        for (const id of Object.keys(jobs)) delete jobs[id];
        controllerSecret = '';
        pending = null;
        sessionStorage.removeItem(storageKey);
        return;
    }
  }
  state.task = job;
  pending = null;
  save();
}
function submit(intent: Intent, hash = '') {
  if (state.locked) throw new Error('设备任务进行中');
  intents.push(intent);
  const job: DeviceJob = {
    id: intent.id,
    action: intent.action,
    state: 'running',
    phase: 'download',
    hash,
    result: '',
    error: '',
    updated: new Date().toISOString(),
  };
  jobs[job.id] = job;
  state.task = job;
  state.locked = true;
  pending = {
    intent,
    end: Date.now() + (flags.mockTaskDelayMs ?? 300),
    failure: flags.mockTaskFailure || '',
  };
  save();
  return job;
}
Object.assign(globalThis, {
  KANO_baseURL: '/api',
  common_headers: {},
  mockDeviceState: state,
  mockCommands: commands,
  mockUploads: uploads,
  mockIntents: intents,
  mockRequests: requests,
  runShellWithRoot: async (command: string) => {
    commands.push(command);
    const marker = command.match(/UFI_EXIT_[a-zA-Z0-9_]+/)![0];
    if (flags.mockProbeError)
      return { success: false, content: '模拟连接失败' };
    advance();
    state.publicKey = sodium.to_base64(
      (await keys).publicKey,
      sodium.base64_variants.ORIGINAL,
    );
    let result: unknown = null;
    try {
      const inner = parse(command)[2] as string;
      const args = parse(inner).filter(
        (x): x is string => typeof x === 'string',
      );
      if (inner.includes('ufi-uninstall-status'))
        result = state.agent ? state.task : null;
      else if (inner.includes(' inspect')) result = state.agent ? state : null;
      else if (args[0] === '/data/mihomo-agent/agent') {
        switch (args[1]) {
          case 'submit': {
            const uploaded = uploads.find((x) => x.name === args[2]);
            if (!uploaded) throw new Error('上传不存在');
            if (bytesToHex(sha256(uploaded.bytes)) !== args[3])
              throw new Error('校验失败');
            const key = await keys;
            const intent = JSON.parse(
              sodium.to_string(
                sodium.crypto_box_seal_open(
                  uploaded.bytes,
                  key.publicKey,
                  key.privateKey,
                ),
              ),
            );
            result = submit(intent, args[3]);
            break;
          }
          case 'job':
            result = jobs[args[2]!];
            break;
          case 'stop':
            result = submit({
              id: crypto.randomUUID().replaceAll('-', ''),
              action: 'stop',
              params: {},
            });
            break;
          case 'controller-secret':
            result = sodium.to_base64(
              sodium.crypto_box_seal(
                sodium.from_string(controllerSecret),
                sodium.from_base64(args[2]!, sodium.base64_variants.ORIGINAL),
              ),
              sodium.base64_variants.ORIGINAL,
            );
            break;
          case 'job-log':
            result = 'F50 任务日志';
            break;
          case 'logs':
            result = 'core.log\n代理运行正常';
            break;
          case 'diagnose':
            result = 'wlan0 192.168.0.1/24';
            break;
          default:
            throw new Error('未知命令');
        }
      } else if (args.includes('submit')) {
        const at = args.indexOf('submit');
        result = submit({
          id: args[at + 1]!,
          action: 'bootstrap',
          params: { githubProxy: args[at + 2]! },
        });
      } else if (inner.includes('bootstrap.sh'))
        result = state.task?.action === 'bootstrap' ? state.task : null;
      return {
        success: true,
        content: JSON.stringify(result) + '\n' + marker + '0',
      };
    } catch (error) {
      return {
        success: true,
        content: JSON.stringify({ error: String(error) }) + '\n' + marker + '1',
      };
    }
  },
});
const nativeFetch = globalThis.fetch.bind(globalThis);
const mockFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  requests.push(url);
  if (new URL(url, location.href).origin !== location.origin)
    throw new Error('浏览器不应请求外网：' + url);
  if (new URL(url, location.href).pathname === '/api/upload_img') {
    if (flags.mockUploadFailure)
      return Response.json({ error: '模拟上传失败' }, { status: 500 });
    const body =
      input instanceof Request
        ? await input.formData()
        : (init!.body as FormData);
    const file = body.get('file') as File;
    const name = crypto.randomUUID() + '.bin';
    uploads.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (flags.mockUploadDelayMs)
      await new Promise((resolve) =>
        setTimeout(resolve, flags.mockUploadDelayMs),
      );
    return Response.json({ url: '/uploads/' + name });
  }
  return nativeFetch(input, init);
};
globalThis.fetch = Object.assign(mockFetch, {
  preconnect: globalThis.fetch.preconnect,
});
