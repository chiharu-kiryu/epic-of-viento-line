import fs from 'node:fs/promises';
import path from 'node:path';
import { toPosix } from './paths.mjs';

const DEFAULT_SKIP_DIRS = new Set(['.git', '.DS_Store', 'node_modules', '.tmp']);

function isTextPath(filePath, allowedExtensions = new Set(['.md', '.txt', '.json', '.yml', '.yaml'])) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '' || allowedExtensions.has(ext);
}

async function collectFiles(rootDir, {
  relativeBase = '',
  skipDirs = DEFAULT_SKIP_DIRS,
  isAccepted = () => true,
} = {}) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (skipDirs.has(entry.name)) {
      continue;
    }

    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));

    if (entry.isDirectory()) {
      const nested = await collectFiles(absolute, {
        relativeBase: relative,
        skipDirs,
        isAccepted,
      });
      files.push(...nested);
      continue;
    }

    if (!entry.isFile() || !isAccepted(entry.name)) {
      continue;
    }

    files.push(relative);
  }

  return files;
}

async function collectFilesRecursive(rootDir, {
  relativeBase = '',
  skipDirs = DEFAULT_SKIP_DIRS,
  acceptedExtensions = new Set(['.md', '.txt', '.json', '.yml', '.yaml']),
} = {}) {
  return collectFiles(rootDir, {
    relativeBase,
    skipDirs,
    isAccepted: (name) => isTextPath(name, acceptedExtensions),
  });
}

export {
  DEFAULT_SKIP_DIRS,
  isTextPath,
  collectFiles,
  collectFilesRecursive,
};
