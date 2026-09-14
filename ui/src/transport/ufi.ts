import sodium from 'libsodium-wrappers';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { quote as shellQuote } from 'shell-quote';
import { z } from 'zod';
import bootstrapScript from './ufi-bootstrap.sh?raw';
import {
  emptyState,
  protocol,
  updatesSchema,
  parseState,
  parseJob,
  type DeviceJob,
  type TaskAction,
  type TaskParams,
} from '../state';
import { requestJSON, requestFailure, transportFailure } from '../request';
import { githubProxyURL } from '../config';

declare const runShellWithRoot: (
  command: string,
  timeout?: number,
) => Promise<{ success: boolean; content?: string }>;
declare const KANO_baseURL: string;
declare const common_headers: HeadersInit;
export const DIR = '/data/mihomo-agent';
const AGENT = DIR + '/agent';
const BOOT = '/data/mihomo-agent-bootstrap';
export const quote = (value: string) => shellQuote([value]);
const uploadResponse = z.object({
  url: z
    .string()
    .transform((value) => value.replace(/^\/?uploads\//, ''))
    .refine(
      (name) =>
        name.endsWith('.bin') && z.guid().safeParse(name.slice(0, -4)).success,
    ),
});

export function shellCommand(command: string, marker: string) {
  return `sh -c ${quote(command)}; printf '\\n${marker}%s\\n' "$?"`;
}
export function shellResult(content: string, marker: string) {
  const match = content.match(new RegExp(`\\n${marker}(\\d+)\\s*$`));
  if (!match) throw new Error('设备未返回完整响应');
  const output = content.slice(0, match.index).trim();
  if (match[1] !== '0') {
    try {
      const value = JSON.parse(output);
      if (typeof value.error === 'string') throw new Error(value.error);
    } catch (error) {
      if (error instanceof Error && !(error instanceof SyntaxError))
        throw error;
    }
    throw new Error(output || `命令失败 (${match[1]})`);
  }
  return output;
}
export async function shell(command: string, timeout = 30_000) {
  const marker = `UFI_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}_`;
  const context = {
    step: '连接设备',
    target: 'UFI 设备 /api/root_shell',
    hint: '检查 UFI 设备 连接、UFI 登录和高级功能。任务可能仍在设备上运行，恢复连接后刷新状态。',
  };
  let result;
  try {
    result = await runShellWithRoot(shellCommand(command, marker), timeout);
  } catch (error) {
    throw transportFailure(context, error);
  }
  if (!result.success)
    throw requestFailure(context, result.content || 'Root 接口不可用');
  return shellResult(result.content || '', marker);
}
async function agent(args: string[], timeout = 30_000) {
  const result = await shell(
    [quote(AGENT), ...args.map(quote)].join(' '),
    timeout,
  );
  return JSON.parse(result) as unknown;
}
export async function checkUpdates() {
  return updatesSchema.parse(await agent(['check-updates'], 45_000));
}
export async function stopAgent() {
  return parseJob(await agent(['task', 'stop']));
}
export async function readDeviceState() {
  const output = await shell(`
    [ "$(id -u)" = 0 ] || { echo '请开启 UFI 高级功能'; exit 1; }
    [ ! -L ${DIR} ] || { echo '设备目录异常'; exit 1; }
    if [ -x ${AGENT} ]; then exec ${AGENT} inspect; fi
    [ ! -e ${DIR} ] || { echo '安装目录仍存在，但 Agent 不可读；请等待安装或卸载完成后刷新'; exit 1; }
    printf null
  `);
  const task = await readBootstrap();
  if (output !== 'null') {
    const state = parseState(output);
    if (
      task &&
      (!state.task ||
        ['queued', 'running'].includes(task.state) ||
        Date.parse(task.updated) > Date.parse(state.task.updated))
    ) {
      state.task = task;
      state.locked ||= ['queued', 'running'].includes(task.state);
    }
    return state;
  }
  return {
    ...emptyState,
    task,
    locked: !!task && ['queued', 'running'].includes(task.state),
  };
}
async function uploadBytes(bytes: Uint8Array) {
  const body = new FormData();
  body.append(
    'file',
    new File([new Uint8Array(bytes)], 'request.bin', {
      type: 'application/octet-stream',
    }),
  );
  const context = {
    step: '上传设备请求',
    target: 'UFI 设备 /api/upload_img',
    hint: '检查设备连接和 UFI 登录状态。',
  };
  const result = await requestJSON(
    `${KANO_baseURL}/upload_img`,
    { method: 'POST', headers: common_headers, body },
    context,
    uploadResponse,
  );
  return result.url;
}
export async function sealRequest(publicKey: string, value: object) {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  if (key.length !== 32) throw new Error('设备公钥无效');
  const bytes = sodium.crypto_box_seal(
    sodium.from_string(JSON.stringify(value)),
    key,
  );
  return { bytes, hash: bytesToHex(sha256(bytes)) };
}
export function taskID() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function submitTask(action: TaskAction, params: TaskParams = {}) {
  const state = await readDeviceState();
  if (!state.agent || !state.publicKey)
    throw new Error('请先安装 Mihomo Agent');
  const id = taskID();
  const sealed = await sealRequest(state.publicKey, { id, action, params });
  const name = await uploadBytes(sealed.bytes);
  try {
    return parseJob(await agent(['submit', name, sealed.hash]));
  } catch (error) {
    if (action === 'uninstall') {
      const completed = await readUninstallJob({
        id,
        action,
        state: 'running',
        phase: 'removing',
        updated: '',
        hash: sealed.hash,
        error: '',
        result: '',
      }).catch(() => null);
      if (completed?.state === 'succeeded') return completed;
    }
    try {
      return parseJob(await agent(['job', id]));
    } catch {}
    throw new Error(
      `任务提交结果未确认\n任务 ID：${id}\n${error instanceof Error ? error.message : String(error)}\n恢复连接后刷新状态，勿连续重复提交。`,
    );
  }
}
export async function readJob(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('无效任务 ID');
  return parseJob(await agent(['job', id]));
}

// Completion is the absence of both owned directories, not a surviving receipt.
export async function readUninstallJob(
  initial: DeviceJob,
): Promise<DeviceJob | null> {
  if (!/^[a-f0-9]{32}$/.test(initial.id)) throw new Error('无效任务 ID');
  const state = await shell(`
    # ufi-uninstall-status
    [ ! -L ${DIR} ] && [ ! -L ${BOOT} ] || { echo '卸载目录异常'; exit 1; }
    if [ ! -e ${DIR} ] && [ ! -L ${DIR} ] && [ ! -e ${BOOT} ] && [ ! -L ${BOOT} ]; then printf null
    elif [ -x ${AGENT} ] && record=$(${AGENT} job ${initial.id} 2>/dev/null); then printf '%s' "$record"
    else printf '{"removing":true}'; fi
  `);
  const value = JSON.parse(state);
  if (value === null)
    return {
      ...initial,
      state: 'succeeded',
      phase: 'done',
      result: 'Mihomo 服务已卸载',
    };
  if (value?.removing === true) return null;
  const job = parseJob(value);
  if (job.state === 'succeeded')
    return { ...job, state: 'failed', error: '卸载未完成，设备文件仍存在' };
  return job;
}
export async function jobLog(job: DeviceJob) {
  if (job.action === 'bootstrap')
    return shell(`tail -n 35 ${BOOT}/jobs/${job.id}/log.txt`);
  const result = await agent(['job-log', job.id]);
  return typeof result === 'string' ? result : '';
}
export async function deviceLogs(diagnose = false) {
  const result = await agent([diagnose ? 'diagnose' : 'logs']);
  return typeof result === 'string' ? result : '';
}

export async function readControllerSecret() {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  try {
    const sealed = await agent([
      'controller-secret',
      sodium.to_base64(key.publicKey, sodium.base64_variants.ORIGINAL),
    ]);
    if (typeof sealed !== 'string') throw new Error('密钥响应无效');
    const value = sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
        key.publicKey,
        key.privateKey,
      ),
    );
    if (!value) throw new Error('密钥响应无效');
    return value;
  } finally {
    sodium.memzero(key.privateKey);
  }
}

