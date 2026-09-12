import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from '../scripts/lib/process.mjs';
import { verifyReleaseVersions } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'desktop');
const runtime = JSON.parse(await fs.readFile(path.join(desktop, 'node-runtime.json'), 'utf8'));

async function download(url, output, sha256) {
  try {
    const bytes = await fs.readFile(output);
    if (createHash('sha256').update(bytes).digest('hex') === sha256) return;
  } catch { /* A missing or partial download is retried. */ }
  console.log(`Downloading ${path.basename(output)}…`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('SHA-256 mismatch');
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, bytes);
      return;
    } catch (error) {
      if (attempt === 2) throw new Error(`Unable to prepare ${path.basename(output)}: ${error.message}`);
      await delay(500 * (attempt + 1));
    }
  }
}

async function prepareNode() {
  const rust = await runCommand('rustc', ['-vV']);
  const triple = process.env.VIENTO_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE
    || process.env.CARGO_BUILD_TARGET || rust.stdout.match(/^host: (.+)$/m)?.[1];
  const target = runtime.targets[triple];
  if (!target) throw new Error(`Unsupported desktop target: ${triple}`);
  const archive = path.join(desktop, '.cache', `${runtime.version}-${target.file.replaceAll('/', '-')}`);
  await download(`https://nodejs.org/dist/${runtime.version}/${target.file}`, archive, target.sha256);
  const binaries = path.join(root, 'src-tauri', 'binaries');
  await fs.mkdir(binaries, { recursive: true });
  const destination = path.join(binaries, `viento-node-${triple}${triple.includes('windows') ? '.exe' : ''}`);
  if (target.node) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'viento-node-'));
    try {
      await runCommand('tar', ['-xf', archive, '-C', temporary, target.node]);
      await fs.copyFile(path.join(temporary, target.node), destination);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  } else {
    await fs.copyFile(archive, destination);
  }
  await fs.chmod(destination, 0o755);
  console.log(`Embedded Node ${runtime.version}: ${triple}`);
}

async function prepareResources() {
  const output = path.join(desktop, 'resources');
  const stage = await fs.mkdtemp(path.join(desktop, '.resources-'));
  try {
    for (const name of ['scripts', 'web', 'schemas']) {
      await fs.cp(path.join(root, name), path.join(stage, name), {
        recursive: true,
        filter: (source) => !path.basename(source).startsWith('.')
          && source !== path.join(root, 'scripts', 'tests') && source !== path.join(root, 'web', 'data'),
      });
    }
    await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });
    await fs.cp(path.join(root, 'node_modules', 'yaml'), path.join(stage, 'node_modules', 'yaml'), { recursive: true });
    const { version: displayVersion, buildVersion: version } = await verifyReleaseVersions();
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module', version, displayVersion }));
    await fs.copyFile(path.join(root, 'VERSION'), path.join(stage, 'VERSION'));
    const license = path.join(desktop, '.cache', `${runtime.version}-LICENSE`);
    await download(`https://raw.githubusercontent.com/nodejs/node/${runtime.version}/LICENSE`, license, runtime.licenseSha256);
    await fs.copyFile(license, path.join(stage, 'NODE-LICENSE'));
    try { await fs.copyFile(path.join(root, 'favicon.ico'), path.join(stage, 'favicon.ico')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rm(output, { recursive: true, force: true });
    await fs.rename(stage, output);
    console.log('Desktop application resources prepared (no project data bundled).');
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

try {
  await verifyReleaseVersions();
  if (!process.argv.includes('--resources-only')) await prepareNode();
  await prepareResources();
} catch (error) { console.error(error.message); process.exitCode = 1; }
