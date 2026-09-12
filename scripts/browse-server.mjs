import { createServer } from 'node:http';
import { PROJECT_ROOT, WEB_ROOT } from './lib/paths.mjs';
import { resolvePort } from './lib/doc-server.mjs';
import { handleStaticRequest } from './lib/doc-server-static-routes.mjs';

const port = resolvePort();
createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    await handleStaticRequest({ pathname: url.pathname, request, response, projectRoot: PROJECT_ROOT, webRoot: WEB_ROOT, requestMethod: request.method });
  } catch (error) {
    if (!response.headersSent) { response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('无法读取作品文件'); }
    else response.destroy();
    console.error(error.message);
  }
}).listen(port, '127.0.0.1', function () {
  console.log(`Read-only viewer running at http://127.0.0.1:${this.address().port}/web/`);
});
