import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_ID = 'io.viento.studio';

// Match Tauri's app_config_dir / app_data_dir, including XDG overrides.
export function appStoragePaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const absolute = (value, fallback) => value && paths.isAbsolute(value) ? value : fallback;
  let configBase;
  let dataBase;
  if (platform === 'win32') {
    configBase = dataBase = absolute(env.APPDATA, paths.join(home, 'AppData', 'Roaming'));
  } else if (platform === 'darwin') {
    configBase = dataBase = paths.join(home, 'Library', 'Application Support');
  } else {
    configBase = absolute(env.XDG_CONFIG_HOME, paths.join(home, '.config'));
    dataBase = absolute(env.XDG_DATA_HOME, paths.join(home, '.local', 'share'));
  }
  const configRoot = paths.join(configBase, APP_ID);
  const dataRoot = paths.join(dataBase, APP_ID);
  return {
    configRoot, dataRoot,
    configFile: paths.join(configRoot, 'viento.config.json'),
    libraryFile: paths.join(dataRoot, 'library.json'),
    workspaces: paths.join(dataRoot, 'workspaces'),
    backups: paths.join(dataRoot, 'backups'),
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`无法读取本机配置 ${file}：${error.message}`, { cause: error });
  }
}

export function readWorkspaceSelector(file) {
  const config = readJson(file);
  if (config === undefined) return null;
  if (config?.version !== 1 || typeof config.workspace !== 'string' || !config.workspace.trim()) {
    throw new Error(`默认作品配置无效：${file}`);
  }
  return path.resolve(path.dirname(file), config.workspace);
}

export function resolveWorkspaceRoot({ appRoot, cwd = process.cwd(), env = process.env, storage = appStoragePaths({ env }) }) {
  if (env.VIENTO_WORKSPACE_ROOT) return path.resolve(cwd, env.VIENTO_WORKSPACE_ROOT);
  if (fs.existsSync(path.join(cwd, 'workspace.json')) || fs.existsSync(path.join(cwd, 'design-data'))) return path.resolve(cwd);
  // Retain explicit selectors from older source exports; new exports omit it.
  const legacy = readWorkspaceSelector(path.join(appRoot, 'viento.config.json'));
  if (legacy) return legacy;
  const selected = readWorkspaceSelector(storage.configFile);
  if (selected) return selected;
  const library = readJson(storage.libraryFile);
  if (library !== undefined && !Array.isArray(library?.recent)) throw new Error(`作品库记录无效：${storage.libraryFile}`);
  const recent = library?.recent.find((item) => typeof item?.path === 'string' && path.isAbsolute(item.path)
    && (fs.existsSync(path.join(item.path, 'workspace.json')) || fs.existsSync(path.join(item.path, 'design-data'))));
  return recent?.path || path.join(storage.workspaces, 'default');
}
