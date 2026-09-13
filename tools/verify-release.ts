import { createHash } from 'node:crypto';
import ky from 'ky';

const manifest = await Bun.file('agent-bootstrap.json').json();
const tag = process.argv[2];
if (tag !== `agent-${manifest.version}`) throw new Error('Release tag does not match the verified build');
const base = `https://github.com/imbytecat/ufi-mihomo/releases/download/${tag}/`;
const expected = await Bun.file('.release/SHA256SUMS').text();
const published = await ky.get(base + 'SHA256SUMS', { retry: 3, timeout: 60000 }).text();
if (published !== expected) throw new Error('Published checksum manifest differs from the build');
await Promise.all(expected.trim().split('\n').map(async line => {
  const [digest, name] = line.split('  ');
  if (!digest || !name || !/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('Invalid checksum entry');
  const bytes = await ky.get(base + name, { retry: 3, timeout: 60000 }).arrayBuffer();
  const actual = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  if (actual !== digest) throw new Error(`Published checksum mismatch: ${name}`);
  console.log(`${name}: OK`);
}));
