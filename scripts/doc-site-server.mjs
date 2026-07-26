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
import { handleApiRequest } from './lib/doc-server-routes.mjs';
import { handleStaticRequest } from './lib/doc-server-static-routes.mjs';

const PORT = resolvePort();
const BACKSTORY_MERGE_MODE = resolveBackstoryModeFromEnv();
const apiState = { rebuildInProgress: false };
const apiDeps = {
  editablePrefixes: EDIT_ROOT_PREFIXES,
  backstoryMergeMode: BACKSTORY_MERGE_MODE,
  state: apiState,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  const handledByApi = await handleApiRequest({
    pathname,
    request: req,
    response: res,
    requestUrl: url,
    ...apiDeps,
  });
  if (handledByApi) {
    return;
  }

  const handledByStatic = await handleStaticRequest({
    pathname,
    response: res,
    projectRoot: PROJECT_ROOT,
    webRoot: WEB_ROOT,
  });
  if (handledByStatic) {
    return;
  }
});

server.listen(PORT, () => {
  console.log(`Doc viewer running at http://localhost:${PORT}`);
  console.log(`Backstory merge mode: ${BACKSTORY_MERGE_MODE}`);
});
