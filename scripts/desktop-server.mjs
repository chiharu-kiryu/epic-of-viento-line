import { readWorkspace, registerWorkspace } from './lib/workspace.mjs';
import { PROJECT_ROOT } from './lib/paths.mjs';
import { rebuildIndex } from './lib/rebuild-workflow.mjs';

try {
  if (!process.env.VIENTO_WORKSPACE_ROOT || !process.env.VIENTO_SESSION_TOKEN) throw new Error('Desktop workspace and session are required');
  const manifest = readWorkspace(PROJECT_ROOT);
  if (!manifest) throw new Error('Workspace manifest is required');
  if ([2, 3].includes(manifest.version)) await registerWorkspace(PROJECT_ROOT);
  await rebuildIndex({ projectRoot: PROJECT_ROOT });
  await import('./doc-site-server.mjs');
  // The app owns the engine. Closing the input pipe also stops it after a crash.
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} catch (error) { console.error(error.message); process.exitCode = 1; }
