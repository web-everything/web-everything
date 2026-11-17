#!/usr/bin/env node
/**
 * @file scripts/readiness/remote-fallback-report.mjs
 * @description Report real remote fallbacks separately from advisory log rows.
 *   summarize is the pure core; main is the injectable IO shell. Importing does not read the log.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admissionLockRoot } from './heavy-admission.mjs';
import { readFallbackLog, summarize } from '../lib/remote-fallback-log.mjs';

/** IO boundary: resolve the shared admission log plus separate local attribution, then emit text or JSON. */
export function main(argv = process.argv.slice(2), {
  cwd = process.cwd(), env = process.env, resolveLockRoot = admissionLockRoot,
  readLog = readFallbackLog, log = line => console.log(line),
} = {}) {
  const override = argv.find(arg => arg.startsWith('--file='));
  const file = override ? override.slice('--file='.length) : join(resolveLockRoot(cwd, env), 'remote-fallbacks.jsonl');
  const { rows, missing, invalid, partial } = readLog(file);
  const report = { ...summarize(rows), missing, invalid, partial };
  if (argv.includes('--json')) {
    log(JSON.stringify(report));
  } else {
    // Reasons are log data: strip terminal control characters only at the text output boundary.
    const clean = value => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?');
    if (missing) log(`log missing: ${clean(file)}`);
    log(`invalid lines: ${invalid}`);
    log(`partial lines: ${partial}`);
    log('Real fallbacks by reason:');
    for (const [reason, count] of Object.entries(report.byReason)) log(`  ${clean(reason)}: ${count}`);
    log('Advisory rows by reason:');
    for (const [reason, count] of Object.entries(report.advisoryByReason)) log(`  ${clean(reason)}: ${count}`);
    log(`real fallbacks = ${report.real}`);
    log(report.topReal ? `top cause: ${clean(report.topReal.reason)} (${report.topReal.count})` : 'top cause: none (0)');
  }
  return missing || invalid > 0 || partial > 0 ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(`remote-fallback-report: ${String(error.message).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '?')}`);
    process.exitCode = 1;
  }
}
