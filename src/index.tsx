import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
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

const notification = { id: 'ufi-mihomo-operation', toasterId: 'ufi-mihomo' };

export default function Gateway() {
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState('正在检测设备状态…');
  const [error, setError] = useState(false);
  const [url, setUrl] = useState('');
  const [lan, setLan] = useState('');
  const [mirror, setMirror] = useState('');
  const [savedMirror, setSavedMirror] = useState<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const busyRef = useRef(false);
  const settingsLoaded = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  let mirrorPrefix = '', mirrorError = '';
  try { mirrorPrefix = downloadMirror(mirror); } catch (error) { mirrorError = error instanceof Error ? error.message : String(error); }
  const mirrorDirty = savedMirror === null || !!mirrorError || mirrorPrefix !== savedMirror;

  async function refresh() {
    try {
      const state = await readDeviceState();
      setDevice(state);
      if (!state.service || !state.core) setSetupOpen(true);
      if (!settingsLoaded.current && state.service) {
        const saved = await shell(`[ ! -f ${DIR}/interfaces ] || cat ${DIR}/interfaces`);
        setLan(saved === 'auto' ? '' : saved);
        const mirrorValue = await shell(`if [ -f ${DIR}/core-mirror ]; then cat ${DIR}/core-mirror; else echo __UFI_MIRROR_UNSAVED__; fi`);
        const prefix = mirrorValue === '__UFI_MIRROR_UNSAVED__' ? null : mirrorValue;
        setSavedMirror(prefix);
        setMirror(current => current || prefix || '');
        settingsLoaded.current = true;
      }
    } catch (error) { setDevice(null); throw error; }
  }

  async function run(id: Action, action: () => Promise<unknown>, quiet = false) {
    if (busyRef.current || disabledReason(id, device, false, url)) return;
    busyRef.current = true;
    setBusy(id); setError(false); setMessage('执行中…');
    if (!quiet) toast.loading('正在执行…', notification);
    try {
      if (id !== 'refresh' && id !== 'diagnose') {
        const state = await readDeviceState();
        setDevice(state);
        const reason = disabledReason(id, state, false, url);
        if (reason) throw new Error(reason);
      }
      const result = String(await action() || '完成');
      setMessage(result);
      if (id === 'logs' || id === 'diagnose') setResultOpen(true);
      if (!quiet) toast.success(id === 'logs' ? '日志已加载'
        : id === 'diagnose' ? '诊断完成' : result.split('\n')[0]!.slice(0, 180), notification);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setError(true); setMessage(detail);
      setResultOpen(true);
      if (!quiet) toast.error(detail.slice(0, 220), { ...notification, duration: 10000 });
    } finally {
      try { await refresh(); } catch (error) {
        setError(true);
        setMessage(value => `${value}\n刷新状态失败：${error instanceof Error ? error.message : String(error)}`);
        if (!quiet) toast.error('状态刷新失败，请检查连接', { ...notification, duration: 10000 });
      }
      busyRef.current = false; setBusy(null);
    }
  }

  useEffect(() => { void run('refresh', async () => '状态已刷新', true); }, []);

  function button(id: Action, label: string, Icon: LucideIcon, onClick: () => void, extraReason = '') {
    const reason = disabledReason(id, device, !!busy, url) || extraReason;
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
  const saveMirror = async () => {
    const prefix = downloadMirror(mirror);
    await upload('core-mirror', prefix + '\n');
    setSavedMirror(prefix); setMirror(prefix);
    return prefix;
  };
  const downloadProgress = (text: string) => {
    setMessage(text);
    toast.loading(text, notification);
  };
  const lifecycle = lifecycleAction(device);

  const title = !device ? busy === 'refresh' ? '正在检测设备状态…' : '无法确认设备状态' : !device.service ? '尚未安装服务'
    : device.locked ? '设备操作进行中' : !device.core ? '服务已安装 · 尚未安装核心'
    : !device.config ? '核心已安装 · 尚未导入配置' : !device.running ? '已停止'
    : device.supervisor && device.listeners && device.network ? '运行中 · 本地接管就绪' : '正在启动 / 恢复中';
  const dot = device?.running ? device.listeners && device.network ? 'running' : 'waiting' : 'stopped';

  return <>{createPortal(<Toaster id="ufi-mihomo" position="top-center" theme="dark" richColors closeButton
    containerAriaLabel="操作通知" toastOptions={{ closeButtonAriaLabel: '关闭提示' }} />, document.body)}<details id="ufi-mihomo" aria-busy={!!busy} onToggle={event => {
    if (event.target === event.currentTarget && event.currentTarget.open && !busyRef.current) void run('refresh', async () => '状态已刷新', true);
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
        {device && <p data-resources className="ufi-mt-2 ufi-text-xs ufi-opacity-60">核心 {device.core ? '已安装' : '未安装'} · 配置 {device.config ? '已就绪' : '未就绪'}</p>}
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
        <input data-url type="password" autoComplete="off" placeholder={device?.subscription ? '已保存，填写新链接以替换' : '订阅链接'} value={url}
          onChange={event => setUrl(event.target.value)} disabled={!!busy} />
      </label>
      <div className="ufi-grid ufi-grid-cols-2 ufi-gap-2 sm:ufi-grid-cols-3">
        {button('save', '保存订阅', Save, () => void run('save', async () => {
          await upload('subscription.curl', curlConfig(url.trim())); setUrl('');
          return '订阅已保存';
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
      <details data-setup open={setupOpen} onToggle={event => { if (event.target === event.currentTarget) setSetupOpen(event.currentTarget.open); }} className="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary className="ufi-flex ufi-items-center ufi-gap-2 ufi-p-3 ufi-text-sm ufi-font-medium"><Download size={16} aria-hidden />核心下载<ChevronDown data-chevron size={16} className="ufi-ml-auto" aria-hidden /></summary>
        <div className="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <label className="ufi-block ufi-text-xs">下载镜像
            <input data-mirror type="url" placeholder="https://ghfast.top" value={mirror}
              aria-invalid={!!mirrorError} aria-describedby="ufi-mirror-help ufi-mirror-state"
              onChange={event => setMirror(event.target.value)} disabled={!!busy} />
          </label>
          <p id="ufi-mirror-help" className="ufi-text-xs ufi-opacity-60">填写代理前缀，留空直连。</p>
          <p id="ufi-mirror-state" data-mirror-state className={`ufi-text-xs ${mirrorError ? 'ufi-text-rose-400' : 'ufi-text-teal-400'}`}>
            {mirrorError || (mirrorDirty ? '未保存' : '已保存')}
          </p>
          <div className="ufi-grid ufi-grid-cols-1 ufi-gap-2 sm:ufi-grid-cols-2">
            {button('save-mirror', '保存', Save, () => void run('save-mirror', async () => {
              await saveMirror(); return '镜像已保存';
            }), mirrorError || (!mirrorDirty ? '镜像已保存，无需重复保存' : ''))}
            {button('download', '保存并下载', Download, () => void run('download', async () => {
              await saveMirror();
              try { return await installOfficial(downloadProgress); }
              catch (error) { throw new Error(`镜像已保存；核心安装未完成：${error instanceof Error ? error.message : String(error)}`); }
            }), mirrorError)}
          </div>
        </div>
      </details>
      <details data-advanced className="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary className="ufi-flex ufi-items-center ufi-gap-2 ufi-p-3 ufi-text-sm ufi-font-medium"><Settings2 size={16} aria-hidden />高级设置<ChevronDown data-chevron size={16} className="ufi-ml-auto" aria-hidden /></summary>
        <div className="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <label className="ufi-block ufi-text-xs">共享接口
            <input data-lan type="text" placeholder="留空自动识别" value={lan}
              onChange={event => setLan(event.target.value)} disabled={!!busy} />
          </label>
          <div className="ufi-grid ufi-grid-cols-2 ufi-gap-2">
            {button('save-interfaces', '保存接口设置', Save, () => void run('save-interfaces', async () => {
              await upload('interfaces', interfaces(lan) + '\n'); return '接口设置已保存';
            }))}
            {button('diagnose', '网络诊断', Stethoscope, () => void run('diagnose', () => shell('ip -o -4 addr show; ip -4 rule show; ip -4 route show table all; ip -6 route show table all; getprop ro.product.cpu.abi')))}
            {commandButton('restart', '重启', RefreshCw)}
            {device?.service && button('service-update', '更新服务文件', Download, () => void run('service-update', installService))}
          </div>
        </div>
      </details>
      <details data-result open={resultOpen} onToggle={event => { if (event.target === event.currentTarget) setResultOpen(event.currentTarget.open); }}>
        <summary className="ufi-flex ufi-items-center ufi-gap-2 ufi-text-xs ufi-opacity-60">操作详情<ChevronDown data-chevron size={14} className="ufi-ml-auto" aria-hidden /></summary>
        <pre data-output data-error={error} className="ufi-mt-2 ufi-max-h-64 ufi-overflow-auto ufi-whitespace-pre-wrap ufi-break-words ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3 ufi-text-xs ufi-leading-relaxed">{message}</pre>
      </details>
    </div>
    <dialog ref={dialog} data-uninstall aria-labelledby="ufi-mihomo-uninstall-title">
      <form method="dialog" className="ufi-space-y-4" onSubmit={event => {
        event.preventDefault(); dialog.current?.close();
        void run('uninstall', async () => {
          const result = await service('uninstall', 95_000);
          settingsLoaded.current = false; setUrl(''); setLan(''); setMirror(''); setSavedMirror(null);
          return result;
        });
      }}>
        <h3 id="ufi-mihomo-uninstall-title" className="ufi-m-0 ufi-text-base">卸载 Mihomo 服务？</h3>
        <p className="ufi-text-sm ufi-leading-relaxed">停止代理并关闭自启，文件与配置保留备份。</p>
        <div className="ufi-flex ufi-flex-wrap ufi-justify-end ufi-gap-2">
          <button type="button" autoFocus onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" data-danger>卸载并备份</button>
        </div>
      </form>
    </dialog>
  </details></>;
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
