import { PROJECT_ROOT, STANDARD_ROOT } from '../lib/paths.mjs';

const cliArgs = process.argv.slice(2);
const cliOptions = new Set(cliArgs.filter((arg) => arg.startsWith('-')));

const MERGE_BACKSTORY = cliOptions.has('--merge-backstory') && !cliOptions.has('--no-merge-backstory');

const TARGET_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  '.tmp',
  'tmp',
  'web',
  'data-template',
  'docs-standard',
  'web/.parcel-cache',
  '.cache',
]);
const SCHEMA_VERSION = 'standard-doc-v2';

const BACKSTORY_KEY_OVERRIDES = {
  '智力||明理之殇': '智力||我生兄妹',
  '智力||幻梦之赐': '智力||我生兄妹',
};

export {
  PROJECT_ROOT,
  STANDARD_ROOT,
  MERGE_BACKSTORY,
  TARGET_EXTENSIONS,
  SKIP_DIRS,
  SCHEMA_VERSION,
  BACKSTORY_KEY_OVERRIDES,
};
