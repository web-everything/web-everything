/** Merge the PR's base into its head; host effects live in update-branch-io.mjs. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';

export const UPDATE_BRANCH_OP = 'update-branch';

function validate({ pr, reason }) {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new TypeError('update-branch: --pr must be a positive integer');
  if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('update-branch: --reason is required and must be non-empty');
}

function behind(value) {
  if (!Number.isSafeInteger(value?.behind_by) || value.behind_by < 0) throw new Error('unreadable behind count; inspect the PR manually');
  return value.behind_by;
}

/** Injected IO only, like maintenance. At most one write and two post-write PR reads.
 * Not a merge/refresh path: it only merges base into the head (expected_head_sha-locked, so a moved head is refused
 * by GitHub). The new head voids any approval and re-runs every check, so no merge guard is bypassed. */
export async function runUpdateBranch(input, io) {
  validate(input);
  const { pr, reason } = input;
  const repo = input.repo ?? CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;
  const result = { ok: false, pr, actor: io.actor(), reason, beforeHead: null, afterHead: null,
    behindBefore: null, behindAfter: null };
  let accepted = false;
  try {
    const pull = await io.readPr(repo, pr);
    result.beforeHead = pull?.head?.sha ?? null;
    result.afterHead = result.beforeHead;
    if (pull?.state !== 'open') {
      Object.assign(result, { refused: true, status: 'not-open' });
    } else {
      if (!result.beforeHead || !pull?.base?.ref) throw new Error('missing PR head/base; inspect the PR manually');
      result.behindBefore = behind(await io.compare(repo, pull.base.ref, result.beforeHead));
      result.behindAfter = result.behindBefore;
      if (result.behindBefore === 0) Object.assign(result, { ok: true, status: 'already-up-to-date' });
      else if (pull.mergeable === false || pull.mergeable_state === 'dirty') {
        let conflicts;
        try { conflicts = await io.files(repo, pr); } catch { conflicts = []; }
        Object.assign(result, { refused: true, status: 'conflict', conflicts,
          detail: 'Conflict: candidate PR files only (first 100); inspect the full PR diff manually to resolve conflicts.' });
      } else if (pull.mergeable !== true || !pull.mergeable_state || pull.mergeable_state === 'unknown') {
        Object.assign(result, { refused: true, status: 'mergeability-unknown', detail: 'Retry after GitHub computes mergeability, or inspect the PR manually.' });
      } else {
        const status = await io.update(repo, pr, result.beforeHead);
        if (status !== 202) throw new Error(`update not accepted (HTTP ${status ?? 'unknown'}); inspect the PR before retrying`);
        accepted = true;
        Object.assign(result, { ok: false, status: 'unconfirmed', afterHead: null, behindAfter: null,
          detail: 'Accepted; if no new head is observed after two reads, inspect the PR before retrying.' });
        for (let attempt = 0; attempt < 2; attempt++) {
          await io.sleep(250);
          const next = await io.readPr(repo, pr);
          if (next?.head?.sha && next.head.sha !== result.beforeHead) {
            result.afterHead = next.head.sha;
            if (!next.base?.ref) throw new Error('missing updated base ref');
            result.behindAfter = behind(await io.compare(repo, next.base.ref, next.head.sha));
            if (result.behindAfter === 0) { result.ok = true; result.status = 'updated'; delete result.detail; }
            else Object.assign(result, { ok: false, refused: true, status: 'partially-updated',
              detail: 'New head observed but still behind the base; inspect the PR before retrying.' });
            break;
          }
        }
      }
    }
  } catch (error) {
    Object.assign(result, { ok: false, status: accepted ? 'unconfirmed' : 'failed',
      detail: `${String(error.message ?? error).slice(0, 500)}; inspect the PR before retrying` });
    if (!accepted) result.refused = true;
  }
  const logged = await io.append({ kind: UPDATE_BRANCH_OP, repo, pr, detail: result });
  if (!logged) result.logWarning = 'Event log unavailable; preserve this result for the operator.';
  return result;
}

export function updateBranchOperation() {
  return op(UPDATE_BRANCH_OP, {
    input: { pr: { type: 'number', required: true }, reason: { type: 'string', required: true },
      repo: { type: 'string', required: false, default: CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug } },
    verdictFrom: 'assess',
    act: effect({ reads: ['input.pr', 'input.reason', 'input.repo'], effects: ({ input }) => {
      validate(input);
      return [{ type: UPDATE_BRANCH_OP, payload: input, idempotent: false }];
    } }),
    assess: compute({ reads: ['findings.act'], fn: ({ findings }) => {
      const entry = findings.act?.effects?.[0];
      if (entry?.status !== 'applied' || !entry.result) throw new Error('update-branch: effect did not complete');
      return entry.result;
    } }),
  });
}

export function finishUpdateBranch({ run, code, lines }) {
  return run?.verdict ? { code: run.verdict.ok ? 0 : 1, lines: [JSON.stringify(run.verdict)] } : { code, lines };
}
