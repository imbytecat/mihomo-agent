import { z } from 'zod';

export const jobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), action: z.enum(['bootstrap', 'install', 'download', 'update', 'start', 'stop', 'restart', 'boot-on', 'boot-off', 'uninstall', 'save-mirror', 'save-interfaces']),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted']), phase: z.string(), updated: z.string(),
  result: z.string().optional().default(''), error: z.string().optional().default(''), hash: z.string(),
});
export type DeviceJob = z.infer<typeof jobSchema>;
export type TaskAction = Exclude<DeviceJob['action'], 'bootstrap'>;
const stateSchema = z.object({
  protocol: z.literal(1), version: z.string(), publicKey: z.string(), service: z.boolean(), core: z.boolean(), config: z.boolean(), subscription: z.boolean(),
  running: z.boolean(), supervisor: z.boolean(), listeners: z.boolean(), network: z.boolean(), boot: z.boolean(), locked: z.boolean(), capture: z.boolean(),
  settings: z.object({ mirror: z.string(), interfaces: z.array(z.string()) }), task: jobSchema.nullable(),
});
export type DeviceState = z.infer<typeof stateSchema> & { agent: boolean };
export const emptyState: DeviceState = {
  service: false, core: false, config: false, subscription: false,
  running: false, supervisor: false, listeners: false, network: false,
  boot: false, locked: false, capture: false,
  agent: false, protocol: 1, version: '', publicKey: '', settings: { mirror: '', interfaces: [] }, task: null,
};
export type Action = 'install' | 'service-update' | 'download' | 'save-mirror' | 'save-interfaces' | 'update'
  | 'start' | 'stop' | 'restart' | 'boot-on' | 'boot-off' | 'logs' | 'refresh' | 'diagnose' | 'uninstall';

export function parseState(text: string): DeviceState {
  const result = stateSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error('设备后端协议不匹配，请更新设备组件');
  return { ...result.data, agent: true };
}
export function parseJob(value: unknown): DeviceJob {
  const result = jobSchema.safeParse(value);
  if (!result.success) throw new Error('设备任务响应无效');
  return result.data;
}

export function lifecycleAction(state: DeviceState | null): 'install' | 'uninstall' | null {
  return state ? state.service ? 'uninstall' : 'install' : null;
}

export function disabledReason(action: Action, state: DeviceState | null, busy = false, draftUrl = ''): string {
  if (busy) return '正在执行操作，请稍候';
  if (action === 'refresh' || action === 'diagnose') return '';
  if (!state) return '尚未确认设备状态，请刷新状态';
  if (state.locked && action !== 'logs') return '设备正在安装或更新，请等待完成后刷新';
  if (action === 'install') return state.service ? '服务已安装，请刷新状态' : state.running ? '请先停止服务' : '';
  if (!state.service) return '请先安装服务';
  if (action === 'uninstall' || action === 'logs') return '';
  if (action === 'stop') return state.running || state.capture ? '' : '服务已停止';
  if (action === 'boot-off') return state.boot ? '' : '开机自启已关闭';
  if (action === 'save-mirror') return '';
  if (action === 'save-interfaces' || action === 'download' || action === 'service-update') {
    if (state.running) return '请先停止服务';
    return '';
  }
  if (!state.core) return '请先安装核心';
  if (action === 'update') {
    return state.subscription || draftUrl.trim() ? '' : '请输入订阅链接';
  }
  if (!state.config) return '请先更新订阅，生成可用配置';
  if (action === 'start') return state.running ? '服务已运行，请使用重启' : '';
  if (action === 'restart') return state.running ? '' : '服务未运行，请使用启动';
  if (action === 'boot-on') return state.boot ? '开机自启已开启' : '';
  return '';
}

export function nextStep(state: DeviceState | null): string {
  if (!state) return '请检查连接后刷新';
  if (state.locked) return '设备操作中，请稍候';
  if (!state.service) return '请先安装服务';
  if (!state.core) return '请下载核心';
  if (!state.subscription && !state.config) return '请保存订阅';
  if (!state.config) return '请更新订阅';
  if (!state.running) return '准备就绪，可以启动';
  if (!state.supervisor) return '守护进程异常，请重启';
  if (!state.listeners) return '等待核心就绪';
  if (!state.network) return '等待共享网络';
  return '本地接管就绪';
}
