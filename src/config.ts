import { parseDocument, isMap } from 'yaml';

export function adaptConfig(source: string): string {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('订阅必须返回完整、有效的 mihomo YAML');
  const config = doc.toJS({ maxAliasCount: 100 });
  if (!config.proxies && !config['proxy-providers']) throw new Error('订阅没有 proxies 或 proxy-providers');
  // Network ownership belongs to this plugin; policy remains in the subscription.
  doc.set('tproxy-port', 7894);
  doc.set('allow-lan', true);
  doc.set('bind-address', '*');
  doc.setIn(['tun', 'enable'], false);
  doc.setIn(['dns', 'enable'], true);
  doc.setIn(['dns', 'listen'], '0.0.0.0:1053');
  doc.set('ipv6', false);
  doc.setIn(['dns', 'ipv6'], false);
  // An outbound mark can conflict with Android netd policy routing.
  if (config['routing-mark']) throw new Error('请从订阅移除 routing-mark，避免与 Android 路由冲突');
  if (config['interface-name']) throw new Error('请从订阅移除 interface-name，让核心跟随蜂窝出口');
  if (config.listeners?.length || config.tunnels?.length) throw new Error('首版不支持额外 listeners/tunnels，请从订阅移除');
  if ((config['external-controller'] || config['external-controller-tls']) && !config.secret) {
    throw new Error('订阅启用了控制 API，但未设置 secret');
  }
  return doc.toString();
}

export function interfaces(value: string): string {
  if (!value.trim() || value.trim() === 'auto') return 'auto';
  const names = [...new Set(value.trim().split(/[\s,]+/).filter(Boolean))];
  if (!names.length || names.some(name => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/.test(name)
    || /^(lo|rmnet|ccmni|pdp|wwan)/.test(name))) {
    throw new Error('填写热点/USB 的 LAN 接口名，不能填写蜂窝接口或 lo');
  }
  return names.join(' ');
}

export function curlConfig(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || /[\r\n\x00]/.test(value)) throw new Error('订阅必须是 HTTP(S) 链接');
  return `url = "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`;
}

export function downloadMirror(value: string): string {
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /[\r\n\x00]/.test(value)) throw new Error('下载镜像必须是无认证、无查询参数的 HTTPS 前缀');
  if (['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(url.hostname)
    || /\/https?:\/\//.test(url.pathname)) throw new Error('请填写下载代理前缀，不要填写完整 GitHub 下载地址；直连请留空');
  return url.href.replace(/\/+$/, '');
}
