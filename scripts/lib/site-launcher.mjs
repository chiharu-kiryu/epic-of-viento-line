import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, SCRIPT_ROOT } from './paths.mjs';
import { DOC_SITE_SERVER_SCRIPT } from './paths.mjs';
import { openInBrowser } from './process.mjs';
import { rebuildIndex } from './rebuild-workflow.mjs';
import { formatBackstoryLabel } from './rebuild-config.mjs';
import { runDocApiContractPreflight } from './verify-doc-api-contract.mjs';

function startStaticServe(port) {
  const child = spawn(process.execPath, [path.join(SCRIPT_ROOT, 'browse-server.mjs'), '--port', `${port}`], {
    cwd: PROJECT_ROOT, stdio: 'inherit',
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code || 0; });
}

function startDocServer(port, backstoryMode) {
  const child = spawn(process.execPath, [DOC_SITE_SERVER_SCRIPT, '--port', `${port}`], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOCS_BACKSTORY_MODE: backstoryMode,
    },
  });

  child.on('error', (error) => {
    console.error(`启动 doc 服务器失败: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function launchDocSite(options) {
  const {
    mode,
    port,
    openBrowser,
    runBuild,
    runStandardize,
    mergeBackstory,
  } = options;

  const shouldRebuild = runStandardize || runBuild;

  console.log('[0/1] 进行 API 契约预检...');
  await runDocApiContractPreflight();

  let currentStep = 1;
  const totalSteps = shouldRebuild ? (runStandardize && runBuild ? 3 : 2) : 1;

  if (shouldRebuild) {
    const result = await rebuildIndex({
      backstoryMode: mergeBackstory,
      runStandardize,
      runBuild,
    });

    if (result.performedStandardize) {
      console.log(`[${currentStep}/${totalSteps}] 已完成：标准化（backstory: ${formatBackstoryLabel(mergeBackstory)}）`);
      currentStep += 1;
    }
    if (result.performedBuild) {
      console.log(`[${currentStep}/${totalSteps}] 已完成：构建静态索引`);
      currentStep += 1;
    }
  }

  const browseUrl = `http://127.0.0.1:${port}/web/?mode=${mode}`;
  if (openBrowser) {
    if (!openInBrowser(browseUrl)) {
      console.warn('未检测到可用浏览器命令，无法自动打开');
    }
  }

  const serverStep = totalSteps > 0 ? Math.min(totalSteps, currentStep) : 1;
  const serverTotal = totalSteps;

  if (mode === 'edit') {
    console.log(`[${serverStep}/${serverTotal}] 启动编辑服务器（含 API）...`);
    startDocServer(port, mergeBackstory);
    return;
  }

  console.log(`[${serverStep}/${serverTotal}] 启动浏览模式静态服务...`);
  startStaticServe(port);
}

export {
  launchDocSite,
  startDocServer,
  startStaticServe,
};
