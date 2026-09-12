import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { Toaster } from 'sonner';
import { useGateway } from './use-gateway';
import { topTask } from './state';
import { Overview, runtimeTitle, stageOf } from './components/Overview';
import { Settings } from './components/Settings';
import { Subscription } from './components/Subscription';
import { TaskNotice } from './components/TaskNotice';
import { Button, Input, Modal, focus } from './components/ui';

export default function Gateway({ container }: { container: HTMLElement }) {
  const model = useGateway();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const subscription = useRef<HTMLDivElement>(null);
  const setup = ['unknown', 'agent', 'service', 'core', 'upgrade'].includes(
    stageOf(model),
  );
  useEffect(() => {
    if (model.device && setup) setSettingsOpen(true);
  }, [setup, model.device?.agent, model.device?.core]);
  const subscriptionCard = (
    <Subscription key="subscription" model={model} anchor={subscription} />
  );
  const settingsCard = (
    <Settings
      key="settings"
      model={model}
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      setup={setup}
      confirmUninstall={() => setUninstallOpen(true)}
    />
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
        container,
      )}
      <details
        data-plugin
        className="ufi-group/plugin ufi-overflow-hidden ufi-rounded-[22px] ufi-border ufi-border-solid ufi-border-[var(--mh-line)] ufi-bg-[var(--mh-bg)] ufi-text-[var(--mh-text)]"
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            model.open.current = event.currentTarget.open;
        }}
      >
        <summary
          className={`ufi-flex ufi-list-none ufi-items-center ufi-gap-3 ufi-px-5 ufi-py-4 ufi-cursor-pointer [&::-webkit-details-marker]:ufi-hidden ${focus}`}
        >
          <ShieldCheck size={22} className="ufi-text-[#0a84ff]" aria-hidden />
          <strong className="ufi-text-base ufi-font-semibold">Mihomo</strong>
          <span className="ufi-ml-auto ufi-text-xs ufi-opacity-65">
            {runtimeTitle(model)}
          </span>
          <ChevronDown
            size={17}
            className="group-open/plugin:ufi-rotate-180"
            aria-hidden
          />
        </summary>
        <div
          data-gateway-body
          aria-busy={!!model.busy}
          className="ufi-px-4 ufi-pb-4"
        >
          <Overview
            model={model}
            container={container}
            addSubscription={() => {
              subscription.current?.scrollIntoView({
                block: 'center',
                behavior: 'smooth',
              });
              model.form.setFocus('subscription');
            }}
          />
          {model.error ? (
            <div className="ufi-mt-3">
              <Button
                full
                variant="danger"
                onClick={() => model.setDetailOpen(true)}
              >
                操作未完成 · 查看详情
              </Button>
            </div>
          ) : (
            topTask(model.device?.task) &&
            model.device?.task && (
              <TaskNotice model={model} job={model.device.task} />
            )
          )}
          {setup
            ? [settingsCard, subscriptionCard]
            : [subscriptionCard, settingsCard]}
        </div>
      </details>
      <Modal
        container={container}
        kind="uninstall"
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        title="卸载 Mihomo 服务？"
        description="停止代理并关闭开机启动，删除本插件全部设备文件和数据，不可恢复。"
        closeLabel="取消卸载"
      >
        <div className="ufi-flex ufi-justify-end ufi-gap-3">
          <Button data-uninstall-cancel onClick={() => setUninstallOpen(false)}>
            取消
          </Button>
          <Button
            data-uninstall-confirm
            variant="danger"
            onClick={() => {
              setUninstallOpen(false);
              void model.perform('uninstall');
            }}
          >
            卸载并删除数据
          </Button>
        </div>
      </Modal>
      <Modal
        container={container}
        kind="result"
        open={model.detailOpen}
        onOpenChange={model.setDetailOpen}
        title={model.detailTitle}
      >
        <pre
          data-output
          className="ufi-m-0 ufi-max-h-[60vh] ufi-overflow-auto ufi-whitespace-pre-wrap ufi-break-words ufi-text-xs ufi-leading-relaxed"
        >
          {model.detail}
        </pre>
      </Modal>
      <Modal
        container={container}
        kind="secret"
        open={!!model.secret}
        onOpenChange={(open) => {
          if (!open) model.setSecret('');
        }}
        title="API 密钥"
        description="首次连接面板时填写。选中文本即可复制。"
        closeLabel="关闭密钥"
      >
        <Input
          type="text"
          aria-label="当前 API 密钥"
          readOnly
          value={model.secret}
          onFocus={(event) => event.currentTarget.select()}
        />
      </Modal>
    </>
  );
}
