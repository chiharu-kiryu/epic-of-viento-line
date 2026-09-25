import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dialogHarness } from './dialog-harness.mjs';
import { createDesktopSession } from '../lib/desktop-session.mjs';

const nativeSource = await fs.readFile(new URL('../../src-tauri/src/desktop_host.rs', import.meta.url), 'utf8');
const closeScript = nativeSource.match(/const CLOSE_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];

async function closeHarness() {
  const harness = await dialogHarness('app-project-settings');
  harness.runtime.setupProjectSettings({ getContext: () => ({}), applied: async () => {}, setBusy() {} });
  return harness;
}

test('desktop close reports document and template drafts and busy operations without discarding input', async () => {
  for (const scenario of ['clean', 'source', 'template', 'saving', 'applying']) {
    const { runtime, document, element } = await closeHarness();
    document.body.inert = false;
    element('docSourceEditor').value = '尚未保存的正文';
    if (scenario === 'source') element('docEditDirtyIndicator').classList.add('is-unsaved');
    if (scenario === 'template') element('projectSettingsDialog').dataset.dirty = 'true';
    if (scenario === 'saving') element('docEditPanel').setAttribute('aria-busy', 'true');
    if (scenario === 'applying') element('projectSettingsDialog').setAttribute('aria-busy', 'true');
    const id = randomUUID(), sent = [];
    runtime.fetch = async (url, options) => { sent.push({ url, ...JSON.parse(options.body) }); return { ok: true }; };
    await vm.runInContext(closeScript.replace('__VIENTO_CLOSE_ID__', JSON.stringify(id)), runtime);
    assert.deepEqual(sent, [{ url: '/__desktop/close-response', id, busy: ['saving', 'applying'].includes(scenario), dirty: ['source', 'template'].includes(scenario) }], scenario);
    assert.equal(document.body.inert, true, 'input is frozen while the host checks this snapshot');
    assert.equal(runtime.window.__vientoCloseGuard.inert, false);
    assert.equal(element('docSourceEditor').value, '尚未保存的正文');
  }
});

test('an incomplete editor or an unavailable bridge cannot report that it is safe to close', async () => {
  for (const failed of ['missing-panel', 'missing-indicator', 'offline', 'unauthorized']) {
    const { runtime, document, element } = await closeHarness();
    document.body.inert = false;
    const source = element('docSourceEditor');
    source.value = '必须保留的草稿';
    element('docEditDirtyIndicator').classList.add('is-unsaved');
    if (failed === 'missing-panel') element('docEditPanel').remove();
    if (failed === 'missing-indicator') element('docEditDirtyIndicator').remove();
    const sent = [];
    runtime.fetch = async (_url, options) => {
      sent.push(JSON.parse(options.body));
      if (failed === 'offline') throw new Error('service unavailable');
      return { ok: false, status: 401 };
    };
    await vm.runInContext(closeScript.replace('__VIENTO_CLOSE_ID__', JSON.stringify(randomUUID())), runtime);
    if (failed.startsWith('missing')) assert.equal(sent.length, 0);
    else assert.equal(sent[0].dirty, true);
    assert.ok(sent.every(body => body.allow === undefined));
    assert.equal(source.value, '必须保留的草稿');
  }
});

test('desktop close bridge requires a request identity and strictly typed editor state', async (t) => {
  const events = [];
  t.mock.method(console, 'log', line => events.push(JSON.parse(line.slice('VIENTO_EVENT '.length))));
  const token = 'e'.repeat(32);
  const session = createDesktopSession(token);
  const server = createServer((req, res) => { void session(req, res, new URL(req.url, 'http://localhost').pathname); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const handshake = await fetch(`${base}/__desktop/session/${token}`, { redirect: 'manual' });
  const cookie = handshake.headers.get('set-cookie').split(';')[0];
  const id = randomUUID();
  for (const body of [null, {}, { allow: true }, { id, busy: 'false', dirty: false }, { id: '../request', busy: false, dirty: false }]) {
    const response = await fetch(`${base}/__desktop/close-response`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(events, []);
  const response = await fetch(`${base}/__desktop/close-response`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id, busy: false, dirty: true }) });
  assert.equal(response.status, 204);
  assert.deepEqual(events, [{ type: 'close-response', id, busy: false, dirty: true }]);
});
