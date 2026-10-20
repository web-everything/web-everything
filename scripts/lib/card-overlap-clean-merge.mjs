/**
 * Card-overlap clean-merge relief for the queue file-overlap guard.
 *
 * The guard defers a candidate whose changed files overlap a PR already in GitHub's merge queue. Many PRs share
 * only backlog card files (`backlog/<card>.md`), and those usually merge cleanly. When the ONLY overlap is card
 * files, this module dry-merges the candidate head onto the merge queue's tip (the last entry's merge-group commit,
 * which already contains main plus every queued PR) with `git merge-tree --write-tree`. That is object-DB only:
 * no ref, branch, index or working tree changes, and nothing is pushed. A clean result lets the candidate enqueue;
 * GitHub's merge queue still builds and tests the real combination before main moves.
 *
 * Fail closed: any non-card overlap, an unknown entry file list, an unreadable queue tip, a fetch failure, a
 * merge-tree error or any conflict returns `relieve: false`, and the caller keeps today's deferral.
 *
 * Setting: drain.cardOverlapCleanMerge (boolean, standard false; env WE_DRAIN_CARD_OVERLAP_CLEAN_MERGE accepting
 * true/false, 1/0, on/off). Resolved standard < platform < tool < env with the source logged.
 */
import { execFileSync } from 'node:child_process';
import { cascadePolicy } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { gitRun } from './git-run.mjs';
import { graphql } from './merge-queue-adaptive-batching.mjs';

const SHA = /^[0-9a-f]{40}$/;

export function readCardOverlapCleanMerge({ env = process.env, tool, platform, log } = {}) {
  const raw = env.WE_DRAIN_CARD_OVERLAP_CLEAN_MERGE;
  const envValue = raw === undefined ? undefined
    : /^(true|1|on)$/i.test(raw) ? true : /^(false|0|off)$/i.test(raw) ? false : raw;
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, ...(log ? { log } : {}),
    standard: { cardOverlapCleanMerge: false },
    valid: { cardOverlapCleanMerge: v => typeof v === 'boolean' },
    envValues: { cardOverlapCleanMerge: envValue },
  });
  return { enabled: r.value.cardOverlapCleanMerge === true, source: r.sources?.cardOverlapCleanMerge ?? 'standard' };
}

/** A backlog card file: exactly `backlog/<name>.md`, no subdirectory, no control characters (JS `$` without /m is end of input). */
export const isCardFile = path => typeof path === 'string' && /^backlog\/[^/\x00-\x1f]+\.md$/.test(path);

/** True only when there is an overlap, no entry file list is unknown, and every shared path is a card file. */
export function cardOnlyOverlap(overlap) {
  if (!overlap?.overlap || !Array.isArray(overlap.with) || !overlap.with.length) return false;
  if (overlap.unknown?.length) return false;
  return overlap.with.every(entry => Array.isArray(entry.files) && entry.files.length > 0 && entry.files.every(isCardFile));
}

/**
 * The merge queue's tip: the merge-group commit of the last entry. Every entry must carry a commit, so a group
 * GitHub is still building reads as unknown (fail closed) rather than as a shorter queue.
 */
export function readQueueTip({ repo, exec = execFileSync }) {
  try {
    const [owner, name] = repo.split('/');
    const data = graphql(exec, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:100){pageInfo{hasNextPage} nodes{position headCommit{oid} pullRequest{number headRefOid}}}}}}', [`owner=${owner}`, `name=${name}`]);
    const page = data.repository?.mergeQueue?.entries;
    if (!Array.isArray(page?.nodes) || !page.nodes.length) return { error: 'merge queue empty or unreadable' };
    if (page.pageInfo?.hasNextPage) return { error: 'merge queue has more than 100 entries' };
    if (page.nodes.some(n => !SHA.test(n?.headCommit?.oid ?? '') || !Number.isInteger(n?.position))) {
      return { error: 'a queue entry has no merge-group commit yet' };
    }
    const last = [...page.nodes].sort((a, b) => a.position - b.position).at(-1);
    return { sha: last.headCommit.oid, num: last.pullRequest?.number ?? null,
      entries: page.nodes.map(n => ({ num: n.pullRequest?.number, headSha: n.pullRequest?.headRefOid ?? null })) };
  } catch (e) { return { error: String(e?.message ?? e).split('\n')[0] }; }
}

