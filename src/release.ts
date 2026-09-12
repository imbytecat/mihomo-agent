export const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';

export function selectRelease(value: unknown, abi: string) {
  const arch = abi === 'arm64-v8a' ? 'arm64-v8'
    : ['armeabi-v7a', 'armeabi'].includes(abi) ? 'armv7' : null;
  if (!arch) throw new Error('不支持此设备架构，目前仅支持 Android ARM64 / ARMv7');
  const release = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!release || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)
    || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('官方未返回有效的稳定版信息');
  }
  const version = release.tag_name;
  const name = `mihomo-android-${arch}-${version}.gz`;
  const asset = release.assets.find(asset => asset?.name === name);
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${version}/${name}`;
  if (asset?.browser_download_url !== url || typeof asset.digest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) {
    throw new Error('官方版本缺少对应架构的核心或 SHA-256，未安装');
  }
  return { version, manifest: `${version}\n${abi}\n${asset.digest.slice(7)}\n` };
}
