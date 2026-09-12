import { RELEASE_API, selectRelease } from './release';
import { emptyState, parseState } from './state';
import { request, requestFailure, responseJSON, transportFailure } from './request';

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

export async function shell(command: string, timeout = 30_000, step = '执行设备命令') {
  const marker = `UFI_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
  const context = { step, target: 'F50 /api/root_shell', hint: '确认仍连接 F50，UFI 页面可访问且已登录、已开启高级功能。' };
  let result;
  try { result = await runShellWithRoot(shellCommand(command, marker), timeout); }
  catch (error) { throw transportFailure(context, error); }
  if (!result.success) throw requestFailure(context, result.content || 'UFI Root 接口不可用');
  return shellResult(result.content || '', marker);
}

export const service = (action: string, timeout?: number) =>
  shell(`sh ${DIR}/service.sh ${quote(action)}`, timeout, `设备操作 ${action}`);

export async function readDeviceState() {
  return parseState(await shell(`
    [ "$(id -u)" = 0 ] || { echo '请先开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] || { echo '安装目录异常，已暂停操作'; exit 1; }
    if [ -f ${DIR}/service.sh ] && [ -f ${DIR}/network.sh ]; then
      exec sh ${DIR}/service.sh inspect
    fi
    [ ! -e ${DIR} ] || { echo '安装文件不完整，已暂停操作，请检查设备安装目录'; exit 1; }
    printf '%s' ${quote(JSON.stringify(emptyState))}
  `, 30_000, '读取设备状态'));
}

export async function installOfficial(progress: (message: string) => void) {
  progress('正在检查设备…');
  const abi = await shell('getprop ro.product.cpu.abi', 30_000, '读取设备架构');
  progress('正在查询官方最新稳定版…');
  const context = {
    step: '查询最新版本', target: `管理浏览器 GET ${RELEASE_API}`,
    hint: '在同一浏览器打开上述地址检查访问情况。下载镜像仅用于核心文件，不代理此版本查询；此时核心下载尚未开始。',
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let release;
  try {
    // Browser fetch: never send UFI authentication headers to GitHub.
    const response = await request(RELEASE_API, { cache: 'no-store', signal: controller.signal }, context);
    const metadata = await responseJSON(response, context);
    try { release = selectRelease(metadata, abi); }
    catch (error) { throw requestFailure({ ...context, step: '解析官方版本' }, `${error instanceof Error ? error.message : String(error)}\n设备架构：${abi}`); }
  } finally {
    clearTimeout(timer);
  }
  progress(`准备安装 ${release.version}…`);
  await upload('core-release', release.manifest);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const resultPath = `${DIR}/install-${id}.result`;
  const job = `sh ${DIR}/service.sh install-official > ${DIR}/install.log 2>&1; code=$?; printf '%s' "$code" > ${resultPath}`;
  try { await shell(`nohup sh -c ${quote(job)} </dev/null >/dev/null 2>&1 &`, 30_000, '启动核心下载任务'); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n任务是否启动尚不确定，请恢复连接后刷新状态，勿重复安装。`); }
  for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    let result;
    try { result = await shell(`if [ -f ${resultPath} ]; then cat ${resultPath}; else echo pending; fi`, 30_000, '读取核心下载进度'); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n任务可能仍在 F50 上运行，请恢复连接后刷新状态，勿重复安装。`); }
    if (result !== 'pending') {
      await shell(`rm -f ${resultPath}`).catch(() => {});
      if (result !== '0') {
        let log;
        try {
          log = await shell(`tail -n 25 ${DIR}/install.log | awk '{ gsub(/https?:\\/\\/[^[:space:]"<>]+/, "[URL hidden]"); if (tolower($0) ~ /(password|secret|token|authorization)[[:space:]"=:]/) print "[sensitive log line hidden]"; else print }'`, 10_000, '读取安装日志');
        } catch (error) { log = error instanceof Error ? error.message : String(error); }
        throw new Error(`核心安装失败\n执行位置：F50\n退出码：${result}\n安装日志：\n${log || '日志为空'}\n请根据日志检查下载镜像、设备联网、存储空间或校验错误。`);
      }
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
  const context = { step: '上传到 F50', target: `POST /api/upload_img（${name}）`, hint: '检查与 F50 的连接和 UFI 登录状态；这是设备上传接口，不是 GitHub 下载源。' };
  const response = await request(`${KANO_baseURL}/upload_img`, {
    method: 'POST', headers: common_headers, body,
  }, context);
  const result = await responseJSON(response, context) as { url?: unknown } | null;
  if (!result || typeof result.url !== 'string'
    || !/^\/?uploads\/[a-zA-Z0-9_.-]+$/.test(result.url)
    || result.url.split('/').includes('..')) {
    throw requestFailure(context, 'UFI 返回的文件路径无效');
  }
  const source = `/data/data/com.minikano.f50_sms/files/${result.url.replace(/^\//, '')}`;
  const temporary = `${DIR}/${name}.upload`;
  const cleanup = `rm -f ${quote(source)} ${quote(temporary)}`;
  await shell(`set -e; umask 077; trap ${quote(cleanup)} EXIT; mkdir -p ${DIR}; chmod 700 ${DIR}; cp ${quote(source)} ${quote(temporary)}; chmod 600 ${quote(temporary)}; mv ${quote(temporary)} ${DIR}/${name}`, 30_000, `保存设备文件 ${name}`);
}

export async function readDownload() {
  const name = `ufi-mihomo-${Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('')}.yaml`;
  const path = `/data/data/com.minikano.f50_sms/files/uploads/${name}`;
  let primaryError: Error | undefined;
  try {
    // UFI logs shell output. Transfer YAML as a file so credentials don't enter that log.
    await shell(`set -e; cp ${DIR}/download.yaml ${quote(path)}; chmod 644 ${quote(path)}`);
    const context = {
      step: '读取订阅文件', target: 'F50 /api/uploads/[临时文件]', hint: '检查设备连接和文件读取权限；此步骤发生在订阅下载之后。',
    };
    const response = await request(`${KANO_baseURL}/uploads/${name}`, { cache: 'no-store' }, context);
    try { return await response.text(); } catch (error) { throw transportFailure(context, error); }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw primaryError;
  } finally {
    try { await shell(`rm -f ${quote(path)}`, 30_000, '清理临时订阅文件'); }
    catch (error) {
      if (!primaryError) throw error;
      primaryError.message += `\n临时文件清理也失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
