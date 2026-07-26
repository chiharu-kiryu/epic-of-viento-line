#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { PROJECT_ROOT } from '../lib/paths.mjs';
import { openInBrowser, commandExists } from '../lib/process.mjs';
import { rebuildIndex } from './rebuild.mjs';
import { DOC_SITE_SERVER_SCRIPT } from '../lib/paths.mjs';
import { formatBackstoryLabel } from '../lib/rebuild-config.mjs';

const argv = process.argv.slice(2);

let port = 4173;
let openBrowser = true;
let runBuild = true;
let runStandardize = true;
let mode = 'browse';
let mergeBackstory = 'default';

function printHelp() {
  console.log(`Usage: start-doc-site.mjs [options]\n\nOptions:\n  -p, --port PORT      HTTP port (default: 4173)\n  -m, --mode MODE      运行模式：browse（只读）/ edit（可编辑） default: browse\n      --merge-backstory      合并背景故事到英雄（默认关闭）\n      --no-merge-backstory   保持背景故事独立文件（默认）\n      --no-open              不自动打开浏览器\n      --no-build             跳过索引重建（保留现有索引）\n      --no-standardize       跳过标准化步骤\n  -h, --help            显示帮助`);
}

function resolvePythonCommand() {
  if (commandExists('python3')) {
    return 'python3';
  }
  if (commandExists('python')) {
    return 'python';
  }
  return null;
}

function parseArgs(args) {
  const valueArgs = new Set(['-p', '--port', '-m', '--mode']);

  while (args.length > 0) {
    const current = args.shift();
    if ((current === '-p' || current === '--port')) {
      const next = args.shift();
      if (!next) {
        throw new Error('缺少 --port 参数');
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`非法端口: ${next}`);
      }
      port = parsed;
      continue;
    }

    if ((current === '-m' || current === '--mode')) {
      const next = args.shift();
      if (!next) {
        throw new Error('缺少 --mode 参数');
      }
      const lower = next.toLowerCase();
      if (lower !== 'browse' && lower !== 'edit') {
        throw new Error(`无效 mode: ${next}，可选 browse | edit`);
      }
      mode = lower;
      continue;
    }

    if (current === '--no-open') {
      openBrowser = false;
      continue;
    }

    if (current === '--no-build') {
      runBuild = false;
      continue;
    }

    if (current === '--no-standardize') {
      runStandardize = false;
      continue;
    }

    if (current === '--merge-backstory') {
      mergeBackstory = 'on';
      continue;
    }

    if (current === '--no-merge-backstory') {
      mergeBackstory = 'off';
      continue;
    }

    if (current === '-h' || current === '--help') {
      printHelp();
      process.exit(0);
    }

    if (valueArgs.has(current)) {
      throw new Error(`缺少参数：${current}`);
    }

    throw new Error(`未知参数：${current}`);
  }
}

function startStaticServe(portValue) {
  const command = resolvePythonCommand();
  if (!command) {
    console.error('Need python3 or python installed');
    process.exit(1);
  }

  const child = spawn(command, ['-m', 'http.server', `${portValue}`, '--bind', '127.0.0.1'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`启动静态服务失败: ${error.message}`);
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

function startDocServer(portValue, backstoryModeValue) {
  const child = spawn(process.execPath, [DOC_SITE_SERVER_SCRIPT, '--port', `${portValue}`], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOCS_BACKSTORY_MODE: backstoryModeValue,
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

(async () => {
  try {
    parseArgs(argv);

    const rebuild = runStandardize || runBuild;
    if (rebuild) {
      const result = await rebuildIndex({
        backstoryMode: mergeBackstory,
        runStandardize,
        runBuild,
      });
      if (result.performedStandardize) {
        console.log(`[1/3] 已完成：标准化（backstory: ${formatBackstoryLabel(mergeBackstory)}）`);
      }
      if (result.performedBuild) {
        const buildStepLabel = result.performedStandardize ? '2/3' : '1/3';
        console.log(`[${buildStepLabel}] 已完成：构建静态索引`);
      }
    }

    const browseUrl = `http://127.0.0.1:${port}/web/?mode=${mode}`;
    if (openBrowser) {
      if (!openInBrowser(browseUrl)) {
        console.warn('未检测到可用浏览器命令，无法自动打开');
      }
    }

    const serverStep = rebuild ? '3' : '1';
    const serverTotal = rebuild ? '3' : '1';
    if (mode === 'edit') {
      console.log(`[${serverStep}/${serverTotal}] 启动编辑服务器（含 API）...`);
      startDocServer(port, mergeBackstory);
      return;
    }

    console.log(`[${serverStep}/${serverTotal}] 启动浏览模式静态服务...`);
    startStaticServe(port);
  } catch (error) {
    console.error(error.message);
    printHelp();
    process.exit(1);
  }
})();
