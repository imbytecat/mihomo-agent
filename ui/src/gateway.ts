// Task observation and presentation are independent of the page's lifetime.
import {
  readJob,
  readBootstrap,
  readUninstallJob,
  jobLog,
  baseURL,
} from './transport/ufi';
import type { DeviceJob } from './state';

export const phases: Record<string, string> = {
  accepted: '任务已接收',
  preparing: '准备中',
  release: '查询官方版本',
  download: '下载中',
  verify: '校验文件',
  installing: '安装中',
  subscription: '下载订阅',
  validate: '校验配置',
  applying: '应用配置',
  rollback: '恢复上一配置',
  saving: '保存设置',
  starting: '启动代理',
  adapt: '适配配置',
  removing: '删除设备文件',
  stopping: '停止代理',
  done: '已完成',
  interrupted: '任务已中断',
  failed: '任务失败',
};
export async function waitTask(
  initial: DeviceJob,
  progress: (job: DeviceJob) => void,
) {
  let job = initial;
  let deleting = 0;
  while (job.state === 'queued' || job.state === 'running') {
    progress(job);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      if (job.action === 'uninstall') {
        const next = await readUninstallJob(job);
        if (!next) {
          if (++deleting > 40)
            throw new Error('卸载未完成，请检查设备上剩余的文件');
          continue;
        }
        job = next;
      } else
        job =
          job.action === 'bootstrap'
            ? (await readBootstrap(job.id))!
            : await readJob(job.id);
    } catch (error) {
      throw new Error(
        `设备任务状态暂不可读\n任务 ID：${job.id}\n${error instanceof Error ? error.message : String(error)}\n任务不会因页面断开而取消，恢复连接后刷新即可继续查看。`,
      );
    }
    if (!job) throw new Error('任务记录不可读');
  }
  progress(job);
  if (job.state !== 'succeeded') {
    const log = await jobLog(job).catch(() => '暂时无法读取任务日志');
    throw new Error(
      `设备任务失败\n执行阶段：${phases[job.phase] || job.phase}\n执行位置：设备\n任务 ID：${job.id}\n${job.error || '请查看任务日志'}\n${log}`,
    );
  }
  return job.result || '任务已完成';
}
export function describeTask(job: DeviceJob) {
  const names: Record<DeviceJob['action'], string> = {
    'self-update': '更新 mihomoctl',
    bootstrap: '安装 mihomoctl',
    install: '安装 Mihomo 服务',
    download: '安装 / 更新 Mihomo 内核',
    update: '更新订阅',
    start: '启动代理',
    stop: '停止代理',
    restart: '重启代理',
    'boot-on': '启用开机启动',
    'boot-off': '关闭开机启动',
    uninstall: '卸载 Mihomo 服务',
    'save-interfaces': '保存接口',
    'save-controller': '应用面板设置',
    'download-dashboard': '安装 / 更新 Zashboard',
  };
  return [
    names[job.action],
    `执行阶段：${phases[job.phase] || job.phase}`,
    job.result,
    job.error,
    `任务 ID：${job.id}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function controllerURL(base: string, port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('无效面板端口');
  const url = new URL(base);
  url.protocol = 'http:';
  url.port = String(port);
  url.pathname = '/ui/';
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.href;
}
export function dashboardURL(port: number) {
  return controllerURL(baseURL(), port);
}
