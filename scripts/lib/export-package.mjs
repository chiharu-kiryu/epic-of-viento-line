import { userError, userMessage } from './user-message.mjs';
import fs from 'node:fs/promises';
import { constants, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { portablePath, readWorkspace, readRegistry, resolveAssetRoot, walkFiles, assertPortableFileTree } from './workspace.mjs';
import { workspacePaths, resolveDocumentDefinition } from './project-layout.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { collectDocumentMedia, mediaKindForName, mediaUrl } from './media-format.mjs';
import { collectAssetImageRefs } from './image-index.mjs';
import { parseSourceContent } from '../standardize-docs/doc-factory.mjs';
import { buildDocumentLayout } from '../standardize-docs/layout.mjs';
import { renderExport } from './export-render.mjs';
import { formatMessage } from '../../web/i18n/messages.js';
import { isSupportedLanguage } from '../../web/i18n/languages.js';

const MAX_FILES = 200000;
const MAX_FILE_BYTES = 8 * 1024 ** 3;
const MAX_TOTAL_BYTES = 64 * 1024 ** 3;
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const signature = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
export const exportError = (message, statusCode = 400) => userError(message, statusCode, 'export_failed');
export function exportFileName(name, suffix) {
  const cleaned = String(name || '作品').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/gu, '_');
  const safe = Array.from(cleaned).slice(0, 70).join('').replace(/[. ]+$/g, '');
  return `${portablePath(safe) ? safe : '作品'}${suffix}`;
}

async function existing(file, signal) {
  signal?.throwIfAborted();
  try {
    await fs.lstat(file); signal?.throwIfAborted(); return true;
  } catch (error) { signal?.throwIfAborted(); if (error.code === 'ENOENT') return false; throw error; }
}

