import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'ufi-mihomo': 'src/index.ts' },
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: false,
  sourcemap: false,
  deps: { alwaysBundle: ['yaml'], onlyBundle: ['yaml'] },
  outputOptions: {
    entryFileNames: '[name].js',
    banner: '//<script>',
    footer: '//</script>',
    // The plugin is parsed as HTML before its script is executed.
    sanitizeFileName: true,
  },
  define: {
    __STYLE__: JSON.stringify(readFileSync('.build/plugin.css', 'utf8')),
    __SERVICE__: JSON.stringify(readFileSync('scripts/service.sh', 'utf8')),
    __NETWORK__: JSON.stringify(readFileSync('scripts/network.sh', 'utf8')),
  },
});
