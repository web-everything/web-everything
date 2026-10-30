#!/usr/bin/env node
/**
 * @file scripts/operations/handoff-home.mjs
 * @description WHERE THE ORCHESTRATOR HANDOFF LIVES, AND HOW IT IS VERSIONED — the location slice of #3779.
 *
 * THE RULING (#3779, operator, 2026-09-21): the handoff is TRACKED, on an `ops/*` branch, OUT of `~/.claude/`,
 * and `/continue` and `/handoff` stop typing its path. This script is the one place that answers "where", so a
 * command asks it instead of hard-coding a directory:
 *
 *   `path` — print the working copy's absolute directory (`~/workspace/.operations/handoff/`).
 *   `pull` — bring the working copy up to date from `origin/ops/handoff` (fast-forward only).
 *   `push` — commit the working copy's two files onto `ops/handoff` and push them. Never a force.
 *
 * THE WORKING COPY is an ordinary git checkout of `ops/handoff` in that directory, and it never commits on its
 * own: its `HEAD` is always the remote tip it last saw. That is what makes "diverged" a one-line test — if the
 * remote tip is not the working copy's `HEAD`, someone else pushed since this copy last synced, and writing
 * over it would silently drop their version. `push` refuses and says `pull` first.
 *
 * ONE TRANSPORT. The commit and push go through `we:scripts/lib/git-transport-branch.mjs`, the same helper
 * `ops/review-requests` and `ops/pr-views` use, with this repo's checkout as the board — the worktree dance,
 * the explicit refspec and the always-prune all come with it. Its `assertReady` hook re-checks the tip INSIDE
 * the transport's worktree, so a push that lands between this script's check and the transport's fetch is
 * still refused rather than written over. The only thing added to the transport for this is `createIfAbsent`,
 * for the very first push, when `ops/handoff` does not exist yet.
 *
 * THE PUBLISH GATE runs BEFORE anything is written, on every push: `scrubPublish`
 * (`we:scripts/lib/secret-scrub.mjs`) over both files always, and on a PUBLIC repo also a personal
 * home-directory path (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`), which `scrubPublish` deliberately
 * does not catch (its header says why). An unknown visibility is refused too: the gate fails closed. There is
 * no override flag — pushing personal text to a public branch is the operator's decision, not a flag's.
 *
 * NOT HERE (#3779 design points 1, 2, 3, 5, unruled): no generator, no generated/hand-kept split, no word cap.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageOnTransportBranch, trackingRefspec } from '../lib/git-transport-branch.mjs';
import { scrubPublish } from '../lib/secret-scrub.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';
import { handoffHome } from '../lib/handoff-path.mjs';

// Preserve the CLI module's public API; location-only consumers use the leaf module directly.
export { handoffHome };

export const HANDOFF_BRANCH = 'ops/handoff';

/** The snapshot `/handoff` rewrites, and the operator's standing rules it only ever appends to. */
export const HANDOFF_FILES = Object.freeze(['handoff-webeverything.md', 'handoff-webeverything-rules.md']);

