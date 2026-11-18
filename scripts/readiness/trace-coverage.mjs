#!/usr/bin/env node
/**
 * @file scripts/readiness/trace-coverage.mjs
 * @description Shadow replay: trace-coverage.mjs trace-map.json misses.json [static-selected.json].
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareCoverage } from '../ci/dep-trace.mjs';

export function runTraceCoverage(argv, { readFile = readFileSync, print = console.log } = {}) {
  if (argv.length < 2 || argv.length > 3) throw new Error('usage: trace-coverage.mjs trace-map.json misses.json [static-selected.json]');
  const [traceMap, misses, staticSelected = []] = argv.map(file => JSON.parse(readFile(file, 'utf8')));
  const summary = compareCoverage({ misses, traceMap, staticSelected });
  print(JSON.stringify(summary));
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runTraceCoverage(process.argv.slice(2)); }
  catch { console.error('trace-coverage: invalid or unreadable evidence'); process.exitCode = 1; }
}
