import fs from 'node:fs/promises';
import path from 'node:path';

function forbiddenPath() {
  return Object.assign(new Error('文件路径不能包含链接或越出指定目录'), {
    statusCode: 403,
    errorCode: 'path_forbidden',
  });
}

// The selected root may itself be reached through a user-chosen alias. Below
// that root, reject links in every component, including existing create parents.
export async function resolveContainedPath(root, candidate, { allowMissing = false } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw forbiddenPath();
  const physicalRoot = await fs.realpath(root);
  let current = physicalRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw forbiddenPath();
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return path.join(physicalRoot, relative);
      throw error;
    }
  }
  return current;
}
