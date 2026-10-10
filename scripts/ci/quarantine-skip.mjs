#!/usr/bin/env node
/**
 * @file scripts/ci/quarantine-skip.mjs
 * @description CI's red-main QUARANTINE skip step (card xx7ckd6 N1; the rules are pure in
 *   we:scripts/lib/red-main-quarantine.mjs#decideCiSkip). Prints the vitest args that skip the quarantined test files
 *   for THIS job — `--exclude=<file> …` on one line, or an empty line — for the unit-suite steps of
 *   we:.github/workflows/ci.yml to append to their `npm run` line.
 *
 *   The list is read FRESH from the `ops/quarantine` branch at job start (`git fetch` of that ref,
 *   we:scripts/lib/red-main-quarantine-io.mjs#readQuarantine), NEVER from the PR's own tree, so a PR cannot add an
 *   entry for itself. Prints nothing (CI runs every test) when:
 *     - `redMainMode` is `stop` (the default). The mode is the one the safety net published on the list (`mode`, set
 *       from the daemon's own cascade, which a CI job cannot see); an unstamped list falls back to this job's cascade
 *       (we:scripts/lib/red-main-hold.mjs#resolveRedMainMode);
 *     - the list is unreadable, or the job's PR is unknown;
 *     - the job is main (push / dispatch) or the PR is a recorded main-fix PR (`fixPrs` on the list);
 *   and it always runs a quarantined file the PR itself changes. It never fails the step: any error ⇒ empty output
 *   (run everything — the safe direction). The decision and its reason go to stderr (the CI log).
 *
 * Usage (repo root as cwd, inside a GitHub Actions job):  node scripts/ci/quarantine-skip.mjs
 *   Test/replay overrides: --event=<name> --ref=<ref> --event-path=<file> --base=<branch> --changed=<a,b> --now=<ms>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuarantine } from '../lib/red-main-quarantine-io.mjs';
import { decideCiSkip, ciJobContext, RED_MAIN_MODES } from '../lib/red-main-quarantine.mjs';
import { resolveRedMainMode } from '../lib/red-main-hold.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });

/** The files this PR changes against its base (`origin/<base>...HEAD`), or `null` when not provable. */
export function changedFilesOf({ board, base, run = git }) {
  if (!base) return null;
  try {
    run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], board);
    return run(['diff', '--name-only', `origin/${base}...HEAD`], board).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
}

/**
 * The whole step, with every seam injectable. Returns `{line, why}` — `line` is what goes to stdout.
 */
export function quarantineSkip({
  env = process.env, board = process.cwd(), now = Date.now(), flags = {},
  mode = undefined, read = null, changed = undefined, readEvent = (p) => JSON.parse(readFileSync(p, 'utf8')),
}) {
  // The mode is the one the safety net PUBLISHED on the list (it resolves it through env / preference / settings, which
  // a CI job cannot see). An unstamped list falls back to this job's own cascade. An injected `mode` wins (replay/tests).
  const r = read ?? readQuarantine({ board });
  const published = r.ok && RED_MAIN_MODES.includes(r.list?.mode) ? { value: r.list.mode, source: 'ops/quarantine' } : null;
  mode = mode ?? published ?? resolveRedMainMode({ env });
  if (mode.value !== 'quarantine') return { line: '', why: `redMainMode is ${mode.value} (${mode.source}) — running everything` };
  let event = null;
  const eventPath = flags['event-path'] ?? env.GITHUB_EVENT_PATH;
  try { event = eventPath ? readEvent(eventPath) : null; } catch { event = null; }
  const ctx = ciJobContext({ eventName: flags.event ?? env.GITHUB_EVENT_NAME, ref: flags.ref ?? env.GITHUB_REF, event });
  const base = flags.base ?? env.GITHUB_BASE_REF ?? event?.pull_request?.base?.ref ?? event?.merge_group?.base_ref?.replace(/^refs\/heads\//, '') ?? null;
  const changedFiles = changed !== undefined ? changed
    : flags.changed !== undefined ? String(flags.changed).split(',').filter(Boolean)
      : (ctx.known && !ctx.onMain ? changedFilesOf({ board, base }) : null);
  const d = decideCiSkip({ mode: mode.value, read: r, ctx, changedFiles, now });
  const why = `${d.why}${d.unsupported?.length ? `; ${d.unsupported.length} name-qualified entr${d.unsupported.length === 1 ? 'y' : 'ies'} not skipped (vitest --exclude is per file)` : ''}`;
  return { line: d.skip.map((f) => `--exclude=${f}`).join(' '), why, skip: d.skip };
}

function flagsOf(argv) {
  const f = {};
  for (const a of argv) { if (!a.startsWith('--')) continue; const i = a.indexOf('='); if (i < 0) f[a.slice(2)] = true; else f[a.slice(2, i)] = a.slice(i + 1); }
  return f;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let out = { line: '', why: 'not run' };
  try {
    const flags = flagsOf(process.argv.slice(2));
    out = quarantineSkip({ flags, ...(flags.now ? { now: Number(flags.now) } : {}) });
  } catch (e) {
    out = { line: '', why: `error (${String(e?.message || e).split('\n')[0]}) — running everything` };
  }
  process.stderr.write(`red-main-quarantine skip: ${out.why}${out.line ? ` → ${out.line}` : ''}\n`);
  writeAllSync(1, `${out.line}\n`);
}