/** This repository's checkout: the board the transport pushes from, and where `origin` is read. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A personal home directory in a path. `scrubPublish` leaves paths alone on purpose; a public branch cannot. */
export const PERSONAL_PATH = /\/Users\/(?!Shared\b)[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[^\\\s]+/;

const KNOWN_VISIBILITY = new Set(['PUBLIC', 'PRIVATE', 'INTERNAL']);

/**
 * PURE. Why these files may not be pushed to a repo of this visibility; empty means they may.
 *
 * @param {{visibility: string|null, files: Array<{name: string, content: string}>}} o
 * @returns {string[]}
 */
export function publishRefusals({ visibility, files }) {
  const reasons = [];
  if (!KNOWN_VISIBILITY.has(visibility)) {
    reasons.push(`repository visibility is unknown (${JSON.stringify(visibility)}), so the gate cannot tell who could read the branch`);
  }
  for (const { name, content } of files) {
    for (const why of scrubPublish(content)) reasons.push(`${name}: ${why}`);
    if (visibility === 'PUBLIC') {
      const hit = content.match(PERSONAL_PATH);
      if (hit) reasons.push(`${name}: personal home-directory path (${hit[0]}) on a PUBLIC repository`);
    }
  }
  return reasons;
}

/** `owner/repo` out of a GitHub remote URL, or null for anything else (a local bare repo, another host). */
export function githubSlug(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The repo's visibility from `gh`, or null when it cannot be read (no slug, no `gh`, no auth). */
export function ghVisibility(slug) {
  if (!slug) return null;
  try {
    return execFileSync('gh', ['repo', 'view', slug, '--json', 'visibility', '-q', '.visibility'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function defaultGit(args, opts) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

const isCheckout = (dir) => existsSync(join(dir, '.git'));

function revParse(run, dir, ref) {
  try { return run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir }).trim() || null; } catch { return null; }
}

function remoteHasBranch(run, cwd, remote) {
  return Boolean(run(['ls-remote', '--heads', remote, `refs/heads/${HANDOFF_BRANCH}`], { cwd }).trim());
}

/** Make `dir` a checkout of `ops/handoff` whose origin is `originUrl`. Existing files are left exactly as they are. */
function ensureWorkingCopy(run, dir, originUrl) {
  if (!isCheckout(dir)) {
    run(['init', '--quiet', `--initial-branch=${HANDOFF_BRANCH}`], { cwd: dir });
    run(['remote', 'add', 'origin', originUrl], { cwd: dir });
    return;
  }
  const branch = run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir }).trim();
  if (branch !== HANDOFF_BRANCH) {
    throw new Error(`handoff-home: ${dir} is a checkout of ${JSON.stringify(branch)}, not ${HANDOFF_BRANCH}; refusing to touch it`);
  }
}

/** Fetch the remote tip into the working copy. Returns its sha, or null when the branch does not exist yet. */
function fetchTip(run, dir) {
  if (!remoteHasBranch(run, dir, 'origin')) return null;
  run(['fetch', '--quiet', 'origin', trackingRefspec(HANDOFF_BRANCH)], { cwd: dir });
  return revParse(run, dir, `origin/${HANDOFF_BRANCH}`);
}

function originOf(run, board) {
  return run(['remote', 'get-url', 'origin'], { cwd: board }).trim();
}

/**
 * `pull`: fast-forward the working copy to `origin/ops/handoff`.
 *
 * @returns {{status: 'no-remote-branch'|'up-to-date'|'updated', dir: string, from?: string|null, to?: string}}
 */
export function pullHandoff({ dir = handoffHome(), board = REPO_ROOT, run = defaultGit } = {}) {
  const originUrl = originOf(run, board);
  // Nothing on the remote yet: say so and leave the directory exactly as it is (no `git init` as a side effect).
  if (!isCheckout(dir) && !remoteHasBranch(run, board, originUrl)) return { status: 'no-remote-branch', dir };
  ensureWorkingCopy(run, dir, originUrl);
  const tip = fetchTip(run, dir);
  if (!tip) return { status: 'no-remote-branch', dir };
  const head = revParse(run, dir, 'HEAD');
  if (head === tip) return { status: 'up-to-date', dir, to: tip };

  if (!head) {
    // First sync of a directory that already holds the files: adopt the remote only where nothing would be lost.
    const differing = HANDOFF_FILES.filter((name) => {
      const local = join(dir, name);
      if (!existsSync(local)) return false;
      let remote;
      try { remote = run(['show', `${tip}:${name}`], { cwd: dir }); } catch { return true; }
      return readFileSync(local, 'utf8') !== remote;
    });
    if (differing.length) {
      throw new Error(`handoff-home: refusing to pull — ${differing.join(', ')} in ${dir} differ from ${HANDOFF_BRANCH} and were never pushed; move them aside or push them first`);
    }
    run(['reset', '--quiet', tip], { cwd: dir });
    run(['checkout', '--quiet', '--', '.'], { cwd: dir });
    return { status: 'updated', dir, from: null, to: tip };
  }

  try {
    run(['merge', '--ff-only', '--quiet', `origin/${HANDOFF_BRANCH}`], { cwd: dir });
  } catch (e) {
    throw new Error(`handoff-home: pull could not fast-forward ${dir} to ${HANDOFF_BRANCH}: ${String(e.stderr || e.message).trim()}`);
  }
  return { status: 'updated', dir, from: head, to: tip };
}

/**
 * `push`: gate, check the remote has not moved, then commit both files through the transport.
 *
 * @returns {{status: 'refused', reasons: string[]} | {status: 'pushed'|'unchanged', commit: string, created?: boolean}}
 */
export function pushHandoff({
  dir = handoffHome(),
  board = REPO_ROOT,
  run = defaultGit,
  visibility = ghVisibility,
  message = `ops/handoff: handoff snapshot and rules, ${new Date().toISOString()}`,
} = {}) {
  const missing = HANDOFF_FILES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length) return { status: 'refused', reasons: [`missing in ${dir}: ${missing.join(', ')}`] };
  const files = HANDOFF_FILES.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));

  // THE GATE FIRST: nothing below (not even `git init` of the working copy) runs for content that may not ship.
  const originUrl = originOf(run, board);
  const reasons = publishRefusals({ visibility: visibility(githubSlug(originUrl)), files });
  if (reasons.length) return { status: 'refused', reasons };

  ensureWorkingCopy(run, dir, originUrl);
  const tip = fetchTip(run, dir);
  const head = revParse(run, dir, 'HEAD');
  if (tip && head !== tip) {
    return {
      status: 'refused',
      reasons: [head
        ? `diverged: ${HANDOFF_BRANCH} on origin is at ${tip.slice(0, 12)} but this working copy last synced at ${head.slice(0, 12)}; run pull, reconcile, then push`
        : `diverged: ${HANDOFF_BRANCH} already exists on origin (${tip.slice(0, 12)}) and this working copy has never pulled it; run pull first`],
    };
  }
  if (!tip && head) {
    return { status: 'refused', reasons: [`${HANDOFF_BRANCH} is gone from origin but this working copy has history (${head.slice(0, 12)}); refusing to recreate it`] };
  }

  const diverged = new Error('diverged');
  let staged;
  try {
    staged = stageOnTransportBranch({
      board,
      branch: HANDOFF_BRANCH,
      files: files.map(({ name, content }) => ({ path: name, content })),
      message,
      run,
      createIfAbsent: !tip,
      // Re-checked where the commit is actually built: a push that raced in after `fetchTip` is refused here.
      assertReady: ({ run: git, wt, created }) => {
        if (created ? tip !== null : git(['rev-parse', 'HEAD'], { cwd: wt }).trim() !== tip) throw diverged;
      },
    });
  } catch (e) {
    if (e === diverged) return { status: 'refused', reasons: [`diverged: ${HANDOFF_BRANCH} moved on origin during this push; run pull, reconcile, then push`] };
    throw e;
  }

  // Resync: the working copy's HEAD becomes the tip just pushed. A mixed reset moves HEAD and the index only;
  // the files on disk are the bytes that were pushed, so the copy comes out clean.
  const pushedTip = fetchTip(run, dir);
  run(['reset', '--quiet', pushedTip], { cwd: dir });
  return { status: staged.pushed ? 'pushed' : 'unchanged', commit: pushedTip, ...(staged.created ? { created: true } : {}) };
}

