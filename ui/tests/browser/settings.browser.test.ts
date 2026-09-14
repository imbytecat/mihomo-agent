import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { app, evaluate, idle, closeModal, open, reload } from './app';

test('autosave preserves newer drafts and validates download settings', async () => {
  await open('ready');
  await app.getByCSS('[data-settings] > summary').click();
  await expect
    .element(app.getByCSS('[data-group=runtime] [data-boot]'))
    .toBeInTheDocument();
  await expect
    .element(app.getByCSS('[data-group=subscription] [data-boot]'))
    .not.toBeInTheDocument();
  await expect
    .element(
      app.getByCSS('[data-group=maintenance] [data-action=self-update]'),
    )
    .toBeInTheDocument();
  await expect
    .element(app.getByCSS('[data-action=self-update]'))
    .toHaveTextContent('更新');
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toHaveTextContent('更新');
  await expect
    .element(app.getByCSS('[data-action=download-dashboard]'))
    .toHaveTextContent('安装');
  await app.getByCSS('[data-action=self-update]').click();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.task?.action === "self-update" && mockDeviceState.task?.state === "succeeded"',
      ),
    )
    .toBeTruthy();
  await idle();
  await app.getByCSS('[data-setting=githubProxy]').fill('https://mirror.example.com/');
  await evaluate('window.mockUploadDelayMs = 900');
  // The click itself blurs the input; it must survive the ensuing autosave render.
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await expect
    .element(app.getByCSS('[data-version=core]'))
    .toHaveTextContent('v9.8.7');
  await idle();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://mirror.example.com" && mockIntents.filter(x => x.action === "save-github-proxy").length === 1',
      ),
    )
    .toBe(true);
  await expect.element(app.getByCSS('[data-task]')).not.toBeInTheDocument();
  await expect
    .element(app.getByCSS('body'))
    .not.toMatchTextContent('已安装，校验通过');
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-install-task]'))
    .toBeInTheDocument();

  await app
    .getByCSS('[data-setting=githubProxy]')
    .fill('https://first.example');
  await userEvent.tab();
  await expect
    .element(app.getByCSS('[data-save-status=githubProxy]'))
    .toMatchTextContent('保存中');
  await app
    .getByCSS('[data-setting=githubProxy]')
    .fill('https://second.example');
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://first.example"',
      ),
    )
    .toBeTruthy();
  await expect
    .element(app.getByCSS('[data-setting=githubProxy]'))
    .toHaveValue('https://second.example');
  await userEvent.tab();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://second.example"',
      ),
    )
    .toBeTruthy();

  await evaluate(
    'window.mockUploadDelayMs = 0; window.mockUploadFailure = true',
  );
  await app
    .getByCSS('[data-setting=githubProxy]')
    .fill('https://retry.example');
  await userEvent.tab();
  await expect
    .element(app.getByText('重试保存', { exact: true }).first())
    .toBeVisible();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://second.example"',
      ),
    )
    .toBe(true);
  await evaluate('window.mockUploadFailure = false');
  await app.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://retry.example"',
      ),
    )
    .toBeTruthy();
  await app
    .getByCSS('[data-setting=githubProxy]')
    .fill('http://invalid.example');
  await app.getByCSS('[data-group=maintenance] [data-action=download]').click();
  await idle();
  await expect
    .poll(() =>
      evaluate(
        'mockDeviceState.settings.githubProxy === "https://retry.example" && mockIntents.filter(x => x.action === "download").length === 1',
      ),
    )
    .toBe(true);
});

