import { adaptConfig, curlConfig, downloadMirror, interfaces } from './config';
import { DIR, installOfficial, readDownload, service, shell, upload } from './ufi';

declare const __SERVICE__: string;
declare const __NETWORK__: string;
declare const __STYLE__: string;

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor || document.getElementById('ufi-mihomo')) return;
  const style = document.createElement('style');
  style.textContent = __STYLE__;
  document.head.append(style);
  const panel = document.createElement('details');
  panel.id = 'ufi-mihomo';
  panel.innerHTML = `
    <summary class="ufi-flex ufi-items-center ufi-gap-3 ufi-p-5">
      <span class="ufi-flex ufi-h-10 ufi-w-10 ufi-items-center ufi-justify-center ufi-rounded-xl ufi-bg-teal-500/15 ufi-text-teal-400" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z"/><path d="m8 12 3 3 5-6"/></svg>
      </span>
      <span class="ufi-flex ufi-flex-col ufi-gap-0.5"><strong class="ufi-text-base ufi-font-semibold">Mihomo 网关</strong><span class="ufi-text-xs ufi-opacity-60">随身连接，安静代理</span></span>
      <span data-dot class="ufi-ml-2 ufi-h-2 ufi-w-2 ufi-rounded-full" aria-hidden="true"></span>
    </summary>
    <div class="ufi-space-y-5 ufi-px-5 ufi-pb-5">
      <div class="ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3">
        <p data-status role="status" class="ufi-whitespace-pre-wrap ufi-break-words ufi-text-xs ufi-leading-relaxed ufi-opacity-80">展开后刷新状态</p>
      </div>
      <label class="ufi-block ufi-text-sm ufi-font-medium">配置订阅
        <input data-url type="password" autocomplete="off" placeholder="粘贴完整配置链接；已保存则留空">
      </label>
      <div data-actions class="ufi-grid ufi-grid-cols-2 ufi-gap-2 sm:ufi-grid-cols-3"></div>
      <p class="ufi-text-xs ufi-leading-relaxed ufi-opacity-60">自动识别热点和 USB 共享网络。IPv4 走代理，共享网络 IPv6 被阻断。</p>
      <details data-setup class="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary class="ufi-flex ufi-items-center ufi-p-3 ufi-text-sm ufi-font-medium">安装与更新</summary>
        <div class="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <p class="ufi-text-xs ufi-leading-relaxed ufi-opacity-60">首次使用：安装服务 → 安装核心 → 保存订阅 → 更新订阅 → 启动。请先停止旧代理插件并关闭其自启。</p>
          <label class="ufi-block ufi-text-xs">核心下载镜像（可选）
            <input data-mirror type="url" placeholder="留空直连 GitHub；或 HTTPS 代理前缀">
          </label>
          <p class="ufi-text-xs ufi-opacity-60">镜像只接收核心下载请求，不接收订阅链接。</p>
          <div data-install class="ufi-grid ufi-grid-cols-1 ufi-gap-2 sm:ufi-grid-cols-2"></div>
        </div>
      </details>
      <details data-advanced class="ufi-rounded-xl ufi-border ufi-border-solid ufi-border-slate-500/20">
        <summary class="ufi-flex ufi-items-center ufi-p-3 ufi-text-sm ufi-font-medium">高级设置</summary>
        <div class="ufi-space-y-3 ufi-px-3 ufi-pb-3">
          <label class="ufi-block ufi-text-xs">手动指定共享入口（可选）
            <input data-lan type="text" placeholder="留空自动识别；仅识别异常时填写">
          </label>
          <p class="ufi-text-xs ufi-opacity-60">修改后点击「保存设置」。通常无需填写。</p>
          <div data-diagnostics class="ufi-grid ufi-grid-cols-2 ufi-gap-2"></div>
        </div>
      </details>
      <pre data-output role="status" class="ufi-max-h-64 ufi-overflow-auto ufi-whitespace-pre-wrap ufi-break-words ufi-rounded-xl ufi-bg-slate-500/10 ufi-p-3 ufi-text-xs ufi-leading-relaxed"></pre>
    </div>
  `;
  anchor.after(panel);
  const status = panel.querySelector<HTMLElement>('[data-status]')!;
  const output = panel.querySelector<HTMLElement>('[data-output]')!;
  const url = panel.querySelector<HTMLInputElement>('[data-url]')!;
  const lan = panel.querySelector<HTMLInputElement>('[data-lan]')!;
  const mirror = panel.querySelector<HTMLInputElement>('[data-mirror]')!;
  const actions = panel.querySelector<HTMLElement>('[data-actions]')!;
  const install = panel.querySelector<HTMLElement>('[data-install]')!;
  const diagnostics = panel.querySelector<HTMLElement>('[data-diagnostics]')!;
  let busy = false;
  let settingsLoaded = false;

  async function refresh() {
    status.textContent = await shell(`[ ! -f ${DIR}/service.sh ] || exec sh ${DIR}/service.sh status; echo '尚未安装服务'`);
    panel.querySelector<HTMLElement>('[data-dot]')!.dataset.state = status.textContent.startsWith('运行中') ? 'running'
      : /等待|恢复/.test(status.textContent) ? 'waiting' : 'stopped';
    if (!settingsLoaded) {
      const saved = await shell(`[ ! -f ${DIR}/interfaces ] || cat ${DIR}/interfaces`);
      lan.value = saved === 'auto' ? '' : saved;
      settingsLoaded = true;
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    panel.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = true);
    output.textContent = '执行中…';
    output.dataset.error = 'false';
    try {
      output.textContent = String(await action() || '完成');
      await refresh();
    } catch (error) {
      output.dataset.error = 'true';
      output.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      panel.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);
    }
  }
  function button(label: string, action: () => Promise<unknown>, container = actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (label === '启动') button.dataset.primary = '';
    button.addEventListener('click', () => void run(action));
    container.append(button);
  }
  button('安装 / 更新服务', async () => {
    if (await shell('id -u') !== '0') throw new Error('请先开启 UFI 高级功能');
    await shell(`[ ! -f ${DIR}/service.sh ] || sh ${DIR}/service.sh stop` , 95_000);
    await upload('network.sh', __NETWORK__);
    await upload('service.sh', __SERVICE__);
    return '服务已安装；更新服务后请手动启动';
  }, install);
  button('网络诊断', () => shell('ip -o -4 addr show; ip -4 rule show; ip -4 route show table all; ip -6 route show table all; getprop ro.product.cpu.abi'), diagnostics);
  button('安装最新官方核心', async () => {
    if (!(await service('status')).startsWith('已停止')) throw new Error('请先停止服务');
    await upload('core-mirror', downloadMirror(mirror.value) + '\n');
    return installOfficial(message => { output.textContent = message; });
  }, install);
  button('保存设置', async () => {
    const names = interfaces(lan.value);
    const subscription = url.value.trim() ? curlConfig(url.value.trim()) : null;
    const state = await service('status');
    if (!state.startsWith('已停止')) throw new Error('修改设置前请先停止服务');
    await upload('interfaces', names + '\n');
    if (subscription) {
      await upload('subscription.curl', subscription);
      url.value = '';
    }
    return '设置已保存到设备';
  });
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.hidden = true;
  panel.append(picker);
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    void run(async () => {
      const state = await service('status');
      if (!state.startsWith('已停止')) throw new Error('请先停止服务');
      if (file.size > 160 * 1024 * 1024) throw new Error('文件超过 160 MiB');
      const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
        await upload('mihomo.next', file);
        return service('core', 95_000);
      }
      if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
        await upload('bundle.zip', file);
        return service('import-zip', 95_000);
      }
      throw new Error('选择 mihomo ELF 核心或原插件 mihomo-tproxy.zip');
    });
  });
  const coreButton = document.createElement('button');
  coreButton.type = 'button';
  coreButton.textContent = '导入核心 / ZIP';
  coreButton.onclick = () => picker.click();
  install.append(coreButton);
  button('复用旧核心', async () => {
    const state = await service('status');
    if (!state.startsWith('已停止')) throw new Error('请先停止服务');
    await shell(`cp /data/clash/Proxy/Clash.Core ${DIR}/mihomo.next`);
    return service('core', 95_000);
  }, install);
  button('更新订阅', async () => {
    await service('fetch', 95_000);
    const source = await readDownload();
    await upload('candidate.yaml', adaptConfig(source));
    return service('apply', 95_000);
  });
  for (const [label, action] of [
    ['启动', 'start'], ['停止', 'stop'], ['日志', 'logs'],
  ]) button(label!, () => service(action!, 95_000));
  for (const [label, action] of [['重启', 'restart'], ['开启自启', 'boot-on'], ['关闭自启', 'boot-off']]) {
    button(label!, () => service(action!, 95_000), diagnostics);
  }
  button('刷新状态', refresh);
  panel.addEventListener('toggle', () => {
    if (panel.open && !busy) void run(refresh);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
