import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const version = process.argv[2] || 'v0.1.0';
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid backend version');
await mkdir('.release', { recursive: true });
const assets: Record<string, { url: string; sha256: string }> = {};
const sums: string[] = [];
for (const [name, goarch, goarm] of [['arm64', 'arm64', ''], ['armv7', 'arm', '7']]) {
  const file = `ufi-agent-linux-${name}`;
  const child = Bun.spawn(['go', 'build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -buildid= -X main.version=${version}`, '-o', `../.release/${file}`, '.'], {
    cwd: 'backend', env: { ...process.env, GOTOOLCHAIN: 'go1.26.7', GOFLAGS: '', GOEXPERIMENT: '', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: goarch!, GOARM: goarm!, GOARM64: 'v8.0' }, stdout: 'inherit', stderr: 'inherit',
  });
  if (await child.exited !== 0) throw new Error(`Cannot build ${file}`);
  const sha256 = createHash('sha256').update(new Uint8Array(await Bun.file(`.release/${file}`).arrayBuffer())).digest('hex');
  assets[name!] = { url: `https://github.com/imbytecat/ufi-mihomo/releases/download/agent-${version}/${file}`, sha256 };
  sums.push(`${sha256}  ${file}`);
}
await writeFile('backend-release.json', JSON.stringify({ version, protocol: 1, assets }, null, 2) + '\n');
const plugin = Bun.spawn([process.execPath, 'run', 'build'], { stdout: 'inherit', stderr: 'inherit' });
if (await plugin.exited !== 0) throw new Error('Plugin build failed');
await copyFile('dist/ufi-mihomo.js', '.release/ufi-mihomo.js');
const pluginHash = createHash('sha256').update(new Uint8Array(await Bun.file('.release/ufi-mihomo.js').arrayBuffer())).digest('hex');
sums.push(`${pluginHash}  ufi-mihomo.js`);
await writeFile('.release/SHA256SUMS', sums.join('\n') + '\n');
console.log(`Release agent-${version} built in .release/; manifest updated.`);