test('controller transactions, encrypted secrets and task details', async () => {
  await open('running');
  await app.getByCSS('[data-settings] > summary').click();
  await expect
    .element(app.getByCSS('[data-dashboard-link]'))
    .toHaveAttribute('href', expect.stringContaining(':9090/ui/'));
  await app.getByCSS('#ufi-control-port').fill('9191');
  await app.getByCSS('#ufi-control-secret').fill('short');
  await evaluate('window.mockTaskDelayMs = 5000');
  await app.getByCSS('[data-action=save-controller]').click();
  await expect.poll(() => evaluate('mockDeviceState.locked')).toBeTruthy();
  await expect
    .element(app.getByCSS('[data-status]'))
    .toHaveTextContent('运行中');
  expect(evaluate('mockDeviceState.controller.port')).toBe(9090);
  await expect
    .poll(() => evaluate('mockDeviceState.controller.port === 9191'))
    .toBeTruthy();
  await idle();
  await expect
    .element(app.getByCSS('[data-dashboard-link]'))
    .toHaveAttribute('href', expect.stringContaining(':9191/ui/'));
  await expect
    .element(app.getByCSS('[data-dashboard-link]'))
    .not.toHaveAttribute('href', expect.stringContaining('secret'));
  await app.getByRole('button', { name: '查看当前密钥', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-dialog=secret][data-state=open]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-dialog=secret] input'))
    .toHaveValue('short');
  expect(
    evaluate(
      'mockCommands.every(c => !c.includes(JSON.stringify({secret: "short"})))',
    ),
  ).toBe(true);
  await closeModal('关闭密钥');
  await app.getByRole('button', { name: '更多操作', exact: true }).click();
  await app.getByRole('menuitem', { name: '运行日志', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-dialog=result][data-state=open]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-dialog=result] [data-dialog-title]'))
    .toHaveTextContent('运行日志');
  await closeModal();
  await app.getByRole('button', { name: '更多操作', exact: true }).click();
  await app.getByRole('menuitem', { name: '最近任务', exact: true }).click();
  await expect
    .element(app.getByCSS('[data-dialog=result][data-state=open]'))
    .toBeVisible();
  await expect
    .element(app.getByCSS('[data-dialog=result] [data-dialog-title]'))
    .toHaveTextContent('任务详情');
  await expect
    .element(app.getByCSS('[data-output]'))
    .toMatchTextContent('面板设置');
  await expect
    .element(app.getByCSS('[data-output]'))
    .not.toMatchTextContent('core.log');
  await closeModal();
  await evaluate(
    'window.mockTaskDelayMs = 300; window.mockTaskFailure = "配置校验失败"',
  );
  await app.getByCSS('#ufi-control-port').fill('9292');
  await app.getByCSS('[data-action=save-controller]').click();
  await expect
    .poll(() => evaluate('mockDeviceState.task.state === "failed"'))
    .toBeTruthy();
  await idle();
  expect(evaluate('mockDeviceState.controller.port')).toBe(9191);
  await expect.element(app.getByCSS('#ufi-control-port')).toHaveValue('9292');
});

test('update checks show component results without submitting mutations or clearing drafts', async () => {
  await open('ready');
  await app.getByCSS('[data-settings] > summary').click();
  await app.getByCSS('[data-url]').fill('https://draft.example/subscription');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('可更新至 v9.8.7');
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
  await expect
    .element(app.getByCSS('[data-update=dashboard]'))
    .toMatchTextContent('最新 v3.26.0');
  await expect
    .element(app.getByCSS('[data-update-checked]'))
    .toMatchTextContent('上次检查');
  await expect
    .element(app.getByCSS('[data-group=maintenance] [data-action=download]'))
    .toBeDisabled();
  await expect
    .element(app.getByCSS('[data-url]'))
    .toHaveValue('https://draft.example/subscription');
  expect(evaluate('mockIntents.length')).toBe(0);
  await evaluate('window.mockUpdateFailure = true');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('检查失败');
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
  await evaluate('window.mockUpdateFailure = false');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await idle();
  expect(evaluate('mockIntents.length')).toBe(0);
  expect(
    evaluate(
      'mockRequests.every(u => new URL(u, location.href).origin === location.origin)',
    ),
  ).toBe(true);
  await reload();
  await app.getByCSS('[data-plugin] > summary').click();
  await idle();
  await app.getByCSS('[data-settings] > summary').click();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .toHaveTextContent('可更新至 v9.8.7');
  expect(evaluate('mockCommands.some(c => c.includes("check-updates"))')).toBe(false);
  await app.getByCSS('[data-action=self-update]').click();
  await idle();
  await expect
    .element(app.getByCSS('[data-update=self]'))
    .not.toBeInTheDocument();
  await expect
    .element(app.getByCSS('[data-update=core]'))
    .toHaveTextContent('已是最新');
});
