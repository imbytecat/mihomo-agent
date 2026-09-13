import { waitTask, describeTask } from './gateway';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import PQueue from 'p-queue';
import { toast } from 'sonner';
import { subscriptionURL, githubProxyURL, interfaces } from './config';
import {
  bootstrapAgent,
  deviceLogs,
  readDeviceState,
  submitTask,
  readJob,
  jobLog,
  readControllerSecret,
  stopAgent,
} from './transport/ufi';
import {
  disabledReason,
  installationTask,
  type Action,
  type DeviceState,
  type DeviceJob,
} from './state';

type Fields = {
  subscription: string;
  githubProxy: string;
  interfaces: string;
  controlEnabled: boolean;
  controlPort: string;
  controlSecret: string;
  resetSecret: boolean;
};
export type Setting = 'githubProxy' | 'interfaces';
export type Operation = Exclude<
  Action,
  'save-github-proxy' | 'save-interfaces' | 'open-dashboard'
>;
const defaults: Fields = {
  subscription: '',
  githubProxy: '',
  interfaces: '',
  controlEnabled: true,
  controlPort: '9090',
  controlSecret: '',
  resetSecret: false,
};
const normalize = { githubProxy: githubProxyURL, interfaces };
const settingAction = {
  githubProxy: 'save-github-proxy',
  interfaces: 'save-interfaces',
} as const;
const settingLabel = { githubProxy: 'GitHub Proxy', interfaces: '接口' };
const notification = { id: 'ufi-mihomo-operation', toasterId: 'ufi-mihomo' };

