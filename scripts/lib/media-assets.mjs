import { userError } from './user-message.mjs';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readWorkspace, resolveAssetRoot, readRegistry, withRegistryLock, writeJson, fingerprint } from './workspace.mjs';
import { resolveContainedPath } from './contained-path.mjs';
import { MEDIA_KINDS, MEDIA_MAX_BYTES, mediaKindForName } from './media-format.mjs';

const reject = (statusCode, message) => userError(message, statusCode, 'media_import_rejected');

function matchesFormat(bytes, extension) {
  const ascii = bytes.toString('utf8');
  if (extension === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (['jpg', 'jpeg'].includes(extension)) return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === 'gif') return /^GIF8[79]a/.test(ascii);
  if (extension === 'webp') return ascii.startsWith('RIFF') && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (extension === 'svg') return /^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(ascii);
  if (extension === 'webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (extension === 'mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (extension === 'mov') return ['ftyp', 'moov', 'mdat', 'wide'].includes(bytes.subarray(4, 8).toString('ascii'));
  if (extension === 'wav') return ['RIFF', 'RF64'].includes(ascii.slice(0, 4)) && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (['ogg', 'oga', 'opus'].includes(extension)) return ascii.startsWith('OggS') && bytes[4] === 0
    && (extension !== 'opus' || bytes.includes(Buffer.from('OpusHead')));
  if (extension === 'flac') return ascii.startsWith('fLaC');
  if (extension === 'm4a') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (extension === 'mp3') return (bytes.length >= 10 && ascii.startsWith('ID3') && [2, 3, 4].includes(bytes[3]))
    || (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe6) === 0xe2 && (bytes[1] & 0x18) !== 0x08
      && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c);
  if (extension === 'aac') return bytes.length >= 7 && bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0;
  return false;
}

function summary(asset, status = 'available') {
  return { id: asset.id, name: asset.name, kind: asset.kind, size: asset.content?.size || 0,
    status, src: `asset:${asset.id}`, url: `/asset-files/${asset.id}` };
}

export async function listMediaAssets(root) {
  const registry = await readRegistry(root);
  const store = resolveAssetRoot(root);
  const assets = await Promise.all(registry.assets.filter((asset) => MEDIA_KINDS.includes(asset.kind)).map(async (asset) => {
    let status = 'missing';
    try {
      const file = await resolveContainedPath(store, path.join(store, asset.location.path));
      const stat = await fs.stat(file);
      status = stat.isFile() ? 'available' : 'missing';
    } catch { /* Offline stores remain visible in the picker. */ }
    return summary(asset, status);
  }));
  return { assets, maxBytes: MEDIA_MAX_BYTES };
}

export async function importMediaAsset(root, request, rawName, { maxBytes = MEDIA_MAX_BYTES } = {}) {
  if (![2, 3].includes(readWorkspace(root)?.version)) throw reject(400, '请先在作品库中打开或登记当前作品，再导入素材。');
  const name = String(rawName || '').replaceAll('\\', '/').split('/').at(-1).trim();
  const kind = mediaKindForName(name);
  if (!name || name.length > 240 || /[\x00-\x1f\x7f]/.test(name) || !kind) throw reject(415, '请选择支持的图片、视频或音频文件。');
  const extension = name.split('.').at(-1).toLowerCase();
  const length = Number(request.headers?.['content-length']);
  if (Number.isFinite(length) && length > maxBytes) throw reject(413, '素材超过单个文件 256 MB 的限制。');
  const store = resolveAssetRoot(root);
  try { if (!(await fs.lstat(store)).isDirectory()) throw new Error(); }
  catch { throw reject(409, '素材目录离线或不可写，请连接素材目录后重试。'); }
  const uploads = await resolveContainedPath(root, path.join(root, '.viento/uploads'), { allowMissing: true });
  await fs.mkdir(uploads, { recursive: true });
  const temporary = path.join(uploads, randomUUID());
  let size = 0;
  let prefix = Buffer.alloc(0);
  const hash = createHash('sha256');
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      for await (const bytes of request.iterator({ destroyOnReturn: false })) {
        size += bytes.length;
        if (size > maxBytes) { request.resume(); throw reject(413, '素材超过单个文件 256 MB 的限制。'); }
        if (prefix.length < 4096) prefix = Buffer.concat([prefix, bytes.subarray(0, 4096 - prefix.length)]);
        hash.update(bytes);
        await handle.writeFile(bytes);
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (!size || !matchesFormat(prefix, extension)) throw reject(415, '文件内容与图片、视频或音频格式不符，未导入。');
    const content = { size, sha256: hash.digest('hex') };
    return await withRegistryLock(root, async () => {
      if (resolveAssetRoot(root) !== store) throw reject(409, '素材目录在上传期间发生变化，请重新导入。');
      const registry = await readRegistry(root);
      for (const old of registry.assets.filter((asset) => asset.kind === kind && asset.content?.sha256 === content.sha256 && asset.content.size === size)) {
        try {
          const file = await resolveContainedPath(store, path.join(store, old.location.path));
          if ((await fingerprint(file)).sha256 === content.sha256) return { asset: summary(old), reused: true };
        } catch { /* Keep a missing/changed old asset and import the new bytes. */ }
      }
      const id = randomUUID();
      const directory = { image: 'images', video: 'videos', audio: 'audio' }[kind];
      const relative = `media/${directory}/${id}.${extension}`;
      const destination = await resolveContainedPath(store, path.join(store, relative), { allowMissing: true });
      const metadata = await resolveContainedPath(root, path.join(root, 'metadata/assets', `${id}.json`), { allowMissing: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.mkdir(path.dirname(metadata), { recursive: true });
      let created = false;
      const incoming = `${destination}.incoming`;
      try {
        try { await fs.link(temporary, destination); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fs.copyFile(temporary, incoming, constants.COPYFILE_EXCL);
          const copied = await fs.open(incoming, 'r+');
          try { await copied.sync(); } finally { await copied.close(); }
          await fs.link(incoming, destination);
        }
        created = true;
        const asset = { format: 'viento-asset', version: 1, id, name, kind, tags: [],
          content, location: { store: 'main', path: relative }, legacyPaths: [] };
        await writeJson(metadata, asset, { exclusive: true });
        return { asset: summary(asset), reused: false };
      } catch (error) {
        if (created) await fs.rm(destination, { force: true });
        throw error;
      } finally { await fs.rm(incoming, { force: true }); }
    });
  } finally { await fs.rm(temporary, { force: true }); }
}
