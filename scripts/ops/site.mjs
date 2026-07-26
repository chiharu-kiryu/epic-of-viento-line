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
    console.error(error.message);
    printHelp();
    process.exit(1);
  }
})();
