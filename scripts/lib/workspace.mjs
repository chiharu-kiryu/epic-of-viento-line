import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { legacyDocumentDefaults, validateDocumentModels } from './document-model.mjs';
import { workspacePaths, validateProjectTypes, projectDocumentDefaults } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WORKSPACE_PATHS = Object.freeze({ documents: 'design-data', templates: 'data-template', metadata: 'metadata' });
export const ASSET_STORES = Object.freeze({ main: { path: 'assets' } });
// Older applications only inspect .viento/workspace.json. Keep a permanent guard
// there so they cannot open v2 and silently export an archive without metadata.
export const V2_GUARD = Object.freeze({ format: 'viento-workspace', version: 2, id: '00000000-0000-0000-0000-000000000000', name: 'Viento Studio 0.2+ required', createdAt: 0, compatibilityGuard: true });

export function portablePath(value) {
  return typeof value === 'string' && value.length > 0 && value.split('/').every((part) => part
    && part !== '.' && part !== '..' && !/[<>:"\\|?*\x00-\x1f\x7f-\x9f]/.test(part) && !/[. ]$/.test(part)
    && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
}

function portableName(value) {
  return portablePath(value) && !value.includes('/');
}

const portableKey = (value) => value.normalize('NFC').toLowerCase();

export function readWorkspace(root) {
  const publicPath = path.join(root, 'workspace.json');
  const file = fs.existsSync(publicPath) ? publicPath : path.join(root, '.viento/workspace.json');
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('作品库清单不能是链接');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('作品库格式无效');
  if (value.compatibilityGuard) throw new Error('公共作品清单缺失，请恢复 workspace.json');
  if (value.format !== 'viento-workspace' || ![1, 2, 3].includes(value.version) || !UUID.test(value.id)
    || !portableName(value.name) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error('作品库格式无效或版本不受支持');
  }
  if (value.version >= 2 && (Object.keys(value.paths || {}).length !== 3
    || Object.entries(workspacePaths(value)).some(([key, expected]) => value.paths[key] !== expected)
    || Object.keys(value.assetStores || {}).length !== 1 || value.assetStores.main?.path !== 'assets'
    || Object.keys(value.assetStores.main).length !== 1)) {
    throw new Error('不受支持的作品库目录声明');
  }
  validateProjectTypes(value);
  return value;
}

export function resolveAssetRoot(root) {
  const file = path.join(root, '.viento/local.json');
  if (!fs.existsSync(file)) return path.join(root, 'assets');
  const local = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (local.version !== 1 || (local.assetStores && (typeof local.assetStores !== 'object' || Array.isArray(local.assetStores)))
    || Object.keys(local.assetStores || {}).some((key) => key !== 'main')) throw new Error('无效的本机素材绑定');
  const target = local.assetStores?.main;
  if (target === undefined) return path.join(root, 'assets');
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('素材目录绑定必须是绝对路径');
  return path.resolve(target);
}

let assetLookupCache = null;
export function resolveAssetRequest(root, requestPath) {
  let record;
  if (requestPath.startsWith('asset-files/')) {
    const id = requestPath.slice('asset-files/'.length);
    if (!UUID.test(id)) throw new Error('无效的素材 ID');
    record = JSON.parse(fs.readFileSync(path.join(root, 'metadata/assets', `${id}.json`), 'utf8'));
    if (record.id !== id) throw new Error('素材 ID 不一致');
  } else {
    const indexPath = path.join(root, '.viento/cache/indexes/assets.json');
    if (fs.existsSync(indexPath)) {
      const stat = fs.statSync(indexPath);
      const key = `${indexPath}:${stat.mtimeMs}:${stat.size}`;
      if (assetLookupCache?.key !== key) {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const paths = new Map();
        for (const asset of index.assets) for (const p of [...asset.legacyPaths, `assets/${asset.location.path}`]) paths.set(p, asset);
        assetLookupCache = { key, paths };
      }
      record = assetLookupCache.paths.get(requestPath);
    }
  }
  const relative = record ? record.location?.path : requestPath.slice('assets/'.length);
  if (!portablePath(relative) || (record && record.location.store !== 'main')) throw new Error('无效的素材位置');
  return path.join(resolveAssetRoot(root), relative);
}

export async function writeJson(file, value, { exclusive = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    if (exclusive) await fsp.link(temporary, file);
    else await fsp.rename(temporary, file);
  } finally { await fsp.rm(temporary, { force: true }); }
}

export async function ensureV2Guard(root) {
  const file = path.join(root, '.viento/workspace.json');
  const expected = `${JSON.stringify(V2_GUARD, null, 2)}\n`;
  try {
    if (!(await fsp.lstat(file)).isFile()) throw new Error('兼容标记必须是实际文件');
    const old = await fsp.readFile(file);
    if (old.equals(Buffer.from(expected))) return;
    const history = path.join(root, '.viento/legacy');
    await fsp.mkdir(history, { recursive: true });
    if ((await fsp.lstat(history)).isSymbolicLink()) throw new Error('历史清单目录不能是链接');
    await fsp.writeFile(path.join(history, `workspace-${randomUUID()}.json`), old, { flag: 'wx' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeJson(file, V2_GUARD);
}

export async function walkFiles(root) {
  const result = [];
  async function visit(dir, prefix = '') {
    const stat = await fsp.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`请使用实际文件夹：${dir}`);
    for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
      if (item.name === '.DS_Store' || item.name.startsWith('._') || item.name === 'Thumbs.db') continue;
      const relative = prefix + item.name;
      if (!portablePath(relative)) throw new Error(`文件名无法跨系统迁移：${relative}`);
      if (item.isDirectory()) await visit(path.join(dir, item.name), `${relative}/`);
      else if (item.isFile()) result.push(relative);
      else throw new Error(`不支持的链接或文件类型：${relative}`);
    }
  }
  await visit(root);
  const names = new Set();
  for (const file of result) {
    const key = file.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error(`文件名跨系统冲突：${file}`);
    names.add(key);
  }
  return result.sort();
}

export async function fingerprint(file) {
  const before = await fsp.stat(file);
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  const after = await fsp.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`读取时文件发生变化：${file}`);
  return { size: before.size, sha256: hash.digest('hex') };
}

export async function readRegistry(root) {
  const documentsRoot = workspacePaths(readWorkspace(root)).documents;
  const metadata = path.join(root, 'metadata');
  if (fs.existsSync(metadata) && (await fsp.lstat(metadata)).isSymbolicLink()) throw new Error('元数据目录不能是链接');
  const assets = [], documents = [];
  const ids = new Set(), locations = new Set(), sources = new Set(), aliases = new Set();
  for (const [kind, records] of [['assets', assets], ['documents', documents]]) {
    const folder = path.join(root, 'metadata', kind);
    if (!fs.existsSync(folder)) continue;
    for (const file of await walkFiles(folder)) {
      if (!file.endsWith('.json')) throw new Error(`登记目录只能包含 JSON：${kind}/${file}`);
      const record = JSON.parse(await fsp.readFile(path.join(folder, file), 'utf8'));
      if (!UUID.test(record.id) || file !== `${record.id}.json` || ids.has(record.id) || record.version !== 1) throw new Error(`无效或重复的登记身份：${kind}/${file}`);
      ids.add(record.id);
      if (kind === 'assets') {
        const location = record.location;
        if (record.format !== 'viento-asset' || typeof record.name !== 'string'
          || !['image', 'video', 'audio', 'font', 'text', 'other'].includes(record.kind)
          || location?.store !== 'main' || !portablePath(location.path)
          || !Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== 'string')
          || (record.content !== null && (!Number.isSafeInteger(record.content?.size) || record.content.size < 0 || !/^[a-f0-9]{64}$/.test(record.content?.sha256)))
          || !Array.isArray(record.legacyPaths) || record.legacyPaths.some((p) => !portablePath(p) || !p.startsWith('assets/'))) throw new Error(`无效的素材登记：${file}`);
        const key = location.path.normalize('NFC').toLowerCase();
        if (locations.has(key)) throw new Error(`素材位置登记重复：${location.path}`);
        locations.add(key);
        for (const alias of new Set([`assets/${location.path}`, ...record.legacyPaths].map(portableKey))) {
          if (aliases.has(alias)) throw new Error(`素材旧路径冲突：${alias}`);
          aliases.add(alias);
        }
      } else {
        if (record.format !== 'viento-document' || !portablePath(record.sourcePath) || !record.sourcePath.startsWith(`${documentsRoot}/`)
          || !Array.isArray(record.assetBindings) || record.assetBindings.some((link) => !UUID.test(link.assetId) || typeof link.role !== 'string')) throw new Error(`无效的文档登记：${file}`);
        const key = record.sourcePath.normalize('NFC').toLowerCase();
        if (sources.has(key)) throw new Error(`文档位置登记重复：${record.sourcePath}`);
        sources.add(key);
      }
      records.push(record);
    }
  }
  validateDocumentModels(documents);
  return { assets, documents };
}

function mediaKind(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [kind, types] of Object.entries({ image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'], video: ['.mp4', '.webm', '.mov'], audio: ['.mp3', '.wav', '.ogg', '.flac'], font: ['.ttf', '.otf', '.woff', '.woff2'], text: ['', '.md', '.txt', '.json', '.yml', '.yaml'] })) {
    if (types.includes(ext)) return kind;
  }
  return 'other';
}

async function acquireRegistryLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); await handle.sync(); }
      catch (error) { await handle.close(); await fsp.rm(file, { force: true }); throw error; }
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt !== 0) throw error;
      const before = await fsp.readFile(file, 'utf8');
      let owner;
      try { owner = JSON.parse(before); } catch { throw new Error(`登记锁内容不完整，请确认没有登记进程后移除：${file}`); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('无效的登记锁');
      try { process.kill(owner.pid, 0); throw new Error('作品库正在登记，请稍后重试'); }
      catch (status) { if (status.code !== 'ESRCH') throw status; }
      if (await fsp.readFile(file, 'utf8') !== before) throw new Error('登记锁已变化，请重试');
      await fsp.unlink(file);
    }
  }
}

