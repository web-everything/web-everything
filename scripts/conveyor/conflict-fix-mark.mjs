/**
 * @file scripts/conveyor/conflict-fix-mark.mjs
 * @description Post the durable conflict-fix comment for a STACKED-BASE mechanical rebase (#3383), with NO label
 *   swap of any kind. The stacked-base sibling of `we:scripts/conveyor/advisory-fix-mark.mjs`, with the SAME
 *   deliberate shape: a durable marker comment, no label touched.
 *
 * WHY NO LABEL SWAP. `we:scripts/conveyor/reconcile-core.mjs`'s STACKED-BASE CONFLICT branch dispatches this
 * repair straight from the `conflicted` phase — the PR was NEVER bounced to `review:changes` first (unlike the
 * ordinary main-base conflict-fix round `we:scripts/conveyor/rearm-review.mjs --round=conflict` hands back), so
 * there is nothing to "re-arm". `review:accepted` (or whatever the PR already carried) rides through this repair
 * completely untouched — the point of the whole branch: a stacked PR's conflict against its OWN base, caused by
 * a fixer pushing to that base, is a purely mechanical rebase, never a reviewer-facing content conflict that
 * would owe a fresh human verdict. This file NEVER touches `review:accepted`, `review:changes`, `review:human`,
 * `review:pending`, or any other label — only the durable comment below.
 *
 * WHY THE SAME MARKER AS THE ORDINARY CONFLICT-FIX ROUND. `we:scripts/conveyor/conflict-fix-round-count.mjs`'s
 * {@link CONFLICT_FIX_COMMENT_MARKER} (and its {@link countConflictFixComments} reader) are single-sourced and
 * REUSED here unchanged, deliberately, rather than a fourth bespoke marker — this is the IDENTICAL kind of round
 * (a mechanical rebase-and-resolve, never a judgment call over a reviewer's finding) `#xkmu3gv` (PR #2579) built
 * `CONFLICT_FIX_ROUND_CAP`/`countConflictFixComments` for, just posted by a different caller for a population
 * that never goes through `rearm-review.mjs`'s label swap. Sharing the marker means BOTH populations bind on the
 * SAME durable cap `reconcile-core.mjs` reads back off the PR's own comment thread — no third counter to drift
 * from the other two.
 *
 * WHY A DURABLE COMMENT AT ALL (mirrors #2643/#2666/#xkmu3gv). `reconcile-core.mjs` bounds this population's
 * auto-fix at `CONFLICT_FIX_ROUND_CAP` so a genuinely unresolvable stacked-base conflict cannot flap forever;
 * that cap must survive a conveyor RESTART, which wipes any in-session tally. Each completed round posts exactly
 * ONE comment whose leading line is {@link CONFLICT_FIX_COMMENT_MARKER}, and the count IS PR state, read back off
 * the PR itself — no parallel state store (#2612 invariant).
 */
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';

export { CONFLICT_FIX_COMMENT_MARKER };

/**
 * we:scripts/conveyor/conflict-fix-mark.mjs#buildConflictFixMarkComment — the durable comment body a completed
 * STACKED-BASE mechanical rebase round posts. Its FIRST line MUST be {@link CONFLICT_FIX_COMMENT_MARKER}
 * (single-sourced, shared with the ordinary conflict-fix round) so posting and counting can never drift. Pure.
 * @param {{ actor?:string, baseRefName?:string|null }} o
 * @returns {string}
 */
export function buildConflictFixMarkComment({ actor = 'conveyor fix agent', baseRefName = null } = {}) {
  const base = baseRefName ? `\`${baseRefName}\`` : 'its own base branch';
  return [
    CONFLICT_FIX_COMMENT_MARKER,
    '',
    `${actor} resolved this PR's conflict against ${base} (a STACKED-BASE mechanical rebase, #3383 — this PR's ` +
      'base is not `main`, so the drain never lands it and this repair never went through a `review:changes` ' +
      'bounce) and re-pushed HEAD.',
    '',
    'This did NOT touch `review:accepted`, `review:changes`, `review:human`, `review:pending`, or any other ' +
      'label — there was nothing to re-arm, since the PR was never bounced. If GitHub has since RETARGETED this ' +
      'PR to `main` (its stacked base merged and was deleted — the normal path), the NEXT conflict on this PR is ' +
      'handled by the ordinary main-base conflict-fix flow instead, unaffected by this marker.',
  ].join('\n');
}

// ── IO SHELL (runs only as a CLI — the pure exports above stay side-effect-free on import) ────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const fail = (m) => {
    process.stderr.write(`✗ ${m}\n`);
    process.exit(1);
  };
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail('usage: conflict-fix-mark.mjs <pr> [--repo=<owner/name>] [--actor=<name>] [--base-ref=<name>]  (pr must be a positive integer)');
  }
  const body = buildConflictFixMarkComment({
    actor: typeof flags.actor === 'string' ? flags.actor : undefined,
    baseRefName: typeof flags['base-ref'] === 'string' ? flags['base-ref'] : null,
  });
  const args = ['pr', 'comment', String(pr), '--body', body];
  if (typeof flags.repo === 'string') args.push(`--repo=${flags.repo}`); // the fix agent runs in its WE lane clone; a missing --repo derives from cwd.
  try {
    execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  } catch (e) {
    fail(`could not post conflict-fix comment on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, pr, commented: true }) + '\n');
}
