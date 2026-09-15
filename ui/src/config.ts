export function interfaces(value: string): string {
  if (!value.trim() || value.trim() === 'auto') return 'auto';
  const names = [
    ...new Set(
      value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
  if (
    !names.length ||
    names.some(
      (name) =>
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/.test(name) ||
        name === 'lo' ||
        /^(rmnet|ccmni|pdp|wwan)/.test(name),
    )
  ) {
    throw new Error('填写热点/USB 的 LAN 接口名，不能填写蜂窝接口或 lo');
  }
  return names.join(' ');
}

export function subscriptionURL(value: string): string {
  const url = new URL(value);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\r\n\x00]/.test(value)
  )
    throw new Error('订阅必须是无认证的 HTTP(S) 链接');
  return url.href;
}

export function releaseProxy(value: string): string {
  value = value.trim();
  if (!value) return '';
  const message = '填写 HTTPS 域名，不含路径、参数或凭据';
  if (value.length > 2048 || !/^https:\/\/[^/?#\\\s@%]+\/?$/.test(value))
    throw new Error(message);
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(message);
  }
}

// cors.js decodes the path once; encode the entire upstream URL, including %.
export function releaseURL(origin: string, address: string): string {
  const proxy = releaseProxy(origin);
  return proxy ? `${proxy}/${encodeURIComponent(address)}` : address;
}
