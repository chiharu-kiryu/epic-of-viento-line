#!/usr/bin/env node
import { printHelp, parseSiteArgs } from '../lib/site-options.mjs';
import { launchDocSite } from '../lib/site-launcher.mjs';

const argv = process.argv.slice(2);

(async () => {
  try {
    const options = parseSiteArgs(argv);

    if (options.showHelp) {
      printHelp();
      process.exit(0);
    }

    await launchDocSite(options);
  } catch (error) {
    if (error?.code === 'DOCAPI_PRECHECK_FAILED') {
      console.error(error.message);
      if (error?.details?.length) {
        console.error('\n已停止启动：请先修复上述 API 契约问题再重试。');
      }
      process.exit(1);
      return;
    }

    console.error(error.message);
    printHelp();
    process.exit(1);
  }
})();
