import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveContainedPath } from './contained-path.mjs';
import { exportError, planExport, writeExportZip } from './export-package.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createExportService(root, { ttlMs = 15 * 60 * 1000 } = {}) {
  const jobs = new Map();
  let busy = false;
  async function release(id) {
    const job = jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    job.released = true;
    // A download may still be opening/streaming the file, especially on Windows.
    // Revoke new reads now, but remove its files only after the last reader exits.
    if (job.readers) return;
    jobs.delete(id);
    await fs.rm(job.directory, { recursive: true, force: true });
  }
  function retain(job) {
    clearTimeout(job.timer);
    if (job.readers || job.released) return job;
    job.timer = setTimeout(() => { void release(job.id).catch(() => {}); }, ttlMs);
    job.timer.unref?.();
    return job;
  }
  function get(id) {
    const job = UUID.test(id || '') && jobs.get(id);
    if (!job || job.released) throw exportError('导出文件已过期，请重新导出', 410);
    return retain(job);
  }
  async function download(id, consume) {
    const job = get(id);
    job.readers += 1;
    clearTimeout(job.timer);
    try {
      if (await consume(job) === true) job.downloaded = true;
    } finally {
      job.readers -= 1;
      if (job.released) await release(job.id);
      else retain(job);
    }
  }
  async function create(options, signal) {
    if (busy) throw exportError('正在准备另一份导出，请稍候', 409);
    busy = true;
    let directory;
    try {
      // Keep prepared and interrupted downloads retryable. Only completed,
      // inactive downloads can give their slot to the next export.
      for (const job of jobs.values()) {
        if (jobs.size < 3) break;
        if (job.downloaded && !job.readers) await release(job.id);
      }
      if (jobs.size >= 3) throw exportError('请先下载或关闭已有导出，再继续', 409);
      const plan = await planExport(root, options, signal);
      const cache = await resolveContainedPath(root, path.join(root, '.viento/cache/exports'), { allowMissing: true });
      await fs.mkdir(cache, { recursive: true, mode: 0o700 });
      await resolveContainedPath(root, cache);
      // Only our expired staging directories are disposable. Authored data and
      // other caches never participate in this cleanup.
      for (const item of await fs.readdir(cache, { withFileTypes: true })) {
        if (!UUID.test(item.name) || !item.isDirectory() || jobs.has(item.name)) continue;
        const candidate = path.join(cache, item.name);
        if (Date.now() - (await fs.stat(candidate)).mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(candidate, { recursive: true });
      }
      const id = randomUUID();
      directory = path.join(cache, id);
      await fs.mkdir(directory, { mode: 0o700 });
      const file = path.join(directory, 'payload.zip');
      await writeExportZip(plan, file, signal);
      const bytes = (await fs.stat(file)).size;
      // Cancellation can arrive after the ZIP writer removed its listener,
      // while the final stat is pending. Recheck before publishing the job.
      signal?.throwIfAborted();
      const job = { id, directory, file, fileName: plan.fileName, bytes, documentCount: plan.documentCount, assetCount: plan.assetCount,
        readers: 0, downloaded: false, released: false };
      jobs.set(id, job);
      retain(job);
      return { id, fileName: job.fileName, bytes, documentCount: job.documentCount, assetCount: job.assetCount };
    } catch (error) {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      if (error.code === 'ENOSPC') throw exportError('磁盘空间不足，无法准备导出文件');
      throw error;
    } finally { busy = false; }
  }
  return { create, get, download, release };
}
