/** Shared conflict finding body and bounce transport for the watcher and drain.
 * Kept independent of the watcher/operations import graph so drain and standards CLIs can load it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildTimeoutMs } from './bounded-child.mjs';

export function buildConflictFindingBody(pr, { appendOnlyStatute = false, reviewHumanFixable = false, resync = false, sameLineConflict = false, enqueueRefusal = null } = {}) {
  const ref = pr?.headRefName ? ` (\`${pr.headRefName}\`)` : '';
  // #3383-append-only-statute — an EXPLICIT, narrower instruction for the one case this file's classifier proves
  // mechanical: both sides only ADDED a new `### ` section at the same spot in a statute doc. Stated as its own
  // paragraph, ahead of the generic "read both sides' intent" instruction, so a fixer never has to re-derive from
  // the raw conflict markers that no existing rule text is actually in dispute here.
  const appendOnlyInstruction = appendOnlyStatute
    ? [
      '',
      "**Append-only statute conflict: resolve by keeping `main`'s version of the file unchanged and " +
        "re-inserting this PR's new `###` section(s), in the same place relative to the neighbouring sections, " +
        "after `main`'s new ones. Change no existing rule text.**",
    ]
    : [];
  // #xu2krte Fork 2 (review-human statute amendment) — this PR already carries `review:human`: a human reviews
  // the FINAL merged result regardless, so resolving the git-level conflict mechanically does not skip that
  // ceremony. Stated as its own explicit instruction (mirrors the append-only case above) so a fixer never has
  // to guess it is allowed to touch a statute file here, or forgets the scope boundary.
  const reviewHumanInstruction = reviewHumanFixable
    ? [
      '',
      '**Review-human statute amendment: resolve the CONFLICT ONLY.** `main` did not independently touch the ' +
        "same hunk this PR amends — verified by comparing diff hunks, not guessed — so keep this PR's own " +
        "intended amendment and reconcile it against whatever ELSE `main` added nearby. Make NO other edits " +
        'beyond resolving this conflict, and do **not** touch any `review:*` label — `review:human` stays; a ' +
        'human still reviews the final merged result before it can land. **Post a comment showing the ' +
        'conflicting hunk BEFORE your resolution and the resolved hunk AFTER** as before/after evidence of what ' +
        'you changed.',
    ]
    : [];
  if (resync) {
    return [
      `PR #${pr?.num ?? pr?.number ?? '?'}${ref} is behind \`main\`: GitHub reports \`mergeable: CONFLICTING\`, ` +
        'but `git merge-tree` finds NO conflict against current `main`. This is the WHOLE finding.',
      '',
      '**Re-sync with `main` — nothing to resolve.** Merge `main` into this branch (no rebase, no force-push), ' +
        'push it, and let GitHub recompute mergeability and run CI on the new head. If the merge unexpectedly ' +
        'conflicts, resolve only that conflict. Make no other edits and touch no `review:*` label.',
      '',
      '_Auto-detected by the parked-PR conflict watch (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`)._',
    ].join('\n');
  }
  return [
    enqueueRefusal ? `PR #${pr?.num ?? pr?.number ?? '?'}${ref}: GitHub refused enqueue: ${enqueueRefusal}` :
    `PR #${pr?.num ?? pr?.number ?? '?'}${ref} has drifted into a real GIT merge conflict against \`main\` — ` +
      "GitHub reports `mergeable: CONFLICTING`. This is the WHOLE finding; there is no separate reviewer comment " +
      'to read on this PR for it.',
    '',
    sameLineConflict
      ? '**Resolving the conflict IS the task.** Merge `main` into this branch (no rebase, no force-push), then return it to independent review.'
      : '**Resolving the conflict IS the task.** Rebase or merge `main` into this branch, resolve every conflicted ' +
      "hunk by reading BOTH sides' intent (this diff's own and whatever landed on `main` since), push the " +
      'resolution, and let the normal fix-agent flow (this bounce) carry it back to independent review.',
    ...(sameLineConflict ? [
      '',
      '**Genuine same-line conflict with `main` in a statute/leash-tier file.** Resolve each conflicting hunk ' +
        "by keeping BOTH sides' intent: main's newer rule text plus this PR's addition. Make no unrelated edits. " +
        'If a hunk is a true either/or choice of rule text you cannot reconcile safely, stand down ' +
        `with \`node scripts/conveyor/stand-down.mjs ${pr?.num ?? pr?.number ?? '?'} --reason=conflict\`, ` +
        'naming the hunk rather than guessing. Post before/after of each resolved hunk as evidence.',
    ] : []),
    ...appendOnlyInstruction,
    ...reviewHumanInstruction,
    '',
    '_Auto-detected by the parked-PR conflict watch (`we:scripts/conveyor/parked-pr-conflict-watch.mjs`, ' +
      '`#xw0odtv`), dispatched per `#xu2krte`._',
  ].join('\n');
}

export function defaultPostConflictFinding({ pr, repo, exec = execFileSync, appendOnlyStatute = false, reviewHumanFixable = false, resync = false, sameLineConflict = false, enqueueRefusal = null }) {
  const bodyPath = join(tmpdir(), `reconcile-finding-conflict-${pr?.number}-${randomUUID()}.md`);
  writeFileSync(bodyPath, buildConflictFindingBody({ num: pr?.number, headRefName: pr?.headRefName }, { appendOnlyStatute, reviewHumanFixable, resync, sameLineConflict, enqueueRefusal }), 'utf8');
  try {
    const argv = [
      join(dirname(fileURLToPath(import.meta.url)), '..', 'conveyor', 'reconcile-finding.mjs'), String(pr?.number),
      `--body-file=${bodyPath}`, '--agent=parked-pr-conflict-watch', '--channel=the parked-PR conflict watch (#xw0odtv, dispatched per #xu2krte)',
    ];
    if (repo) argv.push(`--repo=${repo}`);
    // #x5n4zn3 — was bare (no timeout).
    exec('node', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  } finally {
    try { unlinkSync(bodyPath); } catch { /* best-effort cleanup only */ }
  }
}
