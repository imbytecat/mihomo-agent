import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import manifest from '../backend-release.json';
import bootstrapScript from './bootstrap.sh?raw';
import { emptyState, parseState, parseJob, type DeviceJob, type TaskAction } from './state';
import { request, requestFailure, responseJSON, transportFailure } from './request';

declare const runShellWithRoot: (command: string, timeout?: number) => Promise<{ success: boolean; content?: string }>;
declare const KANO_baseURL: string;
declare const common_headers: HeadersInit;
export const DIR = '/data/ufi-mihomo';
const AGENT = DIR + '/agent';
const BOOT = '/data/ufi-mihomo-bootstrap';
export const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function shellCommand(command: string, marker: string) {
  return `sh -c ${quote(command)}; printf '\\n${marker}%s\\n' "$?"`;
}
export function shellResult(content: string, marker: string) {
  const match = content.match(new RegExp(`\\n${marker}(\\d+)\\s*$`));
  if (!match) throw new Error('设备未返回完整响应');
  const output = content.slice(0, match.index).trim();
  if (match[1] !== '0') {
    try { const value = JSON.parse(output); if (typeof value.error === 'string') throw new Error(value.error); }
    catch (error) { if (error instanceof Error && !(error instanceof SyntaxError)) throw error; }
    throw new Error(output || `命令失败 (${match[1]})`);
  }
  return output;
}
export async function shell(command: string, timeout = 30_000) {
  const marker = `UFI_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
  const context = { step: '连接设备', target: 'F50 /api/root_shell', hint: '检查 F50 连接、UFI 登录和高级功能。任务可能仍在设备上运行，恢复连接后刷新状态。' };
  let result;
  try { result = await runShellWithRoot(shellCommand(command, marker), timeout); }
  catch (error) { throw transportFailure(context, error); }
  if (!result.success) throw requestFailure(context, result.content || 'Root 接口不可用');
  return shellResult(result.content || '', marker);
}
async function agent(args: string[]) {
  const result = await shell([quote(AGENT), ...args.map(quote)].join(' '));
  return JSON.parse(result) as unknown;
}
export const phases: Record<string, string> = {
  accepted: '任务已接收', preparing: '准备中', release: '查询官方版本', download: '下载中',
  verify: '校验文件', installing: '安装中', subscription: '下载订阅', validate: '校验配置',
  applying: '应用配置', rollback: '恢复上一配置', saving: '保存设置', starting: '启动代理',
  adapt: '适配配置',
  stopping: '停止代理', done: '已完成', interrupted: '任务已中断', failed: '任务失败',
};
export async function readDeviceState() {
  const output = await shell(`
    [ "$(id -u)" = 0 ] || { echo '请开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] || { echo '设备目录异常'; exit 1; }
    if [ -x ${AGENT} ]; then exec ${AGENT} inspect; fi
    printf null
  `);
  const task = await readBootstrap();
  if (output !== 'null') {
    const state = parseState(output);
    if (task && (!state.task || ['queued', 'running'].includes(task.state) || Date.parse(task.updated) > Date.parse(state.task.updated))) {
      state.task = task;
      state.locked ||= ['queued', 'running'].includes(task.state);
    }
    return state;
  }
  return { ...emptyState, task, locked: !!task && ['queued', 'running'].includes(task.state) };
}
async function uploadBytes(bytes: Uint8Array) {
  const body = new FormData();
  body.append('file', new File([new Uint8Array(bytes)], 'request.bin', { type: 'application/octet-stream' }));
  const context = { step: '上传设备请求', target: 'F50 /api/upload_img', hint: '检查设备连接和 UFI 登录状态。' };
  const response = await request(`${KANO_baseURL}/upload_img`, { method: 'POST', headers: common_headers, body }, context);
  const result = await responseJSON(response, context) as { url?: unknown } | null;
  const name = typeof result?.url === 'string' ? result.url.replace(/^\/?uploads\//, '') : '';
  if (!/^[a-fA-F0-9-]{36}\.bin$/.test(name)) throw requestFailure(context, '设备返回了无效的上传路径');
  return name;
}
export async function sealRequest(publicKey: string, value: object) {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  if (key.length !== 32) throw new Error('设备公钥无效');
  const bytes = sodium.crypto_box_seal(sodium.from_string(JSON.stringify(value)), key);
  return { bytes, hash: bytesToHex(sha256(bytes)) };
}
export function taskID() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); }

export async function submitTask(action: TaskAction, value = '') {
  const state = await readDeviceState();
  if (!state.agent || !state.publicKey) throw new Error('请先安装设备后端');
  const id = taskID();
  const sealed = await sealRequest(state.publicKey, { id, action, value });
  const name = await uploadBytes(sealed.bytes);
  try { return parseJob(await agent(['submit', name, sealed.hash])); }
  catch (error) {
    try { return parseJob(await agent(['job', id])); } catch {}
    throw new Error(`任务提交结果未确认\n任务 ID：${id}\n${error instanceof Error ? error.message : String(error)}\n恢复连接后刷新状态，勿连续重复提交。`);
  }
}
export async function readJob(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('无效任务 ID');
  return parseJob(await agent(['job', id]));
}
export async function jobLog(job: DeviceJob) {
  if (job.action === 'bootstrap') return shell(`tail -n 35 ${BOOT}/jobs/${job.id}/log.txt`);
  const result = await agent(['job-log', job.id]);
  return typeof result === 'string' ? result : '';
}
export async function waitTask(initial: DeviceJob, progress: (job: DeviceJob) => void) {
  let job = initial;
  while (job.state === 'queued' || job.state === 'running') {
    progress(job);
    await new Promise(resolve => setTimeout(resolve, 1500));
    try { job = job.action === 'bootstrap' ? (await readBootstrap(job.id))! : await readJob(job.id); }
    catch (error) { throw new Error(`设备任务状态暂不可读\n任务 ID：${job.id}\n${error instanceof Error ? error.message : String(error)}\n任务不会因页面断开而取消，恢复连接后刷新即可继续查看。`); }
    if (!job) throw new Error('任务记录不可读');
  }
  progress(job);
  if (job.state !== 'succeeded') {
    const log = await jobLog(job).catch(() => '暂时无法读取任务日志');
    throw new Error(`设备任务失败\n执行阶段：${phases[job.phase] || job.phase}\n执行位置：F50\n任务 ID：${job.id}\n${job.error || '请查看任务日志'}\n${log}`);
  }
  return job.result || '任务已完成';
}
export async function deviceLogs(diagnose = false) {
  const result = await agent([diagnose ? 'diagnose' : 'logs']);
  return typeof result === 'string' ? result : '';
}

export function describeTask(job: DeviceJob) {
  const names: Record<DeviceJob['action'], string> = {
    bootstrap: '安装设备组件', install: '安装服务', download: '下载核心', update: '更新订阅', start: '启动代理', stop: '停止代理', restart: '重启代理',
    'boot-on': '开启自启', 'boot-off': '关闭自启', uninstall: '卸载服务', 'save-mirror': '保存镜像', 'save-interfaces': '保存接口',
    'save-controller': '应用面板设置', 'download-dashboard': '安装面板',
  };
  return [names[job.action], `执行阶段：${phases[job.phase] || job.phase}`, job.result, job.error, `任务 ID：${job.id}`].filter(Boolean).join('\n');
}

export async function readControllerSecret() {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  try {
    const sealed = await agent(['controller-secret', sodium.to_base64(key.publicKey, sodium.base64_variants.ORIGINAL)]);
    if (typeof sealed !== 'string') throw new Error('密钥响应无效');
    const value = sodium.to_string(sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), key.publicKey, key.privateKey));
    if (value.length < 16 || value.length > 256) throw new Error('密钥响应无效');
    return value;
  } finally { sodium.memzero(key.privateKey); }
}

export function controllerURL(base: string, port: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效面板端口');
  const url = new URL(base);
  url.protocol = 'http:'; url.port = String(port); url.pathname = '/ui/'; url.search = ''; url.hash = ''; url.username = ''; url.password = '';
  return url.href;
}
export function dashboardURL(port: number) { return controllerURL(new URL(KANO_baseURL, location.href).href, port); }
async function readBootstrap(id?: string): Promise<DeviceJob | null> {
  if (id && !/^[a-f0-9]{32}$/.test(id)) throw new Error('无效任务 ID');
  const output = await shell(`
    [ ! -L ${BOOT} ] || exit 1
    if [ ! -d ${BOOT} ]; then printf null; exit 0; fi
    id=${id ? quote(id) : `"$(cat ${BOOT}/latest 2>/dev/null)"`}
    case "$id" in ''|*[!a-f0-9]*) printf null; exit 0;; esac
    [ "\${#id}" = 32 ] || exit 1
    sh "${BOOT}/jobs/$id/bootstrap.sh" status "$id"
  `);
  return output === 'null' ? null : parseJob(JSON.parse(output));
}
export async function bootstrapAgent(mirror: string) {
  await sodium.ready;
  const id = taskID();
  const data = sodium.from_string(bootstrapScript);
  const hash = bytesToHex(sha256(data));
  const name = await uploadBytes(data);
  const source = '/data/data/com.minikano.f50_sms/files/uploads/' + name;
  const folder = BOOT + '/jobs/' + id;
  const asset64 = manifest.assets.arm64, asset7 = manifest.assets.armv7;
  const result = await shell(`
    set -e
    umask 077
    [ ! -L ${BOOT} ]
    mkdir -p ${folder}
    chmod 700 ${BOOT} ${BOOT}/jobs ${folder}
    cp ${quote(source)} ${folder}/bootstrap.sh
    chmod 600 ${folder}/bootstrap.sh
    hash=$(sha256sum ${folder}/bootstrap.sh)
    [ "\${hash%% *}" = ${quote(hash)} ] || { echo '安装脚本校验失败'; exit 1; }
    rm -f ${quote(source)}
    sh ${folder}/bootstrap.sh submit ${quote(id)} ${quote(mirror)} ${quote(asset64.url)} ${quote(asset64.sha256)} ${quote(asset7.url)} ${quote(asset7.sha256)}
  `);
  return parseJob(JSON.parse(result));
}
