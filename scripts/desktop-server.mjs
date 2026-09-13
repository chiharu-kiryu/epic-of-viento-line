import { readWorkspace, registerWorkspace } from './lib/workspace.mjs';
import { PROJECT_ROOT } from './lib/paths.mjs';
import { rebuildIndex } from './lib/rebuild-workflow.mjs';
import { stopRunningCommands } from './lib/process.mjs';

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await stopRunningCommands();
  process.exit(0);
}

try {
  if (!process.env.VIENTO_WORKSPACE_ROOT || !process.env.VIENTO_SESSION_TOKEN) throw new Error('Desktop workspace and session are required');
  // Watch the owner before registration or rebuilding can start a worker.
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', chunk => {
    input = (input + chunk).slice(-64);
    if (input.includes('VIENTO_SHUTDOWN\n')) void shutdown();
  });
  process.stdin.on('end', () => { void shutdown(); });
  process.stdin.resume();
  const manifest = readWorkspace(PROJECT_ROOT);
  if (!manifest) throw new Error('Workspace manifest is required');
  if ([2, 3].includes(manifest.version)) await registerWorkspace(PROJECT_ROOT);
  await rebuildIndex({ projectRoot: PROJECT_ROOT });
  await import('./doc-site-server.mjs');
} catch (error) {
  if (!closing) { console.error(error.message); process.exitCode = 1; process.stdin.pause(); }
}
