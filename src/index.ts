import { adaptConfig, curlConfig, downloadMirror, interfaces } from './config';
import { DIR, installOfficial, readDownload, service, shell, upload } from './ufi';

declare const __SERVICE__: string;
declare const __NETWORK__: string;

function mount() {
  const anchor = document.querySelector('.functions-container');
  if (!anchor || document.getElementById('ufi-mihomo')) return;
  const panel = document.createElement('details');
  panel.id = 'ufi-mihomo';
  panel.style.cssText = 'margin:12px 0;padding:12px;border:1px solid #8886;border-radius:10px';
  panel.innerHTML = `
    <summary style="cursor:pointer;font-weight:600">Mihomo 网关</summary>
    <p data-status role="status" style="white-space:pre-wrap">展开后刷新状态</p>
    <label style="display:block;margin:10px 0">完整配置订阅
      <input data-url type="password" autocomplete="off" placeholder="已保存的链接无需重复填写" style="display:block;width:100%;box-sizing:border-box;margin-top:6px">
    </label>
    <label style="display:block;margin:10px 0">核心下载镜像（可选）
      <input data-mirror type="url" placeholder="留空直连 GitHub；或 https://你的下载代理/" style="display:block;width:100%;box-sizing:border-box;margin-top:6px">
    </label>
    <label style="display:block;margin:10px 0">热点 / USB 接口
      <input data-lan type="text" placeholder="例如 wlan0 rndis0；检测后确认" style="display:block;width:100%;box-sizing:border-box;margin-top:6px">
    </label>
    <div data-actions style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0"></div>
    <p style="font-size:12px">只接管所填接口的 IPv4，阻断这些接口的 IPv6 转发。首次使用：安装服务 → 安装官方核心 → 保存设置 → 更新订阅 → 启动。先停止旧猫猫并关闭其自启。下载镜像只用于核心，不接收订阅。</p>
    <pre data-output role="status" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-size:12px"></pre>
  `;
  anchor.after(panel);
  const status = panel.querySelector<HTMLElement>('[data-status]')!;
  const output = panel.querySelector<HTMLElement>('[data-output]')!;
  const url = panel.querySelector<HTMLInputElement>('[data-url]')!;
  const lan = panel.querySelector<HTMLInputElement>('[data-lan]')!;
  const mirror = panel.querySelector<HTMLInputElement>('[data-mirror]')!;
  const actions = panel.querySelector<HTMLElement>('[data-actions]')!;
  let busy = false;

  async function refresh() {
    status.textContent = await shell(`[ ! -f ${DIR}/service.sh ] || exec sh ${DIR}/service.sh status; echo '尚未安装服务'`);
    if (!lan.value) lan.value = await shell(`[ ! -f ${DIR}/interfaces ] || cat ${DIR}/interfaces`);
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    panel.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = true);
    output.textContent = '执行中…';
    try {
      output.textContent = String(await action() || '完成');
      await refresh();
    } catch (error) {
      output.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      panel.querySelectorAll('button, input').forEach(el => (el as HTMLButtonElement).disabled = false);
    }
  }
  function button(label: string, action: () => Promise<unknown>) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => void run(action));
    actions.append(button);
  }
  button('安装 / 更新服务', async () => {
    if (await shell('id -u') !== '0') throw new Error('请先开启 UFI 高级功能');
    await shell(`[ ! -f ${DIR}/service.sh ] || sh ${DIR}/service.sh stop` , 95_000);
    await upload('network.sh', __NETWORK__);
    await upload('service.sh', __SERVICE__);
    return '服务已安装；更新服务后请手动启动';
  });
  button('检测接口', async () => {
    return await shell('ip -o -4 addr show; ip -4 rule show; ip -4 route show; getprop ro.product.cpu.abi')
      + '\n请将热点/USB 对应的 LAN 接口填入上方，勿填写蜂窝出口。';
  });
  button('安装最新官方核心', async () => {
    if (!(await service('status')).startsWith('已停止')) throw new Error('请先停止服务');
    await upload('core-mirror', downloadMirror(mirror.value) + '\n');
    return installOfficial(message => { output.textContent = message; });
  });
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
  actions.append(coreButton);
  button('复用旧核心', async () => {
    const state = await service('status');
    if (!state.startsWith('已停止')) throw new Error('请先停止服务');
    await shell(`cp /data/clash/Proxy/Clash.Core ${DIR}/mihomo.next`);
    return service('core', 95_000);
  });
  button('更新订阅', async () => {
    await service('fetch', 95_000);
    const source = await readDownload();
    await upload('candidate.yaml', adaptConfig(source));
    return service('apply', 95_000);
  });
  for (const [label, action] of [
    ['启动', 'start'], ['停止', 'stop'], ['重启', 'restart'],
    ['开启自启', 'boot-on'], ['关闭自启', 'boot-off'], ['日志', 'logs'],
  ]) button(label!, () => service(action!, 95_000));
  button('刷新状态', refresh);
  panel.addEventListener('toggle', () => {
    if (panel.open && !busy) void run(refresh);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
