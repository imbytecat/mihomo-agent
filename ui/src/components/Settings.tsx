import { Controller } from 'react-hook-form';
import { ChevronDown, Check, Settings2 } from 'lucide-react';
import {
  componentVersion,
  disabledReason,
  installationTask,
  lifecycleAction,
} from '../state';
import type { GatewayModel } from '../use-gateway';
import {
  ActionButton,
  Button,
  Hint,
  Input,
  Row,
  SettingInput,
  Switch,
  focus,
} from './ui';
import { TaskNotice } from './TaskNotice';

function RuntimeSettings({ model }: { model: GatewayModel }) {
  const action = model.device?.boot ? 'boot-off' : 'boot-on';
  const reason = disabledReason(action, model.device, !!model.busy);
  return (
    <section
      data-group="runtime"
      hidden={!model.device?.service}
      aria-labelledby="ufi-runtime-heading"
    >
      <h3
        id="ufi-runtime-heading"
        className="ufi:m-0 ufi:px-4 ufi:pt-5 ufi:pb-2 ufi:text-xs ufi:font-medium ufi:opacity-60"
      >
        运行
      </h3>
      <Row>
        <label htmlFor="ufi-boot">开机启动</label>
        <Switch
          id="ufi-boot"
          data-boot
          checked={model.device?.boot || false}
          disabled={!!reason}
          title={reason}
          onCheckedChange={(enabled) =>
            void model.perform(enabled ? 'boot-on' : 'boot-off')
          }
        />
      </Row>
      <SettingInput
        model={model}
        name="interfaces"
        label="共享接口"
        placeholder="自动识别"
      />
    </section>
  );
}