const registryOperations = new Map();
export async function withRegistryLock(root, operation) {
  const key = path.resolve(root);
  const previous = registryOperations.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const privateRoot = await resolveContainedPath(root, path.join(root, '.viento'), { allowMissing: true });
    await fsp.mkdir(privateRoot, { recursive: true });
    const lockPath = await resolveContainedPath(root, path.join(privateRoot, 'registry.lock'), { allowMissing: true });
    let lock;
    try { lock = await acquireRegistryLock(lockPath); }
    catch (error) { throw Object.assign(error, { statusCode: 409, errorCode: 'registry_busy' }); }
    try { return await operation(); }
    finally { await lock.close(); await fsp.rm(lockPath, { force: true }); }
  });
  registryOperations.set(key, task);
  try { return await task; }
  finally { if (registryOperations.get(key) === task) registryOperations.delete(key); }
}

export async function registerWorkspace(root, { name, legacyIndex, scanAssets = true } = {}) {
  const configured = readWorkspace(root);
  const paths = workspacePaths(configured);
  for (const folder of ['', '.viento', paths.documents, paths.templates, 'assets', 'metadata', 'metadata/assets', 'metadata/documents']) {
    const target = path.join(root, folder);
    try {
      const stat = await fsp.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`请使用实际文件夹：${target}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (name !== undefined && !portableName(name)) throw new Error('无效的作品库名称');
  await fsp.mkdir(path.join(root, '.viento'), { recursive: true });
  const lockPath = path.join(root, '.viento/registry.lock');
  const lock = await acquireRegistryLock(lockPath);
  try {
    const previous = readWorkspace(root);
    const defaultName = portableName(path.basename(root)) ? path.basename(root) : '作品库';
    const manifest = { ...previous, format: 'viento-workspace', version: previous?.version === 3 ? 3 : 2, id: previous?.id || randomUUID(), name: name || previous?.name || defaultName, createdAt: previous?.createdAt ?? Date.now(), paths, assetStores: { ...ASSET_STORES } };
    for (const folder of [paths.documents, paths.templates, 'assets', 'metadata/assets', 'metadata/documents']) await fsp.mkdir(path.join(root, folder), { recursive: true });
    const registry = await readRegistry(root);
    if (!legacyIndex && registry.documents.length === 0) {
      for (const relative of ['.viento/cache/web/data/index.json', 'web/data/index.json']) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file)) continue;
        const candidate = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!Array.isArray(candidate.docs)) throw new Error(`旧索引结构无效，请保留并检查：${file}`);
        legacyIndex = candidate;
        break;
      }
    }
    const byLocation = new Map(registry.assets.map((a) => [a.location.path, a]));
    const bySource = new Map(registry.documents.map((d) => [d.sourcePath, d]));
    const assetRoot = resolveAssetRoot(root);
    // Validate the whole inventory before writing registration files; missing stores are retained.
    const assetFiles = scanAssets && fs.existsSync(assetRoot) ? await walkFiles(assetRoot) : [];
    const documentFiles = (await walkFiles(path.join(root, paths.documents))).filter((file) => ['', '.md', '.txt', '.json', '.yml', '.yaml'].includes(path.extname(file).toLowerCase()));
    const reservedAliases = new Set(registry.assets.flatMap((asset) => [
      `assets/${asset.location.path}`, ...asset.legacyPaths,
    ]).map(portableKey));
    // A renamed asset still owns its old URLs. Reject the whole inventory before
    // writing any descriptors, rather than making the registry unreadable.
    for (const file of assetFiles) {
      if (!byLocation.has(file) && reservedAliases.has(portableKey(`assets/${file}`))) {
        throw new Error(`素材旧路径冲突：assets/${file}；请为新增素材换名或更新原素材的旧路径登记`);
      }
    }
    for (const [files, existing] of [[assetFiles, byLocation], [documentFiles.map((file) => `${paths.documents}/${file}`), bySource]]) {
      const normalized = new Map([...existing.keys()].map((file) => [file.normalize('NFC').toLowerCase(), file]));
      for (const file of files) {
        const registered = normalized.get(file.normalize('NFC').toLowerCase());
        if (registered && registered !== file) throw new Error(`文件路径变更需更新原登记，不能重复分配身份：${registered} → ${file}`);
      }
    }
    let addedAssets = 0, addedDocuments = 0;
    for (const file of assetFiles) {
      if (byLocation.has(file)) continue;
      const record = { format: 'viento-asset', version: 1, id: randomUUID(), name: path.basename(file, path.extname(file)), kind: mediaKind(file), tags: [], location: { store: 'main', path: file }, content: await fingerprint(path.join(assetRoot, file)), legacyPaths: [`assets/${file}`] };
      await writeJson(path.join(root, 'metadata/assets', `${record.id}.json`), record, { exclusive: true });
      byLocation.set(file, record); addedAssets++;
    }
    const oldDocs = new Map((legacyIndex?.docs || []).map((d) => [d.source?.path?.replace(/^docs-standard\//, ''), d]));
    for (const file of documentFiles) {
      const sourcePath = `${paths.documents}/${file}`;
      if (bySource.has(sourcePath)) continue;
      const old = oldDocs.get(sourcePath);
      const bindings = (old?.heroImages || []).map((p) => byLocation.get(p.replace(/^assets\//, ''))).filter(Boolean);
      const record = { format: 'viento-document', version: 1, id: randomUUID(), sourcePath, ...(manifest.version === 3 ? projectDocumentDefaults(manifest, sourcePath) : legacyDocumentDefaults(sourcePath)), ...(old?.path ? { legacyId: old.path } : {}), assetBindings: [...new Set(bindings.map((a) => a.id))].map((assetId) => ({ assetId, role: 'attachment', origin: 'legacy-index' })) };
      await writeJson(path.join(root, 'metadata/documents', `${record.id}.json`), record, { exclusive: true });
      addedDocuments++;
    }
    await writeJson(path.join(root, 'workspace.json'), manifest);
    await ensureV2Guard(root);
    return { workspace: manifest, addedAssets, addedDocuments, assets: byLocation.size, documents: bySource.size + addedDocuments };
  } finally { await lock.close(); await fsp.rm(lockPath, { force: true }); }
}

export async function verifyWorkspace(root) {
  const workspace = readWorkspace(root);
  if (![2, 3].includes(workspace?.version)) throw new Error('请先登记作品库');
  const registry = await readRegistry(root);
  const assetRoot = resolveAssetRoot(root);
  const problems = [];
  for (const record of registry.assets) {
    try {
      const real = await fsp.realpath(path.join(assetRoot, record.location.path));
      const relative = path.relative(await fsp.realpath(assetRoot), real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('文件越出素材目录');
      const actual = await fingerprint(real);
      if (!record.content || actual.size !== record.content.size || actual.sha256 !== record.content.sha256) throw new Error('内容指纹不一致或尚未登记');
    } catch (error) { problems.push({ id: record.id, path: record.location.path, error: error.message }); }
  }
  const assetIds = new Set(registry.assets.map((a) => a.id));
  for (const record of registry.documents) {
    if (!fs.existsSync(path.join(root, record.sourcePath))) problems.push({ id: record.id, path: record.sourcePath, error: '文档源文件缺失' });
    for (const binding of record.assetBindings) if (!assetIds.has(binding.assetId)) problems.push({ id: record.id, error: `未知素材 ${binding.assetId}` });
  }
  return { assets: registry.assets.length, documents: registry.documents.length, ok: problems.length === 0, problems };
}

// An explicit, resumable descriptor migration shares the registration lock.
// Only descriptors change; original source and asset files remain authoritative.
export async function updateDocumentModels(root, transform, { write = false } = {}) {
  if (![2, 3].includes(readWorkspace(root)?.version)) throw new Error('请先登记作品库');
  const lockPath = path.join(root, '.viento/registry.lock');
  const lock = await acquireRegistryLock(lockPath);
  try {
    const registry = await readRegistry(root);
    const plan = transform(registry.documents);
    validateDocumentModels(plan.documents);
    const byId = new Map(plan.documents.map((record) => [record.id, record]));
    if (byId.size !== registry.documents.length) throw new Error('元数据迁移不能改变文档身份或数量');
    const changes = registry.documents.flatMap((before) => {
      const after = byId.get(before.id);
      if (!after || after.sourcePath !== before.sourcePath
        || JSON.stringify(after.assetBindings) !== JSON.stringify(before.assetBindings)) throw new Error('元数据迁移不能改变源文件或素材绑定');
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ before, after }];
    });
    let journal = null;
    if (write && changes.length) {
      journal = `.viento/migrations/document-model-${Date.now()}.json`;
      await writeJson(path.join(root, journal), { version: 1, changes });
      const applied = [];
      try {
        for (const change of changes) {
          await writeJson(path.join(root, 'metadata/documents', `${change.after.id}.json`), change.after);
          applied.push(change);
        }
      } catch (error) {
        for (const change of applied.reverse()) await writeJson(path.join(root, 'metadata/documents', `${change.before.id}.json`), change.before);
        throw error;
      }
    }
    return { write, changed: changes.length, documents: plan.documents.length,
      ownedDocuments: plan.documents.filter((record) => record.relations?.some((relation) => relation.kind === 'part-of')).length,
      ownershipLinks: plan.documents.reduce((n, record) => n + (record.relations || []).filter((relation) => relation.kind === 'part-of').length, 0),
      unresolved: plan.unresolved || [], journal };
  } finally { await lock.close(); await fsp.rm(lockPath, { force: true }); }
}

export async function registeredAssetCatalog(root) {
  if (![2, 3].includes(readWorkspace(root)?.version)) return null;
  const registry = await readRegistry(root);
  const byId = new Map(registry.assets.map((a) => [a.id, a]));
  const byPath = new Map();
  for (const asset of registry.assets) for (const file of [...asset.legacyPaths, `assets/${asset.location.path}`]) byPath.set(file, asset);
  const files = [...byPath.entries()].filter(([, a]) => a.kind === 'image').map(([file]) => file);
  const byBaseName = new Map();
  for (const file of files) {
    const base = path.basename(file, path.extname(file)).toLowerCase();
    byBaseName.set(base, [...(byBaseName.get(base) || []), file]);
  }
  return { registered: true, registry, byId, byPath, files, fileSet: new Set(files), byBaseName, bySource: new Map(registry.documents.map((d) => [d.sourcePath, d])) };
}

export async function buildRegistryIndexes(root, docs, generation) {
  const catalog = await registeredAssetCatalog(root);
  if (!catalog) return null;
  const store = resolveAssetRoot(root);
  const online = fs.existsSync(store);
  const assets = [];
  for (const record of catalog.registry.assets) {
    let status = online ? 'missing' : 'offline';
    try { const stat = await fsp.stat(path.join(store, record.location.path)); status = stat.isFile() ? (record.content && stat.size !== record.content.size ? 'changed' : 'available') : 'missing'; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) status = 'unreadable'; }
    assets.push({ ...record, status, url: `/asset-files/${record.id}` });
  }
  const references = [];
  for (const doc of docs) for (const assetId of doc.assetRefs || []) references.push({ documentId: doc.id || null, sourcePath: doc.source.path.replace(/^docs-standard\//, ''), assetId, resolved: catalog.byId.has(assetId) });
  for (const doc of docs) for (const legacyPath of doc.unresolvedAssetPaths || []) references.push({ documentId: doc.id || null, sourcePath: doc.source.path.replace(/^docs-standard\//, ''), assetId: null, legacyPath, resolved: false });
  return { assets: { generation, count: assets.length, assets }, references: { generation, count: references.length, references } };
}
