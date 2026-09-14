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