/** Dry merge `head` onto `tip` in the object DB. Never writes a ref; a missing commit is fetched by sha with no ref or FETCH_HEAD write. */
export function dryMergeOnto({ head, tip, cwd = process.cwd(), run = gitRun }) {
  if (!SHA.test(head ?? '') || !SHA.test(tip ?? '')) return { clean: false, error: 'missing or invalid sha' };
  const have = sha => run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
  const missing = [head, tip].filter(sha => !have(sha));
  if (missing.length) {
    const f = run('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ...missing], { cwd });
    if (f.status !== 0 || missing.some(sha => !have(sha))) {
      return { clean: false, error: `fetch failed (${String(f.stderr ?? '').trim().split('\n')[0] || `exit ${f.status}`})` };
    }
  }
  const r = run('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', tip, head], { cwd });
  if (r.status === 0 && SHA.test(String(r.stdout ?? '').split('\n')[0].trim())) return { clean: true };
  if (r.status === 1) {
    const paths = String(r.stdout ?? '').split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    return { clean: false, conflict: true, paths: [...new Set(paths)] };
  }
  return { clean: false, error: `merge-tree failed (${String(r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`})` };
}

/**
 * Decide whether a card-only overlap may enqueue. Returns `{ relieve, line }`; the caller logs `line` and keeps
 * its deferral unless `relieve` is true. `queued` ([{num, headSha}]) is the queue membership, with the head each
 * file list was read at, that the overlap was computed from. The tip read must show exactly those PRs at exactly
 * those heads, or a PR that joined or was re-queued in between (whose files were never compared) could ride along.
 */
export function cardOverlapRelief({ num, headSha, overlap, queued, repo, setting, exec = execFileSync, cwd, run = gitRun, readTip = readQueueTip }) {
  if (!setting?.enabled || !overlap?.overlap) return { relieve: false, line: null };
  const blockers = (overlap.with ?? []).map(entry => `#${entry.num}`).join(',');
  const tag = `card-overlap clean-merge: #${num} with ${blockers}`;
  const src = `drain.cardOverlapCleanMerge=on (${setting.source})`;
  if (!cardOnlyOverlap(overlap)) {
    return { relieve: false, line: `${tag} → skip: ${overlap.unknown?.length ? 'unknown queue file list' : 'non-card overlap'} — ${src}` };
  }
  try {
    const tip = readTip({ repo, exec });
    if (tip.error) return { relieve: false, line: `${tag} → skip: queue tip unknown (${tip.error}) — ${src}` };
    const ids = list => Array.isArray(list) && list.every(e => Number.isInteger(e?.num) && SHA.test(e?.headSha ?? ''))
      ? [...new Set(list.filter(e => e.num !== num).map(e => `${e.num}@${e.headSha}`))] : null;
    const checked = ids(queued);
    const atTip = ids(tip.entries);
    if (!checked || !atTip || checked.length !== atTip.length || !checked.every(id => atTip.includes(id))) {
      return { relieve: false, line: `${tag} → skip: queue changed between reads — ${src}` };
    }
    const m = dryMergeOnto({ head: headSha, tip: tip.sha, cwd, run });
    if (m.clean) return { relieve: true, line: `${tag} → enqueue (clean onto queue tip ${tip.sha.slice(0, 10)} after #${tip.num}) — ${src}` };
    if (m.conflict) return { relieve: false, line: `${tag} → skip: conflict (${m.paths.slice(0, 3).join(', ') || 'unnamed paths'}) — ${src}` };
    return { relieve: false, line: `${tag} → skip: ${m.error} — ${src}` };
  } catch (e) {
    return { relieve: false, line: `${tag} → skip: error (${String(e?.message ?? e).split('\n')[0]}) — ${src}` };
  }
}
