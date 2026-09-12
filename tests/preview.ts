// Exercise the actual HTML wrapper and production IIFE, not Vite's module loader.
export {};
const mock = await Bun.build({ entrypoints: ['dev/mock.ts'], target: 'browser' });
if (!mock.success) throw new Error('Cannot build browser mock');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 3007,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/plugin.js') return new Response(Bun.file('dist/ufi-mihomo.js'));
    if (path === '/mock.js') return new Response(mock.outputs[0]);
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UFI mock</title></head><body>
      <main style="max-width:600px;margin:auto;font-family:sans-serif"><h1>UFI 模拟页面</h1><div class="functions-container"></div></main>
      <script type="module">
      import '/mock.js';
      const text = await (await fetch('/plugin.js')).text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      for (const script of doc.querySelectorAll('script')) {
        const el = document.createElement('script'); el.textContent = script.textContent; document.head.append(el);
      }
      </script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});
console.log(`Mock UFI: ${server.url}`);
