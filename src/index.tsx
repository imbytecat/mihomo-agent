import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Toaster } from 'sonner';
import {
  Check,
  ChevronDown,
  Download,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Power,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Stethoscope,
  Trash2,
  X,
  LayoutDashboard,
  KeyRound,
  type LucideIcon,
} from 'lucide-react';
import { useGateway, type Operation, type Setting } from './use-gateway';
import { disabledReason, lifecycleAction } from './state';
import { phases, dashboardURL, describeTask } from './ufi';
import styleText from './style.css?inline';

export default function Gateway() {
  const model = useGateway();
  const { device, busy, form, values, perform } = model;
  const { errors } = form.formState;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useRef<HTMLDetailsElement>(null);
  const subscription = useRef<HTMLDivElement>(null);
  const uninstall = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  const secretDialog = useRef<HTMLDialogElement>(null);
  const stage = !device
    ? 'unknown'
    : !device.service
      ? 'service'
      : !device.controller
        ? 'upgrade'
        : !device.core
          ? 'core'
          : !device.config
            ? 'subscription'
            : 'ready';
  const healthy = !!(device?.running && device.supervisor && device.listeners && device.network);
  const lifecycle = lifecycleAction(device);
  const runAction = device?.running || device?.capture ? 'stop' : 'start';
  const title = !device
    ? busy
      ? '正在连接'
      : '连接失败'
    : device.running
      ? healthy
        ? '运行中'
        : !device.supervisor
          ? '需要恢复'
          : !device.listeners
            ? '正在启动'
            : '等待网络'
      : stage === 'ready'
        ? '已停止'
        : stage === 'upgrade'
          ? '需要更新'
          : '尚未就绪';
  const subtitle = !device
    ? '检查 UFI 登录与高级功能'
    : !device.service
      ? '先安装服务'
      : stage === 'upgrade'
        ? '更新设备组件后继续'
        : !device.core
          ? '下载官方核心'
          : !device.config
            ? '添加订阅，完成设置'
            : healthy
              ? '设备侧已就绪'
              : device.running
                ? '可在更多菜单中查看日志'
                : '随时可以连接';

  useEffect(() => {
    if (device && (!device.service || !device.core)) setSettingsOpen(true);
  }, [device?.service, device?.core]);
  useEffect(() => {
    if (model.detailOpen) {
      if (!details.current?.open) details.current?.showModal();
    } else details.current?.close();
  }, [model.detailOpen]);
  useEffect(() => {
    if (model.secret) {
      if (!secretDialog.current?.open) secretDialog.current?.showModal();
    } else secretDialog.current?.close();
  }, [model.secret]);

  const controlPending =
    !!device?.controller &&
    (values.controlEnabled !== device.controller.enabled ||
      Number(values.controlPort) !== device.controller.port ||
      !!values.controlSecret ||
      values.resetSecret ||
      (device.config && !device.controller.applied));
  function action(
    id: Operation,
    label: string,
    Icon: LucideIcon,
    onClick = () => void perform(id),
    primary = false,
    extraReason = '',
  ) {
    const reason = disabledReason(id, device, !!busy, values.subscription) || extraReason;
    return (
      <button
        type="button"
        data-action={id}
        data-primary={primary || undefined}
        disabled={!!reason}
        title={reason}
        className={primary ? 'mh-button mh-primary' : 'mh-button'}
        data-danger={id === 'uninstall' ? '' : undefined}
        onClick={onClick}
      >
        {busy === id ? <LoaderCircle size={17} className="mh-spin" aria-hidden /> : <Icon size={17} aria-hidden />}
        {label}
      </button>
    );
  }
  function menuItem(id: Operation, label: string, Icon: LucideIcon) {
    const reason = disabledReason(id, device, !!busy, values.subscription);
    return (
      <DropdownMenu.Item className="mh-menu-item" disabled={!!reason} title={reason} onSelect={() => void perform(id)}>
        <Icon size={16} aria-hidden />
        {label}
      </DropdownMenu.Item>
    );
  }
  function settingField(name: Setting, label: string, placeholder: string) {
    const input = form.register(name, { validate: (value) => model.validate(name, value) });
    const status = model.saveStatus(name);
    const blocked = !!busy || (name === 'interfaces' && !!device?.running);
    const reason = disabledReason(name === 'mirror' ? 'save-mirror' : 'save-interfaces', device, !!busy);
    return (
      <div className="mh-field">
        <div className="mh-field-heading">
          <label htmlFor={`ufi-${name}`}>{label}</label>
          {errors[name]?.type === 'server' ? (
            <button type="button" className="mh-retry" disabled={!!reason} onClick={() => model.autosave(name)}>
              重试保存
            </button>
          ) : (
            <span data-save-status={name} className={errors[name] ? 'mh-field-error' : 'mh-save-state'}>
              {model.saving === name && <LoaderCircle size={12} className="mh-spin" aria-hidden />}
              {errors[name] ? '格式不正确' : status}
            </span>
          )}
        </div>
        <input
          {...input}
          id={`ufi-${name}`}
          data-setting={name}
          type={name === 'mirror' ? 'url' : 'text'}
          placeholder={placeholder}
          disabled={blocked}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="done"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          aria-invalid={!!errors[name]}
          aria-describedby={`ufi-${name}-help`}
          onBlur={(event) => {
            void input.onBlur(event);
            model.autosave(name);
          }}
        />
        <p id={`ufi-${name}-help`} className={errors[name] ? 'mh-field-error' : 'mh-hint'}>
          {errors[name]?.message ||
            (name === 'mirror'
              ? '留空直连 · 离开输入框自动保存'
              : device?.running
                ? '停止代理后可修改'
                : '留空自动识别 · 离开输入框自动保存')}
        </p>
      </div>
    );
  }

  const sections = {
    runtime: (
      <section key="runtime" hidden={!device?.service} data-group="runtime" aria-labelledby="ufi-runtime-heading">
        <h3 id="ufi-runtime-heading" className="mh-section-heading">
          运行
        </h3>
        <label className="mh-row">
          <span>
            <Power size={17} aria-hidden />
            开机启动
          </span>
          <input
            type="checkbox"
            role="switch"
            data-boot
            checked={device?.boot ?? false}
            disabled={!!disabledReason(device?.boot ? 'boot-off' : 'boot-on', device, !!busy)}
            title={disabledReason(device?.boot ? 'boot-off' : 'boot-on', device, !!busy)}
            onChange={(event) => void perform(event.target.checked ? 'boot-on' : 'boot-off')}
          />
        </label>
        {settingField('interfaces', '共享接口', '自动识别')}
      </section>
    ),
    controller: (
      <section
        key="controller"
        hidden={!device?.service}
        data-group="controller"
        aria-labelledby="ufi-controller-heading"
      >
        <h3 id="ufi-controller-heading" className="mh-section-heading">
          控制面板
          <span className="mh-save-state">
            {['controlEnabled', 'controlPort', 'controlSecret', 'resetSecret'].some(
              (name) => name in form.formState.dirtyFields,
            )
              ? '待应用'
              : device?.controller?.applied
                ? '已应用'
                : '已保存'}
          </span>
        </h3>
        {!device?.controller && (
          <p className="mh-section-note">{device?.service ? '请先更新设备组件' : '安装后可设置'}</p>
        )}
        <fieldset hidden={!device?.controller} disabled={!!busy || !device?.controller || device.locked}>
          <label className="mh-row">
            <span>
              <LayoutDashboard size={17} aria-hidden />
              启用控制面板
            </span>
            <input type="checkbox" role="switch" {...form.register('controlEnabled')} />
          </label>
          <div className="mh-field">
            <label htmlFor="ufi-control-port">API 端口</label>
            <input
              id="ufi-control-port"
              inputMode="numeric"
              type="text"
              {...form.register('controlPort', { validate: (value) => model.validate('controlPort', value) })}
              aria-invalid={!!errors.controlPort}
              aria-describedby="ufi-port-error"
            />
            {errors.controlPort && (
              <p id="ufi-port-error" className="mh-field-error">
                {errors.controlPort.message}
              </p>
            )}
          </div>
          <div className="mh-field">
            <div className="mh-field-heading">
              <label htmlFor="ufi-control-secret">API 密钥</label>
              <button type="button" className="mh-link-button" onClick={() => void perform('view-secret')}>
                查看当前密钥
              </button>
            </div>
            <input
              id="ufi-control-secret"
              type="password"
              autoComplete="new-password"
              placeholder="留空保持现有密钥"
              disabled={values.resetSecret}
              {...form.register('controlSecret', { validate: (value) => model.validate('controlSecret', value) })}
              aria-invalid={!!errors.controlSecret}
              aria-describedby="ufi-secret-error"
            />
            {errors.controlSecret && (
              <p id="ufi-secret-error" className="mh-field-error">
                {errors.controlSecret.message}
              </p>
            )}
            <label className="mh-check">
              <input
                type="checkbox"
                {...form.register('resetSecret', {
                  onChange: (event) => {
                    if (event.target.checked) form.setValue('controlSecret', '', { shouldDirty: true });
                  },
                })}
              />
              重新生成密钥
            </label>
            {action('save-controller', '保存并应用', Check, undefined, false, controlPending ? '' : '设置未改变')}
            <p className="mh-hint">
              {device?.running ? '应用后会重启代理' : device?.config ? '保存后生效' : '保存后随订阅生效'}
            </p>
          </div>
        </fieldset>
      </section>
    ),
    maintenance: (
      <section key="maintenance" data-group="maintenance" aria-labelledby="ufi-maintenance-heading">
        <h3 id="ufi-maintenance-heading" className="mh-section-heading">
          安装与更新
        </h3>
        {settingField('mirror', '下载镜像', 'https://ghfast.top')}
        <div className="mh-row">
          <span>
            设备组件<span className="mh-row-value">{device?.version || '未安装'}</span>
          </span>
          {action('service-update', '更新组件', Download)}
        </div>
        <div className="mh-row">
          <span>
            Mihomo 核心
            <span className="mh-row-value">{device?.running ? '停止后更新' : device?.core ? '已安装' : '未安装'}</span>
          </span>
          {action('download', device?.core ? '更新核心' : '下载核心', Download)}
        </div>
        <div className="mh-row">
          <span>
            Zashboard<span className="mh-row-value">{device?.dashboard.version || '未安装'}</span>
          </span>
          {action('download-dashboard', device?.dashboard.installed ? '更新面板' : '安装面板', Download)}
        </div>
        <div data-lifecycle className="mh-row">
          <span>
            代理服务<span className="mh-row-value">{device ? (device.service ? '已安装' : '未安装') : '未知'}</span>
          </span>
          {action(
            lifecycle ?? 'install',
            !device ? (busy ? '检测中' : '状态未知') : lifecycle === 'uninstall' ? '卸载' : '安装',
            lifecycle === 'uninstall' ? Trash2 : Download,
            () => {
              if (lifecycle === 'uninstall') uninstall.current?.showModal();
              else if (lifecycle === 'install') void perform('install');
            },
          )}
        </div>
      </section>
    ),
  };
  const setup = ['service', 'core', 'upgrade'].includes(stage);
  const sectionOrder: (keyof typeof sections)[] = setup
    ? ['maintenance', 'runtime', 'controller']
    : ['runtime', 'controller', 'maintenance'];

  const subscriptionCard = (
    <section key="subscription">
      <div className="mh-section-label">订阅</div>
      <div className="mh-group" data-group="subscription" ref={subscription}>
        <div className="mh-field">
          <div className="mh-field-heading">
            <label htmlFor="ufi-subscription">订阅</label>
            <span className="mh-save-state">
              {values.subscription?.trim() ? '待应用' : device?.subscription ? '已保存' : '未配置'}
            </span>
          </div>
          <input
            {...form.register('subscription', { validate: (value) => model.validate('subscription', value) })}
            id="ufi-subscription"
            type="password"
            data-url
            placeholder={device?.subscription ? '留空使用已保存订阅' : '粘贴订阅链接'}
            disabled={!!busy}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="go"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void perform('update');
              }
            }}
            aria-invalid={!!errors.subscription}
            aria-describedby="ufi-subscription-error"
          />
          {errors.subscription && (
            <p id="ufi-subscription-error" className="mh-field-error">
              {errors.subscription.message}
            </p>
          )}
          {action('update', values.subscription?.trim() ? '保存并更新' : '更新订阅', RefreshCw)}
        </div>
      </div>
    </section>
  );
  const settingsCard = (
    <details
      key="settings"
      ref={settings}
      data-settings
      className="mh-group mh-settings"
      open={settingsOpen}
      onToggle={(event) => {
        if (event.target === event.currentTarget) setSettingsOpen(event.currentTarget.open);
      }}
    >
      <summary className="mh-row">
        <span>
          <Settings2 size={18} aria-hidden />
          设置
        </span>
        <ChevronDown data-chevron size={16} aria-hidden />
      </summary>
      {sectionOrder.map((name) => sections[name])}
    </details>
  );

  return (
    <>
      {createPortal(
        <Toaster
          id="ufi-mihomo"
          position="top-center"
          theme="dark"
          richColors
          closeButton
          containerAriaLabel="操作通知"
          toastOptions={{ closeButtonAriaLabel: '关闭提示' }}
        />,
        document.body,
      )}
      <details
        id="ufi-mihomo"
        onToggle={(event) => {
          if (event.target === event.currentTarget) model.open.current = event.currentTarget.open;
        }}
      >
        <summary className="mh-header">
          <ShieldCheck size={22} aria-hidden />
          <strong>Mihomo</strong>
          <span className="mh-header-status" data-health={healthy ? 'ready' : 'idle'}>
            {title}
          </span>
          <ChevronDown size={17} data-chevron aria-hidden />
        </summary>
        <div className="mh-body" aria-busy={!!busy}>
          <div className="mh-hero">
            <div className="mh-hero-heading">
              <span className="mh-status-symbol" data-health={healthy ? 'ready' : 'idle'}>
                <ShieldCheck size={30} aria-hidden />
              </span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="mh-icon-button" aria-label="更多操作">
                    <MoreHorizontal size={22} aria-hidden />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="mh-menu"
                    data-ufi-menu
                    sideOffset={8}
                    collisionPadding={12}
                    align="end"
                  >
                    {menuItem('refresh', '刷新状态', RefreshCw)}
                    {menuItem('logs', '查看日志', FileText)}
                    {menuItem('diagnose', '网络诊断', Stethoscope)}
                    <DropdownMenu.Separator className="mh-menu-separator" />
                    {menuItem('restart', '重启代理', RefreshCw)}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            <h2 data-status>{title}</h2>
            <p className="mh-subtitle">{subtitle}</p>
            {stage === 'unknown' ? (
              action('refresh', '重新检测', RefreshCw, undefined, true)
            ) : stage === 'ready' || device?.running || device?.capture ? (
              action(
                runAction,
                runAction === 'stop' ? '停止代理' : '启动代理',
                runAction === 'stop' ? Square : Play,
                undefined,
                true,
              )
            ) : stage === 'service' ? (
              action('install', '安装服务', Download, undefined, true)
            ) : stage === 'upgrade' ? (
              action('service-update', '更新设备组件', Download, undefined, true)
            ) : stage === 'core' ? (
              action('download', '下载核心', Download, undefined, true)
            ) : (
              <button
                type="button"
                className="mh-button mh-primary"
                disabled={!!busy || device?.locked}
                onClick={() => {
                  subscription.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  form.setFocus('subscription');
                }}
              >
                添加订阅
              </button>
            )}
            {device?.service && (
              <div className="mh-dashboard-entry">
                {!disabledReason('open-dashboard', device, !!busy) ? (
                  <a
                    data-dashboard-link
                    className="mh-button"
                    href={dashboardURL(device.controller!.port)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <LayoutDashboard size={17} aria-hidden />
                    打开面板
                  </a>
                ) : (
                  <button
                    type="button"
                    className="mh-button"
                    disabled
                    title={disabledReason('open-dashboard', device, !!busy)}
                  >
                    <LayoutDashboard size={17} aria-hidden />
                    打开面板
                  </button>
                )}
                {!!disabledReason('open-dashboard', device) && (
                  <span className="mh-hint">{disabledReason('open-dashboard', device)}</span>
                )}
              </div>
            )}
            {stage !== 'ready' && device && (
              <div className="mh-steps" aria-label="安装进度">
                {[
                  ['服务', device.service],
                  ['核心', device.core],
                  ['配置', device.config],
                ].map(([label, done]) => (
                  <span key={String(label)} data-done={!!done}>
                    {done ? <Check size={13} aria-hidden /> : <span className="mh-step-dot" />}
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {model.error ? (
            <button type="button" className="mh-task mh-field-error" onClick={() => model.setDetailOpen(true)}>
              操作未完成 · 查看详情
            </button>
          ) : (
            device?.task && (
              <button
                type="button"
                data-task
                className="mh-task"
                aria-live="polite"
                onClick={() => void model.showTask()}
              >
                {['queued', 'running'].includes(device.task.state) && (
                  <LoaderCircle size={14} className="mh-spin" aria-hidden />
                )}
                {['failed', 'interrupted'].includes(device.task.state)
                  ? describeTask(device.task).split('\n')[0] + '失败 · 查看详情'
                  : ['queued', 'running'].includes(device.task.state)
                    ? phases[device.task.phase] || '设备处理中'
                    : device.task.result || '任务已完成'}
              </button>
            )
          )}

          {setup ? [settingsCard, subscriptionCard] : [subscriptionCard, settingsCard]}
        </div>

        <dialog ref={uninstall} data-uninstall aria-labelledby="ufi-uninstall-title">
          <form
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              uninstall.current?.close();
              void perform('uninstall');
            }}
          >
            <h3 id="ufi-uninstall-title">卸载 Mihomo？</h3>
            <p>停止代理并关闭自启，文件与配置保留备份。</p>
            <div className="mh-dialog-actions">
              <button type="button" className="mh-button" autoFocus onClick={() => uninstall.current?.close()}>
                取消
              </button>
              <button type="submit" className="mh-button" data-danger>
                卸载并备份
              </button>
            </div>
          </form>
        </dialog>
        <dialog ref={details} data-result aria-labelledby="ufi-detail-title" onClose={() => model.setDetailOpen(false)}>
          <div className="mh-dialog-heading">
            <h3 id="ufi-detail-title">{model.detailTitle}</h3>
            <button
              type="button"
              className="mh-icon-button"
              aria-label="关闭详情"
              onClick={() => model.setDetailOpen(false)}
            >
              <X size={20} aria-hidden />
            </button>
          </div>
          <pre data-output>{model.detail}</pre>
        </dialog>
        <dialog
          ref={secretDialog}
          data-secret-dialog
          aria-labelledby="ufi-secret-title"
          onClose={() => model.setSecret('')}
        >
          <div className="mh-dialog-heading">
            <h3 id="ufi-secret-title">
              <KeyRound size={17} aria-hidden /> API 密钥
            </h3>
            <button type="button" className="mh-icon-button" aria-label="关闭密钥" onClick={() => model.setSecret('')}>
              <X size={20} aria-hidden />
            </button>
          </div>
          <p>首次连接面板时填写。选中文本即可复制。</p>
          <input
            type="text"
            aria-label="当前 API 密钥"
            readOnly
            value={model.secret}
            onFocus={(event) => event.currentTarget.select()}
          />
        </dialog>
      </details>
    </>
  );
}

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor) return;
  let style = document.getElementById('ufi-mihomo-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'ufi-mihomo-style';
    document.head.append(style);
  }
  style.textContent = styleText;
  if (document.getElementById('ufi-mihomo-mount')) return;
  const container = document.createElement('div');
  container.id = 'ufi-mihomo-mount';
  anchor.after(container);
  createRoot(container).render(<Gateway />);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