export async function planExport(root, options = {}, signal) {
  signal?.throwIfAborted();
  if (!options || !['document', 'workspace'].includes(options.kind)) throw exportError('请选择文档分享或完整项目包');
  if (options.kind === 'document' && !['markdown', 'html'].includes(options.format)) throw exportError('请选择 Markdown 或离线网页');
  const language = options.language === undefined ? 'zh-CN' : options.language;
  if (!isSupportedLanguage(language)) throw exportError('不支持的界面语言');
  const t = (key, ...values) => formatMessage(language, key, ...values);
  const manifest = readWorkspace(root);
  const paths = workspacePaths(manifest);
  const registry = await readRegistry(root, { signal });
  signal?.throwIfAborted();
  const assetRoot = resolveAssetRoot(root);
  const entries = new Map(), snapshots = new Map();
  const folderSnapshots = [];
  const missingPaths = [];
  async function snapshotExists(file) {
    if (await existing(file, signal)) return true;
    // Absence is part of a complete-project snapshot too: a first import or
    // restored manifest must not be silently left out of a successful package.
    missingPaths.push(file);
    return false;
  }
  const addBuffer = (name, buffer) => entries.set(name, { path: name, buffer });
  async function addFile(base, relative, name = relative, expected = null) {
    signal?.throwIfAborted();
    if (!portablePath(name)) throw exportError(userMessage`文件名无法跨系统导出：${name}`);
    let absolute, stat;
    try {
      absolute = await resolveContainedPath(base, path.join(base, relative));
      signal?.throwIfAborted();
      stat = await fs.stat(absolute);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'ENOENT') throw exportError(userMessage`文件或素材缺失，无法完整导出：${relative}`);
      throw error;
    }
    if (!stat.isFile()) throw exportError(userMessage`导出内容必须是实际文件：${relative}`);
    if (stat.size > MAX_FILE_BYTES) throw exportError(userMessage`文件超过 8 GiB 限制：${relative}`);
    const entry = { path: name, base, relative, absolute, stat, expected };
    entries.set(name, entry);
    snapshots.set(absolute, entry);
    return entry;
  }
  async function addFolder(base, folder) {
    const files = await walkFiles(base, { signal });
    folderSnapshots.push({ base, files });
    for (const file of files) await addFile(base, file, `${folder}/${file}`);
  }
  async function validateSnapshot(snapshotSignal = signal) {
    try {
      snapshotSignal?.throwIfAborted();
      for (const entry of snapshots.values()) {
        const file = await resolveContainedPath(entry.base, path.join(entry.base, entry.relative));
        snapshotSignal?.throwIfAborted();
        const stat = await fs.stat(file);
        snapshotSignal?.throwIfAborted();
        if (file !== entry.absolute || signature(stat) !== signature(entry.stat)) throw exportError(userMessage`导出期间文件发生变化，请保存后重试：${entry.relative}`, 409);
      }
      for (const { base, files } of folderSnapshots) {
        const current = await walkFiles(base, { signal: snapshotSignal });
        snapshotSignal?.throwIfAborted();
        if (JSON.stringify(current) !== JSON.stringify(files)) throw exportError('导出期间项目文件发生变化，请保存后重试', 409);
      }
      for (const file of missingPaths) {
        if (await existing(file, snapshotSignal)) throw exportError(userMessage`导出期间项目文件发生变化，请保存后重试：${path.relative(root, file)}`, 409);
      }
      snapshotSignal?.throwIfAborted();
      if (JSON.stringify(readWorkspace(root)) !== JSON.stringify(manifest)
        || resolveAssetRoot(root) !== assetRoot) throw exportError('导出期间项目配置或登记信息发生变化，请重试', 409);
      const currentRegistry = await readRegistry(root, { signal: snapshotSignal });
      snapshotSignal?.throwIfAborted();
      if (JSON.stringify(currentRegistry) !== JSON.stringify(registry)) throw exportError('导出期间项目配置或登记信息发生变化，请重试', 409);
    } catch (error) { snapshotSignal?.throwIfAborted(); throw error; }
  }

  let title, archiveManifest, documentCount = 0, assetCount = 0;
  if (options.kind === 'workspace') {
    const workspace = manifest || { format: 'viento-workspace', version: 1, id: randomUUID(), name: exportFileName(path.basename(root), ''), createdAt: Math.floor(Date.now() / 1000) };
    title = workspace.name;
    for (const folder of [paths.documents, paths.templates, ...(workspace.version >= 2 ? ['metadata'] : []), 'assets']) {
      const base = folder === 'assets' ? assetRoot : path.join(root, folder);
      if (await snapshotExists(base)) {
        await resolveContainedPath(folder === 'assets' ? path.dirname(base) : root, base);
        await addFolder(base, folder);
      } else if (folder === paths.documents || (folder === 'assets' && base !== path.join(root, 'assets'))) {
        throw exportError(userMessage`项目目录不可用，无法完整导出：${folder}`);
      }
    }
    if (await snapshotExists(path.join(root, 'workspace.json'))) await addFile(root, 'workspace.json');
    else addBuffer('workspace.json', json(workspace));
    if (workspace.version >= 2 && await snapshotExists(path.join(root, '.viento/workspace.json'))) await addFile(root, '.viento/workspace.json');
    for (const asset of registry.assets) {
      if (!entries.has(`assets/${asset.location.path}`)) throw exportError(userMessage`素材缺失，无法完整导出：${asset.name}`);
      entries.get(`assets/${asset.location.path}`).expected = asset.content;
    }
    for (const doc of registry.documents) {
      if (!entries.has(doc.sourcePath)) throw exportError(userMessage`登记的正文缺失：${doc.sourcePath}`);
      for (const binding of doc.assetBindings) if (!registry.assets.some((asset) => asset.id === binding.assetId)) throw exportError(userMessage`文档引用的素材未登记：${doc.sourcePath}`);
    }
    documentCount = registry.documents.length;
    assetCount = [...entries.keys()].filter((name) => name.startsWith('assets/')).length;
    archiveManifest = { format: 'viento-archive', version: workspace.version === 3 ? 3 : 2, exportedAt: Math.floor(Date.now() / 1000), workspace };
  } else {
    const source = options.path;
    if (!portablePath(source) || !source.startsWith(`${paths.documents}/`)) throw exportError('请选择当前项目中的正文文档');
    if (!/\.(md|txt|json|ya?ml)$/i.test(source) && path.extname(source)) throw exportError('该文件类型不支持文档分享');
    const byPath = new Map(registry.documents.map((doc) => [doc.sourcePath, doc]));
    const selected = [], seen = new Set();
    function select(sourcePath, depth = 0) {
      if (seen.has(sourcePath)) return;
      seen.add(sourcePath);
      const descriptor = byPath.get(sourcePath) || {};
      selected.push({ sourcePath, descriptor, depth });
      if (options.includeChildren !== false && descriptor.id) {
        for (const child of registry.documents.filter((doc) => doc.relations?.some((link) => link.kind === 'part-of' && link.targetId === descriptor.id))) select(child.sourcePath, depth + 1);
      }
    }
    select(source);
    const assetsByUrl = new Map(), usedAssets = new Map();
    for (const asset of registry.assets) {
      assetsByUrl.set(`/asset-files/${asset.id}`, asset);
      // Registry paths are literal filenames, not already encoded URLs.
      for (const alias of [`assets/${asset.location.path}`, ...asset.legacyPaths]) assetsByUrl.set(`/${alias.split('/').map(encodeURIComponent).join('/')}`, asset);
    }
    function resolveMedia(src) {
      const url = mediaUrl(src);
      if (!url) throw exportError(userMessage`素材引用无效：${src}`);
      const registered = assetsByUrl.get(url);
      if (!registered && url.startsWith('/asset-files/')) throw exportError(userMessage`素材引用未登记：${src}`);
      const relative = registered?.location.path || url.slice('/assets/'.length).split('/').map(decodeURIComponent).join('/');
      const id = registered?.id || digest(relative).slice(0, 32);
      if (!usedAssets.has(id)) usedAssets.set(id, {
        ...registered, id, name: registered?.name || path.basename(relative),
        kind: registered?.kind || mediaKindForName(relative) || 'other',
        relative, path: `assets/${id}${path.extname(relative).toLowerCase()}`, expected: registered?.content,
      });
      return usedAssets.get(id);
    }
    const documents = [];
    let documentBytes = 0;
    for (const item of selected) {
      const entry = await addFile(root, item.sourcePath, `sources/${item.sourcePath}`);
      if (entry.stat.size > 16 * 1024 ** 2) throw exportError(userMessage`正文过大，请使用完整项目包：${item.sourcePath}`);
      documentBytes += entry.stat.size;
      if (documentBytes > 64 * 1024 ** 2) throw exportError('所选正文超过 64 MB，请分开分享或使用完整项目包');
      const raw = await fs.readFile(entry.absolute, { signal }).catch(error => { signal?.throwIfAborted(); throw error; });
      signal?.throwIfAborted();
      entry.expected = { size: raw.length, sha256: digest(raw) };
      const parsed = parseSourceContent(raw.toString('utf8'), item.sourcePath, resolveDocumentDefinition(manifest, item.sourcePath, item.descriptor));
      if (parsed.parseError) throw exportError(userMessage`正文解析失败，请修正格式后导出：${item.sourcePath}`);
      // Match the reference index: declarations and legacy image paths also
      // carry assets, even when the layout has no inline player or image.
      const media = collectDocumentMedia(parsed.blocks);
      const references = [
        ...(item.descriptor.assetBindings || []).map((binding) => `asset:${binding.assetId}`),
        ...media.urls,
        ...collectAssetImageRefs(media.text, item.sourcePath).map((file) => `/${file.split('/').map(encodeURIComponent).join('/')}`),
      ];
      const linkedAssets = [...new Map(references.map((src) => {
        const asset = resolveMedia(src);
        return [asset.id, asset];
      })).values()];
      documents.push({ ...item, title: parsed.title, layout: buildDocumentLayout(parsed), linkedAssets });
      if (item.descriptor.id) await addFile(root, `metadata/documents/${item.descriptor.id}.json`);
    }
    title = documents[0].title;
    const content = renderExport(documents, options.format, resolveMedia, language);
    addBuffer(options.format === 'html' ? 'index.html' : 'document.md', Buffer.from(content));
    for (const asset of usedAssets.values()) {
      await addFile(assetRoot, asset.relative, asset.path, asset.expected);
      if (registry.assets.some((record) => record.id === asset.id)) await addFile(root, `metadata/assets/${asset.id}.json`);
    }
    addBuffer('README.txt', Buffer.from([
      t('请先解压整个 ZIP 文件，再打开 {0}。', options.format === 'html' ? 'index.html' : 'document.md'),
      t('assets/ 包含引用的素材，请与正文一同保留。sources/ 保留未经改写的原始正文。'),
      t('这是阅读分享包；项目恢复请使用“完整项目包”。'),
      '',
    ].join('\n')));
    documentCount = documents.length;
    assetCount = usedAssets.size;
    archiveManifest = { format: 'viento-document-export', version: 1, exportedAt: Math.floor(Date.now() / 1000), title,
      documents: selected.map(({ sourcePath, descriptor, depth }) => ({ id: descriptor.id || null, sourcePath, depth })),
      assets: [...usedAssets.values()].map(({ id, path: target, relative }) => ({ id, path: target, originalPath: `assets/${relative}` })) };
  }
  if (entries.size > MAX_FILES) throw exportError('导出文件过多');
  try { assertPortableFileTree(entries.keys()); } catch (error) { throw exportError(error.message); }
  if ([...entries.values()].reduce((total, entry) => total + (entry.buffer?.length ?? entry.stat.size), 0) > MAX_TOTAL_BYTES) throw exportError('导出内容超过 64 GiB 限制');
  return { entries: [...entries.values()], archiveManifest, validateSnapshot, documentCount, assetCount,
    fileName: exportFileName(title, options.kind === 'workspace' ? '.viento.zip' : `-${options.format === 'html' ? t('网页') : 'Markdown'}.zip`) };
}

