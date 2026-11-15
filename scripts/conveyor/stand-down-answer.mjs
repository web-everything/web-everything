#!/usr/bin/env node
/** Explicit operator ceremony only. Contract: we:scripts/conveyor/stand-down-answer.md. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { rearmWindow } from './rearm-review.mjs';
import { buildOperatorAnswer, latestUnresolvedStandDown, parseOperatorAnswer, isTerminalStandDown } from './stand-down-answer-core.mjs';

/**
 * ONLY an operator `rearm-review` may supersede an ALREADY-ANSWERED stand-down (#6748: the answer is exactly what
 * deadlocked the PR). Requires `status:answered-waiting-fixer` AND an unchanged head (no commit newer than the
 * stand-down). Fails closed on a missing label, id, or unreadable date. Returns {target, supersedes} or null.
 */
function answeredStandDownToRearm(snapshot) {
  const { comments, labels, commits } = snapshot;
  if (!Array.isArray(labels) || !labels.some((l) => l?.name === 'status:answered-waiting-fixer')) return null;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const c = comments[i];
    if (!isTerminalStandDown(c)) continue;
    // The guard (rearm-review.mjs#rearmWindow) honours only ITS window's latest stand-down: any other target is refused.
    const win = rearmWindow(comments);
    if (win.rearmed || String(c.id) !== win.standDownId) return null; // one rearm-review per window
    let prior = null;
    for (let j = i + 1; j < comments.length; j += 1) {
      if (parseOperatorAnswer(comments[j])?.standDownId === String(c.id)) prior = comments[j]; // LAST answer wins
    }
    if (!c.id || !prior) return null;
    // Replay guard: a rearm-review answer already stands for this stand-down; never post a second.
    if (parseOperatorAnswer(prior).disposition === 'rearm-review') return null;
    // Same head: SHA identity when the stand-down names its head; else the head's commit must not post-date it
    // (and the last listed commit must be the live head).
    const named = /\n<!-- stand-down [^>\n]*\bhead=([0-9a-f]{7,40})\b[^>\n]* -->\s*$/.exec(c.body ?? '')?.[1]; // the TRAILER only
    const live = String(snapshot.headRefOid ?? '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(live)) return null;
    if (named) return live.startsWith(named) ? { target: c, supersedes: String(prior.id) } : null;
    if (String(commits?.at(-1)?.oid ?? '').toLowerCase() !== live) return null;
    const standAt = Date.parse(c.createdAt);
    const headAt = Date.parse(Array.isArray(commits) ? commits.at(-1)?.committedDate : undefined);
    if (!Number.isFinite(standAt) || !Number.isFinite(headAt) || headAt > standAt) return null;
    return prior.id ? { target: c, supersedes: String(prior.id) } : null;
  }
  return null;
}

export function runStandDownAnswer(argv, { gh = (args) => execFileSync('gh', args, {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}) } = {}) {
  const [pr, ...args] = argv;
  if (!/^[1-9]\d*$/.test(pr ?? '')) throw new Error('PR must be a positive integer');
  const flags = {};
  for (const arg of args) {
    const m = arg.match(/^--(repo|reason|actor|channel|disposition)=([\s\S]*)$/);
    if (!m || Object.hasOwn(flags, m[1])) throw new Error(`unknown or duplicate argument: ${arg}`);
    flags[m[1]] = m[2];
  }
  for (const key of ['repo', 'reason', 'actor', 'channel']) {
    if (!flags[key]?.trim()) throw new Error(`--${key} is required and must be non-empty`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(flags.repo)) throw new Error('--repo must be owner/name');
  // Validate the ceremony before any IO. --reason is deliberately never trimmed or paraphrased.
  buildOperatorAnswer({ standDownId: 'validation', ...flags });
  let snapshot;
  try {
    snapshot = JSON.parse(gh(['pr', 'view', pr, `--repo=${flags.repo}`, '--json', 'comments,labels,commits,headRefOid']));
  } catch (error) {
    throw new Error(`Could not read comments for ${flags.repo} PR #${pr}: ${String(error.message || error).split(/[\r\n]/)[0]}`);
  }
  let target = latestUnresolvedStandDown(snapshot.comments);
  let supersedes;
  if (!target && flags.disposition === 'rearm-review') ({ target, supersedes } = answeredStandDownToRearm(snapshot) ?? {});
  if (!target) throw new Error('no unresolved stand-down on this PR');
  if (flags.disposition === 'rearm-review' && !supersedes) {
    // Every rearm-review answer is checked by the guard's own window (rearm-review.mjs#rearmWindow): refuse what it would ignore.
    const win = rearmWindow(snapshot.comments);
    if (win.rearmed || String(target.id) !== win.standDownId) {
      throw new Error('rearm-review refused: the guard would ignore it (stand-down is outside the guard window, or a rearm-review already stands)');
    }
  }
  if (!target.id) throw new Error('unresolved stand-down has no durable comment id');
  const body = buildOperatorAnswer({ standDownId: String(target.id), ...flags, ...(supersedes ? { supersedes } : {}) });
  if (body.length > 65536) throw new Error('operator answer exceeds GitHub comment limit');
  // ONE durable write; no label swap, deletion, or automatic retry after an ambiguous write failure.
  return gh(['pr', 'comment', pr, `--repo=${flags.repo}`, '--body', body]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(String(runStandDownAnswer(process.argv.slice(2)) ?? '')); }
  catch (error) { process.stderr.write(`stand-down-answer: ${error.message}\n`); process.exitCode = 1; }
}
