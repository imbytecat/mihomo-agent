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
        /^(lo|rmnet|ccmni|pdp|wwan)/.test(name),
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

export function githubProxyURL(value: string): string {
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[\r\n\x00]/.test(value)
  )
    throw new Error('GitHub Proxy 必须是无认证、无查询参数的 HTTPS 前缀');
  if (
    ['github.com', 'api.github.com', 'raw.githubusercontent.com'].includes(
      url.hostname,
    ) ||
    /\/https?:\/\//.test(url.pathname)
  )
    throw new Error(
      '请填写 GitHub Proxy 前缀，不要填写完整 GitHub 地址；直连请留空',
    );
  return url.href.replace(/\/+$/, '');
}