function PanelSettings({ model }: { model: GatewayModel }) {
  const { device, form, values, busy } = model;
  const { errors, dirtyFields } = form.formState;
  const pending =
    !!device?.controller &&
    (values.controlEnabled !== device.controller.enabled ||
      Number(values.controlPort) !== device.controller.port ||
      !!values.controlSecret ||
      values.resetSecret ||
      (device.config && !device.controller.applied));
  return (
    <section
      data-group="controller"
      hidden={!device?.service}
      aria-labelledby="ufi-controller-heading"
    >
      <h3
        id="ufi-controller-heading"
        className="ufi:m-0 ufi:flex ufi:items-center ufi:justify-between ufi:px-4 ufi:pt-5 ufi:pb-2 ufi:text-xs ufi:font-medium ufi:opacity-60"
      >
        控制面板
        <span>
          {Object.keys(dirtyFields).some(
            (key) => key.startsWith('control') || key === 'resetSecret',
          )
            ? '待应用'
            : device?.controller?.applied
              ? '已应用'
              : '已保存'}
        </span>
      </h3>
      {!device?.controller && (
        <div className="ufi:px-4">
          <Hint>请先更新 Mihomo Agent</Hint>
        </div>
      )}
      <fieldset
        hidden={!device?.controller}
        disabled={!!busy || !device?.controller || device.locked}
        className="ufi:m-0 ufi:min-w-0 ufi:border-0 ufi:p-0"
      >
        <Row>
          <label htmlFor="ufi-control-enabled">启用控制面板</label>
          <Controller
            control={form.control}
            name="controlEnabled"
            render={({ field }) => (
              <Switch
                id="ufi-control-enabled"
                checked={field.value}
                onCheckedChange={field.onChange}
                onBlur={field.onBlur}
                ref={field.ref}
                disabled={!!busy || !!device?.locked}
              />
            )}
          />
        </Row>
        <div className="ufi:border-0 ufi:border-t ufi:border-solid ufi:border-[var(--mh-line)] ufi:p-4">
          <label htmlFor="ufi-control-port" className="ufi:mb-2.5 ufi:block">
            API 端口
          </label>
          <Input
            id="ufi-control-port"
            inputMode="numeric"
            type="text"
            {...form.register('controlPort', {
              validate: (value) => model.validate('controlPort', value),
            })}
            aria-invalid={!!errors.controlPort}
            aria-describedby={
              errors.controlPort?.message ? 'ufi-port-error' : undefined
            }
          />
          <Hint id="ufi-port-error" error>
            {errors.controlPort?.message}
          </Hint>
        </div>
        <div className="ufi:border-0 ufi:border-t ufi:border-solid ufi:border-[var(--mh-line)] ufi:p-4">
          <div className="ufi:mb-2.5 ufi:flex ufi:items-center ufi:justify-between ufi:gap-2">
            <label htmlFor="ufi-control-secret">API 密钥</label>
            <button
              type="button"
              className={`ufi:m-0 ufi:border-0 ufi:bg-none ufi:bg-transparent ufi:p-1 ufi:text-xs ufi:text-[#0a84ff] ufi:cursor-pointer ${focus}`}
              onClick={() => void model.perform('view-secret')}
            >
              查看当前密钥
            </button>
          </div>
          <Input
            id="ufi-control-secret"
            type="password"
            autoComplete="new-password"
            placeholder="留空保持现有密钥"
            disabled={values.resetSecret}
            {...form.register('controlSecret', {
              validate: (value) => model.validate('controlSecret', value),
            })}
            aria-invalid={!!errors.controlSecret}
            aria-describedby={
              errors.controlSecret?.message ? 'ufi-secret-error' : undefined
            }
          />
          <Hint id="ufi-secret-error" error>
            {errors.controlSecret?.message}
          </Hint>
          <label className="ufi:my-2 ufi:flex ufi:min-h-11 ufi:items-center ufi:gap-2 ufi:text-xs">
            <input
              type="checkbox"
              className="ufi:m-0 ufi:h-4 ufi:w-4 ufi:accent-[#0a84ff]"
              {...form.register('resetSecret', {
                onChange: (event) => {
                  if (event.target.checked)
                    form.setValue('controlSecret', '', { shouldDirty: true });
                },
              })}
            />
            重新生成密钥
          </label>
          <ActionButton
            model={model}
            action="save-controller"
            label="保存并应用"
            icon={Check}
            primary
            extraReason={pending ? '' : '设置未改变'}
          />
          <Hint>
            {device?.running
              ? '应用后会重启代理'
              : device?.config
                ? '保存后生效'
                : '保存后随订阅生效'}
          </Hint>
        </div>
      </fieldset>
    </section>
  );
}

