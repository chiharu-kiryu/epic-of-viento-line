import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function parseReleaseVersion(version) {
  const match = /^[a-z]\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/.exec(version);
  if (!match) throw new Error('VERSION must use the project release format, for example b.2.8 or b.2.8.1');
  return { version, buildVersion: `${match[1]}.${match[2]}.${match[3] ?? '0'}` };
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
