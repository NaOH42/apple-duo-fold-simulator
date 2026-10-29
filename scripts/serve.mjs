import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.env.PORT || 4173);
const base = process.argv.find(a => a.startsWith('--base='))?.slice(7) || '/';
if (!base.startsWith('/') || !base.endsWith('/')) throw new Error('base must start and end with /');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm','.json':'application/json'};
try { await stat(resolve(root, 'index.html')); }
catch { console.error('请先运行 npm run build，生成网页包。'); process.exit(1); }
const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }
  if (!pathname.startsWith(base)) { res.writeHead(404).end(); return; }
  const relative = pathname.slice(base.length) || 'index.html';
  const filename = resolve(root, relative);
  if (!filename.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const content = await readFile(filename);
    res.writeHead(200, {'Content-Type':mime[extname(filename)] || 'application/octet-stream', 'Cache-Control':filename.endsWith('index.html') ? 'no-cache' : 'public,max-age=3600'});
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404).end('Not found'); }
});
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
server.listen(port, '0.0.0.0', () => {
  const url = `http://localhost:${port}${base}`;
  console.log(`Apple DUO 已启动：${url}`);
  for (const addresses of Object.values(networkInterfaces())) for (const a of addresses || []) {
    if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.')) console.log(`同一 Wi-Fi 手机地址：http://${a.address}:${port}${base}`);
  }
  console.log('关闭此窗口或按 Ctrl+C 停止。');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' }).unref();
  }
});
