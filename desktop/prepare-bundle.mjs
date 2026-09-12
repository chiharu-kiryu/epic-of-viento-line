import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/lib/process.mjs';

// linuxdeploy's GTK plugin creates symlinks without replacing existing links.
// Recreate its generated staging directory on every bundle, keeping Rust build
// caches, completed installers and all workspace data intact.
if ((process.env.TAURI_ENV_PLATFORM || process.platform) === 'linux') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (!config.productName || /[/\\]/.test(config.productName)) throw new Error('Invalid bundle name');
  const metadata = await runCommand('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: path.join(root, 'src-tauri'),
  });
  const target = JSON.parse(metadata.stdout).target_directory;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const directory = path.join(target, entry.name);
    for (const profile of [directory, path.join(directory, 'debug'), path.join(directory, 'release')]) {
      await fs.rm(path.join(profile, 'bundle/appimage', `${config.productName}.AppDir`), {
        recursive: true, force: true,
      });
    }
  }
  console.log('AppImage staging directories prepared for a clean bundle.');
}
