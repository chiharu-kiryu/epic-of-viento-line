import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function nativeMobileLibrary(binary, root) {
  const owned = !root;
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'viento-mobile-native-'));
  const child = spawn(binary, [root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = once(child, 'exit');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const entry = pending.shift();
    if (!entry) return;
    try { const value = JSON.parse(line); if (value.error) entry.reject(value.error); else entry.resolve(value.data); }
    catch (error) { entry.reject(error); }
  });
  child.on('error', (error) => pending.splice(0).forEach(({ reject }) => reject(error)));
  child.on('exit', () => pending.splice(0).forEach(({ reject }) => reject(new Error(errors || 'Native test adapter exited'))));
  return {
    root,
    invoke(command, request) {
      if (command !== 'mobile_storage') return Promise.reject(new Error('unexpected command'));
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(JSON.stringify(request) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      await exited;
      if (owned) await fs.rm(root, { recursive: true, force: true });
    },
  };
}
