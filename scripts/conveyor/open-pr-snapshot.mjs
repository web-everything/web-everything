#!/usr/bin/env node
/** Runner discovery job: keep synchronous gh calls and large JSON off its event loop. */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { defaultFetchOpenPrs } from './open-pr-fetch.mjs';

export function writeOpenPrSnapshot({ repo, output }, { fetchOpenPrs = defaultFetchOpenPrs } = {}) {
  if (!repo || !output) throw new Error('open-pr-snapshot requires --repo and --output');
  const prs = fetchOpenPrs({ repo });
  writeFileSync(output, JSON.stringify(prs), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const arg = name => process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
    writeOpenPrSnapshot({ repo: arg('repo'), output: arg('output') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
