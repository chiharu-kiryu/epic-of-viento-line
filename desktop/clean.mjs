import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appStoragePaths, readWorkspaceSelector } from '../scripts/lib/app-storage.mjs';

// Only application build output belongs here. Never add dist/, workspaces/,
// .viento/, Git history or arbitrary user-supplied paths to this list.
const generated = ['src-tauri/target', 'src-tauri/binaries', 'src-tauri/gen/schemas',
  'desktop/resources', 'desktop/.cache', 'desktop/ui/i18n', 'mobile/dist',
  'src-tauri/gen/android/.gradle', 'src-tauri/gen/android/.kotlin', 'src-tauri/gen/android/build',
  'src-tauri/gen/android/app/build', 'src-tauri/gen/android/buildSrc/build', 'src-tauri/gen/android/buildSrc/.gradle',
  'src-tauri/gen/android/app/src/main/jniLibs', 'src-tauri/gen/android/.tauri',
  'src-tauri/gen/android/app/src/main/java/io/viento/studio/generated',
  'src-tauri/gen/android/app/src/main/assets/tauri.conf.json', 'src-tauri/gen/android/app/proguard-tauri.pro',
  'src-tauri/gen/android/app/tauri.build.gradle.kts', 'src-tauri/gen/android/app/tauri.properties',
  'src-tauri/gen/android/tauri.settings.gradle'];
const root = fileURLToPath(new URL('../', import.meta.url));

export async function cleanBuilds(appRoot, { dryRun = false, storage = appStoragePaths() } = {}) {
  const base = await fs.realpath(appRoot);
  const targets = [];
  const readJson = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const selector = readWorkspaceSelector(path.join(base, 'viento.config.json'));
  const localSelector = readWorkspaceSelector(storage.configFile);
  const protectedPaths = [path.join(base, 'workspaces'), storage.configRoot, storage.dataRoot];
  for (const workspace of [selector, localSelector, process.env.VIENTO_WORKSPACE_ROOT].filter(Boolean)) {
    const absolute = path.resolve(workspace);
    protectedPaths.push(absolute);
    const local = await readJson(path.join(absolute, '.viento/local.json'));
    const assets = local?.assetStores?.main;
    if (assets) {
      if (typeof assets !== 'string' || !path.isAbsolute(assets)) throw new Error('本机素材绑定无效，未清理构建目录');
      protectedPaths.push(assets);
    }
  }
  for (let i = 0; i < protectedPaths.length; i++) {
    protectedPaths[i] = await fs.realpath(protectedPaths[i]).catch((error) => {
      if (error.code === 'ENOENT') return protectedPaths[i];
      throw error;
    });
  }
  const contains = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
  // Validate the whole plan before deleting anything. Linked build parents can
  // point into another checkout or data drive; never traverse them.
  for (const relative of generated) {
    let current = base;
    const parts = relative.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
        throw new Error(`清理目录的父路径必须是实际文件夹：${current}`);
      }
    }
    const target = path.join(base, relative);
    const stat = await fs.lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isSymbolicLink() && protectedPaths.some((data) => contains(target, data) || contains(data, target))) {
      throw new Error(`构建目录与作品或素材位置重叠，未清理：${target}`);
    }
    if (stat) targets.push({ path: target, relative });
  }
  for (const target of targets) {
    if (!dryRun) await fs.rm(target.path, { recursive: true, force: true });
  }
  return targets.map((target) => target.relative);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('用法：npm run clean [-- --dry-run]');
    const dryRun = process.argv.includes('--dry-run');
    const files = await cleanBuilds(root, { dryRun });
    console.log(`${dryRun ? '将清理' : '已清理'} ${files.length} 个构建目录：${files.join(', ') || '无'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