export function useGateway() {
  const form = useForm<Fields>({
    defaultValues: defaults,
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });
  const values = useWatch({ control: form.control }) as Fields;
  const [queue] = useState(() => new PQueue({ concurrency: 1 }));
  const [device, setDevice] = useState<DeviceState | null>(null);
  const deviceRef = useRef<DeviceState | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef(false);
  const pendingSaves = useRef(0);
  const [saving, setSaving] = useState<Setting | null>(null);
  const [saved, setSaved] = useState<Record<Setting, string | null>>({
    githubProxy: null,
    interfaces: null,
  });
  const savedRef = useRef(saved);
  const loaded = useRef(false);
  const open = useRef(false);
  const [detail, setDetail] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTitle, setDetailTitle] = useState('操作详情');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState(false);
  const detailRequest = useRef(0);
  const observe = (task: DeviceJob) => {
    if (deviceRef.current) {
      const state = {
        ...deviceRef.current,
        task,
        locked: ['queued', 'running'].includes(task.state),
      };
      deviceRef.current = state;
      setDevice(state);
    }
  };

  const readState = async () => {
    try {
      const state = await readDeviceState();
      if (!state.service && loaded.current) {
        loaded.current = false;
        savedRef.current = { githubProxy: null, interfaces: null };
        setSaved({ ...savedRef.current });
      }
      deviceRef.current = state;
      setDevice(state);
      return state;
    } catch (error) {
      deviceRef.current = null;
      setDevice(null);
      throw error;
    }
  };
  const refresh = async () => {
    const state = await readState();
    if (state.service) {
      try {
        for (const name of ['githubProxy', 'interfaces'] as const) {
          const text =
            name === 'githubProxy'
              ? state.settings.githubProxy
              : state.settings.interfaces.join(' ');
          const value = normalize[name](text);
          let current: string | null = null;
          try {
            current = normalize[name](form.getValues(name));
          } catch {}
          const replace =
            !form.getFieldState(name).isDirty ||
            current === savedRef.current[name] ||
            current === value;
          savedRef.current[name] = value;
          if (replace)
            form.resetField(name, {
              defaultValue: value === 'auto' ? '' : value,
            });
        }
        setSaved({ ...savedRef.current });
        loaded.current = true;
        if (state.controller) {
          if (!form.getFieldState('controlEnabled').isDirty)
            form.resetField('controlEnabled', {
              defaultValue: state.controller.enabled,
            });
          if (!form.getFieldState('controlPort').isDirty)
            form.resetField('controlPort', {
              defaultValue: String(state.controller.port),
            });
        }
      } catch (error) {
        deviceRef.current = null;
        setDevice(null);
        throw error;
      }
    }
    return state;
  };

  const showTask = async () => {
    const task = deviceRef.current?.task;
    if (!task) return;
    const revision = ++detailRequest.current;
    setDetailTitle('任务详情');
    setDetail(describeTask(task));
    setDetailOpen(true);
    try {
      const latest =
        task.action === 'bootstrap' ? task : await readJob(task.id);
      const log = await jobLog(latest);
      if (revision === detailRequest.current)
        setDetail(describeTask(latest) + (log ? '\n\n' + log : ''));
    } catch {
      if (revision === detailRequest.current)
        setDetail((value) => value + '\n\n暂时无法读取任务日志');
    }
  };

  function dirty(name: Setting) {
    try {
      return normalize[name](form.getValues(name)) !== savedRef.current[name];
    } catch {
      return true;
    }
  }

  // Called inside the queue. A completed save must not overwrite newer typing.
  const persist = async (name: Setting, snapshot: string) => {
    let value: string;
    try {
      value = normalize[name](snapshot);
    } catch (error) {
      form.setError(name, {
        type: 'validate',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (value === savedRef.current[name]) return;
    const state = await readState();
    const reason = disabledReason(settingAction[name], state);
    if (reason) throw new Error(reason);
    setSaving(name);
    try {
      await waitTask(
        await submitTask(settingAction[name], { [name]: value }),
        () => {},
      );
      savedRef.current[name] = value;
      setSaved({ ...savedRef.current });
      if (form.getValues(name) === snapshot)
        form.resetField(name, { defaultValue: value === 'auto' ? '' : value });
      toast.dismiss(`ufi-mihomo-${name}`);
    } catch (error) {
      form.setError(name, { type: 'server', message: '保存失败，点此重试' });
      throw error;
    } finally {
      setSaving(null);
      await readState();
    }
  };

  const autosave = (name: Setting) => {
    if (busyRef.current || !deviceRef.current?.service || !dirty(name)) return;
    const snapshot = form.getValues(name);
    pendingSaves.current++;
    void queue
      .add(() => persist(name, snapshot))
      .catch((error) => {
        if (form.getFieldState(name).error?.type !== 'validate') {
          form.setError(name, {
            type: 'server',
            message: '保存失败，点此重试',
          });
          toast.error(`${settingLabel[name]}保存失败`, {
            id: `ufi-mihomo-${name}`,
            toasterId: 'ufi-mihomo',
            description: (error instanceof Error
              ? error.message
              : String(error)
            ).split('\n')[0],
            action: {
              label: '详情',
              onClick: () => {
                setDetail(
                  error instanceof Error ? error.message : String(error),
                );
                setDetailOpen(true);
              },
            },
          });
        }
      })
      .finally(() => {
        pendingSaves.current--;
      });
  };

  const perform = async (id: Operation, quiet = false) => {
    const snapshot = form.getValues();
    if (
      busyRef.current ||
      disabledReason(id, deviceRef.current, false, snapshot.subscription)
    )
      return;
    detailRequest.current++;
    busyRef.current = true;
    setBusy(id);
    setError(false);
    setDetailTitle('操作详情');
    let failed = false;
    if (!quiet && !installationTask(id))
      toast.loading('正在处理…', notification);
    try {
      await queue.add(async () => {
        const state = await readState().catch((error) => {
          if (id === 'update-agent' || id === 'stop') return null;
          throw error;
        });
        const reason = disabledReason(id, state, false, snapshot.subscription);
        if (reason) throw new Error(reason);
        let result = '';
        switch (id) {
          case 'install':
            result = await waitTask(
              !state?.agent
                ? await bootstrapAgent(githubProxyURL(snapshot.githubProxy))
                : await submitTask('install', {
                    githubProxy: githubProxyURL(snapshot.githubProxy),
                  }),
              observe,
            );
            result = 'Mihomo 服务已安装';
            break;
          case 'update-agent':
            result = await waitTask(
              !state
                ? await bootstrapAgent(githubProxyURL(snapshot.githubProxy))
                : await submitTask('update-agent', {
                    githubProxy: githubProxyURL(snapshot.githubProxy),
                  }),
              observe,
            );
            break;
          case 'stop':
            result = await waitTask(
              state ? await submitTask('stop') : await stopAgent(),
              observe,
            );
            break;
          case 'download':
            result = await waitTask(
              await submitTask('download', {
                githubProxy: githubProxyURL(snapshot.githubProxy),
              }),
              observe,
            );
            loaded.current = false;
            break;
          case 'update':
            if (snapshot.subscription.trim()) {
              try {
                subscriptionURL(snapshot.subscription.trim());
              } catch (error) {
                form.setError('subscription', {
                  message: '请输入有效订阅链接',
                });
                throw error;
              }
            }
            result = await waitTask(
              await submitTask('update', { url: snapshot.subscription.trim() }),
              observe,
            );
            if (form.getValues('subscription') === snapshot.subscription)
              form.resetField('subscription', { defaultValue: '' });
            break;
          case 'start':
            result = await waitTask(
              await submitTask(
                'start',
                deviceRef.current?.capabilities.interfaces
                  ? { interfaces: interfaces(snapshot.interfaces) }
                  : {},
              ),
              observe,
            );
            loaded.current = false;
            break;
          case 'save-controller': {
            if (!(await form.trigger(['controlPort', 'controlSecret'])))
              throw new Error('请检查控制面板设置');
            const input = {
              enabled: snapshot.controlEnabled,
              port: Number(snapshot.controlPort),
              secret: snapshot.controlSecret || undefined,
              reset: snapshot.resetSecret,
            };
            result = await waitTask(
              await submitTask('save-controller', { controller: input }),
              observe,
            );
            form.resetField('controlSecret', { defaultValue: '' });
            form.resetField('resetSecret', { defaultValue: false });
            form.resetField('controlEnabled', {
              defaultValue: snapshot.controlEnabled,
            });
            form.resetField('controlPort', {
              defaultValue: String(input.port),
            });
            setSecret('');
            break;
          }
          case 'download-dashboard':
            result = await waitTask(
              await submitTask('download-dashboard', {
                githubProxy: githubProxyURL(snapshot.githubProxy),
              }),
              observe,
            );
            break;
          case 'view-secret':
            setSecret(await readControllerSecret());
            result = '密钥已读取';
            break;
          case 'uninstall':
            result = await waitTask(await submitTask('uninstall'), observe);
            loaded.current = false;
            form.reset(defaults);
            savedRef.current = { githubProxy: null, interfaces: null };
            setSaved({ ...savedRef.current });
            break;
          case 'diagnose':
            result = await deviceLogs(true);
            break;
          case 'logs':
            result = await deviceLogs();
            break;
          case 'refresh':
            result = '状态已刷新';
            break;
          default:
            result = await waitTask(await submitTask(id), observe);
        }
        if (!quiet && id !== 'refresh') setDetail(result);
        if (id === 'logs' || id === 'diagnose') {
          setDetailTitle(id === 'logs' ? '运行日志' : '网络诊断');
          setDetailOpen(true);
        }
        if (!quiet && !installationTask(id))
          toast.success(
            id === 'logs'
              ? '日志已加载'
              : id === 'diagnose'
                ? '诊断完成'
                : result.split('\n')[0]!.slice(0, 180),
            notification,
          );
      });
    } catch (error) {
      failed = true;
      const text = error instanceof Error ? error.message : String(error);
      setError(true);
      setDetail(text);
      if (!quiet)
        toast.error(text.split('\n')[0]!.slice(0, 160), {
          ...notification,
          duration: 10000,
          action: { label: '详情', onClick: () => setDetailOpen(true) },
        });
    } finally {
      try {
        await refresh();
      } catch (error) {
        setError(true);
        setDetail(
          (value) =>
            value +
            '\n\n状态刷新失败：\n' +
            (error instanceof Error ? error.message : String(error)),
        );
        if (!quiet && !failed)
          toast.error('无法刷新状态', {
            ...notification,
            action: { label: '详情', onClick: () => setDetailOpen(true) },
          });
      }
      busyRef.current = false;
      setBusy(null);
    }
  };

  useEffect(() => {
    void perform('refresh', true);
    let probing = false;
    const timer = setInterval(() => {
      if (!open.current || document.hidden || probing) return;
      if (busyRef.current) {
        // Observe runtime changes even while a detached task is being watched.
        probing = true;
        void readState()
          .catch(() => {})
          .finally(() => {
            probing = false;
          });
      } else if (!queue.pending && !queue.size) {
        probing = true;
        void queue
          .add(refresh)
          .catch(() => {})
          .finally(() => {
            probing = false;
          });
      }
    }, 5000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        pendingSaves.current ||
        form.getValues('subscription').trim() ||
        (
          [
            'controlEnabled',
            'controlPort',
            'controlSecret',
            'resetSecret',
          ] as const
        ).some((name) => form.getFieldState(name).isDirty) ||
        (['githubProxy', 'interfaces'] as const).some(
          (name) => form.getFieldState(name).isDirty && dirty(name),
        )
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  const validate = (
    name: 'subscription' | Setting | 'controlPort' | 'controlSecret',
    value: string,
  ) => {
    try {
      if (name === 'controlPort')
        return (
          (/^\d+$/.test(value) &&
            Number(value) >= 1024 &&
            Number(value) <= 65535 &&
            !['7894', '1053'].includes(value)) ||
          '请输入可用的 1024–65535 端口'
        );
      if (name === 'controlSecret')
        return (
          /^[\x21-\x7e]*$/.test(value) || '密钥包含无法用于 HTTP 鉴权的字符'
        );
      if (name === 'subscription') {
        if (value.trim()) subscriptionURL(value.trim());
      } else normalize[name](value);
      return true;
    } catch (error) {
      return error instanceof Error ? error.message : '格式不正确';
    }
  };
  const saveStatus = (name: Setting) => {
    if (saving === name) return '保存中';
    if (form.formState.errors[name])
      return form.formState.errors[name]!.message!;
    if (!device?.service) return '草稿';
    if (saved[name] === null) return '读取中';
    return dirty(name)
      ? '未保存'
      : !form.getValues(name).trim()
        ? name === 'githubProxy'
          ? '直连'
          : '自动'
        : '已保存';
  };
  return {
    device,
    busy,
    form,
    values,
    saving,
    saveStatus,
    validate,
    autosave,
    perform,
    open,
    detail,
    detailTitle,
    detailOpen,
    setDetailOpen,
    error,
    showTask,
    secret,
    setSecret,
  };
}

export type GatewayModel = ReturnType<typeof useGateway>;
