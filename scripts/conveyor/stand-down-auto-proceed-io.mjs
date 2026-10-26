/** R123 bounded reconciliation writer. Contract: we:scripts/conveyor/stand-down-auto-proceed.md. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { repoKeyForSlug, ghRepoSlug } from '../lib/constellation-repos.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { fixLoopConfig, readFixLoopRows, fixLoopLedgerPath } from './fix-loop-ledger.mjs';
import { parseOperatorAnswer } from './stand-down-answer-core.mjs';
import { hasAutoProceedCandidate, classifyStandDownAutoProceed } from './stand-down-auto-proceed.mjs';
import { DEFAULT_PR_SCOPED_CHECKS, resolvePrScopedChecks } from './main-red-recovery.mjs';
import { withFileLock, writeJsonAtomic } from '../lib/atomic-json-file.mjs';

const gh = (args, options = {}) => JSON.parse(execFileSyncThrottled('gh', args, {
  encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options,
}));
// A single-comment WRITE (POST), not a thread read: named apart so the comment-read ratchet does not mistake it for one.
const ISSUE_COMMENT_WRITE = 'comments';
const readHead = ({ repo, number }) => gh(['pr', 'view', String(number), '--repo', repo, '--json', 'headRefOid']).headRefOid;

/** Bind the history reader as well as the ledger filter to the reconciled repository. */
export function readAutoProceedContext({ repo, defaultBranch = 'main', env = process.env }, {
  readRows = readFixLoopRows,
  readMainRuns = ({ repo, branch }) => gh(['run', 'list', '--repo', repo, '--branch', branch,
    '--workflow', 'CI', '--limit', '60', '--json', 'conclusion,status,updatedAt']),
} = {}) {
  const key = repoKeyForSlug(repo);
  if (!key) throw new Error('operator answer required: unknown main-history repository');
  const slug = ghRepoSlug(repo);
  return { repo: key, rows: readRows({ env }),
    config: fixLoopConfig(env, { readMainRuns: () => readMainRuns({ repo: slug, branch: defaultBranch }) }) };
}

/** Ten pages maximum, with total-count and unique-id proof; filter=all retains earlier failed attempts. */
export function readAutoProceedChecks({ repo, head }, { read = gh } = {}) {
  const runs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const data = read(['api', `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`]);
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 1 || data.total_count > 1000
      || (total !== undefined && data.total_count !== total) || !Array.isArray(data.check_runs)) throw new Error('operator answer required: incomplete or oversized check feed (1000 run limit)');
    total = data.total_count;
    runs.push(...data.check_runs);
    if (runs.length === total && new Set(runs.map(r => r.id)).size === total) return { head, complete: true, runs };
    if (data.check_runs.length !== 100 || runs.length >= total) break;
  }
  throw new Error('operator answer required: check pagination incomplete');
}