export async function writeExportZip(plan, output, signal) {
  signal?.throwIfAborted();
  const zip = new yazl.ZipFile();
  const hashes = [];
  const stopped = new AbortController(), pending = new Set();
  const fail = (error) => {
    if (!stopped.signal.aborted) stopped.abort(error);
    zip.outputStream.destroy(stopped.signal.reason);
  };
  // The ZIP output may close before a pending open/stat/read/close finishes.
  // Keep ownership of those operations until they have released their inputs.
  function track(task) {
    const settled = task.catch(fail);
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
  }
  zip.on('error', fail);
  const aborted = () => fail(signal.reason);
  signal?.addEventListener('abort', aborted, { once: true });
  const writing = pipeline(zip.outputStream, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  writing.catch(fail);
  try {
    for (const entry of plan.entries) {
      if (entry.buffer) {
        hashes.push({ path: entry.path, size: entry.buffer.length, sha256: digest(entry.buffer) });
        zip.addBuffer(entry.buffer, entry.path);
        continue;
      }
      zip.addReadStreamLazy(entry.path, { size: entry.stat.size, mtime: entry.stat.mtime, mode: 0o100644,
        compress: /\.(md|txt|json|ya?ml)$/i.test(entry.path) }, (callback) => {
        track((async () => {
          stopped.signal.throwIfAborted();
          const file = await resolveContainedPath(entry.base, path.join(entry.base, entry.relative));
          stopped.signal.throwIfAborted();
          const input = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          let reader;
          try {
            stopped.signal.throwIfAborted();
            if (signature(await input.stat()) !== signature(entry.stat)) throw exportError(userMessage`导出期间文件发生变化：${entry.relative}`, 409);
            stopped.signal.throwIfAborted();
            const hash = createHash('sha256');
            let size = 0;
            const hashed = new Transform({
              transform(chunk, encoding, done) { size += chunk.length; hash.update(chunk); done(null, chunk); },
              flush(done) {
                const sha256 = hash.digest('hex');
                if (entry.expected && (entry.expected.size !== size || entry.expected.sha256 !== sha256)) return done(exportError(userMessage`文件内容与登记不一致，请刷新登记后重试：${entry.relative}`, 409));
                hashes.push({ path: entry.path, size, sha256 }); done();
              },
            });
            reader = input.createReadStream();
            // An aborted pipeline can reject before an in-flight read lets the
            // file stream close. Wait for that close explicitly as well.
            track(new Promise(resolve => reader.once('close', resolve)));
            track(pipeline(reader, hashed, { signal: stopped.signal }));
            callback(null, hashed);
          } catch (error) {
            fail(error);
            if (reader) reader.destroy(stopped.signal.reason);
            else await input.close().catch(fail);
            throw error;
          }
        })().catch(callback));
      });
    }
    zip.addReadStreamLazy('manifest.json', (callback) => {
      track((async () => {
        stopped.signal.throwIfAborted();
        await plan.validateSnapshot(stopped.signal);
        stopped.signal.throwIfAborted();
        callback(null, Readable.from(json({ ...plan.archiveManifest, files: hashes })));
      })().catch(callback));
    });
    zip.end();
    await writing;
  } catch (error) { fail(error); }
  finally {
    await writing.catch(fail);
    while (pending.size) await Promise.all(pending);
    signal?.removeEventListener('abort', aborted);
  }
  stopped.signal.throwIfAborted();
}
