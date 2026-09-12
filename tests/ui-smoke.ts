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
  await browser('fill', '[data-setting=mirror]', 'https://ghfast.top/');
  await browser('eval', 'window.mockUploadDelayMs = 900');
  // The click itself blurs the input; it must survive the ensuing autosave render.
  await browser('find', 'role', 'button', 'click', '--name', '更新核心', '--exact');
  await browser('wait', '--text', '校验通过');
  await check('mockStored.mirror === "https://ghfast.top" && mockUploads.filter(x => x.name === "core-mirror").length === 1');

  await browser('fill', '[data-setting=mirror]', 'https://first.example');
  await browser('press', 'Tab');
  await browser('wait', '--fn', 'document.querySelector("[data-save-status=mirror]")?.textContent.includes("保存中")');
  await browser('fill', '[data-setting=mirror]', 'https://second.example');
  await browser('wait', '--fn', 'mockStored.mirror === "https://first.example"');
  await check('document.querySelector("[data-setting=mirror]").value === "https://second.example"');
  await browser('press', 'Tab');
  await browser('wait', '--fn', 'mockStored.mirror === "https://second.example"');

  await browser('eval', 'window.mockUploadDelayMs = 0; window.mockUploadFailure = true');
  await browser('fill', '[data-setting=mirror]', 'https://retry.example');
  await browser('press', 'Tab');
  await browser('wait', '--text', '重试保存');
  await check('mockStored.mirror === "https://second.example"');
  await browser('eval', 'window.mockUploadFailure = false');
  await browser('find', 'role', 'button', 'click', '--name', '重试保存', '--exact');
  await browser('wait', '--fn', 'mockStored.mirror === "https://retry.example"');
  await browser('fill', '[data-setting=mirror]', 'http://invalid.example');
  await browser('find', 'role', 'button', 'click', '--name', '更新核心', '--exact');
  await idle();
  await check('mockStored.mirror === "https://retry.example" && mockCommands.filter(c => c.includes("install-official")).length === 1');

  await page('missing-service');
  await browser('fill', '[data-setting=mirror]', 'https://before-install.example');
  await browser('find', 'role', 'button', 'click', '--name', '安装', '--exact');
  await browser('wait', '--text', '服务已安装');
  await check('document.querySelector("[data-setting=mirror]").value === "https://before-install.example"');
  await browser('find', 'role', 'button', 'click', '--name', '下载核心', '--exact');
  await browser('wait', '--text', '校验通过');
  await check('mockStored.mirror === "https://before-install.example"');
  await browser('fill', '[data-url]', 'https://example.com/subscription');
  await browser('find', 'role', 'button', 'click', '--name', '保存并更新', '--exact');
  await browser('wait', '--text', '配置已更新');
  await check('mockDeviceState.config && document.querySelector("[data-url]").value === ""');
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
  await check('!mockCommands.some(c => c.includes("uninstall"))');
  await browser('find', 'role', 'button', 'click', '--name', '卸载', '--exact');
  await browser('find', 'role', 'button', 'click', '--name', '卸载并备份', '--exact');
  await browser('wait', '--fn', '!mockDeviceState.service');
  await idle();
  await check('!mockDeviceState.running && !mockDeviceState.boot');
  assert.equal(await browser('errors'), '');
  console.log('UI checks passed: autosave ordering, newer edits, retry, setup, subscription, controls, and uninstall.');
} finally {
  await browser('close').catch(() => {});
  server.kill();
  await server.exited;
}
