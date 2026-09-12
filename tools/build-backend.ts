import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const version = process.argv[2] || 'v0.1.0';
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid backend version');
await mkdir('.release', { recursive: true });
const assets: Record<string, { url: string; sha256: string }> = {};
for (const [name, goarch, goarm] of [['arm64', 'arm64', ''], ['armv7', 'arm', '7']]) {
  const file = `ufi-agent-linux-${name}`;
  const process = Bun.spawn(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -buildid= -X main.version=${version}`, '-o', `../.release/${file}`, '.'], {
    cwd: 'backend', env: { ...Bun.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: goarch!, GOARM: goarm! }, stdout: 'inherit', stderr: 'inherit',
  });
  if (await process.exited !== 0) throw new Error(`Cannot build ${file}`);
  const sha256 = createHash('sha256').update(new Uint8Array(await Bun.file(`.release/${file}`).arrayBuffer())).digest('hex');
  assets[name!] = { url: `https://github.com/imbytecat/ufi-mihomo/releases/download/agent-${version}/${file}`, sha256 };
}
await writeFile('backend-release.json', JSON.stringify({ version, protocol: 1, assets }, null, 2) + '\n');
console.log(`Backend ${version} built; manifest updated.`);
