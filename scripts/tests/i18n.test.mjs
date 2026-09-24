import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, write, serve } from './helpers.mjs';
import english from '../../web/i18n/en.js';
import japanese from '../../web/i18n/ja.js';
import { t as tr, applyLanguage, getLanguage, localize, translateMessage, onLanguageChange } from '../../web/i18n/index.js';

test('language changes update retained UI references while preserving authored labels and interpolation values', (t) => {
  t.after(() => applyLanguage('zh-CN'));
  const messages = localize({ actions: { save: '保存' }, categories: { builtin: '场景' } });
  const buttons = messages.actions;
  const dataLabel = '场景';
  Object.defineProperty(messages.categories, 'custom', { value: dataLabel, configurable: true });
  const filename = '作品/设置/保存.md <b>literal</b> {0}';
  const status = tr`已保存到 ${filename}`;
  let events = 0;
  const stop = onLanguageChange(() => events++);
  assert.equal(buttons.save, '保存');
  applyLanguage('en');
  assert.equal(buttons.save, 'Save');
  assert.equal(messages.categories.builtin, 'Scenes');
  assert.equal(messages.categories.custom, dataLabel);
  assert.equal(translateMessage(status), `Saved to ${filename}`);
  assert.equal(tr('未登记的项目文本'), '未登记的项目文本');
  applyLanguage('en');
  assert.equal(events, 1);
  applyLanguage('ja');
  assert.equal(buttons.save, '保存');
  assert.equal(messages.categories.builtin, 'シーン');
  assert.equal(messages.categories.custom, dataLabel);
  assert.equal(translateMessage(status), `保存先：${filename}`);
  assert.equal(tr('未登记的项目文本'), '未登记的项目文本');
  assert.equal(events, 2);
  stop();
  applyLanguage('unsupported');
  assert.equal(getLanguage(), 'zh-CN');
  assert.equal(buttons.save, '保存');
});

test('English and Japanese catalogues preserve all message parameters', () => {
  const parameters = (text) => [...text.matchAll(/\{\d+\}/g)].map((entry) => entry[0]).sort();
  for (const [source, translated] of [...Object.entries(english), ...Object.entries(japanese)]) {
    assert.ok(translated.trim(), source);
    assert.deepEqual(parameters(translated), parameters(source), source);
  }
});

test('unknown messages cannot resolve inherited object properties in either catalogue', (t) => {
  t.after(() => applyLanguage('zh-CN'));
  for (const locale of ['en', 'ja']) {
    applyLanguage(locale);
    for (const literal of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(tr(literal), literal);
  }
});

test('desktop language preferences require the local session and stay outside the project', async (t) => {
  const root = await fixture(t);
  const preferenceRoot = await fs.mkdtemp(path.join(path.dirname(root), 'viento-preferences-'));
  t.after(() => fs.rm(preferenceRoot, { recursive: true, force: true }));
  const file = path.join(preferenceRoot, 'preferences.json');
  await write(root, 'design-data/story.md', '# 场景\n\n保存：正文不是界面\n');
  const token = '1'.repeat(48);
  const base = await serve(t, root, { VIENTO_SESSION_TOKEN: token, VIENTO_PREFERENCES_PATH: file });
  assert.equal((await fetch(`${base}/__desktop/preferences`)).status, 401);
  const session = await fetch(`${base}/__desktop/session/${token}`, { redirect: 'manual' });
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  assert.deepEqual(await (await fetch(`${base}/__desktop/preferences`, { headers })).json(), { language: 'zh-CN' });
  await fs.writeFile(file, JSON.stringify({ language: 'en' }));
  assert.deepEqual(await (await fetch(`${base}/__desktop/preferences`, { headers })).json(), { language: 'en' });
  await fs.writeFile(file, JSON.stringify({ language: 'ja', futureOption: true }));
  assert.deepEqual(await (await fetch(`${base}/__desktop/preferences`, { headers })).json(), { language: 'ja' });
  for (const value of ['', null, false, 0, 'unsupported']) {
    const bytes = JSON.stringify({ language: value, futureOption: { enabled: true } });
    await fs.writeFile(file, bytes);
    assert.equal((await fetch(`${base}/__desktop/preferences`, { headers })).status, 400, `invalid stored language: ${value}`);
    assert.equal(await fs.readFile(file, 'utf8'), bytes, 'reading a bad preference must not rewrite it');
  }
  for (const value of [null, [], 'en']) {
    await fs.writeFile(file, JSON.stringify(value));
    assert.equal((await fetch(`${base}/__desktop/preferences`, { headers })).status, 400);
    assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify(value));
  }
  await fs.writeFile(file, JSON.stringify({ futureOption: { enabled: true } }));
  assert.deepEqual(await (await fetch(`${base}/__desktop/preferences`, { headers })).json(), { language: 'zh-CN' });
  await fs.writeFile(file, JSON.stringify({ language: 'en' }));
  const post = (body, extra = {}) => fetch(`${base}/__desktop/preferences`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ language: 'en', id: randomUUID() }, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post({ language: '../en', id: randomUUID() })).status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal((await post({ language: 'zh-CN', id: 'not-a-request-id' })).status, 400);
  assert.equal((await post({ language: 'zh-CN', id: randomUUID() })).status, 204);
  assert.equal((await post({ language: 'ja', id: randomUUID() })).status, 204);
  assert.equal((await post({ language: 'ja', id: randomUUID() }, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post({ language: 'ja-JP', id: randomUUID() })).status, 400);
  // Only the desktop host acknowledges and commits a preference, not the server.
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).language, 'en');
  assert.equal((await fetch(`${base}/__desktop/preferences`, { method: 'DELETE', headers })).status, 405);
  for (const module of ['index.js', 'en.js', 'ja.js', 'languages.js', 'messages.js', 'settings.js', 'settings.css']) {
    const response = await fetch(`${base}/web/i18n/${module}`, { headers });
    assert.equal(response.status, 200, module);
    assert.ok(!(await response.text()).startsWith('<!doctype'), module);
  }
  assert.equal(await fs.readFile(path.join(root, 'design-data/story.md'), 'utf8'), '# 场景\n\n保存：正文不是界面\n');
  await assert.rejects(fs.access(path.join(root, 'preferences.json')));
});
