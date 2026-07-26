import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const SCRIPT_ROOT = path.join(PROJECT_ROOT, 'scripts');
const DOC_ROOT = path.join(PROJECT_ROOT, 'design-data');
const ASSET_ROOT = path.join(PROJECT_ROOT, 'assets');
const WEB_ROOT = path.join(PROJECT_ROOT, 'web');
const STANDARD_ROOT = path.join(PROJECT_ROOT, 'docs-standard');
const DATA_TEMPLATE_ROOT = path.join(PROJECT_ROOT, 'data-template');

const INDEX_OUTPUT = path.join(WEB_ROOT, 'data', 'index.json');
const INDEX_OUTPUT_DIR = path.dirname(INDEX_OUTPUT);

const STANDARDIZE_SCRIPT = path.join(SCRIPT_ROOT, 'standardize-docs.mjs');
const BUILD_STATIC_SCRIPT = path.join(SCRIPT_ROOT, 'build-static-doc-site.mjs');
const DOC_SITE_SERVER_SCRIPT = path.join(SCRIPT_ROOT, 'doc-site-server.mjs');

function toPosix(filePath) {
  return (filePath || '').split(path.sep).join('/');
}

function trimName(fileName = '') {
  return (fileName || '').replace(/\.(md|txt|json|ya?ml)$/i, '');
}

export {
  PROJECT_ROOT,
  SCRIPT_ROOT,
  DOC_ROOT,
  ASSET_ROOT,
  WEB_ROOT,
  STANDARD_ROOT,
  DATA_TEMPLATE_ROOT,
  INDEX_OUTPUT,
  INDEX_OUTPUT_DIR,
  STANDARDIZE_SCRIPT,
  BUILD_STATIC_SCRIPT,
  DOC_SITE_SERVER_SCRIPT,
  toPosix,
  trimName,
};
