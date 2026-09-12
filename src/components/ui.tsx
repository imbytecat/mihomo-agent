import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import * as Toggle from '@radix-ui/react-switch';
import { clsx } from 'clsx';
import { LoaderCircle, X, type LucideIcon } from 'lucide-react';
import { disabledReason } from '../state';
import type { GatewayModel, Operation, Setting } from '../use-gateway';

export const focus =
  'focus-visible:ufi-outline focus-visible:ufi-outline-2 focus-visible:ufi-outline-offset-2 focus-visible:ufi-outline-[#0a84ff]';
export const buttonStyle = `ufi-inline-flex ufi-min-h-11 ufi-items-center ufi-justify-center ufi-gap-2 ufi-m-0 ufi-rounded-xl ufi-border ufi-border-solid ufi-border-[var(--mh-line)] ufi-bg-none ufi-px-3.5 ufi-py-2.5 ufi-text-sm ufi-font-medium ufi-leading-normal ufi-no-underline ufi-cursor-pointer disabled:ufi-opacity-40 disabled:ufi-cursor-not-allowed ${focus}`;

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'default' | 'primary' | 'danger';
  full?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'default',
      full,
      loading,
      icon: Icon,
      children,
      className,
      ...props
    },
    ref,
  ) {
    return (
      <button
        type="button"
        {...props}
        ref={ref}
        className={clsx(
          buttonStyle,
          full && 'ufi-w-full',
          variant === 'primary'
            ? 'ufi-bg-[#006ddb] ufi-text-white hover:ufi-bg-[#0060c2]'
            : 'ufi-bg-white/5 hover:ufi-bg-white/10',
          variant === 'danger'
            ? 'ufi-text-[#ff6961]'
            : variant !== 'primary' && 'ufi-text-inherit',
          className,
        )}
      >
        {loading ? (
          <LoaderCircle
            size={17}
            className="ufi-shrink-0 ufi-animate-spin motion-reduce:ufi-animate-none"
            aria-hidden
          />
        ) : (
          Icon && <Icon size={17} className="ufi-shrink-0" aria-hidden />
        )}
        {children}
      </button>
    );
  },
);

export function ActionButton({
  model,
  action,
  label,
  icon,
  primary,
  onClick,
  extraReason = '',
}: {
  model: GatewayModel;
  action: Operation;
  label: string;
  icon?: LucideIcon;
  primary?: boolean;
  onClick?: () => void;
  extraReason?: string;
}) {
  const reason =
    disabledReason(
      action,
      model.device,
      !!model.busy,
      model.values.subscription,
    ) || extraReason;
  return (
    <Button
      data-action={action}
      data-primary={primary || undefined}
      icon={icon}
      loading={model.busy === action}
      disabled={!!reason}
      title={reason}
      full={primary}
      variant={
        action === 'uninstall'
          ? 'danger'
          : primary && action !== 'stop'
            ? 'primary'
            : 'default'
      }
      onClick={onClick || (() => void model.perform(action))}
    >
      {label}
    </Button>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        {...props}
        ref={ref}
        className={clsx(
          'ufi-block ufi-h-11 ufi-w-full ufi-min-w-0 ufi-m-0 ufi-rounded-xl ufi-border ufi-border-solid ufi-border-[var(--mh-line)] ufi-bg-white/5 ufi-px-3 ufi-py-2.5 ufi-text-base ufi-font-normal ufi-text-inherit ufi-leading-normal placeholder:ufi-text-inherit placeholder:ufi-opacity-35 disabled:ufi-opacity-40',
          focus,
          className,
        )}
      />
    );
  },
);

