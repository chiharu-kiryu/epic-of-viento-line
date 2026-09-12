import { createServer } from 'node:http';
import { PROJECT_ROOT, WEB_ROOT } from './lib/paths.mjs';
import { resolvePort } from './lib/doc-server.mjs';
import { handleStaticRequest } from './lib/doc-server-static-routes.mjs';
import { handleApiRequest } from './lib/doc-server-routes.mjs';
import { API_PATHS } from './lib/doc-api-contract.mjs';
import { createExportService } from './lib/export-service.mjs';

const port = resolvePort();
const service = { exports: createExportService(PROJECT_ROOT) };
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === API_PATHS.EXPORT && await handleApiRequest({ pathname: url.pathname, request, response, requestUrl: url, service })) return;
    await handleStaticRequest({ pathname: url.pathname, request, response, projectRoot: PROJECT_ROOT, webRoot: WEB_ROOT, requestMethod: request.method });
  } catch (error) {
    if (!response.headersSent) { response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('无法读取作品文件'); }
    else response.destroy();
    console.error(error.message);
  }
}).listen(port, '127.0.0.1', function () {
  console.log(`Read-only viewer running at http://127.0.0.1:${this.address().port}/web/`);
});
