import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePaths } from './project-layout.mjs';
import { readWorkspace, resolveAssetRoot } from './workspace.mjs';
import { resolveWorkspaceRoot } from './app-storage.mjs';

// The application is located from its module, while data can live anywhere.
const APPLICATION_ROOT = path.resolve(process.env.VIENTO_APP_ROOT || fileURLToPath(new URL('../../', import.meta.url)));
const PROJECT_ROOT = resolveWorkspaceRoot({ appRoot: APPLICATION_ROOT });
let WORKSPACE_MANIFEST = readWorkspace(PROJECT_ROOT);
export function reloadWorkspaceManifest() {
  const next = readWorkspace(PROJECT_ROOT);
  if (JSON.stringify(workspacePaths(next)) !== JSON.stringify(workspacePaths(WORKSPACE_MANIFEST))) throw new Error('项目目录已改变，请重新打开项目');
  WORKSPACE_MANIFEST = next;
  return next;
}
const IS_DESKTOP_WORKSPACE = Boolean(process.env.VIENTO_SESSION_TOKEN);
const IS_MANAGED_WORKSPACE = Boolean(process.env.VIENTO_WORKSPACE_ROOT) || Boolean(WORKSPACE_MANIFEST);
const CACHE_ROOT = IS_MANAGED_WORKSPACE ? path.join(PROJECT_ROOT, '.viento', 'cache') : PROJECT_ROOT;
const SCRIPT_ROOT = path.join(APPLICATION_ROOT, 'scripts');
const DOCUMENTS_PATH = workspacePaths(WORKSPACE_MANIFEST).documents;
const TEMPLATES_PATH = workspacePaths(WORKSPACE_MANIFEST).templates;
const DOC_ROOT = path.join(PROJECT_ROOT, DOCUMENTS_PATH);
const ASSET_ROOT = resolveAssetRoot(PROJECT_ROOT);
const METADATA_ROOT = path.join(PROJECT_ROOT, 'metadata');
const WEB_ROOT = path.join(APPLICATION_ROOT, 'web');
const STANDARD_ROOT = path.join(CACHE_ROOT, 'docs-standard');
const DATA_TEMPLATE_ROOT = path.join(PROJECT_ROOT, TEMPLATES_PATH);
const INDEX_OUTPUT = [2, 3].includes(WORKSPACE_MANIFEST?.version)
  ? path.join(CACHE_ROOT, 'indexes', 'documents.json')
  : path.join(CACHE_ROOT, 'web', 'data', 'index.json');
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
  DOCUMENTS_PATH,
  TEMPLATES_PATH,
  WORKSPACE_MANIFEST,
  APPLICATION_ROOT,
  IS_DESKTOP_WORKSPACE,
  IS_MANAGED_WORKSPACE,
  METADATA_ROOT,
  CACHE_ROOT,
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
