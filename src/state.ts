export const emptyState = {
  service: false, core: false, config: false, subscription: false,
  running: false, supervisor: false, listeners: false, network: false,
  boot: false, locked: false, capture: false,
};
export type DeviceState = typeof emptyState;
export type Action = 'install' | 'service-update' | 'download' | 'save-mirror' | 'save-interfaces' | 'update'
  | 'start' | 'stop' | 'restart' | 'boot-on' | 'boot-off' | 'logs' | 'refresh' | 'diagnose' | 'uninstall';

export function parseState(text: string): DeviceState {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Object.keys(emptyState).some(key =>
    typeof (value as Record<string, unknown>)[key] !== 'boolean')) throw new Error('设备状态格式异常，请更新服务');
  return value as DeviceState;
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
