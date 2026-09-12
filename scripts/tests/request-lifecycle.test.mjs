import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchJsonApiRequest, fetchTextApiRequest } from '../../web/modules/app-services.js';

async function delayedServer(t, { headers = true, body = '{"ok":true,"data":{"value":1}}' } = {}) {
  const server = createServer((_request, response) => {
    if (headers) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.flushHeaders();
    }
    const timer = setTimeout(() => response.end(body), 700);
    response.on('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('JSON and template timeouts remain active while response bodies are loading', async (t) => {
  const url = await delayedServer(t);
  for (const fetchRequest of [fetchJsonApiRequest, fetchTextApiRequest]) {
    await assert.rejects(fetchRequest(url, {}, 150, '读取内容'), (error) => {
      assert.match(error.message, /读取内容.*超时/);
      assert.equal(error.attempts[0].url, url);
      return true;
    });
  }
});

test('timeouts before response headers preserve the useful error instead of mutating a DOMException', async (t) => {
  const url = await delayedServer(t, { headers: false });
  await assert.rejects(fetchJsonApiRequest(url, {}, 150, '保存文档'), (error) => {
    assert.match(error.message, /保存文档.*超时/);
    assert.notEqual(error.name, 'TypeError');
    return true;
  });
});

test('a caller can cancel a request after its headers without losing the cancellation reason', async (t) => {
  const url = await delayedServer(t);
  const controller = new AbortController();
  const pending = fetchTextApiRequest(url, { signal: controller.signal }, 2000);
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, (error) => error.name === 'AbortError' && !/超时/.test(error.message));
});
