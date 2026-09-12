import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../scripts/lib/process.mjs';
import { APP_ROOT, verifyReleaseVersions } from './version.mjs';

async function main() {
  const { version, buildVersion } = await verifyReleaseVersions();
  // Use Node to launch the CLI on every platform, including Windows where the
  // npm shim is a .cmd file and cannot be spawned directly without a shell.
  await runCommand(process.execPath, [path.join(APP_ROOT, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', ...process.argv.slice(2)], { cwd: APP_ROOT, stdio: 'inherit' });
  if (process.argv.some((arg) => ['--no-bundle', '--help', '-h', '--version', '-V'].includes(arg))) return;

  const metadata = await runCommand('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: path.join(APP_ROOT, 'src-tauri'),
  });
  const target = JSON.parse(metadata.stdout).target_directory;
  const token = new RegExp('(?<=[_-])' + buildVersion.replaceAll('.', '\\.') + '(?=[_.-])', 'g');
  async function renameBundles(directory, depth = 0) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3 && !/\.(?:app|AppDir)$/.test(entry.name)) {
        await renameBundles(source, depth + 1);
      } else if (entry.isFile() && /\.(?:AppImage|deb|rpm|dmg|exe|msi|app\.tar\.gz)(?:\.sig)?$/.test(entry.name)) {
        const renamed = entry.name.replace(token, version);
        if (renamed === entry.name) continue;
        const destination = path.join(directory, renamed.replaceAll(' ', '-'));
        await fs.rename(source, destination);
        console.log(`Release ${version}: ${destination}`);
      }
    }
  }
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(target, entry.name);
    for (const profile of [directory, path.join(directory, 'debug'), path.join(directory, 'release')]) {
      await renameBundles(path.join(profile, 'bundle'));
    }
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
