#!/usr/bin/env node
/**
 * @file scripts/operations/gh-etag-prune.mjs
 * @description Prune the on-disk GitHub ETag cache (age + size bound). `node scripts/operations/gh-etag-prune.mjs [--dry-run] [--dir=<d>]`.
 */
import { pathToFileURL } from 'node:url';
import { ghEtagCacheDir, pruneEtagDir } from '../lib/gh-rest-read.mjs';

export function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes('--dry-run');
  const d = argv.find((a) => a.startsWith('--dir='));
  const dir = d ? d.slice(6) : ghEtagCacheDir(env);
  const r = pruneEtagDir(dir, { dryRun });
  console.log(JSON.stringify({ dir: dir.replace(env.HOME || '', '~'), ...r }));
  return r.error ? 1 : 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) { process.exitCode = main(); }
