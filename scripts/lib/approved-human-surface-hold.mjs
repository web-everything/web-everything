import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseLatestHumanClearedSha, scoreEscalation, clearanceBindsHead } from './review-escalation.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';

/** PURE: only a fully proven, manifest-free human approval keeps its head. */
export function decideHoldApprovedHumanSurfaceHead({ setting, approved, humanSurface, conflicting, manifestOnHead } = {}) {
  const hold = setting === 'on' && approved === true && humanSurface === true && conflicting === false && manifestOnHead === false;
  return { hold, reason: hold ? 'approved human-surface head retained; merge queue owns freshness' : 'approved human-surface head hold does not apply' };
}

/** IO: invalid layers fall through to the built-in off. */
export function resolveSkipRebaseApprovedHumanSurface({ env = process.env, readFile = readFileSync } = {}) {
  const parse = v => ['on', 'true', '1'].includes(String(v).toLowerCase()) ? 'on' : ['off', 'false', '0'].includes(String(v).toLowerCase()) ? 'off' : null;
  const raw = parse(env?.WE_MERGE_QUEUE_SKIP_REBASE_APPROVED_HUMAN_SURFACE);
  if (raw) return { value: raw, source: 'env' };
  try {
    const value = JSON.parse(readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'approved-human-surface-hold.json'), 'utf8'))?.mergeQueue?.skipRebaseApprovedHumanSurface;
    if (['on', 'off'].includes(value)) return { value, source: 'settings' };
  } catch { /* default */ }
  return { value: 'off', source: 'default' };
}

/** IO: read the live head, tracked tree and trusted clearance; errors refuse mutation. */
// `readCoverage({comments, headSha})` (optional, approval-binding): the caller's git-proven clearance coverage for this head.
export function readApprovedHumanSurfaceHold({ setting, pr, repo, expectedHead, exec, readComments = readCompletePrComments, readCoverage = null }) {
  if (setting !== 'on') return decideHoldApprovedHumanSurfaceHead({ setting });
  const view = JSON.parse(exec('gh', ['pr', 'view', String(pr), ...(repo ? ['--repo', repo] : []), '--json', 'headRefOid,labels,mergeable'], { encoding: 'utf8' }));
  if (!/^[0-9a-f]{40}$/i.test(view.headRefOid ?? '') || view.headRefOid !== expectedHead || !Array.isArray(view.labels)) throw Error('live approval head/labels unreadable or moved');
  const comments = readComments(pr, { repo, exec });
  if (!Array.isArray(comments)) throw Error('clearance comments unreadable');
  const git = args => {
    const output = exec('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (output == null) throw Error('git output unreadable');
    return String(output);
  };
  const mb = git(['merge-base', 'origin/main', expectedHead]).trim();
  if (!/^[0-9a-f]{40}$/i.test(mb)) throw Error('merge base unreadable');
  const files = git(['diff', '--name-only', '-z', '--no-renames', mb, expectedHead]).split('\0').filter(Boolean);
  const diffHunks = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', mb, expectedHead]);
  const manifest = git(['ls-tree', '--name-only', expectedHead, '--', '.lane-manifest.json']).trim();
  if (!['', '.lane-manifest.json'].includes(manifest)) throw Error('tracked manifest unreadable');
  if (!['MERGEABLE', 'CONFLICTING'].includes(view.mergeable)) throw Error('live mergeability unreadable');
  return decideHoldApprovedHumanSurfaceHead({ setting,
    approved: view.labels.some(l => (l?.name ?? l) === 'review:accepted') && clearanceBindsHead({ humanClearedSha: parseLatestHumanClearedSha(comments),
      headSha: expectedHead, coverage: typeof readCoverage === 'function' ? readCoverage({ comments, headSha: expectedHead }) : null }),
    humanSurface: scoreEscalation({ changedFiles: files, diffHunks }).humanRequired === true,
    conflicting: view.mergeable === 'CONFLICTING', manifestOnHead: manifest === '.lane-manifest.json' });
}

/** IO: reuse refreshStalePr's pinned, same-head workflow rerun without rebuilding. */
export function refreshHeldHead({ hold, options, refresh }) {
  return refresh({ ...options, ...(hold ? { refresh: () => ({ ok: true, action: 'current' }) } : {}) });
}

/** PURE: queue freshness may excuse only the stale merge-state arm; all other gates still run. */
export function retainApprovedHumanQueueHead(pr, { hold, queueOwnsFreshness } = {}) {
  if (!pr || !hold || !queueOwnsFreshness || pr.mergeable !== 'MERGEABLE'
    || pr.mergeStateStatus !== 'BEHIND'
    || ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(pr.reviewDecision)) return pr;
  return { ...pr, mergeStateStatus: 'CLEAN' };
}
