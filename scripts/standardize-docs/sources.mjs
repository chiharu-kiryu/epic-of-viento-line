import { collectFiles } from '../lib/scan-files.mjs';
import {
  inSourceScopes,
  normalizeFilterPath,
} from '../lib/path-filter.mjs';
import { SKIP_DIRS } from './config.mjs';
import { isTextLike } from './utils.mjs';

async function collectSourcePaths(rootDir, {
  relativeBase = '',
  sourceFilters = [],
  skipDirs = SKIP_DIRS,
  excludedRoots = [],
} = {}) {
  const normalizedFilters = sourceFilters.map(normalizeFilterPath);
  const all = await collectFiles(rootDir, {
    relativeBase,
    skipDirs,
    excludedRoots,
    isAccepted: (name) => isTextLike(name),
  });
  if (normalizedFilters.length === 0) {
    return all;
  }
  return all.filter((relativePath) => inSourceScopes(relativePath, normalizedFilters));
}

export {
  collectSourcePaths,
};
