// Manual browser smoke-test host. The only mocked part is the Tauri IPC wire;
// every document operation executes the real Rust Android storage code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { nativeMobileLibrary } from './mobile-native-harness.mjs';

if (!process.env.VIENTO_MOBILE_STORE_BIN || !process.env.VIENTO_MOBILE_TEST_ROOT) throw new Error('Set VIENTO_MOBILE_STORE_BIN and VIENTO_MOBILE_TEST_ROOT to isolated test paths.');
const library = await nativeMobileLibrary(process.env.VIENTO_MOBILE_STORE_BIN, process.env.VIENTO_MOBILE_TEST_ROOT);
const root = fileURLToPath(new URL('../../mobile/dist/', import.meta.url));
const bridge = `window.__TAURI__={core:{async invoke(command,request){if(!['mobile_storage','mobile_archive'].includes(command))throw new Error('Unexpected command');const result=await fetch('/__test_native',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,request})}).then(r=>r.json());if(result.error)throw result.error;return result.data;}}};`;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const config = JSON.parse(await fs.readFile(new URL('../../src-tauri/tauri.android.conf.json', import.meta.url)));
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/__test_native' && req.method === 'POST') {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['content-type'] !== 'application/json') {
        res.writeHead(403); res.end(); return;
      }
      let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2_000_000) throw new Error('request too large'); }
      const { command, request } = JSON.parse(data);
      let result;
      try {
        if (command === 'mobile_archive') {
          // Only the system picker is substituted. Fixtures are explicitly
          // supplied by the test operator, never paths from the browser.
          const selection = JSON.parse(await fs.readFile(path.join(library.root, '.archive-selection.json'), 'utf8'));
          if (selection.cancelled) result = { data: { cancelled: true } };
          else {
            const value = await library.invoke('mobile_storage', {
              action: request.action === 'import' ? 'importArchive' : 'exportArchive',
              workspaceId: request.workspaceId, path: selection.path,
            });
            result = { data: request.action === 'import' ? { workspace: value } : value };
          }
        } else if (command === 'mobile_storage') result = { data: await library.invoke(command, request) };
        else throw new Error('Unexpected command');
      } catch (error) { result = { error }; }
      const hold = path.join(library.root, '.hold-save-reply');
      if (request.action === 'save' && !result.error && await fs.stat(hold).catch(() => null)) {
        await fs.rm(hold); console.log('Test: native save completed; reply held until the page closes.'); return;
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); return;
    }
    if (pathname === '/__test_bridge.js') { res.setHeader('Content-Type', types['.js']); res.end(bridge); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) throw new Error('bad path');
    let bytes = await fs.readFile(file);
    if (file.endsWith('.html')) bytes = Buffer.from(bytes.toString().replace('<head>', '<head><script type="module" src="/__test_bridge.js"></script>'));
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Security-Policy', config.app.security.csp.replace('connect-src ', "connect-src 'self' "));
    res.end(bytes);
  } catch (error) { res.writeHead(404); res.end(String(error.message)); }
});
server.listen(Number(process.env.VIENTO_MOBILE_TEST_PORT || 0), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, root: library.root })));
async function stop() { server.close(); server.closeAllConnections(); await library.close(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
