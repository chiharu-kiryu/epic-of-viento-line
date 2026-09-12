import fs from 'node:fs/promises';
import path from 'node:path';
import { toPosix } from './paths.mjs';

const DEFAULT_SKIP_DIRS = new Set(['.git', '.DS_Store', 'node_modules', '.tmp']);
const DEFAULT_FILE_SCAN_CONCURRENCY = 8;
const FILE_SCAN_CONCURRENCY = normalizeNumericConfigValue(
  'DOC_FILE_SCAN_CONCURRENCY',
  DEFAULT_FILE_SCAN_CONCURRENCY,
  1,
);

function normalizeNumericConfigValue(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    return fallback;
  }

  return parsed;
}

function isTextPath(filePath, allowedExtensions = new Set(['.md', '.txt', '.json', '.yml', '.yaml'])) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '' || allowedExtensions.has(ext);
}

async function collectFiles(rootDir, {
  relativeBase = '',
  skipDirs = DEFAULT_SKIP_DIRS,
  isAccepted = () => true,
  excludedRoots = [],
} = {}) {
  const files = [];
  const exclusions = excludedRoots.map((root) => path.resolve(root));
  const normalizedSkipDirs = skipDirs instanceof Set
    ? skipDirs
    : new Set(Array.isArray(skipDirs) ? skipDirs : []);
  const queue = [{ dir: rootDir, base: relativeBase || '' }];
  let cursor = 0;

  const waitForWork = () => new Promise((resolve) => {
    setImmediate(resolve);
  });

  let activeTasks = 0;
  const worker = async () => {
    while (true) {
      const item = queue[cursor];
      if (!item) {
        if (activeTasks === 0) {
          return;
        }
        await waitForWork();
        continue;
      }
      cursor += 1;
      activeTasks += 1;

      try {
        const entries = await fs.readdir(item.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) {
            continue;
          }
          if (normalizedSkipDirs.has(entry.name)) {
            continue;
          }

          const absolute = path.join(item.dir, entry.name);
          const relative = toPosix(path.join(item.base, entry.name));
          if (exclusions.some((root) => {
            const fromRoot = path.relative(root, absolute);
            return fromRoot === '' || (!fromRoot.startsWith(`..${path.sep}`) && fromRoot !== '..' && !path.isAbsolute(fromRoot));
          })) {
            continue;
          }

          if (entry.isDirectory()) {
            queue.push({
              dir: absolute,
              base: relative,
            });
            continue;
          }

          if (!entry.isFile() || !isAccepted(entry.name)) {
            continue;
          }
          files.push(relative);
        }
      } finally {
        activeTasks -= 1;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(FILE_SCAN_CONCURRENCY, 64));
  const workers = Array.from({ length: workerCount }, worker);
  await Promise.all(workers);

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
