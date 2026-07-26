const DEFAULT_PORT = 4173;

function printHelp() {
  console.log(`Usage: start-doc-site.mjs [options]\n\nOptions:\n  -p, --port PORT      HTTP port (default: 4173)\n  -m, --mode MODE      运行模式：browse（只读）/ edit（可编辑） default: browse\n      --merge-backstory      合并背景故事到英雄（默认关闭）\n      --no-merge-backstory   保持背景故事独立文件（默认）\n      --no-open              不自动打开浏览器\n      --no-build             跳过索引重建（保留现有索引）\n      --no-standardize       跳过标准化步骤\n  -h, --help            显示帮助`);
}

function parseSiteArgs(args) {
  const options = {
    port: DEFAULT_PORT,
    openBrowser: true,
    runBuild: true,
    runStandardize: true,
    mode: 'browse',
    mergeBackstory: 'default',
    showHelp: false,
  };

  const valueArgs = new Set(['-p', '--port', '-m', '--mode']);

  const rest = [...args];
  while (rest.length > 0) {
    const current = rest.shift();

    if ((current === '-p' || current === '--port')) {
      const next = rest.shift();
      if (!next) {
        throw new Error('缺少 --port 参数');
      }
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`非法端口: ${next}`);
      }
      options.port = parsed;
      continue;
    }

    if ((current === '-m' || current === '--mode')) {
      const next = rest.shift();
      if (!next) {
        throw new Error('缺少 --mode 参数');
      }
      const lower = next.toLowerCase();
      if (lower !== 'browse' && lower !== 'edit') {
        throw new Error(`无效 mode: ${next}，可选 browse | edit`);
      }
      options.mode = lower;
      continue;
    }

    if (current === '--no-open') {
      options.openBrowser = false;
      continue;
    }

    if (current === '--no-build') {
      options.runBuild = false;
      continue;
    }

    if (current === '--no-standardize') {
      options.runStandardize = false;
      continue;
    }

    if (current === '--merge-backstory') {
      options.mergeBackstory = 'on';
      continue;
    }

    if (current === '--no-merge-backstory') {
      options.mergeBackstory = 'off';
      continue;
    }

    if (current === '-h' || current === '--help') {
      options.showHelp = true;
      return options;
    }

    if (valueArgs.has(current)) {
      throw new Error(`缺少参数：${current}`);
    }

    throw new Error(`未知参数：${current}`);
  }

  return options;
}

export {
  DEFAULT_PORT,
  printHelp,
  parseSiteArgs,
};
