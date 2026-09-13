import { toPosix } from './paths.mjs';

function normalizeFilterPath(rawPath) {
  return toPosix((rawPath || '').trim())
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/');
}

function normalizeComparablePath(rawPath) {
  // Extensions and dotted directory names are part of a document's identity.
  return normalizeFilterPath(rawPath);
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
