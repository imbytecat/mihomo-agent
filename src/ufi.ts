import { RELEASE_API, selectRelease } from './release';
import { emptyState, parseState } from './state';

declare const runShellWithRoot: (
  command: string, timeout?: number,
) => Promise<{ success: boolean; content?: string }>;
declare const KANO_baseURL: string;
declare const common_headers: HeadersInit;

export const DIR = '/data/ufi-mihomo';
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function shellCommand(command: string, marker: string) {
  // A child shell keeps `exit` and `set -e` away from UFI's persistent root shell.
  return `sh -c ${quote(command)}; printf '\\n${marker}%s\\n' "$?"`;
}

export function shellResult(content: string, marker: string) {
  const match = content.match(new RegExp(`\\n${marker}(\\d+)\\s*$`));
  if (!match) throw new Error('UFI 未返回命令退出码，请刷新状态后重试');
  const output = content.slice(0, match.index).trim();
  if (match[1] !== '0') throw new Error(output || `命令失败 (${match[1]})`);
  return output;
}

export async function shell(command: string, timeout = 30_000) {
  const marker = `UFI_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
  const result = await runShellWithRoot(shellCommand(command, marker), timeout);
  if (!result.success) throw new Error(result.content || 'UFI Root 接口不可用');
  return shellResult(result.content || '', marker);
}

export const service = (action: string, timeout?: number) =>
  shell(`sh ${DIR}/service.sh ${quote(action)}`, timeout);

export async function readDeviceState() {
  return parseState(await shell(`
    [ "$(id -u)" = 0 ] || { echo '请先开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] || { echo '安装目录异常，已暂停操作'; exit 1; }
    if [ -f ${DIR}/service.sh ] && [ -f ${DIR}/network.sh ]; then
      exec sh ${DIR}/service.sh inspect
    fi
    [ ! -e ${DIR} ] || { echo '安装文件不完整，已暂停操作，请检查设备安装目录'; exit 1; }
    printf '%s' ${quote(JSON.stringify(emptyState))}
  `));
}

export async function installOfficial(progress: (message: string) => void) {
  progress('正在查询官方最新稳定版…');
  const abi = await shell('getprop ro.product.cpu.abi');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let release;
  try {
    // Browser fetch: never send UFI authentication headers to GitHub.
    const response = await fetch(RELEASE_API, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`查询官方最新版本失败 (${response.status})，请稍后重试`);
    release = selectRelease(await response.json(), abi);
  } finally {
    clearTimeout(timer);
  }
  await upload('core-release', release.manifest);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resultPath = `${DIR}/install-${id}.result`;
  const job = `sh ${DIR}/service.sh install-official > ${DIR}/install.log 2>&1; code=$?; printf '%s' "$code" > ${resultPath}`;
  await shell(`nohup sh -c ${quote(job)} </dev/null >/dev/null 2>&1 &`);
  for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const result = await shell(`if [ -f ${resultPath} ]; then cat ${resultPath}; else echo pending; fi`);
    if (result !== 'pending') {
      await shell(`rm -f ${resultPath}`);
      if (result !== '0') throw new Error('官方核心安装失败，原核心保留。请查看日志');
      return `核心 ${release.version} 已安装，校验通过`;
    }
    progress(`下载核心 ${release.version} · ${Math.round((i + 1) * 1.5)} 秒`);
  }
  throw new Error('等待安装超时，请刷新状态并查看日志，勿重复安装');
}

export async function upload(name: string, data: string | File) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name)) throw new Error('无效文件名');
  const body = new FormData();
  body.append('file', typeof data === 'string'
    ? new File([data], name, { type: 'application/octet-stream' }) : data);
  const response = await fetch(`${KANO_baseURL}/upload_img`, {
    method: 'POST', headers: common_headers, body,
  });
  const result = await response.json();
  if (!response.ok || typeof result.url !== 'string'
    || !/^\/?uploads\/[a-zA-Z0-9_.-]+$/.test(result.url)
    || result.url.split('/').includes('..')) {
    throw new Error('上传失败或 UFI 返回了无效路径');
  }
  const source = `/data/data/com.minikano.f50_sms/files/${result.url.replace(/^\//, '')}`;
  const temporary = `${DIR}/${name}.upload`;
  const cleanup = `rm -f ${quote(source)} ${quote(temporary)}`;
  await shell(`set -e; umask 077; trap ${quote(cleanup)} EXIT; mkdir -p ${DIR}; chmod 700 ${DIR}; cp ${quote(source)} ${quote(temporary)}; chmod 600 ${quote(temporary)}; mv ${quote(temporary)} ${DIR}/${name}`);
}

export async function readDownload() {
  const name = `ufi-mihomo-${Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')}.yaml`;
  const path = `/data/data/com.minikano.f50_sms/files/uploads/${name}`;
  try {
    // UFI logs shell output. Transfer YAML as a file so credentials don't enter that log.
    await shell(`set -e; cp ${DIR}/download.yaml ${quote(path)}; chmod 644 ${quote(path)}`);
    const response = await fetch(`${KANO_baseURL}/uploads/${name}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取下载的订阅');
    return await response.text();
  } finally {
    await shell(`rm -f ${quote(path)}`);
  }
}
