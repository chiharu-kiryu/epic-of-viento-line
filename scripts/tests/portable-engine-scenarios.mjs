// The same scenarios run in a restricted JS context and in a real browser.
// No Node imports or application server endpoints are available to this module.
import * as engine from '../../engine/index.mjs';

const equal = (actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
};
async function rejected(operation, status) {
  try { await operation(); } catch (error) { equal(error.statusCode, status); return error; }
  throw new Error(`Expected error ${status}`);
}

function memoryStorage() {
  const entries = new Map(), records = new WeakMap(), locks = new Map();
  let revision = 0, failure = false, calls = 0;
  const canonical = (name) => name.replace(/^docs-standard\//, '');
  return {
    failNextWrite() { failure = true; },
    get calls() { return calls; },
    async transaction(name, operation) {
      const key = canonical(name), previous = locks.get(key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      locks.set(key, current);
      await previous;
      try { return await operation(); }
      finally { release(); if (locks.get(key) === current) locks.delete(key); }
    },
    async resolve(name) {
      calls++;
      const path = canonical(name), handle = entries.get(path) || Object.freeze({});
      return { path, handle, exists: records.has(handle) };
    },
    async read(reference) {
      const record = records.get(reference.handle);
      if (!record) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { ...record, writeState: reference.handle };
    },
    async write(reference, content, { create, previous, documentType }) {
      if (failure) { failure = false; throw new Error('storage full'); }
      if (!create && previous.writeState !== reference.handle) throw new Error('Opaque write state was lost');
      if (create && records.has(reference.handle)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const snapshot = { content, version: String(++revision), lastModified: new Date(revision).toISOString(), documentType };
      entries.set(reference.path, reference.handle);
      records.set(reference.handle, snapshot);
      return snapshot;
    },
  };
}

export async function runPortableEngineScenarios(defaults) {
  const checks = [];
  const check = async (name, operation) => { await operation(); checks.push({ name, status: 'passed' }); };
  await check('No Node globals or native filesystem', () => {
    equal(typeof process, 'undefined'); equal(typeof Buffer, 'undefined'); equal(typeof require, 'undefined');
  });

  const model = engine.createProjectModel(defaults);
  const manifest = { version: 3, id: 'portable-project', name: '测试 / Test / テスト', documentTypes: [{
    id: 'character', label: '角色', directory: 'characters', template: 'character.md', parserProfile: 'structured',
    parserOptions: { titleField: 'Name' }, fieldGroups: [{ title: 'Attributes', fields: ['HP'] }],
  }] };
  const descriptor = model.resolveDocumentDefinition(manifest, 'documents/moved.md', { id: 'stable-id', documentType: 'character' });
  await check('Project types, templates and registered identity', () => {
    engine.validateProjectTypes(manifest);
    equal(model.workspacePaths(manifest), defaults.paths);
    equal(model.projectDefinition(manifest).documentTypes[0].content, defaults.templates['character.md']);
    equal(descriptor.id, 'stable-id'); equal(descriptor.documentType, 'character');
    equal(model.workspacePaths({ version: 2 }).documents, 'design-data');
  });

  for (const [extension, source] of [
    ['md', '\uFEFF# Character\r\nName: 旅人\r\nHP: 100\r\n\r\n原文 / Original / 原文。\r\n'],
    ['txt', 'Name: 旅人\nHP: 100\n'],
    ['json', '\uFEFF{ "Name": "旅人", "HP": 100, "id": 900719925474099312345 }\r\n'],
    ['yaml', '\uFEFF# 注释\r\nName: 旅人\r\nHP: 100 # 保留\r\nid: 900719925474099312345\r\n'],
  ]) await check(`${extension}: parse, layout and lossless field edit`, () => {
    const file = `documents/characters/旅人.${extension}`;
    const parsed = engine.parseSourceContent(source, file, descriptor);
    equal(parsed.title, '旅人');
    equal(engine.buildDocumentLayout(parsed).sections[0].title, 'Attributes');
    const fields = engine.createDocumentFieldDraft(source, file, descriptor);
    equal(engine.serializeFieldDraft(source, fields, []), source);
    const changed = engine.serializeFieldDraft(source, fields, fields.fields.map((field) => field.key === 'HP' ? '125' : field.value));
    equal(changed, source.replace('100', '125'));
    equal(String(engine.parseSourceContent(changed, file, descriptor).fields.HP), '125');
  });

  await check('Image, video and audio insertion preserve source and IDs', () => {
    const assets = ['image', 'video', 'audio'].map((type, index) => ({
      type, src: `asset:00000000-0000-4000-8000-00000000000${index}`, caption: `${type} / 素材`,
    }));
    for (const [ext, source] of [['json', '\uFEFF{ "id": 900719925474099312345 }\r\n'], ['yaml', '\uFEFF# 注释\r\nid: 900719925474099312345\r\n']]) {
      const draft = engine.prepareMediaDraft(source, `documents/媒体.${ext}`, assets);
      equal(draft.media, assets);
      equal(draft.content.includes('900719925474099312345'), true);
      equal(draft.content.startsWith('\uFEFF'), true);
      equal(engine.prepareMediaDraft(draft.content, `documents/媒体.${ext}`).media, assets);
    }
  });

  const storage = memoryStorage(), writes = [];
  const store = engine.createDocumentStore({ storage, editablePrefixes: ['documents/', 'docs-standard/documents/'], onWrite: (path) => { writes.push(path); } });
  const path = 'documents/characters/旅人.md';
  await check('Create, read and save using opaque storage handles', async () => {
    const created = await store.writeDoc({ path, content: '# 初稿\r\n', create: true, documentType: 'character' });
    equal(created.ok, true);
    const read = await store.getDocByPath(path);
    equal(read.title, '旅人'); equal(read.type, 'md'); equal(read.content, '# 初稿\r\n'); equal(read.version, created.version);
    const result = await store.writeDoc({ path, content: '# 保存済み\r\n', expectedVersion: read.version });
    equal((await store.getDocByPath(path)).version, result.version);
    equal(writes.length, 2);
  });
  await check('Concurrent aliases, stale drafts and failed writes preserve data', async () => {
    const before = await store.getDocByPath(path);
    const results = await Promise.allSettled(['first', 'second'].map((content, index) => store.writeDoc({
      path: index ? `docs-standard/${path}` : path, content, expectedVersion: before.version,
    })));
    equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    equal(results.find((result) => result.status === 'rejected').reason.statusCode, 409);
    const latest = await store.getDocByPath(path), writesBefore = writes.length;
    const conflict = await rejected(() => store.writeDoc({ path, content: 'stale', expectedVersion: before.version }), 409);
    equal(conflict.payload.currentVersion, latest.version);
    await rejected(() => store.writeDoc({ path, content: 'no version' }), 409);
    await rejected(() => store.writeDoc({ path, content: 'duplicate', create: true }), 409);
    storage.failNextWrite();
    await rejected(() => store.writeDoc({ path, content: 'failed', expectedVersion: latest.version }), 500);
    equal(await store.getDocByPath(path), latest); equal(writes.length, writesBefore);
    await store.writeDoc({ path, content: 'recovered', expectedVersion: latest.version });
    equal((await store.getDocByPath(path)).content, 'recovered');
  });
  await check('Invalid logical paths never reach storage', async () => {
    const before = storage.calls;
    for (const path of ['../secret.md', '/documents/a.md', 'documents/../secret.md', 'content://provider/file', 'C:/documents/a.md', 'documents\\a.md', 'metadata/a.json']) {
      await rejected(() => store.getDocByPath(path), 400);
      await rejected(() => store.writeDoc({ path, content: 'escape', create: true }), 400);
    }
    equal(storage.calls, before);
  });
  return checks;
}
