import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';

export default defineConfig(({ mode }) => ({
  root: 'dev',
  server: { host: '127.0.0.1' },
  define: { 'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development') },
  plugins: [react(), {
    name: 'ufi-single-script',
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') output.code = `//<script>\n${output.code.replace(/<\/script/gi, '<\\/script')}\n//</script>\n`;
      }
    },
  }],
  css: { postcss: { plugins: [tailwindcss(fileURLToPath(new URL('./tailwind.config.cjs', import.meta.url)))] } },
  build: {
    outDir: '../dist', emptyOutDir: true, target: 'es2020', sourcemap: false,
    lib: { entry: fileURLToPath(new URL('./src/index.tsx', import.meta.url)), name: 'UfiMihomo', formats: ['iife'], fileName: () => 'ufi-mihomo.js' },
  },
}));
