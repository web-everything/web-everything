#!/usr/bin/env node
/**
 * @file scripts/conveyor/standards-harness-driver.mjs
 * @description The CHILD process the Standards verifier runs the PR's protocol rules in (VERIFIER-STANDARDS-STATUS).
 *   plateau-app's harness imports each protocol's `rules.mjs` from the PR head, so PR code runs here, never in the
 *   verifier. This driver:
 *   1. reads the per-run nonce from fd 3 and closes the fd at once (the parent never puts it in env or argv, and it
 *      stays only in this module's scope);
 *   2. sends the harness's own console output to stderr, so stdout carries nothing but the result;
 *   3. imports main's harness and runs `validateAll(root)`;
 *   4. prints exactly one line `{"nonce","ok","count"}` and exits 0 only when every protocol passed.
 *   A rule that calls `process.exit(0)` early, or prints a fake marker, produces no result line carrying the nonce, so
 *   the parent's `harnessVerdict` fails the run. No nonce means no output and exit 1.
 * Usage (parent only): node standards-harness-driver.mjs --harness=<abs validate-protocols.mjs> --root=<abs protocols dir>
 */
import { readFileSync, closeSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const nonce = (() => {
  try { const value = readFileSync(3, 'utf8').trim(); closeSync(3); return value; } catch { return ''; }
})();
const log = (...parts) => console.error(...parts);
console.log = log; console.info = log; console.warn = log; console.debug = log;

const option = name => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
let code = 1;
try {
  const harness = option('harness'); const root = option('root');
  if (nonce.length >= 8 && harness && root) {
    const outcome = await (await import(pathToFileURL(harness).href)).validateAll(root);
    const count = Array.isArray(outcome?.results) ? outcome.results.length : 0;
    const ok = outcome?.ok === true && count >= 1;
    writeSync(1, `${JSON.stringify({ nonce, ok, count })}\n`);
    code = ok ? 0 : 1;
  }
} catch (error) { console.error(String(error?.message ?? error)); }
process.exit(code);
