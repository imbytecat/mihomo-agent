// Requires agent-browser. Exercises the production artifact against the local UFI mock.
import assert from 'node:assert/strict';

const session = `ufi-ux-${Date.now()}`;
const server = Bun.spawn([process.execPath, 'tests/preview.ts'], {
  env: { ...process.env, UFI_PREVIEW_PORT: '0' },
  stdout: 'pipe',
  stderr: 'inherit',
});
const reader = server.stdout.getReader();
let output = '';
while (!output.includes('\n')) {
  const { value, done } = await reader.read();
  if (done) throw new Error('Preview server exited before starting');
  output += new TextDecoder().decode(value);
}
reader.releaseLock();
const base = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
assert(base, output);
async function browser(...args: string[]) {
  const process = Bun.spawn(['agent-browser', '--session', session, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  assert.equal(code, 0, `${args.join(' ')}\n${out}\n${err}`);
  return out.trim();
}
const check = async (expression: string) =>
  assert.equal(await browser('eval', expression), 'true', expression);
async function idle() {
  await browser(
    'wait',
    '--fn',
    '!document.querySelector("[data-gateway-body]").matches("[aria-busy=true]")',
  );
  // A user can dismiss transient notifications before scrolling to the next action.
  // Fast CI clicks otherwise land underneath a still-visible fixed toast.
  const close = '[data-sonner-toast][data-removed=false] [data-close-button]';
  while (Number(await browser('get', 'count', close))) {
    await browser('find', 'first', close, 'click');
    await browser(
      'wait',
      '--fn',
      '!document.querySelector("[data-sonner-toast][data-removed=true]")',
    );
  }
}
async function closeModal(name = '关闭详情') {
  await browser('find', 'role', 'button', 'click', '--name', name, '--exact');
  await browser('wait', '--fn', '!document.querySelector("[data-dialog]")');
  await idle();
}
async function page(state: string) {
  await browser('open', `${base}?state=${state}`);
  await browser('wait', '[data-plugin] > summary');
  await browser('click', '[data-plugin] > summary');
  await idle();
}
try {
  await page('ready');
  await browser('click', '[data-settings] > summary');
  await check(
    '!!document.querySelector("[data-group=runtime] [data-boot]") && !document.querySelector("[data-group=subscription] [data-boot]")',
  );
  await check(
    '!!document.querySelector("[data-group=maintenance] [data-action=update-agent]")',
  );
  await check(
    'document.querySelector("[data-action=update-agent]").textContent === "更新" && document.querySelector("[data-group=maintenance] [data-action=download]").textContent === "更新" && document.querySelector("[data-action=download-dashboard]").textContent === "安装"',
  );
  await browser('click', '[data-action=update-agent]');
  await browser(
    'wait',
    '--fn',
    'mockDeviceState.task?.action === "update-agent" && mockDeviceState.task?.state === "succeeded"',
  );
  await idle();
  await browser('fill', '[data-setting=githubProxy]', 'https://ghfast.top/');
  await browser('eval', 'window.mockUploadDelayMs = 900');
  // The click itself blurs the input; it must survive the ensuing autosave render.
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser(
    'wait',
    '--fn',
    'document.querySelector("[data-version=core]").textContent === "v9.8.7"',
  );
  await idle();
  await check(
    'mockDeviceState.settings.githubProxy === "https://ghfast.top" && mockIntents.filter(x => x.action === "save-github-proxy").length === 1',
  );
  await check(
    '!document.querySelector("[data-task]") && !document.body.innerText.includes("已安装，校验通过") && !!document.querySelector("[data-group=maintenance] [data-install-task]")',
  );

  await browser('fill', '[data-setting=githubProxy]', 'https://first.example');
  await browser('press', 'Tab');
  await browser(
    'wait',
    '--fn',
    'document.querySelector("[data-save-status=githubProxy]")?.textContent.includes("保存中")',
  );
  await browser('fill', '[data-setting=githubProxy]', 'https://second.example');
  await browser(
    'wait',
    '--fn',
    'mockDeviceState.settings.githubProxy === "https://first.example"',
  );
  await check(
    'document.querySelector("[data-setting=githubProxy]").value === "https://second.example"',
  );
  await browser('press', 'Tab');
  await browser(
    'wait',
    '--fn',
    'mockDeviceState.settings.githubProxy === "https://second.example"',
  );

  await browser(
    'eval',
    'window.mockUploadDelayMs = 0; window.mockUploadFailure = true',
  );
  await browser('fill', '[data-setting=githubProxy]', 'https://retry.example');
  await browser('press', 'Tab');
  await browser('wait', '--text', '重试保存');
  await check(
    'mockDeviceState.settings.githubProxy === "https://second.example"',
  );
  await browser('eval', 'window.mockUploadFailure = false');
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '重试保存',
    '--exact',
  );
  await browser(
    'wait',
    '--fn',
    'mockDeviceState.settings.githubProxy === "https://retry.example"',
  );
  await browser('fill', '[data-setting=githubProxy]', 'http://invalid.example');
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await idle();
  await check(
    'mockDeviceState.settings.githubProxy === "https://retry.example" && mockIntents.filter(x => x.action === "download").length === 1',
  );

  await page('missing-service');
  await browser(
    'fill',
    '[data-setting=githubProxy]',
    'https://before-install.example',
  );
  await browser('click', '[data-primary=true][data-action=install]');
  await browser('wait', '--fn', 'mockDeviceState.service');
  await idle();
  await check(
    'document.querySelector("[data-setting=githubProxy]").value === "https://before-install.example"',
  );
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser(
    'wait',
    '--fn',
    'document.querySelector("[data-version=core]").textContent === "v9.8.7"',
  );
  await idle();
  await check(
    'mockDeviceState.settings.githubProxy === "https://before-install.example"',
  );
  await browser('fill', '[data-url]', 'https://example.com/subscription');
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '保存并更新',
    '--exact',
  );
  await browser('wait', '--text', '配置已更新');
  await idle();
  await check(
    'mockDeviceState.config && document.querySelector("[data-url]").value === ""',
  );
  await check(
    'mockCommands.every(c => !c.includes("https://example.com/subscription")) && mockUploads.every(u => !new TextDecoder().decode(u.bytes).includes("https://example.com/subscription"))',
  );
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '启动代理',
    '--exact',
  );
  await browser('wait', '--fn', 'mockDeviceState.running');
  await idle();
  await browser('click', '[data-boot]');
  await browser('wait', '--fn', 'mockDeviceState.boot');
  await idle();
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '更多操作',
    '--exact',
  );
  await browser(
    'find',
    'role',
    'menuitem',
    'click',
    '--name',
    '运行日志',
    '--exact',
  );
  await browser('wait', '[data-dialog=result][data-state=open]');
  await closeModal();
  await browser('find', 'role', 'button', 'click', '--name', '卸载', '--exact');
  await browser('wait', '[data-dialog=uninstall][data-state=open]');
  await browser('click', '[data-uninstall-cancel]');
  await browser(
    'wait',
    '--fn',
    '!document.querySelector("[data-dialog=uninstall]")',
  );
  await check('!mockIntents.some(x => x.action === "uninstall")');
  await browser('find', 'role', 'button', 'click', '--name', '卸载', '--exact');
  await browser('wait', '[data-dialog=uninstall][data-state=open]');
  await browser('click', '[data-uninstall-confirm]');
  await browser('wait', '--fn', '!mockDeviceState.service');
  await idle();
  await check(
    '!mockDeviceState.running && !mockDeviceState.boot && !mockDeviceState.agent',
  );
  assert.equal(await browser('errors'), '');
  await page('missing-core');
  await check(
    'document.querySelector("[data-group=maintenance] [data-action=download]").textContent === "安装"',
  );
  await browser(
    'eval',
    'window.mockTaskFailure = "F50 TLS 握手失败：api.github.com"; window.mockTaskDelayMs = 9000',
  );
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await browser('reload');
  await browser('wait', '[data-plugin] > summary');
  await browser('click', '[data-plugin] > summary');
  await browser('wait', '--fn', 'mockDeviceState.task?.state === "failed"');
  await browser('click', '[data-task]');
  await browser('wait', '[data-dialog=result][data-state=open]');
  await check(
    'document.querySelector("[data-output]").textContent.includes("F50 TLS")',
  );
  await check(
    'mockIntents.length === 0 && mockRequests.every(u => new URL(u, location.href).origin === location.origin)',
  );
  await closeModal();
  await browser(
    'eval',
    'window.mockTaskFailure = ""; window.mockTaskDelayMs = 8000',
  );
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await browser('reload');
  await browser('wait', '[data-plugin] > summary');
  await browser('click', '[data-plugin] > summary');
  await browser(
    'wait',
    '--fn',
    'mockDeviceState.core && mockDeviceState.task?.state === "succeeded"',
  );
  await check(
    'mockIntents.length === 0 && document.querySelector("[data-version=core]").textContent === "v9.8.7" && !document.querySelector("[data-task]")',
  );
  await page('running');
  await browser('click', '[data-settings] > summary');
  await check(
    'document.querySelector("[data-dashboard-link]").href.includes(":9090/ui/")',
  );
  await browser('fill', '#ufi-control-port', '9191');
  await browser('fill', '#ufi-control-secret', 'short');
  await browser('eval', 'window.mockTaskDelayMs = 5000');
  await browser('click', '[data-action=save-controller]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await check(
    'document.querySelector("[data-status]").textContent === "运行中" && mockDeviceState.controller.port === 9090',
  );
  await browser('wait', '--fn', 'mockDeviceState.controller.port === 9191');
  await idle();
  await check(
    'document.querySelector("[data-dashboard-link]").href.includes(":9191/ui/") && !document.querySelector("[data-dashboard-link]").href.includes("secret")',
  );
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '查看当前密钥',
    '--exact',
  );
  await browser('wait', '[data-dialog=secret][data-state=open]');
  await check(
    'document.querySelector("[data-dialog=secret] input").value === "short" && mockCommands.every(c => !c.includes(JSON.stringify({secret: "short"})))',
  );
  await closeModal('关闭密钥');
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '更多操作',
    '--exact',
  );
  await browser(
    'find',
    'role',
    'menuitem',
    'click',
    '--name',
    '运行日志',
    '--exact',
  );
  await browser('wait', '[data-dialog=result][data-state=open]');
  await check(
    'document.querySelector("[data-dialog=result] [data-dialog-title]").textContent === "运行日志"',
  );
  await closeModal();
  await browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    '更多操作',
    '--exact',
  );
  await browser(
    'find',
    'role',
    'menuitem',
    'click',
    '--name',
    '最近任务',
    '--exact',
  );
  await browser('wait', '[data-dialog=result][data-state=open]');
  await check(
    'document.querySelector("[data-dialog=result] [data-dialog-title]").textContent === "任务详情" && document.querySelector("[data-output]").textContent.includes("面板设置") && !document.querySelector("[data-output]").textContent.includes("core.log")',
  );
  await closeModal();
  await browser(
    'eval',
    'window.mockTaskDelayMs = 300; window.mockTaskFailure = "配置校验失败"',
  );
  await browser('fill', '#ufi-control-port', '9292');
  await browser('click', '[data-action=save-controller]');
  await browser('wait', '--fn', 'mockDeviceState.task.state === "failed"');
  await idle();
  await check(
    'mockDeviceState.controller.port === 9191 && document.querySelector("#ufi-control-port").value === "9292"',
  );
  await page('managed-linux');
  await browser('click', '[data-settings] > summary');
  await check(
    'document.querySelector("[data-status]").textContent === "运行中" && document.body.innerText.includes("网络由系统管理")',
  );
  await check(
    'document.querySelector("[data-action=update-agent]").disabled && document.querySelector("[data-group=maintenance] [data-action=download]").disabled && document.querySelector("[data-boot]").disabled && document.querySelector("[data-setting=interfaces]").disabled',
  );
  console.log(
    'UI checks passed: task groups, setup, autosave, encrypted keys, controller apply/failure, independent runtime status and task/log details, reconnect.',
  );
} catch (error) {
  console.error(await browser('snapshot'));
  console.error(
    await browser(
      'eval',
      'JSON.stringify({state: mockDeviceState, intents: mockIntents, detail: document.querySelector("[data-output]")?.textContent})',
    ),
  );
  throw error;
} finally {
  await browser('close').catch(() => {});
  server.kill();
  await server.exited;
}
