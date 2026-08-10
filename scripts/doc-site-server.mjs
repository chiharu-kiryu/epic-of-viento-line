import { createServer } from 'node:http';
import {
  PROJECT_ROOT,
  WEB_ROOT,
} from './lib/paths.mjs';
import { resolveBackstoryModeFromEnv } from './lib/rebuild-config.mjs';
import {
  resolvePort,
  EDIT_ROOT_PREFIXES,
} from './lib/doc-server.mjs';
import { createDocumentService } from './lib/doc-api-service.mjs';
import { handleApiRequest } from './lib/doc-server-routes.mjs';
import { handleStaticRequest } from './lib/doc-server-static-routes.mjs';

const PORT = resolvePort();
const HOST = process.env.DOC_API_HOST || '127.0.0.1';
const BACKSTORY_MERGE_MODE = resolveBackstoryModeFromEnv();
const apiState = { rebuildInProgress: false };
const docService = createDocumentService({
  editablePrefixes: EDIT_ROOT_PREFIXES,
  backstoryMergeMode: BACKSTORY_MERGE_MODE,
  state: apiState,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  const handledByApi = await handleApiRequest({
    pathname,
    request: req,
    response: res,
    requestUrl: url,
    service: docService,
  });
  if (handledByApi) {
    return;
  }

  const handledByStatic = await handleStaticRequest({
    pathname,
    response: res,
    projectRoot: PROJECT_ROOT,
    webRoot: WEB_ROOT,
    requestMethod: req.method,
  });
  if (handledByStatic) {
    return;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Doc viewer running at http://${HOST}:${PORT}`);
  console.log(`Backstory merge mode: ${BACKSTORY_MERGE_MODE}`);
});
