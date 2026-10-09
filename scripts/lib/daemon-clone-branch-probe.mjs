/**
 * @file scripts/lib/daemon-clone-branch-probe.mjs — the probe behind the `daemon-clone-wrong-branch` health smell.
 *
 * Live 2026-10-09 06:52 ET: the verdict-ledger store writer checked `ops/review-requests` out IN the review daemon's
 * own clone. The tree lost `skills-src/`, the daemon died on MODULE_NOT_FOUND, and nothing noticed for ~1.5 h.
 * This reads each daemon clone's current branch (one `symbolic-ref` per clone) so the watch flags it in minutes.
 *
 * Only TRANSPORT/STORE branches (`ops/*`) count as wrong: a daemon clone never has a reason to sit on one. A
 * detached HEAD or a deliberately pinned lane branch (e.g. the host sampler) is out of scope here.
 */
import { execFileSync } from 'node:child_process';
import { daemonCloneRoots } from './daemon-clone-registry.mjs';

export const WRONG_BRANCH_RE = /^ops\//;

const defaultExec = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** @returns {{cloneRoot: string, branch: string}[]} clones currently on an `ops/*` branch. Never throws. */
export function probeDaemonCloneBranches({ roots, workspace, exec = defaultExec } = {}) {
  let list = roots;
  if (!list) { try { list = daemonCloneRoots(workspace); } catch { list = []; } }
  const out = [];
  for (const cloneRoot of list) {
    let branch;
    try { branch = String(exec(['-C', cloneRoot, 'symbolic-ref', '--short', '-q', 'HEAD']) ?? '').trim(); } catch { continue; }
    if (branch && WRONG_BRANCH_RE.test(branch)) out.push({ cloneRoot, branch });
  }
  return out;
}