export async function readBootstrap(id?: string): Promise<DeviceJob | null> {
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
const agentReleaseSchema = z.object({
  tag_name: z.string().min(1),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      digest: z.string().nullable().optional(),
    }),
  ),
});
export async function latestAgentAssets(githubProxy = '') {
  const prefix = githubProxyURL(githubProxy);
  const official =
    'https://api.github.com/repos/imbytecat/mihomo-agent/releases/latest';
  const address = prefix ? `${prefix}/${official}` : official;
  const context = {
    step: '检查 Agent 最新版本',
    target: address,
    hint: '检查 GitHub Proxy 是否支持 GitHub API 和浏览器跨域；留空时直连。',
  };
  const release = await requestJSON(
    address,
    { credentials: 'omit', signal: AbortSignal.timeout(30_000) },
    context,
    agentReleaseSchema,
  );
  const asset = (arch: string) => {
    const name = `mihomo-agent-linux-${arch}`;
    const value = release.assets.find((entry) => entry.name === name);
    const url = `https://github.com/imbytecat/mihomo-agent/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
    if (
      value?.browser_download_url !== url ||
      !/^sha256:[a-f0-9]{64}$/i.test(value.digest || '')
    )
      throw requestFailure(context, `官方版本缺少 ${arch} 文件或有效 SHA-256`);
    return { url, sha256: value.digest!.slice(7).toLowerCase() };
  };
  return { arm64: asset('arm64'), armv7: asset('armv7') };
}

export async function bootstrapAgent(githubProxy: string) {
  const assets = await latestAgentAssets(githubProxy);
  await sodium.ready;
  const id = taskID();
  const data = sodium.from_string(bootstrapScript);
  const hash = bytesToHex(sha256(data));
  const name = await uploadBytes(data);
  const source = '/data/data/com.minikano.f50_sms/files/uploads/' + name;
  const folder = BOOT + '/jobs/' + id;
  const asset64 = assets.arm64,
    asset7 = assets.armv7;
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
    sh ${folder}/bootstrap.sh submit ${quote(id)} ${quote(githubProxy)} ${quote(asset64.url)} ${quote(asset64.sha256)} ${quote(asset7.url)} ${quote(asset7.sha256)} ${protocol}
  `);
  return parseJob(JSON.parse(result));
}

export function baseURL() {
  return new URL(KANO_baseURL, location.href).href;
}
