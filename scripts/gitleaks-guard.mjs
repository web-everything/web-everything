#!/usr/bin/env node
/** R1082 commit/push backstop. Require mode refuses absent push ranges.
 * New remote refs scan all history reachable from the pushed SHA; updates scan remote..local.
 * Malformed/unreadable evidence fails closed; auto mode visibly falls back for empty ranges.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadCredentialProtection } from './lib/credential-protection-settings.mjs';

export function pushedRanges(input) {
  if (typeof input !== 'string' || input.length > 1024 * 1024) throw Error('push evidence missing/over 1 MiB; operator must inspect refs and retry');
  const ranges = [];
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || ![fields[1], fields[3]].every(v => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v))) throw Error('invalid pre-push ref evidence; retry through Git');
    const [, local, , remote] = fields;
    if (/^0+$/.test(local)) continue; // Ref deletion introduces no content.
    ranges.push(/^0+$/.test(remote) ? local : `${remote}..${local}`);
  }
  return [...new Set(ranges)];
}
export function findGitleaks(env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, 'gitleaks');
    try { accessSync(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  return null;
}
export function gitleaksGuard({ phase, input = '', mode = 'auto', env = process.env,
  find = findGitleaks, run = spawnSync, log = console.error } = {}) {
  if (!['auto', 'require', 'off'].includes(mode)) { log('Invalid gitleaks mode; refusing unscanned operation.'); return 1; }
  if (!['pre-commit', 'pre-push'].includes(phase)) { log('Expected pre-commit or pre-push.'); return 1; }
  if (mode === 'off') { log('gitleaks secret scan disabled (mode=off).'); return 0; }
  const binary = find(env);
  if (!binary) {
    log('!!! gitleaks not installed: secret scan SKIPPED !!!\nInstall: brew install gitleaks (or https://github.com/gitleaks/gitleaks#installing)\nSet gitleaks.mode=require in scripts/settings/credential-protection.json to refuse missing scanners.');
    return mode === 'require' ? 1 : 0;
  }
  let commands;
  try { commands = phase === 'pre-commit' ? [['protect', '--staged', '--redact']]
    : pushedRanges(input).map(range => ['detect', '--redact', `--log-opts=${range}`]); }
  catch (e) { log(e.message); return 1; }
  if (phase === 'pre-push' && commands.length === 0) {
    if (mode === 'require') {
      log('No pre-push ranges supplied; mode=require refuses unscanned push. Retry through Git with ref evidence.');
      return 1;
    }
    log('No pre-push ranges supplied; mode=auto falls back to scanning HEAD~1..HEAD (HEAD for a single commit). This does not verify all pushed history.');
    const parent = run('git', ['rev-list', '--max-count=2', 'HEAD'], { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    const commits = String(parent.stdout ?? '').trim().split('\n');
    if (parent.error || parent.status !== 0 || commits.length > 2
      || !commits.every(sha => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))) {
      log('Cannot determine HEAD parent; repair Git evidence and retry.');
      return 1;
    }
    commands = [['detect', '--redact', `--log-opts=${commits.length === 2 ? 'HEAD~1..HEAD' : 'HEAD'}`]];
  }
  for (const args of commands) {
    const result = run(binary, args, { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 300000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) { log('gitleaks refused this operation (findings or scanner failure); inspect scanner output and repair before retrying.'); return 1; }
  }
  return 0;
}
export function main(argv = process.argv.slice(2)) {
  const { settings } = loadCredentialProtection();
  let input = '';
  try { if (argv[0] === 'pre-push') input = readFileSync(0, 'utf8'); }
  catch { console.error('Cannot read pre-push ref evidence; refusing push.'); return 1; }
  return gitleaksGuard({ phase: argv[0], input, mode: settings.gitleaks.mode });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