function Installation({
  model,
  confirmUninstall,
}: {
  model: GatewayModel;
  confirmUninstall: () => void;
}) {
  const { device } = model;
  const task =
    device?.task && installationTask(device.task.action) ? device.task : null;
  const lifecycle = lifecycleAction(device);
  return (
    <section data-group="maintenance" aria-labelledby="ufi-maintenance-heading">
      <div className="ufi:flex ufi:items-center ufi:justify-between ufi:gap-3 ufi:px-4 ufi:pt-5 ufi:pb-2">
        <h3
          id="ufi-maintenance-heading"
          className="ufi:m-0 ufi:text-xs ufi:font-medium ufi:opacity-60"
        >
          安装与更新
        </h3>
        <ActionButton model={model} action="check-updates" label="检查更新" />
      </div>
      {model.updates && (
        <p
          data-update-checked
          className="ufi:m-0 ufi:px-4 ufi:text-xs ufi:opacity-60"
        >
          上次检查{' '}
          {new Date(model.updates.checkedAt).toLocaleString([], {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}
      <SettingInput
        model={model}
        name="githubProxy"
        label="GitHub Proxy"
        placeholder="https://ghfast.top"
      />
      {(
        [
          [
            'agent',
            'Mihomo Agent',
            device?.agent,
            device?.version,
            'update-agent',
          ],
          [
            'core',
            'Mihomo 内核',
            device?.core,
            device?.coreVersion,
            'download',
          ],
          [
            'dashboard',
            'Zashboard',
            device?.dashboard.installed,
            device?.dashboard.version,
            'download-dashboard',
          ],
        ] as const
      ).map(([id, name, installed, version, action]) => {
        const checked = model.updates?.[id];
        const update =
          checked?.current === (installed === false ? '' : version || '')
            ? checked
            : undefined;
        const label =
          update &&
          {
            available: `可更新至 ${update.latest}`,
            'up-to-date': '已是最新',
            'not-installed': `最新 ${update.latest}`,
            unknown: `最新 ${update.latest} · 当前版本无法比较`,
            error: '检查失败',
          }[update.state];
        return (
          <Row key={id}>
            <span className="ufi:flex ufi:min-w-0 ufi:flex-wrap ufi:items-baseline ufi:gap-x-2">
              <span>{name}</span>
              <span
                data-version={id}
                className="ufi:break-all ufi:text-xs ufi:opacity-60"
              >
                {componentVersion(installed, version)}
              </span>
              {label && (
                <span
                  data-update={id}
                  title={update?.error || `最新正式版 ${update?.latest}`}
                  className={
                    update?.state === 'available'
                      ? 'ufi:text-xs ufi:text-[#0a84ff]'
                      : update?.state === 'error'
                        ? 'ufi:text-xs ufi:text-[#ff6961]'
                        : 'ufi:text-xs ufi:opacity-60'
                  }
                >
                  {label}
                </span>
              )}
            </span>
            <ActionButton
              model={model}
              action={
                action === 'update-agent' && installed === false
                  ? 'install'
                  : action
              }
              label={installed === false ? '安装' : '更新'}
              extraReason={
                update?.state === 'up-to-date' ? '已是最新正式版' : ''
              }
            />
          </Row>
        );
      })}
      {task && <TaskNotice model={model} job={task} installation />}
      <Row>
        <span data-lifecycle>
          Mihomo 服务{' '}
          <span className="ufi:text-xs ufi:opacity-60">
            {device
              ? device.service
                ? '已安装'
                : device.agent
                  ? '未完成'
                  : '未安装'
              : '状态未知'}
          </span>
        </span>
        <ActionButton
          model={model}
          action={lifecycle || 'install'}
          label={
            lifecycle === 'uninstall' ? '卸载' : device ? '安装' : '状态未知'
          }
          onClick={lifecycle === 'uninstall' ? confirmUninstall : undefined}
        />
      </Row>
    </section>
  );
}

export function Settings({
  model,
  open,
  onOpenChange,
  setup,
  confirmUninstall,
}: {
  model: GatewayModel;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  setup: boolean;
  confirmUninstall: () => void;
}) {
  const groups = {
    runtime: <RuntimeSettings key="runtime" model={model} />,
    controller: <PanelSettings key="controller" model={model} />,
    maintenance: (
      <Installation
        key="maintenance"
        model={model}
        confirmUninstall={confirmUninstall}
      />
    ),
  };
  const order: (keyof typeof groups)[] = setup
    ? ['maintenance', 'runtime', 'controller']
    : ['runtime', 'controller', 'maintenance'];
  return (
    <details
      data-settings
      open={open}
      className="ufi:group/settings ufi:mt-4 ufi:overflow-hidden ufi:rounded-2xl ufi:bg-[var(--mh-group)]"
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          onOpenChange(event.currentTarget.open);
      }}
    >
      <summary
        className={`ufi:flex ufi:min-h-14 ufi:list-none ufi:items-center ufi:justify-between ufi:px-4 ufi:py-3 ufi:cursor-pointer ufi:[&::-webkit-details-marker]:hidden ${focus}`}
      >
        <span className="ufi:flex ufi:items-center ufi:gap-2">
          <Settings2 size={18} aria-hidden />
          设置
        </span>
        <ChevronDown
          size={16}
          className="ufi:group-open/settings:rotate-180"
          aria-hidden
        />
      </summary>
      {order.map((name) => groups[name])}
    </details>
  );
}
