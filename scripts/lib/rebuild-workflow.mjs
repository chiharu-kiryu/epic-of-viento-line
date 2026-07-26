import { runNodeScript } from './process.mjs';
import {
  STANDARDIZE_SCRIPT,
  BUILD_STATIC_SCRIPT,
  PROJECT_ROOT,
} from './paths.mjs';
import { resolveStandardizeArgs } from './rebuild-config.mjs';

function normalizeRebuildSourceFilter(rawPath = '') {
  const safePath = String(rawPath || '').trim();
  if (!safePath) {
    return '';
  }
  return safePath.replace(/^\/+/, '');
}

function normalizeRebuildOptions(options = {}) {
  return {
    backstoryMode: options.backstoryMode || 'default',
    sourceFilter: normalizeRebuildSourceFilter(options.sourceFilter),
    runStandardize: options.runStandardize !== false,
    runBuild: options.runBuild !== false,
    projectRoot: options.projectRoot || PROJECT_ROOT,
  };
}

function makeRebuildPlan({ backstoryMode, sourceFilter, runStandardize, runBuild }) {
  const performedStandardize = Boolean(runStandardize);
  const shouldBuild = Boolean(runBuild || runStandardize);
  const performedBuild = Boolean(shouldBuild);

  const standardizeArgs = resolveStandardizeArgs(backstoryMode);
  if (performedStandardize && sourceFilter) {
    standardizeArgs.push(sourceFilter);
  }

  return {
    source: sourceFilter || null,
    mode: sourceFilter && performedStandardize ? 'partial' : 'full',
    standardizeArgs,
    performedStandardize,
    performedBuild,
    shouldBuild,
  };
}

async function runRebuildPlan({ projectRoot, standardizeArgs, runStandardize, runBuild }) {
  let standardizeResult = null;
  let buildResult = null;

  if (runStandardize) {
    standardizeResult = await runNodeScript(STANDARDIZE_SCRIPT, standardizeArgs, { cwd: projectRoot });
  }

  if (runBuild) {
    buildResult = await runNodeScript(BUILD_STATIC_SCRIPT, [], { cwd: projectRoot });
  }

  return {
    standardize: standardizeResult,
    build: buildResult,
  };
}

async function rebuildIndex(rawOptions = {}) {
  const options = normalizeRebuildOptions(rawOptions);
  const startedAt = Date.now();
  const plan = makeRebuildPlan(options);

  const runResult = await runRebuildPlan({
    projectRoot: options.projectRoot,
    standardizeArgs: plan.standardizeArgs,
    runStandardize: plan.performedStandardize,
    runBuild: plan.performedBuild,
  });

  return {
    ok: true,
    ...plan,
    elapsedMs: Date.now() - startedAt,
    ...runResult,
  };
}

export {
  normalizeRebuildSourceFilter,
  normalizeRebuildOptions,
  makeRebuildPlan,
  runRebuildPlan,
  rebuildIndex,
};
