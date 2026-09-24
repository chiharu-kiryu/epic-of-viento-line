import { timingSafeEqual } from 'node:crypto';
import { readRequestJsonBody } from './doc-server.mjs';
import fs from 'node:fs/promises';
import { isSupportedLanguage } from '../../web/i18n/languages.js';

function equalsSecret(value, expected) {
  if (typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function createDesktopSession(token = process.env.VIENTO_SESSION_TOKEN, { exports } = {}) {
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
    if (pathname === '/__desktop/preferences') {
      try {
        if (req.method === 'GET') {
          let language = 'zh-CN';
          if (process.env.VIENTO_PREFERENCES_PATH) {
            try {
              const preferences = JSON.parse(await fs.readFile(process.env.VIENTO_PREFERENCES_PATH, 'utf8'));
              if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return reject(400, 'Invalid language preference');
              if (Object.hasOwn(preferences, 'language')) language = preferences.language;
            }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          if (!isSupportedLanguage(language)) return reject(400, 'Invalid language preference');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ language })); return true;
        }
        if (req.method === 'POST') {
          const body = await readRequestJsonBody(req);
          if (!body || !isSupportedLanguage(body.language) || typeof body.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.id)) return reject(400, 'Invalid language preference');
          emit({ type: 'preferences', id: body.id, language: body.language });
          res.writeHead(204); res.end(); return true;
        }
        res.setHeader('Allow', 'GET, POST'); return reject(405, 'Method not allowed');
      } catch (error) { return reject(error.statusCode || 500, 'Unable to read language preferences'); }
    }
    if (pathname === '/__desktop/export' && req.method === 'POST') {
      try {
        const body = await readRequestJsonBody(req);
        if (!body || typeof body.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.requestId)) return reject(400, '无效的导出任务');
        const job = exports?.get(body.id);
        if (!job) return reject(410, '导出文件已过期，请重新导出');
        emit({ type: 'export', id: job.id, requestId: body.requestId, fileName: job.fileName });
        res.writeHead(204); res.end();
      } catch (error) { return reject(error.statusCode || 400, error.message || '无法保存导出文件'); }
      return true;
    }
    if (pathname === '/__desktop/close-response' && req.method === 'POST') {
      try {
        const body = await readRequestJsonBody(req);
        if (!body || typeof body.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.id)
          || typeof body.busy !== 'boolean' || typeof body.dirty !== 'boolean') return reject(400, 'Invalid close response');
        emit({ type: 'close-response', id: body.id, busy: body.busy, dirty: body.dirty }); res.writeHead(204); res.end();
      } catch { return reject(400, 'Invalid close response'); }
      return true;
    }
    if (pathname.startsWith('/__desktop/')) return reject(404, 'Unknown desktop route');
    return false;
  };
}