function describe(verb, out) {
  if (out.status === 'refused') return `handoff ${verb} REFUSED:\n${out.reasons.map((r) => `  - ${r}`).join('\n')}`;
  if (verb === 'pull') {
    if (out.status === 'no-remote-branch') return `handoff pull: ${HANDOFF_BRANCH} does not exist on origin yet; ${out.dir} left as it is`;
    return `handoff pull: ${out.status}${out.to ? ` at ${out.to.slice(0, 12)}` : ''} (${out.dir})`;
  }
  return `handoff push: ${out.status}${out.created ? ` (created ${HANDOFF_BRANCH})` : ''} at ${out.commit.slice(0, 12)}`;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const [verb, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  try {
    if (verb === 'path') {
      writeLineSync(1, handoffHome());
    } else if (verb === 'pull' || verb === 'push') {
      const out = verb === 'pull' ? pullHandoff() : pushHandoff();
      writeLineSync(out.status === 'refused' ? 2 : 1, json ? JSON.stringify(out) : describe(verb, out));
      if (out.status === 'refused') process.exitCode = 1;
    } else {
      writeLineSync(2, 'usage: handoff-home.mjs path|pull|push [--json]');
      process.exitCode = 2;
    }
  } catch (e) {
    writeLineSync(2, `error: ${String(e?.message ?? e)}`);
    process.exitCode = 1;
  }
}
