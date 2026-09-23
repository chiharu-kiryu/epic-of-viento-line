import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fixture, write, serve, request } from './helpers.mjs';
import { PROJECT_DEFAULTS } from '../lib/project-layout.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';
import { API_REQUEST_KEYS } from '../lib/doc-api-contract.mjs';
import { editorHarness } from './editor-harness.mjs';
import { dialogHarness } from './dialog-harness.mjs';
import { fetchTextApiRequest, fetchJsonApiRequest } from '../../web/modules/app-services.js';

async function project(t, { version = 3, template = '角色.md', content = '# 目标模板\n', decoys = {}, missing = false } = {}) {
  const root = await fixture(t);
  const documents = version === 3 ? 'documents' : 'design-data';
  const templates = version === 3 ? 'templates' : 'data-template';
  await write(root, 'workspace.json', JSON.stringify({ format: 'viento-workspace', version, id: randomUUID(), name: '模板传输验证', createdAt: 0,
    paths: { documents, templates, metadata: 'metadata' }, assetStores: PROJECT_DEFAULTS.assetStores,
    documentTypes: [{ id: 'character', label: '自定义角色', directory: 'characters', parserProfile: 'structured', template,
      parserOptions: { titleField: '姓名' }, fieldGroups: [{ title: '身份与设定', fields: ['姓名', '灵魂数量', '可繁衍'] }] }],
  }));
  await write(root, `${documents}/原文.md`, '# 必须保留的原文\r\n');
  if (!missing) await write(root, `${templates}/${template}`, content);
  for (const [name, text] of Object.entries(decoys)) await write(root, `${templates}/${name}`, text);
  await registerWorkspace(root);
  const manifestBytes = await fs.readFile(path.join(root, 'workspace.json'));
  const registry = await readRegistry(root);
  const base = await serve(t, root);
  const configuration = (await request(base, '/api/project')).data;
  let client;
  const requests = [];
  const h = await editorHarness({
    loadTemplateContent: (options) => client.loadTemplateContent(options),
    writeDoc: (options) => client.writeDoc({ ...options, docApiUrl: `${base}/api/doc` }),
    readDocSource: (options) => client.readDocSource({ ...options, docApiUrl: `${base}/api/doc` }),
  });
  // Keep the production client/reader and HTTP body handling. Only resolve
  // browser-relative URLs against this test server's origin.
  const ui = await dialogHarness('app-doc-service', {
    ...vm.runInContext('({ APP_ERROR_MESSAGES, APP_REQUEST_LABELS })', h.runtime), API_REQUEST_KEYS, fetchJsonApiRequest,
    fetchTextApiRequest: (url, ...args) => {
      const absolute = new URL(url, base).href; requests.push(absolute);
      return fetchTextApiRequest(absolute, ...args);
    },
  });
  client = ui.runtime;
  h.runtime.logRuntimeErrorOrMessage = (_label, error) => error.message;
  h.runtime.rebuildIndexForDoc = (doc) => client.rebuildDocIndex({ rebuildUrl: `${base}/api/rebuild`, sourceFilter: doc.sourcePath });
  h.state.workspace = configuration.workspace; h.state.docs = []; h.state.activePath = '';
  h.runtime.rebuildDocPathCaches([]);
  return { ...h, root, base, documents, templates, template, configuration, client, requests, registry, manifestBytes };
}

async function saveAndReopen(h, content, extension = 'md') {
  const file = `${h.documents}/任意目录/新角色.${extension}`;
  h.element('docCreatePathInput').value = file;
  await h.runtime.saveCurrentDoc();
  assert.equal(h.state.isCreating, false, h.element('docEditStatus').textContent);
  assert.equal(h.state.editHasUnsavedChanges, false);
  assert.deepEqual(await fs.readFile(path.join(h.root, file)), Buffer.from(content));
  const registry = await readRegistry(h.root), record = registry.documents.find((item) => item.sourcePath === file);
  assert.ok(record);
  assert.equal(record.documentType, 'character');
  assert.deepEqual(registry.documents.filter((item) => item.sourcePath !== file), h.registry.documents);
  const read = await h.client.readDocSource({ docApiUrl: `${h.base}/api/doc`, pathValue: file });
  assert.equal(read.content, content);
  assert.equal(h.state.activeEditSourceVersion, read.version);
  h.runtime.exitEditMode({ skipUnsavedConfirm: true });
  await h.runtime.enterEditMode();
  assert.equal(h.runtime.getCurrentEditContent(), content);
  const indexed = (await (await fetch(`${h.base}/data/index.json`)).json()).docs.find((doc) => doc.id === record.id);
  assert.ok(indexed);
  assert.equal(indexed.category, 'character');
  assert.equal(indexed.content, content);
  assert.deepEqual(await fs.readFile(path.join(h.root, 'workspace.json')), h.manifestBytes);
  assert.equal(await fs.readFile(path.join(h.root, h.documents, '原文.md'), 'utf8'), '# 必须保留的原文\r\n');
  assert.deepEqual(await fs.readFile(path.join(h.root, h.templates, h.template)), Buffer.from(content));
  return indexed;
}

