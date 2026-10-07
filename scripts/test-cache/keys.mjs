#!/usr/bin/env node
/**
 * @file scripts/test-cache/keys.mjs
 * @description prepare-124 S1 — key every unit test file and print tier counts (`--stats`) or one key (`--file=<path>`).
 * Read-only; never writes the store. `--json` prints the rows.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyAll } from '../lib/test-result-cache.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const root = resolve(flag('root')?.split('=')[1] ?? fileURLToPath(new URL('../..', import.meta.url)));
const t0 = Date.now();
const { rows, tiers, cacheable, uncacheable } = keyAll({ root });
const ms = Date.now() - t0;

if (flag('file')) {
  const want = flag('file').split('=')[1];
  console.log(JSON.stringify(rows.find((r) => r.file === want) ?? null, null, 2));
} else if (flag('json')) {
  console.log(JSON.stringify({ ms, tiers, rows }, null, 2));
} else {
  console.log(`keyed ${rows.length} unit test files in ${ms} ms (${cacheable} cacheable, ${uncacheable.length} not)`);
  console.log('tiers:');
  for (const [tier, n] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) console.log(`  ${tier.padEnd(18)} ${n}`);
  const reasons = {};
  for (const r of uncacheable) { const k = r.reason.replace(/ (?:in|\().*$/, '').slice(0, 60); reasons[k] = (reasons[k] ?? 0) + 1; }
  console.log('uncacheable reasons:');
  for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
