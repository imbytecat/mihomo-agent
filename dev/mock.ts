// Development-only persistent task mock; never included in the plugin.
import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { parse } from 'shell-quote';
import { emptyState, type DeviceState, type DeviceJob, type TaskAction } from '../src/state';

const ready = { ...emptyState, agent: true, service: true, core: true, config: true, subscription: true };
const scenarios: Record<string, DeviceState> = {
  'missing-service': emptyState, 'missing-core': { ...ready, core: false, config: false, subscription: false },
  'missing-config': { ...ready, config: false, subscription: false }, ready,
  running: { ...ready, running: true, supervisor: true, listeners: true, network: true, capture: true },
};
const scenario = new URL(location.href).searchParams.get('state') || 'missing-service';
const storageKey = 'ufi-mock-' + scenario;
type Intent = { id: string; action: TaskAction | 'bootstrap'; value: string };
type Pending = { intent: Intent; end: number; failure: string };
const persisted = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
const state: DeviceState = persisted?.state || structuredClone(scenarios[scenario] || emptyState);
let pending: Pending | null = persisted?.pending || null;
const jobs: Record<string, DeviceJob> = persisted?.jobs || {};
const commands: string[] = [], intents: Intent[] = [], requests: string[] = [];
const uploads: { name: string; bytes: Uint8Array }[] = [];
const keys = sodium.ready.then(() => sodium.crypto_box_keypair());
const flags = globalThis as typeof globalThis & {
  mockProbeError?: boolean; mockUploadFailure?: boolean; mockUploadDelayMs?: number;
  mockTaskDelayMs?: number; mockTaskFailure?: string;
};
const save = () => sessionStorage.setItem(storageKey, JSON.stringify({ state, pending, jobs }));
function advance() {
  if (!pending || Date.now() < pending.end) return;
  const { intent, failure } = pending;
  const job = jobs[intent.id]!;
  job.state = failure ? 'failed' : 'succeeded'; job.error = failure; job.phase = failure ? 'download' : 'done';
  job.updated = new Date().toISOString(); state.locked = false;
  if (!failure) {
    switch (intent.action) {
      case 'bootstrap': case 'install': state.agent = state.service = true; state.settings.mirror = intent.value; job.result = '服务已安装'; break;
      case 'save-mirror': state.settings.mirror = intent.value; job.result = '镜像已保存'; break;
      case 'save-interfaces': state.settings.interfaces = intent.value === 'auto' ? [] : intent.value.split(' '); job.result = '接口已保存'; break;
      case 'download': state.core = true; state.settings.mirror = intent.value; job.result = '核心 v9.8.7 已安装，校验通过'; break;
      case 'update': state.config = state.subscription = true; job.result = '配置已更新'; break;
      case 'boot-on': state.boot = true; job.result = '自启已开启'; break;
      case 'boot-off': state.boot = false; job.result = '自启已关闭'; break;
      case 'start': case 'restart': Object.assign(state, { running: true, supervisor: true, listeners: true, network: true, capture: true }); job.result = '代理已启动'; break;
      case 'stop': Object.assign(state, { running: false, supervisor: false, listeners: false, network: false, capture: false }); job.result = '代理已停止'; break;
      case 'uninstall': Object.assign(state, structuredClone(emptyState), { agent: true, publicKey: state.publicKey, task: job }); job.result = '代理服务已卸载，运行文件已备份'; break;
    }
  }
  state.task = job; pending = null; save();
}
function submit(intent: Intent, hash = '') {
  if (state.locked) throw new Error('设备任务进行中');
  intents.push(intent);
  const job: DeviceJob = { id: intent.id, action: intent.action, state: 'running', phase: 'download', hash, result: '', error: '', updated: new Date().toISOString() };
  jobs[job.id] = job; state.task = job; state.locked = true;
  pending = { intent, end: Date.now() + (flags.mockTaskDelayMs ?? 300), failure: flags.mockTaskFailure || '' };
  save(); return job;
}
Object.assign(globalThis, {
  KANO_baseURL: '/api', common_headers: {}, mockDeviceState: state, mockCommands: commands, mockUploads: uploads, mockIntents: intents, mockRequests: requests,
  runShellWithRoot: async (command: string) => {
    commands.push(command);
    const marker = command.match(/UFI_EXIT_[a-zA-Z0-9_]+/)![0];
    if (flags.mockProbeError) return { success: false, content: '模拟连接失败' };
    advance();
    state.publicKey = sodium.to_base64((await keys).publicKey, sodium.base64_variants.ORIGINAL);
    let result: unknown = null;
    try {
      const inner = parse(command)[2] as string;
      const args = parse(inner).filter((x): x is string => typeof x === 'string');
      if (inner.includes(' inspect')) result = state.agent ? state : null;
      else if (args[0] === '/data/ufi-mihomo/agent') {
        switch (args[1]) {
          case 'submit': {
            const uploaded = uploads.find(x => x.name === args[2]);
            if (!uploaded) throw new Error('上传不存在');
            if (bytesToHex(sha256(uploaded.bytes)) !== args[3]) throw new Error('校验失败');
            const key = await keys;
            const intent = JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(uploaded.bytes, key.publicKey, key.privateKey)));
            result = submit(intent, args[3]); break;
          }
          case 'job': result = jobs[args[2]!]; break;
          case 'job-log': result = 'F50 任务日志'; break;
          case 'logs': result = 'core.log\n代理运行正常'; break;
          case 'diagnose': result = 'wlan0 192.168.0.1/24'; break;
          default: throw new Error('未知命令');
        }
      } else if (args.includes('submit')) {
        const at = args.indexOf('submit');
        result = submit({ id: args[at + 1]!, action: 'bootstrap', value: args[at + 2]! });
      } else if (inner.includes('bootstrap.sh')) result = state.task?.action === 'bootstrap' ? state.task : null;
      return { success: true, content: JSON.stringify(result) + '\n' + marker + '0' };
    } catch (error) {
      return { success: true, content: JSON.stringify({ error: String(error) }) + '\n' + marker + '1' };
    }
  },
});
const nativeFetch = globalThis.fetch.bind(globalThis);
const mockFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  if (new URL(url, location.href).origin !== location.origin) throw new Error('浏览器不应请求外网：' + url);
  if (url === '/api/upload_img') {
    if (flags.mockUploadFailure) return Response.json({ error: '模拟上传失败' }, { status: 500 });
    const file = (init!.body as FormData).get('file') as File;
    const name = crypto.randomUUID() + '.bin';
    uploads.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (flags.mockUploadDelayMs) await new Promise(resolve => setTimeout(resolve, flags.mockUploadDelayMs));
    return Response.json({ url: '/uploads/' + name });
  }
  return nativeFetch(input, init);
};
globalThis.fetch = Object.assign(mockFetch, { preconnect: globalThis.fetch.preconnect });
