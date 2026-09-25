import { PROJECT_ROOT, STANDARD_ROOT } from '../lib/paths.mjs';

const TARGET_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  '.tmp',
  'tmp',
  'engine',
  'mobile',
  'web',
  'data-template',
  'templates',
  'assets',
  'docs-standard',
  'web/.parcel-cache',
  '.cache',
  'package.json',
  'package-lock.json',
  'desktop',
  'src-tauri',
  'target',
  'dist',
  '.viento',
  'metadata',
  'workspaces',
  'schemas',
]);
const SCHEMA_VERSION = 'standard-doc-v2';

export {
  PROJECT_ROOT,
  STANDARD_ROOT,
  TARGET_EXTENSIONS,
  SKIP_DIRS,
  SCHEMA_VERSION,
};
