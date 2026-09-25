import {
  createDocumentStore, createProjectModel, parseSourceContent, createDocumentFieldDraft,
  buildDocumentLayout, attachDocumentHierarchy, makeCapabilitiesPayload, API_PATHS,
} from '../engine/index.mjs';

export function nativeFailure(value) {
  if (value instanceof Error) return value;
  const payload = value?.payload || {};
  if (Number.isFinite(payload.modifiedAt)) payload.lastModified = new Date(payload.modifiedAt).toISOString();
  return Object.assign(new Error(value?.message || String(value)), {
    statusCode: value?.statusCode || 500, errorCode: value?.errorCode || '', payload,
  });
}

export function createMobilePlatform({ invoke, workspaceId }) {
  const transactions = new Map();
  const canonical = (path) => path.replace(/^docs-standard\//, '');
  const call = async (action, path, payload, signal) => {
    signal?.throwIfAborted();
    let aborted;
    const pending = new Promise((resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal?.addEventListener('abort', aborted, { once: true });
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return invoke('mobile_storage', { action, workspaceId, path, payload });
      }).then(resolve, reject);
    });
    try { return await pending; }
    catch (error) { throw nativeFailure(error); }
    finally { signal?.removeEventListener('abort', aborted); }
  };
  const snapshot = (value) => ({ ...value, lastModified: new Date(value.modifiedAt).toISOString() });
  const storage = (signal) => ({
    async transaction(path, operation) {
      const key = canonical(path), previous = transactions.get(key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      transactions.set(key, current);
      await previous;
      try { signal?.throwIfAborted(); return await operation(); }
      finally { release(); if (transactions.get(key) === current) transactions.delete(key); }
    },
    async resolve(path) {
      const reference = await call('resolve', canonical(path), undefined, signal);
      return { ...reference, handle: reference.path };
    },
    async read(reference) { return snapshot(await call('read', reference.handle, undefined, signal)); },
    async write(reference, content, { create, previous, documentType }) {
      // The native host compares the revision again inside its own shared lock.
      return snapshot(await call('save', undefined, { path: reference.handle, content, create,
        expectedVersion: previous?.version, documentType }, signal));
    },
  });

  async function context(signal) {
    const data = await call('context', undefined, undefined, signal);
    return { ...data, model: createProjectModel(data.defaults) };
  }
  async function index(signal) {
    const { manifest, documents, model } = await context(signal);
    const docs = new Array(documents.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(documents.length, 4) }, async () => {
      while (cursor < documents.length) {
        const at = cursor++, record = documents[at];
        const source = snapshot(await call('read', record.sourcePath, undefined, signal));
        const descriptor = model.resolveDocumentDefinition(manifest, record.sourcePath, record);
        const parsed = parseSourceContent(source.content, record.sourcePath, descriptor);
        const group = descriptor.typeLabel || descriptor.documentType;
        docs[at] = {
          ...parsed, id: record.id, path: record.legacyId || `document/${record.id}`,
          title: parsed.title, name: parsed.title, category: descriptor.documentType, group, purpose: group,
          sourcePath: record.sourcePath, source: { path: record.sourcePath }, type: parsed.format || parsed.type,
          raw: source.content, rawPath: record.sourcePath, layout: buildDocumentLayout(parsed),
          meta: { title: parsed.title, category: descriptor.documentType, group, purpose: group },
          documentType: descriptor.documentType, parserProfile: descriptor.parserProfile,
          parser: { contentType: parsed.type, format: parsed.format, profile: parsed.profile,
            ...(parsed.parseError ? { error: parsed.parseError } : {}) },
          relations: record.relations || [], images: [], heroSkills: [],
          lastModified: source.lastModified, _sourceVersion: source.version,
        };
      }
    }));
    return { docs: attachDocumentHierarchy(docs), count: docs.length,
      workspace: model.projectDefinition(manifest), generatedAt: new Date().toISOString() };
  }

  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  async function request(url, options = {}) {
    const signal = options.signal;
    signal?.throwIfAborted();
    const pathname = new URL(url, 'https://tauri.localhost').pathname;
    const method = options.method || 'GET';
    try {
      const { manifest, model, documents } = await context(signal);
      const prefixes = [model.workspacePaths(manifest).documents + '/', `docs-standard/${model.workspacePaths(manifest).documents}/`];
      const store = createDocumentStore({ storage: storage(signal), editablePrefixes: prefixes });
      const query = new URL(url, 'https://tauri.localhost').searchParams;
      const body = options.body ? JSON.parse(options.body) : {};
      if (method === 'GET' && pathname === API_PATHS.CAPABILITIES) {
        const capabilities = makeCapabilitiesPayload(prefixes, 'disabled', 'android-native');
        capabilities.capabilities = { edit: true, create: true, rebuild: true, media: false, export: false, project: false };
        capabilities.endpoints = [API_PATHS.CAPABILITIES, API_PATHS.INDEX, API_PATHS.DOC, API_PATHS.REBUILD, API_PATHS.FIELDS];
        return json(capabilities);
      }
      if (method === 'GET' && ['/data/index.json', '/web/data/index.json', API_PATHS.INDEX].includes(pathname)) return json(await index(signal));
      if (pathname === API_PATHS.DOC) {
        if (method === 'GET') return json(await store.getDocByPath(query.get('path')));
        if (method === 'POST') return json(await store.writeDoc(body));
      }
      if (method === 'POST' && pathname === API_PATHS.REBUILD) return json({ ok: true, data: { generatedAt: new Date().toISOString() } });
      if (method === 'GET' && pathname.startsWith(`/${model.workspacePaths(manifest).templates}/`)) {
        const value = await call('template', decodeURIComponent(pathname.slice(1)), undefined, signal);
        return new Response(new TextEncoder().encode(value.content), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      if (method === 'POST' && pathname === API_PATHS.FIELDS) {
        if (typeof body.content !== 'string' || typeof body.sourcePath !== 'string') return json({ ok: false, error: 'bad path' }, 400);
        const record = documents.find((record) => record.sourcePath === canonical(body.sourcePath));
        const descriptor = model.resolveDocumentDefinition(manifest, canonical(body.sourcePath), record || (body.documentType ? { documentType: body.documentType } : {}));
        return json(createDocumentFieldDraft(body.content, body.sourcePath, descriptor));
      }
      if (method === 'GET' && pathname === API_PATHS.PROJECT) return json({ project: model.projectDefinition(manifest) });
      return json({ ok: false, error: '当前移动端预览版尚不支持此操作' }, 501);
    } catch (failure) {
      if (signal?.aborted) throw signal.reason;
      const error = nativeFailure(failure);
      return json({ ok: false, error: error.message, errorCode: error.errorCode, ...error.payload,
        userMessage: { key: error.message, values: [] } }, error.statusCode || 500);
    }
  }
  return { request, index };
}
