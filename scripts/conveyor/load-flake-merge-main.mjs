/**
 * we:scripts/conveyor/load-flake-merge-main.mjs — a load-flake retry first merges current main into the PR head (#xg0rkxn).
 *
 * Live plateau #220 (2026-10-10): the fixer went red on host-load timing flakes, and the timing-test fix for exactly
 * those flakes (plateau #221) landed on main three minutes before the hold. The quiet-host re-dispatch then ran on the
 * old head 4687407aa, without #221, and went red on the same flakes. A retry must run on the PR as it would land.
 *
 * So before a quiet-host re-dispatch, when main has moved past the PR head, this merges main into the head with a
 * plain merge commit built WITHOUT a working tree (`git merge-tree --write-tree` + `git commit-tree`, the same
 * sanctioned shape as we:scripts/conveyor/poc-branch-sync.mjs) and pushes it as a fast-forward: no force, hooks off.
 * A merge that conflicts is NOT resolved here: the retry goes ahead on the old head and the conflict is left to the
 * normal conflict-fix path (we:scripts/conveyor/parked-pr-conflict-watch.mjs sees the PR as conflicting).
 *
 * Setting `loadFlake.mergeMainBeforeRetry` (default true) resolves in the policy-cascade shape (we:scripts/lib/
 * policy-cascade.mjs, PR #4772, once merged): standard default → platform preference → tool settings file → env.
 * The source is logged once per process.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MERGE_MAIN_POLICY = 'loadFlake';
export const MERGE_MAIN_KEY = 'mergeMainBeforeRetry';
export const MERGE_MAIN_STANDARD = true;
export const MERGE_MAIN_ENV = 'WE_LOAD_FLAKE_MERGE_MAIN_BEFORE_RETRY';
export const PLATFORM_PREFERENCES_PATH = join(ROOT, 'scripts/lib/delivery-platform-preferences.json');
export const PLATFORM_PREFERENCES_ENV = 'WE_PLATFORM_PREFERENCES_FILE';
export const TOOL_SETTINGS_PATH = join(ROOT, 'scripts/settings/load-flake.json');

const asBool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
};

function readJson(path, readFile) {
  try { return { data: JSON.parse(String(readFile(path, 'utf8'))) }; }
  catch (e) { return e?.code === 'ENOENT' ? {} : { error: `${path}: ${String(e?.message ?? e).split('\n')[0]}` }; }
}

/**
 * Resolve `loadFlake.mergeMainBeforeRetry` through standard → platform → tool → env. Each layer counts only when set
 * AND a boolean; an invalid value is named in `invalid` and never overrides a lower layer. Never throws.
 * @returns {{value:boolean, source:'standard'|'platform'|'tool'|'env', invalid:string[], errors:string[]}}
 */
export function resolveMergeMainBeforeRetry({ env = process.env, readFile = readFileSync } = {}) {
  let value = MERGE_MAIN_STANDARD;
  let source = 'standard';
  const invalid = [];
  const errors = [];
  const layer = (name, raw) => {
    if (raw === undefined) return;
    const b = asBool(raw);
    if (b === undefined) { invalid.push(`${name}=${JSON.stringify(raw)}`); return; }
    value = b; source = name;
  };
  const platformPath = String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim() || PLATFORM_PREFERENCES_PATH;
  const platform = readJson(platformPath, readFile);
  if (platform.error) errors.push(platform.error);
  layer('platform', platform.data?.[MERGE_MAIN_POLICY]?.[MERGE_MAIN_KEY]);
  const tool = readJson(TOOL_SETTINGS_PATH, readFile);
  if (tool.error) errors.push(tool.error);
  layer('tool', tool.data?.[MERGE_MAIN_KEY]);
  const envRaw = env?.[MERGE_MAIN_ENV];
  layer('env', envRaw === undefined || envRaw === '' ? undefined : envRaw);
  return { value, source, invalid, errors };
}

let lastLogged = null;
/** The cascade's source line, once per process per distinct effective value (the same shape policy-cascade prints). */
export function logMergeMainSource(resolved, write = (line) => process.stderr.write(line)) {
  const line = `policy-cascade · ${MERGE_MAIN_POLICY}: ${MERGE_MAIN_KEY}=${resolved.value} (${resolved.source})`
    + `${resolved.invalid.length ? ` · invalid: ${resolved.invalid.join(', ')}` : ''}${resolved.errors.length ? ` · errors: ${resolved.errors.join('; ')}` : ''}`;
  if (line === lastLogged) return false;
  lastLogged = line;
  write(`${line}\n`);
  return true;
}

/** The PR-comment sentence for a merge outcome (appended to the retry's result comment). Pure. */
export function describeMergeMain(out) {
  if (!out) return '';
  if (out.result === 'merged') return `Merged current \`${out.base}\` (${out.mainSha.slice(0, 9)}) into the head first, so the retry runs on the PR as it would land: ${out.headSha.slice(0, 9)} → ${out.sha.slice(0, 9)}.`;
  if (out.result === 'conflict') return `Current \`${out.base}\` (${out.mainSha.slice(0, 9)}) conflicts with the head${out.files?.length ? ` (${out.files.slice(0, 5).join(', ')})` : ''}; not merged here, left to the conflict-fix path.`;
  return '';
}

/**
 * IO: merge `base` into the PR head and push the merge commit as a fast-forward. Runs in the daemon's own checkout
 * (`cwd`), never a lane: plumbing only (no working tree, no checkout), hooks off, no force.
 * @param {{slug:string, branch:string, headSha:string, base?:string}} o
 * @returns {{result:'up-to-date'|'merged'|'conflict', base:string, headSha:string, mainSha:string, sha?:string, files?:string[]}}
 */
export function defaultMergeMain({ slug, branch, headSha, base = 'main' }, { run, cwd = ROOT, url = `https://github.com/${slug}.git` } = {}) {
  const git = (args, opts = {}) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts });
  git(['fetch', '--no-tags', '--quiet', url, `refs/heads/${base}`, `refs/heads/${branch}`]);
  const mainSha = git(['rev-parse', `FETCH_HEAD^{commit}`]).trim();
  const tip = git(['rev-parse', `${headSha}^{commit}`]).trim();
  try { git(['merge-base', '--is-ancestor', mainSha, tip]); return { result: 'up-to-date', base, headSha: tip, mainSha }; }
  catch (e) { if (e?.status !== 1) throw e; }
  let tree;
  try { tree = git(['merge-tree', '--write-tree', '--name-only', tip, mainSha]).split('\n')[0].trim(); }
  catch (e) {
    if (e?.status !== 1) throw e;
    // Exit 1 = conflicts: the first line is the tree, then the conflicted paths up to a blank line.
    const files = String(e.stdout ?? '').split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    return { result: 'conflict', base, headSha: tip, mainSha, files: [...new Set(files)] };
  }
  const sha = git(['commit-tree', tree, '-p', tip, '-p', mainSha, '-m',
    `Merge ${base} into ${branch} before the load-flake retry\n\nThe retry must run on the PR as it would land (#xg0rkxn).`]).trim();
  git(['push', '--quiet', url, `${sha}:refs/heads/${branch}`]);
  return { result: 'merged', base, headSha: tip, mainSha, sha };
}