for (const version of [2, 3]) for (const [label, template, decoys] of [
  ['fragment filename', '角色.md#副本.md', { '角色.md': '# 不能读取的同名文件\n' }],
  ['fragment directory', '设定#1/角色.md', {}],
  ['literal percent', '100%角色.md', {}],
  ['percent escape', '角色%23参考.md', { '角色#参考.md': '# 不能读取的解码文件\n' }],
  ['encoded separator text', '分组%2f角色.md', { '分组/角色.md': '# 不能读取的目录文件\n' }],
  ['ordinary Unicode and spaces', '世界 设定/角色-🦊.md', {}],
]) test(`template HTTP: v${version} ${label} loads the configured file before creating and reopening`, async (t) => {
  const content = '# 目标模板\r\n\r\n姓名：星裔\r\n灵魂数量：0\r\n';
  const h = await project(t, { version, template, decoys, content });
  assert.equal(h.configuration.entries[0].content, content, 'settings already reads the correct template');
  await h.runtime.enterCreateMode();
  assert.equal(h.runtime.getCurrentEditContent(), content, h.element('docEditStatus').textContent);
  assert.equal(h.requests.length, 1);
  const url = new URL(h.requests[0]);
  assert.equal(url.hash, ''); assert.equal(url.search, '');
  assert.equal(decodeURIComponent(url.pathname), `/${h.templates}/${template}`);
  const indexed = await saveAndReopen(h, content);
  assert.equal(indexed.title, '星裔');
  for (const [name, text] of Object.entries(decoys)) assert.equal(await fs.readFile(path.join(h.root, h.templates, name), 'utf8'), text);
});

for (const [extension, body] of [
  ['md', '# 星裔\r\n\r\n姓名：星裔\r\n灵魂数量：0\r\n可繁衍：false\r\n'],
  ['txt', '星裔\r\n\r\n姓名：星裔\r\n灵魂数量：0\r\n可繁衍：false\r\n'],
  ['json', '{\r\n  "姓名": "星裔", "灵魂数量": 0, "可繁衍": false\r\n}\r\n'],
  ['yaml', '# 模板注释\r\n姓名: 星裔\r\n灵魂数量: 0\r\n可繁衍: false\r\n'],
  ['yml', '# 模板注释\r\n姓名: 星裔\r\n灵魂数量: 0\r\n可繁衍: false\r\n'],
]) test(`template HTTP: ${extension} keeps BOM and CRLF through the reader, creation, indexing and reopening`, async (t) => {
  const content = '\uFEFF' + body;
  const h = await project(t, { template: `角色.${extension}`, content });
  await h.runtime.enterCreateMode();
  assert.equal(h.runtime.getCurrentEditContent(), content);
  assert.ok(h.state.activeCreatePath.endsWith(`.${extension}`));
  const indexed = await saveAndReopen(h, content, extension);
  assert.equal(indexed.title, '星裔');
  const preview = await request(h.base, '/api/project/preview', { type: h.configuration.entries[0].type, format: extension, content });
  assert.equal(preview.status, 200);
  assert.deepEqual(indexed.layout, preview.data.layout, 'creation and preview use the same project parser rules');
});

test('template HTTP: a missing file remains retryable and a valid empty template can be saved', async (t) => {
  const h = await project(t, { missing: true });
  await h.runtime.enterCreateMode();
  assert.match(h.element('docEditStatus').textContent, /模板加载失败/);
  assert.equal(h.state.isLoadingTemplate, false);
  assert.equal(h.state.isCreating, true);
  await write(h.root, `${h.templates}/${h.template}`, '');
  await h.runtime.setCreateTypeState('character');
  assert.equal(h.requests.length, 2);
  assert.equal(h.runtime.getCurrentEditContent(), '');
  assert.doesNotMatch(h.element('docEditStatus').textContent, /模板加载失败/);
  await saveAndReopen(h, '');
});

test('template HTTP: an HTML fallback remains an error instead of becoming document source', async (t) => {
  const h = await project(t);
  await assert.rejects(h.client.loadTemplateContent({ templatePath: '/web/index.html' }), /HTML/);
  assert.deepEqual(await readRegistry(h.root), h.registry);
});
