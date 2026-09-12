// Requires agent-browser. Exercises the production artifact against the local UFI mock.
import assert from 'node:assert/strict';

const session = `ufi-ux-${Date.now()}`;
const server = Bun.spawn([process.execPath, 'tests/preview.ts'], {
  env: { ...process.env, UFI_PREVIEW_PORT: '0' }, stdout: 'pipe', stderr: 'inherit',
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
  const process = Bun.spawn(['agent-browser', '--session', session, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  assert.equal(code, 0, `${args.join(' ')}\n${out}\n${err}`);
  return out.trim();
}
const check = async (expression: string) => assert.equal(await browser('eval', expression), 'true', expression);
const idle = () => browser('wait', '--fn', '!document.querySelector(".mh-body").matches("[aria-busy=true]")');
async function page(state: string) {
  await browser('open', `${base}?state=${state}`);
  await browser('wait', '#ufi-mihomo > summary');
  await browser('click', '#ufi-mihomo > summary');
  await idle();
}
try {
  await page('ready');
  await browser('click', '[data-settings] > summary');
  await check('!!document.querySelector("[data-group=runtime] [data-boot]") && !document.querySelector("[data-group=subscription] [data-boot]")');
  await check('!!document.querySelector("[data-group=maintenance] [data-action=service-update]")');
  await browser('fill', '[data-setting=mirror]', 'https://ghfast.top/');
  await browser('eval', 'window.mockUploadDelayMs = 900');
  // The click itself blurs the input; it must survive the ensuing autosave render.
  await browser('find', 'role', 'button', 'click', '--name', '更新核心', '--exact');
  await browser('wait', '--text', '校验通过');
  await idle();
  await check('mockDeviceState.settings.mirror === "https://ghfast.top" && mockIntents.filter(x => x.action === "save-mirror").length === 1');

  await browser('fill', '[data-setting=mirror]', 'https://first.example');
  await browser('press', 'Tab');
  await browser('wait', '--fn', 'document.querySelector("[data-save-status=mirror]")?.textContent.includes("保存中")');
  await browser('fill', '[data-setting=mirror]', 'https://second.example');
  await browser('wait', '--fn', 'mockDeviceState.settings.mirror === "https://first.example"');
  await check('document.querySelector("[data-setting=mirror]").value === "https://second.example"');
  await browser('press', 'Tab');
  await browser('wait', '--fn', 'mockDeviceState.settings.mirror === "https://second.example"');

  await browser('eval', 'window.mockUploadDelayMs = 0; window.mockUploadFailure = true');
  await browser('fill', '[data-setting=mirror]', 'https://retry.example');
  await browser('press', 'Tab');
  await browser('wait', '--text', '重试保存');
  await check('mockDeviceState.settings.mirror === "https://second.example"');
  await browser('eval', 'window.mockUploadFailure = false');
  await browser('find', 'role', 'button', 'click', '--name', '重试保存', '--exact');
  await browser('wait', '--fn', 'mockDeviceState.settings.mirror === "https://retry.example"');
  await browser('fill', '[data-setting=mirror]', 'http://invalid.example');
  await browser('find', 'role', 'button', 'click', '--name', '更新核心', '--exact');
  await idle();
  await check('mockDeviceState.settings.mirror === "https://retry.example" && mockIntents.filter(x => x.action === "download").length === 1');

  await page('missing-service');
  await browser('fill', '[data-setting=mirror]', 'https://before-install.example');
  await browser('find', 'role', 'button', 'click', '--name', '安装', '--exact');
  await browser('wait', '--text', '服务已安装');
  await idle();
  await check('document.querySelector("[data-setting=mirror]").value === "https://before-install.example"');
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser('wait', '--text', '校验通过');
  await idle();
  await check('mockDeviceState.settings.mirror === "https://before-install.example"');
  await browser('fill', '[data-url]', 'https://example.com/subscription');
  await browser('find', 'role', 'button', 'click', '--name', '保存并更新', '--exact');
  await browser('wait', '--text', '配置已更新');
  await idle();
  await check('mockDeviceState.config && document.querySelector("[data-url]").value === ""');
  await check('mockCommands.every(c => !c.includes("https://example.com/subscription")) && mockUploads.every(u => !new TextDecoder().decode(u.bytes).includes("https://example.com/subscription"))');
  await browser('find', 'role', 'button', 'click', '--name', '启动代理', '--exact');
  await browser('wait', '--fn', 'mockDeviceState.running');
  await idle();
  await browser('click', '[data-boot]');
  await browser('wait', '--fn', 'mockDeviceState.boot');
  await browser('find', 'role', 'button', 'click', '--name', '更多操作', '--exact');
  await browser('find', 'role', 'menuitem', 'click', '--name', '查看日志', '--exact');
  await browser('wait', '[data-result][open]');
  await browser('find', 'role', 'button', 'click', '--name', '关闭详情', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '卸载', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '取消', '--exact');
  await check('!mockIntents.some(x => x.action === "uninstall")');
  await browser('find', 'role', 'button', 'click', '--name', '卸载', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '卸载并备份', '--exact');
  await browser('wait', '--fn', '!mockDeviceState.service');
  await idle();
  await check('!mockDeviceState.running && !mockDeviceState.boot');
  assert.equal(await browser('errors'), '');
  await page('missing-core');
  await browser('eval', 'window.mockTaskFailure = "F50 TLS 握手失败：api.github.com"; window.mockTaskDelayMs = 9000');
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await browser('reload');
  await browser('wait', '#ufi-mihomo > summary');
  await browser('click', '#ufi-mihomo > summary');
  await browser('wait', '--fn', 'mockDeviceState.task?.state === "failed"');
  await browser('click', '[data-task]');
  await browser('wait', '[data-result][open]');
  await check('document.querySelector("[data-output]").textContent.includes("F50 TLS")');
  await check('mockIntents.length === 0 && mockRequests.every(u => new URL(u, location.href).origin === location.origin)');
  await browser('find', 'role', 'button', 'click', '--name', '关闭详情', '--exact');
  await browser('eval', 'window.mockTaskFailure = ""; window.mockTaskDelayMs = 8000');
  await browser('click', '[data-group=maintenance] [data-action=download]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await browser('reload');
  await browser('wait', '#ufi-mihomo > summary');
  await browser('click', '#ufi-mihomo > summary');
  await browser('wait', '--fn', 'mockDeviceState.core && mockDeviceState.task?.state === "succeeded"');
  await check('mockIntents.length === 0 && document.querySelector("[data-task]").textContent.includes("校验通过")');
  await page('running');
  await browser('click', '[data-settings] > summary');
  await check('document.querySelector("[data-dashboard-link]").href.includes(":9090/ui/")');
  await browser('fill', '#ufi-control-port', '9191');
  await browser('fill', '#ufi-control-secret', 'short');
  await browser('eval', 'window.mockTaskDelayMs = 5000');
  await browser('click', '[data-action=save-controller]');
  await browser('wait', '--fn', 'mockDeviceState.locked');
  await check('document.querySelector("[data-status]").textContent === "运行中" && mockDeviceState.controller.port === 9090');
  await browser('wait', '--fn', 'mockDeviceState.controller.port === 9191');
  await idle();
  await check('document.querySelector("[data-dashboard-link]").href.includes(":9191/ui/") && !document.querySelector("[data-dashboard-link]").href.includes("secret")');
  await browser('find', 'role', 'button', 'click', '--name', '查看当前密钥', '--exact');
  await browser('wait', '[data-secret-dialog][open]');
  await check('document.querySelector("[data-secret-dialog] input").value === "short" && mockCommands.every(c => !c.includes(JSON.stringify({secret: "short"})))');
  await browser('find', 'role', 'button', 'click', '--name', '关闭密钥', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '更多操作', '--exact');
  await browser('find', 'role', 'menuitem', 'click', '--name', '查看日志', '--exact');
  await browser('wait', '[data-result][open]');
  await check('document.querySelector("#ufi-detail-title").textContent === "运行日志"');
  await browser('find', 'role', 'button', 'click', '--name', '关闭详情', '--exact');
  await browser('click', '[data-task]');
  await browser('wait', '[data-result][open]');
  await check('document.querySelector("#ufi-detail-title").textContent === "任务详情" && document.querySelector("[data-output]").textContent.includes("面板设置") && !document.querySelector("[data-output]").textContent.includes("core.log")');
  await browser('find', 'role', 'button', 'click', '--name', '关闭详情', '--exact');
  await browser('eval', 'window.mockTaskDelayMs = 300; window.mockTaskFailure = "配置校验失败"');
  await browser('fill', '#ufi-control-port', '9292');
  await browser('click', '[data-action=save-controller]');
  await browser('wait', '--fn', 'mockDeviceState.task.state === "failed"');
  await idle();
  await check('mockDeviceState.controller.port === 9191 && document.querySelector("#ufi-control-port").value === "9292"');
  console.log('UI checks passed: task groups, setup, autosave, encrypted keys, controller apply/failure, independent runtime status and task/log details, reconnect.');
} catch (error) {
  console.error(await browser('snapshot'));
  console.error(await browser('eval', 'JSON.stringify({state: mockDeviceState, intents: mockIntents, detail: document.querySelector("[data-output]")?.textContent})'));
  throw error;
} finally {
  await browser('close').catch(() => {});
  server.kill();
  await server.exited;
}
