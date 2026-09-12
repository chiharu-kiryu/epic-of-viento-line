import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runCommand } from '../lib/process.mjs';
import { createTemplateFixture } from './template-fixture.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['scripts', 'web']) {
    await fs.cp(path.join(PROJECT_ROOT, name), path.join(root, name), {
      recursive: true,
      filter: (source) => !path.basename(source).startsWith('.')
        && source !== path.join(PROJECT_ROOT, 'scripts/tests')
        && source !== path.join(PROJECT_ROOT, 'web/data'),
    });
  }
  await createTemplateFixture(root);
  await fs.copyFile(path.join(PROJECT_ROOT, 'package.json'), path.join(root, 'package.json'));
  await fs.symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.mkdir(path.join(root, 'design-data'), { recursive: true });
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await write(root, 'web/data/index.json', JSON.stringify({ count: 0, docs: [] }));
  return root;
}

export async function write(root, relative, content) {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

function fixtureEnvironment() {
  const env = { ...process.env };
  // Running checks for a selected project must never redirect fixture writes
  // into that project. Tests which need separate roots pass them explicitly.
  delete env.VIENTO_APP_ROOT;
  delete env.VIENTO_WORKSPACE_ROOT;
  delete env.VIENTO_SESSION_TOKEN;
  delete env.VIENTO_PREFERENCES_PATH;
  return env;
}

export function node(root, args) {
  return runCommand(process.execPath, args, { cwd: root, env: fixtureEnvironment() });
}

export async function serve(t, root, env = {}, script = 'doc-site-server.mjs') {
  const child = spawn(process.execPath, [`scripts/${script}`, '--port', '0'], {
    cwd: root,
    env: {
      ...fixtureEnvironment(),
      PORT: '0',
      DOC_API_HOST: '127.0.0.1',
      DOC_API_TOKEN: '',
      DOC_API_WRITE_TOKEN: '',
      DOC_API_REQUIRE_WRITE_AUTH: '0',
      DOC_API_SECURITY_AUDIT: '0',
      DOC_API_RATE_LIMIT_MAX_REQUESTS: '1000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server start timed out: ${output}`)), 10000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Server exited: ${output}`)); });
    child.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/(?:Doc viewer|Read-only viewer) running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.stderr.on('data', (data) => { output += data; });
  });
}

export async function request(base, pathname, payload) {
  const response = await fetch(`${base}${pathname}`, payload === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  return { status: response.status, payload: json, data: json.data || json };
}