/** Exclusive, durable intent BEFORE the write: crashes/ambiguous responses require operator inspection. */
export function reserveAutoProceed({ repo, number, standDownId, env = process.env }) {
  const dir = join(dirname(fixLoopLedgerPath(env)), 'stand-down-auto-proceed');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(`${repo}#${number}#${standDownId}`).digest('hex');
  try { writeFileSync(join(dir, `${key}.json`), JSON.stringify({ repo, number, standDownId }), { flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

/** Persist scheduling progress before IO so even failed reads rotate across one-shot processes. */
export function selectAutoProceedCandidates(candidates, { repo, env = process.env,
  read = readFileSync, write = writeJsonAtomic } = {}) {
  if (!candidates.length) return [];
  if (typeof repo !== 'string' || !repo || candidates.some(pr => !Number.isSafeInteger(pr.number) || pr.number < 1)
    || new Set(candidates.map(pr => pr.number)).size !== candidates.length) throw new Error('invalid candidate repository/PR identity');
  const dir = join(dirname(fixLoopLedgerPath(env)), 'stand-down-auto-proceed');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `cursor-${createHash('sha256').update(repo).digest('hex')}.json`);
  return withFileLock(`${path}.lock`, () => {
    let after = 0;
    try {
      const cursor = JSON.parse(read(path, 'utf8'));
      if (cursor?.v !== 1 || cursor.repo !== repo || !Number.isSafeInteger(cursor.after) || cursor.after < 1) {
        throw new Error('invalid candidate cursor');
      }
      after = cursor.after;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const sorted = [...candidates].sort((a, b) => a.number - b.number);
    const next = sorted.findIndex(pr => pr.number > after);
    const start = next < 0 ? 0 : next;
    const selected = [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, 3);
    write(path, { v: 1, repo, after: selected.at(-1).number });
    return selected;
  });
}

/** At most three candidate PRs/tick; all IO injectable. No retries after a write starts. */
export function enrichPrsWithStandDownAutoProceed(prs, { repo, requiredChecks, defaultBranch = 'main',
  readRows = readFixLoopRows,
  readComments = (number, o) => readCompletePrComments(number, o), readHead: headReader = readHead,
  readChecks = readAutoProceedChecks, readContext = () => readAutoProceedContext({ repo, defaultBranch, env }, { readRows }),
  readScopedChecks = resolvePrScopedChecks, reserve = reserveAutoProceed,
  selectCandidates = selectAutoProceedCandidates, env = process.env,
  post = ({ repo, number, body }) => gh(['api', `repos/${repo}/issues/${number}/${ISSUE_COMMENT_WRITE}`, '--method', 'POST', '--input', '-'], { input: JSON.stringify({ body }) }),
  log = line => console.error(line),
} = {}) {
  const candidates = prs.filter(hasAutoProceedCandidate);
  if (!candidates.length) return prs;
  let selected, context;
  try { selected = new Set(selectCandidates(candidates, { repo, env })); }
  catch (e) {
    log(`R123 candidate cursor unavailable; all holds retained; operator answer remains available: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`);
    return prs;
  }
  return prs.map(pr => {
    if (!hasAutoProceedCandidate(pr)) return pr;
    if (!selected.has(pr)) { log(`R123 PR #${pr.number}: deferred by 3-PR tick bound; operator answer remains available`); return pr; }
    // Keep the latest complete thread even when a later decision or IO step refuses the write.
    let fresh = pr;
    try {
      const comments = readComments(pr.number, { repo });
      fresh = { ...pr, comments };
      // Cheap first pass rejects judgment holds without reading checks or main history.
      if (!hasAutoProceedCandidate(fresh)) return fresh;
      const checks = readChecks({ repo, head: pr.headRefOid });
      try { context ??= readContext(); } catch { context = null; } // Cases a/b do not depend on main's ledger.
      const scoped = readScopedChecks() ?? DEFAULT_PR_SCOPED_CHECKS;
      const decision = classifyStandDownAutoProceed({ pr: fresh, requiredChecks, checks,
        redMainContext: context, prScopedChecks: scoped });
      if (decision.action !== 'auto-proceed') { log(`R123 PR #${pr.number}: ${decision.why}`); return fresh; }
      // A later operator question/answer may have arrived during check reads. Reclassify that full thread.
      const currentComments = readComments(pr.number, { repo });
      fresh = { ...pr, comments: currentComments };
      const current = classifyStandDownAutoProceed({ pr: fresh, requiredChecks, checks,
        redMainContext: context, prScopedChecks: scoped });
      if (current.action !== 'auto-proceed' || current.standDownId !== decision.standDownId) return fresh;
      if (headReader({ repo, number: pr.number }) !== pr.headRefOid) throw new Error('head moved; operator hold retained');
      if (!reserve({ repo, number: pr.number, standDownId: decision.standDownId, env })) {
        log(`R123 PR #${pr.number}: answer already reserved; inspect thread before any manual retry`); return fresh;
      }
      const posted = post({ repo, number: pr.number, body: decision.body });
      const comment = { ...posted, author: posted?.author ?? posted?.user };
      if (comment.body !== decision.body || !parseOperatorAnswer(comment)) throw new Error('posted answer principal/record unverified; inspect thread');
      return { ...fresh, comments: [...currentComments, comment] };
    } catch (e) {
      log(`R123 PR #${pr.number}: operator answer required; inspect thread/reservation: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300)}`);
      return fresh;
    }
  });
}
