#!/usr/bin/env node
/**
 * @file scripts/readiness/trace-coverage.mjs
 * @description Shadow replay: trace-coverage.mjs trace-map.json misses.json [static-selected.json].
 * trace-map.json is mergeTraces output. The summary carries `incomplete`; when true, a warning names how many
 * results rest on incomplete evidence, whose untraced results are unknown (`traced: null`), not proof of absence.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareCoverage } from '../ci/dep-trace.mjs';

export function runTraceCoverage(argv, { readFile = readFileSync, print = console.log, warn = console.error } = {}) {
  if (argv.length < 2 || argv.length > 3) throw new Error('usage: trace-coverage.mjs trace-map.json misses.json [static-selected.json]');
  const [traceMap, misses, staticSelected] = argv.map(file => JSON.parse(readFile(file, 'utf8')));
  const summary = compareCoverage({ misses, traceMap, staticSelected });
  print(JSON.stringify(summary));
  if (summary.incomplete) warn(`trace-coverage: incomplete evidence for ${summary.counts.incomplete} result(s); `
    + 'a child process ran without the trace hook, so an untraced result there is unknown');
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runTraceCoverage(process.argv.slice(2)); }
  catch { console.error('trace-coverage: invalid or unreadable evidence'); process.exitCode = 1; }
}
