import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// All service instances in this server share one queue per document.
const transactions = new Map();

async function withDocumentTransaction(filePath, operation) {
  const key = filePath.replace(/^docs-standard\/(?=design-data\/|documents\/)/, '');
  const previous = transactions.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  transactions.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (transactions.get(key) === current) {
      transactions.delete(key);
    }
  }
}

function documentContentVersion(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function readDocumentSnapshot(absolutePath) {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const bytes = await handle.readFile();
    const stats = await handle.stat();
    return { content: bytes.toString('utf8'), stats, version: documentContentVersion(bytes) };
  } finally {
    await handle.close();
  }
}

async function writeDocumentAtomically(absolutePath, content, { create = false, previousStats = null } = {}) {
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true });
  // A valid 255-byte source name must not overflow the filesystem limit when
  // creating its temporary sibling. The random name stays short on its own.
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, 'wx', previousStats ? previousStats.mode & 0o777 : 0o666);
  try {
    await handle.writeFile(content, 'utf8');
    if (previousStats) {
      // Creation applies umask; restore the existing document's permissions exactly.
      await handle.chmod(previousStats.mode & 0o777);
    }
    let stats = await handle.stat();
    // Keep modification times advancing even on coarse clocks.
    if (previousStats && stats.mtimeMs <= previousStats.mtimeMs) {
      await handle.utimes(stats.atime, (previousStats.mtimeMs + 1) / 1000);
      stats = await handle.stat();
    }
    await handle.sync();
    await handle.close();
    if (create) {
      // link is exclusive: another creator can never be silently overwritten.
      await fs.link(temporaryPath, absolutePath);
    } else {
      await fs.rename(temporaryPath, absolutePath);
    }
    return stats;
  } finally {
    await handle.close();
    await fs.rm(temporaryPath, { force: true });
  }
}

export { withDocumentTransaction, documentContentVersion, readDocumentSnapshot, writeDocumentAtomically };
