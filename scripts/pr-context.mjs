#!/usr/bin/env node
/** Read-only context port for jurors/fixers. Head must come from the examined work order.
 * Context is TTL bounded, never merge/label/write authority. No daemon or background work.
 */
import { pathToFileURL } from 'node:url';
import { runGhSync } from './lib/gh-throttle.mjs';
import { readPinnedPrContext } from './lib/review-pr-snapshot.mjs';
import { readCompletePrComments } from './conveyor/pr-comments-complete.mjs';

export function readPrContextCli(args, { exec = runGhSync, ...snapshotOptions } = {}) {
  const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const pr = args.find(a => /^\d+$/.test(a));
  const repo = option('repo'), headSha = option('head');
  // Complete comments are shared by the fixer pack and every CLI reader, including long threads.
  const view = readPinnedPrContext({ ...snapshotOptions, repo, pr, headSha, exec,
    readComments: readCompletePrComments });
  const field = option('field');
  if (field && !Object.hasOwn(view, field)) throw new Error(`pr-context: unknown field ${field}`);
  return field ? view[field] : view;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = readPrContextCli(process.argv.slice(2));
    process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result)}\n`);
  } catch (e) {
    console.error(`pr-context: ${e.message}`);
    process.exitCode = 1;
  }
}
