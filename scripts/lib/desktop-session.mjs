import { timingSafeEqual } from 'node:crypto';
import { readRequestJsonBody } from './doc-server.mjs';

function equalsSecret(value, expected) {
  if (typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function createDesktopSession(token = process.env.VIENTO_SESSION_TOKEN) {
  if (!token) return null;
  if (!/^[a-f\d-]{32,64}$/i.test(token)) throw new Error('Invalid desktop session token');
  const emit = (event) => console.log(`VIENTO_EVENT ${JSON.stringify(event)}`);
  return async (req, res, pathname) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    const reject = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: message })); return true; };
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) return reject(403, 'Invalid desktop origin');
    if (pathname.startsWith('/__desktop/session/') && req.method === 'GET'
      && equalsSecret(pathname.slice('/__desktop/session/'.length), token)) {
      res.setHeader('Set-Cookie', `viento-session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(302, { Location: '/?mode=edit&desktop=1' }); res.end(); return true;
    }
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('viento-session='));
    if (!equalsSecret(cookie?.slice('viento-session='.length), token)) return reject(401, 'Desktop session required');
    if (pathname === '/__desktop/library' && req.method === 'POST') {
      emit({ type: 'library' }); res.writeHead(204); res.end(); return true;
    }
    if (pathname === '/__desktop/close-response' && req.method === 'POST') {
      try {
        const body = await readRequestJsonBody(req);
        if (typeof body.allow !== 'boolean') return reject(400, 'Invalid close response');
        emit({ type: 'close-response', allow: body.allow }); res.writeHead(204); res.end();
      } catch { return reject(400, 'Invalid close response'); }
      return true;
    }
    if (pathname.startsWith('/__desktop/')) return reject(404, 'Unknown desktop route');
    return false;
  };
}
