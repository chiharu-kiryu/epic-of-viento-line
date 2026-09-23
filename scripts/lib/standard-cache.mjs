import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectFilesRecursive } from './scan-files.mjs';
import { resolveContainedPath } from './contained-path.mjs';

const RECORDS = '.entries';

export function buildStandardOutputPath(sourceRelativePath) {
  // Cache paths are independent of source filename length and file/directory
  // shapes. Full relative paths retain the source extension and Unicode bytes.
  const key = sourceRelativePath.replaceAll('\\', '/');
  return `${RECORDS}/${createHash('sha256').update(key).digest('hex')}.json`;
}

export async function collectStandardPaths(root, options = {}) {
  // Old mirrored caches remain readable during a scoped rebuild. Hidden
  // folders stay excluded from source scans; only this cache reader opens ours.
  const legacy = await collectFilesRecursive(root, options);
  let records;
  try {
    records = await resolveContainedPath(root, path.join(root, RECORDS));
    if (!(await fs.stat(records)).isDirectory()) throw new Error('标准文档缓存位置必须是实际目录');
  } catch (error) {
    if (error.code === 'ENOENT') return legacy;
    throw error;
  }
  const relativeBase = path.join(options.relativeBase || '', RECORDS);
  return legacy.concat(await collectFilesRecursive(records, { ...options, relativeBase }));
}
