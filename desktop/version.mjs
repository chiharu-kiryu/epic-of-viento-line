import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function parseReleaseVersion(version) {
  const beta = /^b\.([0-9])\.([0-9])$/.exec(version);
  if (beta) return { version, buildVersion: `0.${beta[1]}.${beta[2]}` };
  if (/^[1-9][0-9]*\.[0-9]\.[0-9]$/.test(version)) return { version, buildVersion: version };
  throw new Error('VERSION must use b.X.Y (X and Y are digits 0–9) or a numeric release such as 1.0.0');
}

export function nextReleaseVersion(version) {
  parseReleaseVersion(version);
  const [stage, major, minor] = version.split('.');
  if (minor !== '9') return `${stage}.${major}.${Number(minor) + 1}`;
  if (major !== '9') return `${stage}.${Number(major) + 1}.0`;
  return stage === 'b' ? '1.0.0' : `${BigInt(stage) + 1n}.0.0`;
}

export async function readReleaseVersion() {
  return parseReleaseVersion((await fs.readFile(path.join(APP_ROOT, 'VERSION'), 'utf8')).trim());
}

export async function verifyReleaseVersions() {
  const release = await readReleaseVersion();
  const names = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'web/index.html', 'desktop/ui/index.html'];
  const [pkg, lock, tauri, cargo, cargoLock, web, library] = await Promise.all(
    names.map((name) => fs.readFile(path.join(APP_ROOT, name), 'utf8')),
  );
  const versions = {
    'package.json': JSON.parse(pkg).version,
    'package-lock.json': JSON.parse(lock).version,
    'package-lock.json root package': JSON.parse(lock).packages?.['']?.version,
    'src-tauri/tauri.conf.json': JSON.parse(tauri).version,
    'src-tauri/Cargo.toml': cargo.match(/^version = "([^"]+)"/m)?.[1],
    'src-tauri/Cargo.lock': cargoLock.match(/\[\[package\]\]\s+name = "viento-studio"\s+version = "([^"]+)"/)?.[1],
  };
  for (const [name, version] of Object.entries(versions)) {
    if (version !== release.buildVersion) throw new Error(`${name}: expected ${release.buildVersion} for ${release.version}, got ${version}`);
  }
  for (const [name, html] of [['web/index.html', web], ['desktop/ui/index.html', library]]) {
    if (html.match(/id="appVersion"[^>]*>([^<]+)</)?.[1] !== release.version) {
      throw new Error(`${name}: displayed version must match VERSION (${release.version})`);
    }
  }
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== '--next') {
      throw new Error('Usage: node desktop/version.mjs --next');
    }
    console.log(nextReleaseVersion((await readReleaseVersion()).version));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
