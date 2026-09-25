import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseVersions } from '../desktop/version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function prepareMobile() {
  const release = await verifyReleaseVersions();
  const mobile = path.join(root, 'mobile'), output = path.join(mobile, 'dist');
  const stage = await fs.mkdtemp(path.join(mobile, '.dist-'));
  try {
    for (const directory of ['web', 'engine']) await fs.cp(path.join(root, directory), path.join(stage, directory), {
      recursive: true, filter: (source) => !path.basename(source).startsWith('.') && source !== path.join(root, 'web/data') && !source.endsWith('.md'),
    });
    await fs.cp(path.join(root, 'node_modules/yaml/browser'), path.join(stage, 'vendor/yaml'), { recursive: true });
    await fs.copyFile(path.join(root, 'node_modules/yaml/LICENSE'), path.join(stage, 'vendor/yaml/LICENSE'));
    // Resolve the sole bare dependency without inline scripts, remote CDNs or a
    // Node runtime. All other engine sources stay exactly the same.
    for (const file of await fs.readdir(path.join(stage, 'engine'))) {
      if (!file.endsWith('.mjs')) continue;
      const target = path.join(stage, 'engine', file);
      await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replaceAll("from 'yaml'", "from '/vendor/yaml/index.js'"));
    }
    await fs.mkdir(path.join(stage, 'scripts/lib'), { recursive: true });
    for (const file of ['doc-api-contract.mjs', 'media-format.mjs', 'document-values.mjs']) await fs.copyFile(path.join(root, 'scripts/lib', file), path.join(stage, 'scripts/lib', file));
    await fs.mkdir(path.join(stage, 'mobile'));
    for (const file of ['platform.mjs', 'library.js', 'editor.js', 'drafts.mjs', 'mobile.css']) await fs.copyFile(path.join(mobile, file), path.join(stage, 'mobile', file));
    const library = (await fs.readFile(path.join(mobile, 'index.html'), 'utf8')).replaceAll('__VIENTO_VERSION__', release.version);
    await fs.writeFile(path.join(stage, 'index.html'), library);
    const editor = (await fs.readFile(path.join(root, 'web/index.html'), 'utf8'))
      .replace(/<title>.*?<\/title>/, '<title>Viento Studio</title>')
      .replace('</head>', '<link rel="stylesheet" href="/mobile/mobile.css" /></head>')
      .replace('<body>', '<body class="mobile-host">')
      .replace('<script type="module" src="/web/app.js"></script>', '<script type="module" src="/mobile/editor.js"></script>')
      .replace('<script type="module" src="/web/modules/desktop-bridge.js"></script>', '');
    await fs.writeFile(path.join(stage, 'editor.html'), editor);
    await fs.copyFile(path.join(root, 'favicon.ico'), path.join(stage, 'favicon.ico'));
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(stage, output);
    console.log(`Mobile resources prepared: ${release.version} (no Node executable or workspace data)`);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMobile().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
