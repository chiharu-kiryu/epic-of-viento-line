import { runNodeScript } from '../lib/process.mjs';
import {
  STANDARDIZE_SCRIPT,
  BUILD_STATIC_SCRIPT,
} from '../lib/paths.mjs';
import { resolveStandardizeArgs } from '../lib/rebuild-config.mjs';

async function rebuildIndex({ backstoryMode = 'default', sourceFilter = '', runStandardize = true, runBuild = true }) {
  const startedAt = Date.now();
  const args = resolveStandardizeArgs(backstoryMode);
  const normalizedSourceFilter = (sourceFilter || '').trim();
  const performedStandardize = Boolean(runStandardize);
  const shouldBuild = runBuild || runStandardize;
  const performedBuild = Boolean(shouldBuild);

  let standardResult = null;
  if (runStandardize) {
    const standardizeArgs = [...args];
    if (normalizedSourceFilter) {
      standardizeArgs.push(normalizedSourceFilter);
    }
    standardResult = await runNodeScript(STANDARDIZE_SCRIPT, standardizeArgs);
  }

  let buildResult = null;
  if (shouldBuild) {
    buildResult = await runNodeScript(BUILD_STATIC_SCRIPT, []);
  }

  return {
    ok: true,
    source: normalizedSourceFilter || null,
    elapsedMs: Date.now() - startedAt,
    standardize: standardResult,
    build: buildResult,
    mode: normalizedSourceFilter ? 'partial' : 'full',
    performedStandardize,
    performedBuild,
  };
}

export {
  rebuildIndex,
};
