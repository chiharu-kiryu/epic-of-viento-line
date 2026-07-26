import { toPosix } from './paths.mjs';

function normalizeFilterPath(rawPath) {
  return toPosix((rawPath || '').trim())
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

function normalizeComparablePath(rawPath) {
  return toPosix((rawPath || '').trim())
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/')
    .replace(/\.[A-Za-z0-9]{1,10}$/u, '');
}

function isPathMatch(candidate, filter) {
  if (!filter) {
    return false;
  }
  const normalizedCandidate = normalizeComparablePath(candidate);
  const normalizedFilter = normalizeComparablePath(filter);

  if (!normalizedFilter) {
    return false;
  }

  return (
    normalizedCandidate === normalizedFilter
    || normalizedCandidate.startsWith(`${normalizedFilter}/`)
    || normalizedFilter.startsWith(`${normalizedCandidate}/`)
  );
}

function inSourceScopes(candidatePath, sourceFilters = []) {
  if (sourceFilters.length === 0) {
    return true;
  }
  return sourceFilters.some((filter) => isPathMatch(candidatePath, filter));
}

export {
  normalizeFilterPath,
  normalizeComparablePath,
  isPathMatch,
  inSourceScopes,
};
