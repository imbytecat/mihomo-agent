export const emptyState = {
  service: false, core: false, config: false, subscription: false,
  running: false, supervisor: false, listeners: false, network: false,
  boot: false, locked: false, capture: false,
};
export type DeviceState = typeof emptyState;
export type Action = 'install' | 'service-update' | 'download' | 'save' | 'update'
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
  if (action === 'save' || action === 'download' || action === 'service-update') {
    if (state.running) return '请先停止服务';
    return '';
  }
  if (!state.core) return '请先安装核心';
  if (action === 'update') {
    if (draftUrl.trim()) return '请先保存新订阅链接';
    return state.subscription ? '' : '请先保存订阅链接';
  }
  if (!state.config) return '请先更新订阅，生成可用配置';
  if (action === 'start') return state.running ? '服务已运行，请使用重启' : '';
  if (action === 'restart') return state.running ? '' : '服务未运行，请使用启动';
  if (action === 'boot-on') return state.boot ? '开机自启已开启' : '';
  return '';
}

export function nextStep(state: DeviceState | null): string {
  if (!state) return '无法确认设备状态，请检查 UFI 登录和高级功能，再刷新状态。';
  if (state.locked) return '设备正在执行安装或更新。完成后刷新状态，期间不要重复操作。';
  if (!state.service) return '第一步：点击「安装服务」，再下载官方核心。';
  if (!state.core) return '下一步：安装最新官方核心。';
  if (!state.subscription && !state.config) return '下一步：填写订阅链接并保存，再点击「更新订阅」。';
  if (!state.config) return '下一步：点击「更新订阅」，校验并生成运行配置。';
  if (!state.running) return '准备就绪，点击「启动」开启共享网络代理。';
  if (!state.supervisor) return '核心仍在运行，但守护进程已退出，请停止或重启。';
  if (!state.listeners) return '核心已启动，DNS / TProxy 监听尚未就绪，请查看日志。';
  if (!state.network) return '等待热点 / USB 共享网络，或正在恢复接管；持续异常请查看日志。';
  return '本地进程、监听与规则就绪，外网连通性仍需客户端验证。';
}
