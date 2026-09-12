import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChevronDown, Download, FileText, LoaderCircle, Play, Power,
  RefreshCw, Save, Settings2, ShieldCheck, Square, Stethoscope, Trash2, type LucideIcon,
} from 'lucide-react';
import { adaptConfig, curlConfig, downloadMirror, interfaces } from './config';
import { DIR, installOfficial, readDeviceState, readDownload, service, shell, upload } from './ufi';
import { disabledReason, lifecycleAction, nextStep, type Action, type DeviceState } from './state';
import serviceScript from '../scripts/service.sh?raw';
import networkScript from '../scripts/network.sh?raw';
import styleText from './style.css?inline';

export default function Gateway() {
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState('正在检测设备状态…');
  const [error, setError] = useState(false);
  const [url, setUrl] = useState('');
  const [lan, setLan] = useState('');
  const [mirror, setMirror] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const busyRef = useRef(false);
  const settingsLoaded = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  async function refresh() {
    try {
      const state = await readDeviceState();
      setDevice(state);
      if (!state.service || !state.core) setSetupOpen(true);
      if (!settingsLoaded.current && state.service) {
        const saved = await shell(`[ ! -f ${DIR}/interfaces ] || cat ${DIR}/interfaces`);
        setLan(saved === 'auto' ? '' : saved);
        const savedMirror = await shell(`[ ! -f ${DIR}/core-mirror ] || cat ${DIR}/core-mirror`);
        setMirror(current => current || savedMirror);
        settingsLoaded.current = true;
      }
    } catch (error) { setDevice(null); throw error; }
  }

  async function run(id: Action, action: () => Promise<unknown>) {
    if (busyRef.current || disabledReason(id, device, false, url)) return;
    busyRef.current = true;
    setBusy(id); setError(false); setMessage('执行中…');
    try {
      if (id !== 'refresh' && id !== 'diagnose') {
        const state = await readDeviceState();
        setDevice(state);
        const reason = disabledReason(id, state, false, url);
        if (reason) throw new Error(reason);
      }
      setMessage(String(await action() || '完成'));
    } catch (error) {
      setError(true); setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      try { await refresh(); } catch (error) {
        setError(true);
        setMessage(value => `${value}\n刷新状态失败：${error instanceof Error ? error.message : String(error)}`);
      }
      busyRef.current = false; setBusy(null);
    }
  }

  useEffect(() => { void run('refresh', async () => '状态已刷新'); }, []);

  function button(id: Action, label: string, Icon: LucideIcon, onClick: () => void) {
    const reason = disabledReason(id, device, !!busy, url);
    return <button key={id} type="button" data-action={id} disabled={!!reason} title={reason}
      aria-describedby="ufi-mihomo-next" onClick={onClick}
      data-primary={id === 'start' ? '' : undefined} data-danger={id === 'uninstall' ? '' : undefined}
      className="ufi-flex ufi-items-center ufi-justify-center ufi-gap-2">
      {busy === id ? <LoaderCircle size={16} className="ufi-animate-spin motion-reduce:ufi-animate-none" aria-hidden /> : <Icon size={16} aria-hidden />}
      <span>{label}</span>
    </button>;
  }
  const commandButton = (id: Action, label: string, Icon: LucideIcon) =>
    button(id, label, Icon, () => void run(id, () => service(id, 95_000)));
  const installService = async () => {
    await shell(`[ ! -f ${DIR}/service.sh ] || sh ${DIR}/service.sh stop`, 95_000);
    await upload('network.sh', networkScript); await upload('service.sh', serviceScript);
    return '服务文件已就绪';
  };
  const lifecycle = lifecycleAction(device);

  const title = !device ? busy === 'refresh' ? '正在检测设备状态…' : '无法确认设备状态' : !device.service ? '尚未安装服务'
    : device.locked ? '设备操作进行中' : !device.core ? '服务已安装 · 尚未安装核心'
    : !device.config ? '核心已安装 · 尚未导入配置' : !device.running ? '已停止'
    : device.supervisor && device.listeners && device.network ? '运行中 · 本地接管就绪' : '正在启动 / 恢复中';
  const dot = device?.running ? device.listeners && device.network ? 'running' : 'waiting' : 'stopped';

  return <details id="ufi-mihomo" aria-busy={!!busy} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open && !busyRef.current) void run('refresh', async () => '状态已刷新');
  }}>
    <summary className="ufi-flex ufi-items-center ufi-gap-3 ufi-p-5">
      <span className="ufi-flex ufi-h-10 ufi-w-10 ufi-items-center ufi-justify-center ufi-rounded-xl ufi-bg-teal-500/15 ufi-text-teal-400"><ShieldCheck size={24} aria-hidden /></span>
      <span className="ufi-flex ufi-flex-col ufi-gap-0.5"><strong className="ufi-text-base ufi-font-semibold">Mihomo 网关</strong><span className="ufi-text-xs ufi-opacity-60">随身连接，安静代理</span></span>
      <span data-dot data-state={dot} className="ufi-ml-2 ufi-h-2 ufi-w-2 ufi-rounded-full" aria-hidden />
      <ChevronDown data-chevron size={18} className="ufi-ml-auto ufi-opacity-60" aria-hidden />
    </summary>
    <div className="ufi-space-y-5 ufi-px-5 ufi-pb-5">
      <div className="ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3">
        <p data-status role="status" className="ufi-text-xs ufi-leading-relaxed ufi-opacity-80">{title}</p>
        {device && <p data-resources className="ufi-mt-2 ufi-text-xs ufi-opacity-60">核心：{device.core ? '已安装' : '未安装'} · 配置：{device.config ? '已就绪' : '未就绪'} · 自启：{device.boot ? '开' : '关'}</p>}
      </div>
      <p id="ufi-mihomo-next" data-next className="ufi-text-sm ufi-leading-relaxed ufi-text-teal-400" role="status">{!device && busy === 'refresh' ? '正在检查服务、核心和配置…' : nextStep(device)}</p>
      <div data-lifecycle className="ufi-flex ufi-items-center ufi-justify-between ufi-gap-3 ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20 ufi-p-3">
        <span className="ufi-text-sm ufi-font-medium">服务管理</span>
        {button(lifecycle ?? 'install', !device ? busy === 'refresh' ? '检测中…' : '状态未知'
          : lifecycle === 'uninstall' ? '卸载服务' : '安装服务', lifecycle === 'uninstall' ? Trash2 : Download, () => {
          if (lifecycle === 'uninstall') dialog.current?.showModal();
          else if (lifecycle === 'install') void run('install', installService);
        })}
      </div>
      <label className="ufi-block ufi-text-sm ufi-font-medium">配置订阅
        <input data-url type="password" autoComplete="off" placeholder="粘贴完整配置链接；已保存则留空" value={url}
          onChange={event => setUrl(event.target.value)} disabled={!!disabledReason('save', device, !!busy)} />
      </label>
      <div className="ufi-grid ufi-grid-cols-2 ufi-gap-2 sm:ufi-grid-cols-3">
        {button('save', '保存设置', Save, () => void run('save', async () => {
          const names = interfaces(lan);
          const subscription = url.trim() ? curlConfig(url.trim()) : null;
          const mirrorPrefix = downloadMirror(mirror);
          await upload('interfaces', names + '\n');
          await upload('core-mirror', mirrorPrefix + '\n');
          if (subscription) { await upload('subscription.curl', subscription); setUrl(''); }
          return '设置已保存到设备';
        }))}
        {button('update', '更新订阅', RefreshCw, () => void run('update', async () => {
          await service('fetch', 95_000);
          await upload('candidate.yaml', adaptConfig(await readDownload()));
          return service('apply', 95_000);
        }))}
        {commandButton('start', '启动', Play)}
        {commandButton('stop', '停止', Square)}
        {commandButton('logs', '日志', FileText)}
        {button('refresh', '刷新状态', RefreshCw, () => void run('refresh', async () => '状态已刷新'))}
      </div>
      <label className="ufi-flex ufi-items-center ufi-justify-between ufi-gap-3 ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3">
        <span className="ufi-flex ufi-items-center ufi-gap-2 ufi-text-sm"><Power size={16} aria-hidden />开机自启
          <span className="ufi-text-xs ufi-opacity-60">{device?.boot ? '已开启' : '已关闭'}</span>
        </span>
        <input type="checkbox" role="switch" data-boot checked={device?.boot ?? false}
          disabled={!!disabledReason(device?.boot ? 'boot-off' : 'boot-on', device, !!busy)}
          title={disabledReason(device?.boot ? 'boot-off' : 'boot-on', device, !!busy)}
          aria-describedby="ufi-mihomo-next" onChange={event => {
            const action = event.target.checked ? 'boot-on' : 'boot-off';
            void run(action, async () => { await service(action); return action === 'boot-on' ? '开机自启已开启' : '开机自启已关闭'; });
          }} />
      </label>
      <p className="ufi-text-xs ufi-leading-relaxed ufi-opacity-60">自动识别热点和 USB 共享网络。IPv4 走代理，共享网络 IPv6 被阻断。</p>
      <details data-setup open={setupOpen} onToggle={event => { if (event.target === event.currentTarget) setSetupOpen(event.currentTarget.open); }} className="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary className="ufi-flex ufi-items-center ufi-gap-2 ufi-p-3 ufi-text-sm ufi-font-medium"><Download size={16} aria-hidden />核心安装与更新<ChevronDown data-chevron size={16} className="ufi-ml-auto" aria-hidden /></summary>
        <div className="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <p className="ufi-text-xs ufi-leading-relaxed ufi-opacity-60">首次使用：安装服务 → 安装核心 → 保存订阅 → 更新订阅 → 启动。请先停用其他透明代理，避免规则冲突。</p>
          <label className="ufi-block ufi-text-xs">核心下载镜像（可选）
            <input data-mirror type="url" placeholder="留空直连 GitHub；或 HTTPS 代理前缀" value={mirror}
              onChange={event => setMirror(event.target.value)} disabled={!!busy} />
          </label>
          <p className="ufi-text-xs ufi-opacity-60">镜像可提前填写，下载核心时使用；不会用于订阅。</p>
          <div className="ufi-grid ufi-grid-cols-1 ufi-gap-2 sm:ufi-grid-cols-2">
            {button('download', '安装最新官方核心', Download, () => void run('download', async () => {
              await upload('core-mirror', downloadMirror(mirror) + '\n');
              return installOfficial(setMessage);
            }))}
          </div>
        </div>
      </details>
      <details data-advanced className="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary className="ufi-flex ufi-items-center ufi-gap-2 ufi-p-3 ufi-text-sm ufi-font-medium"><Settings2 size={16} aria-hidden />高级设置<ChevronDown data-chevron size={16} className="ufi-ml-auto" aria-hidden /></summary>
        <div className="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <label className="ufi-block ufi-text-xs">手动指定共享入口（可选）
            <input data-lan type="text" placeholder="留空自动识别；仅识别异常时填写" value={lan}
              onChange={event => setLan(event.target.value)} disabled={!!disabledReason('save', device, !!busy)} />
          </label>
          <p className="ufi-text-xs ufi-opacity-60">修改后点击「保存设置」。通常无需填写。</p>
          <div className="ufi-grid ufi-grid-cols-2 ufi-gap-2">
            {button('diagnose', '网络诊断', Stethoscope, () => void run('diagnose', () => shell('ip -o -4 addr show; ip -4 rule show; ip -4 route show table all; ip -6 route show table all; getprop ro.product.cpu.abi')))}
            {commandButton('restart', '重启', RefreshCw)}
            {device?.service && button('service-update', '更新服务文件', Download, () => void run('service-update', installService))}
          </div>
        </div>
      </details>
      <pre data-output data-error={error} role={error ? 'alert' : 'status'} className="ufi-max-h-64 ufi-overflow-auto ufi-whitespace-pre-wrap ufi-break-words ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3 ufi-text-xs ufi-leading-relaxed">{message}</pre>
    </div>
    <dialog ref={dialog} data-uninstall aria-labelledby="ufi-mihomo-uninstall-title">
      <form method="dialog" className="ufi-space-y-4" onSubmit={event => {
        event.preventDefault(); dialog.current?.close();
        void run('uninstall', async () => {
          const result = await service('uninstall', 95_000);
          settingsLoaded.current = false; setUrl(''); setLan(''); setMirror('');
          return result;
        });
      }}>
        <h3 id="ufi-mihomo-uninstall-title" className="ufi-m-0 ufi-text-base">卸载 Mihomo 服务？</h3>
        <p className="ufi-text-sm ufi-leading-relaxed">将停止代理、关闭开机自启并清理本插件接管规则。安装文件、配置和订阅会移到设备上的备份目录，可手动恢复。</p>
        <p className="ufi-text-xs ufi-opacity-60">卸载后恢复系统直连。本界面需在 UFI 插件管理中另行删除。</p>
        <div className="ufi-flex ufi-flex-wrap ufi-justify-end ufi-gap-2">
          <button type="button" autoFocus onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" data-danger>确认卸载并备份</button>
        </div>
      </form>
    </dialog>
  </details>;
}

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor) return;
  let style = document.getElementById('ufi-mihomo-style');
  if (!style) { style = document.createElement('style'); style.id = 'ufi-mihomo-style'; document.head.append(style); }
  style.textContent = styleText;
  if (document.getElementById('ufi-mihomo-mount')) return;
  const container = document.createElement('div'); container.id = 'ufi-mihomo-mount'; anchor.after(container);
  createRoot(container).render(<Gateway />);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
