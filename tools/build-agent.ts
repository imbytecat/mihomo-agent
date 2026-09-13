import { createHash } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { parse } from 'semver';

const version =
  process.argv[2] || (await Bun.file('agent-bootstrap.json').json()).version;
const parsed = parse(version);
if (
  !parsed ||
  parsed.prerelease.length ||
  parsed.build.length ||
  version !== `v${parsed.version}`
)
  throw new Error('Invalid Agent version');
const buildEnv = {
  ...process.env,
  GOTOOLCHAIN: 'go1.26.7',
  GOENV: 'off',
  GOWORK: 'off',
  GOFLAGS: '',
  GOEXPERIMENT: '',
  GOFIPS140: 'off',
  CGO_ENABLED: '0',
};
const probe = Bun.spawn(['go', 'env', 'GOROOT'], {
  env: buildEnv,
  stdout: 'pipe',
  stderr: 'inherit',
});
const goroot = (await new Response(probe.stdout).text()).trim();
if ((await probe.exited) !== 0) throw new Error('Cannot locate Go 1.26.7');
// Nix patches stdlib paths even with the same version; those builds have different hashes.
if (goroot.includes('/nix/store/'))
  throw new Error(
    '发布需要官方 Go。请运行：mise exec go@1.26.7 -- bun run build:release',
  );
await mkdir('.release', { recursive: true });
const assets: Record<string, { url: string; sha256: string }> = {};
const sums: string[] = [];
const metadata = Bun.spawn(['go', 'run', './cmd/mihomo-agent', 'version'], {
  cwd: 'agent',
  env: buildEnv,
  stdout: 'pipe',
  stderr: 'inherit',
});
const protocol = (
  JSON.parse(await new Response(metadata.stdout).text()) as { protocol: number }
).protocol;
if ((await metadata.exited) !== 0 || !Number.isInteger(protocol))
  throw new Error('Cannot read Agent protocol');
for (const [name, goarch, goarm] of [
  ['arm64', 'arm64', ''],
  ['armv7', 'arm', '7'],
  ['amd64', 'amd64', ''],
]) {
  const file = `mihomo-agent-linux-${name}`;
  const child = Bun.spawn(
    [
      'go',
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      `-s -w -buildid= -X main.version=${version}`,
      '-o',
      `../.release/${file}`,
      './cmd/mihomo-agent',
    ],
    {
      cwd: 'agent',
      env: {
        ...buildEnv,
        GOOS: 'linux',
        GOARCH: goarch!,
        GOARM: goarm!,
        GOARM64: 'v8.0',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await child.exited) !== 0) throw new Error(`Cannot build ${file}`);
  const sha256 = createHash('sha256')
    .update(new Uint8Array(await Bun.file(`.release/${file}`).arrayBuffer()))
    .digest('hex');
  assets[name!] = {
    url: `https://github.com/imbytecat/ufi-mihomo/releases/download/agent-${version}/${file}`,
    sha256,
  };
  sums.push(`${sha256}  ${file}`);
}
await writeFile(
  'agent-bootstrap.json',
  JSON.stringify({ version, protocol, assets }, null, 2) + '\n',
);
const plugin = Bun.spawn([process.execPath, 'run', 'build'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await plugin.exited) !== 0) throw new Error('Plugin build failed');
await copyFile('dist/ufi-mihomo.js', '.release/ufi-mihomo.js');
const pluginHash = createHash('sha256')
  .update(
    new Uint8Array(await Bun.file('.release/ufi-mihomo.js').arrayBuffer()),
  )
  .digest('hex');
sums.push(`${pluginHash}  ufi-mihomo.js`);
await writeFile('.release/SHA256SUMS', sums.join('\n') + '\n');
console.log(`Release agent-${version} built in .release/; manifest updated.`);
