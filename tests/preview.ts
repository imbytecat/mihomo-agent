// Local-only browser harness. No shell commands are executed.
const uploads: { name: string; text: string }[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 3007,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/plugin.js') return new Response(Bun.file('dist/ufi-mihomo.js'));
    if (path === '/debug') return Response.json(uploads);
    if (path === '/api/upload_img') {
      const file = (await request.formData()).get('file') as File;
      uploads.push({ name: file.name, text: await file.text() });
      return Response.json({ url: `/uploads/${crypto.randomUUID()}.txt` });
    }
    if (path.startsWith('/api/uploads/')) return new Response('proxies: []\nrules: ["MATCH,DIRECT"]\ndns: {nameserver: [223.5.5.5]}\n');
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UFI mock</title></head><body>
      <main style="max-width:600px;margin:auto;font-family:sans-serif"><h1>UFI 模拟页面</h1><div class="functions-container"></div></main>
      <script>
      const KANO_baseURL = '/api';
      const common_headers = {};
      const runShellWithRoot = async command => {
        window.lastCommand = command;
        const marker = command.match(/UFI_EXIT_[a-zA-Z0-9_]+/)[0];
        let content = '';
        if (command.includes('id -u')) content = '0';
        else if (command.includes('status')) content = '已停止\\n开机自启：关闭';
        else if (command.includes('ip -o')) content = 'wlan0 192.168.0.1/24';
        else if (command.includes('apply')) content = '配置已更新';
        else if (command.includes('fetch')) content = '订阅下载完成';
        else if (command.includes('.result')) content = '0';
        return { success: true, content: content + '\\n' + marker + '0' };
      };
      fetch('/plugin.js').then(r => r.text()).then(text => {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        for (const script of doc.querySelectorAll('script')) {
          const el = document.createElement('script'); el.textContent = script.textContent; document.head.append(el);
        }
      });
      </script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
});
console.log(`Mock UFI: ${server.url}`);
