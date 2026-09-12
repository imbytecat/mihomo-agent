import { RefreshCw } from 'lucide-react';
import type { RefObject } from 'react';
import type { GatewayModel } from '../use-gateway';
import { ActionButton, Hint, Input } from './ui';

export function Subscription({
  model,
  anchor,
}: {
  model: GatewayModel;
  anchor: RefObject<HTMLDivElement | null>;
}) {
  const { form, values, device, busy } = model;
  const error = form.formState.errors.subscription;
  return (
    <section className="ufi-mt-4">
      <h3 className="ufi-m-0 ufi-px-3 ufi-py-2 ufi-text-xs ufi-font-normal ufi-opacity-60">
        订阅
      </h3>
      <div
        data-group="subscription"
        ref={anchor}
        className="ufi-rounded-2xl ufi-bg-[var(--mh-group)] ufi-p-4"
      >
        <div className="ufi-mb-2.5 ufi-flex ufi-items-center ufi-justify-between">
          <label htmlFor="ufi-subscription">订阅链接</label>
          <span className="ufi-text-xs ufi-opacity-60">
            {values.subscription?.trim()
              ? '待应用'
              : device?.subscription
                ? '已保存'
                : '未配置'}
          </span>
        </div>
        <Input
          {...form.register('subscription', {
            validate: (value) => model.validate('subscription', value),
          })}
          id="ufi-subscription"
          data-url
          type="password"
          placeholder={
            device?.subscription ? '留空使用已保存订阅' : '粘贴订阅链接'
          }
          disabled={!!busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error?.message ? 'ufi-subscription-error' : undefined}
          enterKeyHint="go"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void model.perform('update');
            }
          }}
        />
        <Hint error id="ufi-subscription-error">
          {error?.message}
        </Hint>
        <div className="ufi-mt-3">
          <ActionButton
            model={model}
            action="update"
            label={values.subscription?.trim() ? '保存并更新' : '更新订阅'}
            icon={RefreshCw}
            primary
          />
        </div>
      </div>
    </section>
  );
}