export function Switch(props: ComponentProps<typeof Toggle.Root>) {
  return (
    <Toggle.Root
      {...props}
      className={clsx(
        'ufi-relative ufi-h-7 ufi-w-12 ufi-shrink-0 ufi-m-0 ufi-rounded-full ufi-border-0 ufi-bg-none ufi-bg-white/20 ufi-p-0.5 ufi-cursor-pointer data-[state=checked]:ufi-bg-[#30d158] disabled:ufi-opacity-40 disabled:ufi-cursor-not-allowed',
        focus,
        props.className,
      )}
    >
      <Toggle.Thumb className="ufi-block ufi-h-6 ufi-w-6 ufi-rounded-full ufi-bg-white ufi-shadow-sm data-[state=checked]:ufi-translate-x-5" />
    </Toggle.Root>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div className="ufi-flex ufi-min-h-16 ufi-items-center ufi-justify-between ufi-gap-3 ufi-border-0 ufi-border-t ufi-border-solid ufi-border-[var(--mh-line)] ufi-px-4 ufi-py-3">
      {children}
    </div>
  );
}
export function Hint({
  children,
  error,
  id,
}: {
  children?: ReactNode;
  error?: boolean;
  id?: string;
}) {
  return children ? (
    <p
      id={id}
      className={clsx(
        'ufi-m-0 ufi-mt-2 ufi-text-xs ufi-leading-relaxed',
        error ? 'ufi-text-[#ff6961]' : 'ufi-opacity-60',
      )}
    >
      {children}
    </p>
  ) : null;
}

export function SettingInput({
  model,
  name,
  label,
  placeholder,
}: {
  model: GatewayModel;
  name: Setting;
  label: string;
  placeholder: string;
}) {
  const field = model.form.register(name, {
    validate: (value) => model.validate(name, value),
  });
  const error = model.form.formState.errors[name];
  return (
    <div className="ufi-border-0 ufi-border-t ufi-border-solid ufi-border-[var(--mh-line)] ufi-p-4">
      <div className="ufi-mb-2.5 ufi-flex ufi-items-center ufi-justify-between ufi-gap-2">
        <label htmlFor={`ufi-${name}`}>{label}</label>
        {error?.type === 'server' ? (
          <Button onClick={() => model.autosave(name)}>重试保存</Button>
        ) : (
          <span
            data-save-status={name}
            className={clsx(
              'ufi-text-xs',
              error ? 'ufi-text-[#ff6961]' : 'ufi-opacity-60',
            )}
          >
            {model.saveStatus(name)}
          </span>
        )}
      </div>
      <Input
        {...field}
        id={`ufi-${name}`}
        data-setting={name}
        type={name === 'githubProxy' ? 'url' : 'text'}
        placeholder={placeholder}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-invalid={!!error}
        aria-describedby={`ufi-${name}-help`}
        disabled={
          !!model.busy || (name === 'interfaces' && !!model.device?.running)
        }
        onBlur={(event) => {
          void field.onBlur(event);
          model.autosave(name);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <Hint id={`ufi-${name}-help`} error={!!error}>
        {error?.message ||
          (name === 'githubProxy'
            ? '留空直连 · 离开输入框自动保存'
            : model.device?.running
              ? '停止代理后可修改'
              : '留空自动识别 · 离开输入框自动保存')}
      </Hint>
    </div>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  container,
  children,
  closeLabel = '关闭详情',
  kind,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description?: string;
  container: HTMLElement;
  children: ReactNode;
  closeLabel?: string;
  kind: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Backdrop className="ufi-fixed ufi-inset-0 ufi-z-[2147483640] ufi-bg-black/60" />
        <Dialog.Popup
          data-dialog={kind}
          data-state={open ? 'open' : 'closed'}
          {...(!description ? { 'aria-describedby': undefined } : {})}
          className="ufi-fixed ufi-left-1/2 ufi-top-1/2 ufi-z-[2147483641] ufi-max-h-[80vh] ufi-w-[calc(100vw-32px)] ufi-max-w-xl -ufi-translate-x-1/2 -ufi-translate-y-1/2 ufi-overflow-auto ufi-rounded-2xl ufi-border ufi-border-solid ufi-border-[var(--mh-line)] ufi-bg-[var(--mh-group)] ufi-p-5 ufi-text-[var(--mh-text)] ufi-shadow-xl focus:ufi-outline-none"
        >
          <div className="ufi-flex ufi-items-center ufi-justify-between ufi-gap-3">
            <Dialog.Title
              data-dialog-title
              className="ufi-m-0 ufi-text-lg ufi-font-semibold"
            >
              {title}
            </Dialog.Title>
            <Dialog.Close
              render={<Button aria-label={closeLabel} icon={X} />}
            />
          </div>
          {description && (
            <Dialog.Description className="ufi-m-0 ufi-mt-3 ufi-text-sm ufi-leading-relaxed ufi-opacity-70">
              {description}
            </Dialog.Description>
          )}
          <div className="ufi-mt-4">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
