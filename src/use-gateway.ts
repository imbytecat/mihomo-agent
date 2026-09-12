import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import PQueue from 'p-queue';
import { toast } from 'sonner';
import { adaptConfig, curlConfig, downloadMirror, interfaces } from './config';
import { DIR, installOfficial, readDeviceState, readDownload, service, shell, upload } from './ufi';
import { disabledReason, type Action, type DeviceState } from './state';
import serviceScript from '../scripts/service.sh?raw';
import networkScript from '../scripts/network.sh?raw';

type Fields = { subscription: string; mirror: string; interfaces: string };
export type Setting = 'mirror' | 'interfaces';
export type Operation = Exclude<Action, 'save-mirror' | 'save-interfaces'>;
const defaults: Fields = { subscription: '', mirror: '', interfaces: '' };
const normalize = { mirror: downloadMirror, interfaces };
const settingAction = { mirror: 'save-mirror', interfaces: 'save-interfaces' } as const;
const settingFile = { mirror: 'core-mirror', interfaces: 'interfaces' };
const settingLabel = { mirror: '镜像', interfaces: '接口' };
const notification = { id: 'ufi-mihomo-operation', toasterId: 'ufi-mihomo' };

export function useGateway() {
  const form = useForm<Fields>({ defaultValues: defaults, mode: 'onBlur', reValidateMode: 'onChange' });
  const values = useWatch({ control: form.control }) as Fields;
  const [queue] = useState(() => new PQueue({ concurrency: 1 }));
  const [device, setDevice] = useState<DeviceState | null>(null);
  const deviceRef = useRef<DeviceState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef(false);
  const pendingSaves = useRef(0);
  const [saving, setSaving] = useState<Setting | null>(null);
  const [saved, setSaved] = useState<Record<Setting, string | null>>({ mirror: null, interfaces: null });
  const savedRef = useRef(saved);
  const loaded = useRef(false);
  const open = useRef(false);
  const [detail, setDetail] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState(false);

  const readState = async () => {
    try {
      const state = await readDeviceState();
      if (!state.service && loaded.current) {
        loaded.current = false;
        savedRef.current = { mirror: null, interfaces: null }; setSaved({ ...savedRef.current });
      }
      deviceRef.current = state; setDevice(state); return state;
    } catch (error) { deviceRef.current = null; setDevice(null); throw error; }
  };
  const refresh = async () => {
    const state = await readState();
    if (state.service && !loaded.current) {
      try {
        for (const name of ['mirror', 'interfaces'] as const) {
          const text = await shell(`[ ! -f ${DIR}/${settingFile[name]} ] || cat ${DIR}/${settingFile[name]}`);
          const value = normalize[name](text);
          savedRef.current[name] = value;
          if (!form.getFieldState(name).isDirty) form.resetField(name, { defaultValue: value === 'auto' ? '' : value });
        }
        setSaved({ ...savedRef.current }); loaded.current = true;
      } catch (error) { deviceRef.current = null; setDevice(null); throw error; }
    }
    return state;
  };

  function dirty(name: Setting) {
    try { return normalize[name](form.getValues(name)) !== savedRef.current[name]; } catch { return true; }
  }

  // Called inside the queue. A completed save must not overwrite newer typing.
  const persist = async (name: Setting, snapshot: string) => {
    let value: string;
    try { value = normalize[name](snapshot); }
    catch (error) {
      form.setError(name, { type: 'validate', message: error instanceof Error ? error.message : String(error) }); throw error;
    }
    if (value === savedRef.current[name]) return;
    const state = await readState();
    const reason = disabledReason(settingAction[name], state);
    if (reason) throw new Error(reason);
    setSaving(name);
    try {
      await upload(settingFile[name], value + '\n');
      savedRef.current[name] = value; setSaved({ ...savedRef.current });
      if (form.getValues(name) === snapshot) form.resetField(name, { defaultValue: value === 'auto' ? '' : value });
      toast.dismiss(`ufi-mihomo-${name}`);
    } catch (error) {
      form.setError(name, { type: 'server', message: '保存失败，点此重试' }); throw error;
    } finally { setSaving(null); }
  };

  const autosave = (name: Setting) => {
    if (busyRef.current || !deviceRef.current?.service || !dirty(name)) return;
    const snapshot = form.getValues(name);
    pendingSaves.current++;
    void queue.add(() => persist(name, snapshot)).catch(error => {
      if (form.getFieldState(name).error?.type !== 'validate') {
        form.setError(name, { type: 'server', message: '保存失败，点此重试' });
        toast.error(`${settingLabel[name]}保存失败`, {
          id: `ufi-mihomo-${name}`, toasterId: 'ufi-mihomo', description: error instanceof Error ? error.message : String(error),
        });
      }
    }).finally(() => { pendingSaves.current--; });
  };

  const perform = async (id: Operation, quiet = false) => {
    const snapshot = form.getValues();
    if (busyRef.current || disabledReason(id, deviceRef.current, false, snapshot.subscription)) return;
    busyRef.current = true; setBusy(id); setError(false);
    if (!quiet) toast.loading('正在处理…', notification);
    try {
      await queue.add(async () => {
        const state = await readState();
        const reason = disabledReason(id, state, false, snapshot.subscription);
        if (reason) throw new Error(reason);
        let result = '';
        switch (id) {
          case 'install': case 'service-update':
            await shell(`[ ! -f ${DIR}/service.sh ] || sh ${DIR}/service.sh stop`, 95_000);
            await upload('network.sh', networkScript); await upload('service.sh', serviceScript);
            result = id === 'install' ? '服务已安装' : '服务已更新'; break;
          case 'download':
            await persist('mirror', snapshot.mirror);
            result = await installOfficial(text => { setDetail(text); toast.loading(text, notification); }); break;
          case 'update':
            if (snapshot.subscription.trim()) {
              let config: string;
              try { config = curlConfig(snapshot.subscription.trim()); }
              catch (error) { form.setError('subscription', { message: '请输入有效订阅链接' }); throw error; }
              await upload('subscription.curl', config);
            }
            await service('fetch', 95_000);
            await upload('candidate.yaml', adaptConfig(await readDownload()));
            result = await service('apply', 95_000);
            if (form.getValues('subscription') === snapshot.subscription) form.resetField('subscription', { defaultValue: '' });
            break;
          case 'start':
            await persist('interfaces', snapshot.interfaces);
            result = await service('start', 95_000) || '代理已启动'; break;
          case 'uninstall':
            result = await service('uninstall', 95_000);
            loaded.current = false; form.reset(defaults);
            savedRef.current = { mirror: null, interfaces: null }; setSaved({ ...savedRef.current });
            break;
          case 'diagnose':
            result = await shell('ip -o -4 addr show; ip -4 rule show; ip -4 route show table all; ip -6 route show table all; getprop ro.product.cpu.abi'); break;
          case 'refresh': result = '状态已刷新'; break;
          default:
            result = await service(id, 95_000) || ({ stop: '代理已停止', restart: '代理已重启', 'boot-on': '自启已开启', 'boot-off': '自启已关闭' }[id as string] ?? '完成');
        }
        if (!quiet) setDetail(result);
        if (id === 'logs' || id === 'diagnose') setDetailOpen(true);
        if (!quiet) toast.success(id === 'logs' ? '日志已加载' : id === 'diagnose' ? '诊断完成' : result.split('\n')[0]!.slice(0, 180), notification);
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setError(true); setDetail(text);
      if (!quiet) toast.error(text.slice(0, 220), { ...notification, duration: 10000, action: { label: '详情', onClick: () => setDetailOpen(true) } });
    } finally {
      try { await refresh(); } catch {
        setError(true); setDetail(value => value + '\n状态刷新失败');
        if (!quiet) toast.error('无法刷新状态', notification);
      }
      busyRef.current = false; setBusy(null);
    }
  };

  useEffect(() => {
    void perform('refresh', true);
    const timer = setInterval(() => {
      if (open.current && !document.hidden && !busyRef.current && !queue.pending && !queue.size) void queue.add(refresh).catch(() => {});
    }, 15000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingSaves.current || form.getValues('subscription').trim()
        || (['mirror', 'interfaces'] as const).some(name => form.getFieldState(name).isDirty && dirty(name))) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  const validate = (name: keyof Fields, value: string) => {
    try { if (name === 'subscription') { if (value.trim()) curlConfig(value.trim()); } else normalize[name](value); return true; }
    catch (error) { return error instanceof Error ? error.message : '格式不正确'; }
  };
  const saveStatus = (name: Setting) => {
    if (saving === name) return '保存中';
    if (form.formState.errors[name]) return form.formState.errors[name]!.message!;
    if (!device?.service) return '草稿';
    if (saved[name] === null) return '读取中';
    return dirty(name) ? '未保存' : !form.getValues(name).trim() ? name === 'mirror' ? '直连' : '自动' : '已保存';
  };
  return { device, busy, form, values, saving, saveStatus, validate, autosave, perform, open, detail, detailOpen, setDetailOpen, error };
}
