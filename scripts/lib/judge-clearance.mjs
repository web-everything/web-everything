/** Pure judge boundary. All evidence is supplied by the trusted caller; no IO. */
import { JUDGE_PROTECTED, RATIFICATION_PROTECTED, RULING_MARKERS, JUDGE_WORKFLOW_LOGINS } from './gate-config.mjs';
import { latestAdvisory, advisoryCoversHead, trustedAdvisoryComments, labelNames } from './advisory-labels.mjs';
import { parseAuthorActorId, parseClearerActorId } from './review-independence.mjs';
import { parseDelegationMarker } from './delegation-marker.mjs';
import { isAiCommit } from './ai-pr-authorship.mjs';
import { SECRET_PATTERNS, isHighEntropyToken } from './secret-scrub.mjs';

export const JUDGE_REFUSALS = Object.freeze([
  'kill-switch', 'wait-not-elapsed', 'not-human-gated', 'reviewers-not-accepted',
  'protected-list', 'secret-in-diff', 'independence-unknown', 'same-provider', 'same-actor', 'error',
]);
const refuse = (refusal, detail = null) => ({ allowed: false, refusal, detail });
const providerOf = value => ({ claude: 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai' })[value] ?? null;

/** Derive identity from live PR repository/number evidence, never from a branch name. */
export function deriveRecordBinding({ record, pr, baseShaIsAncestor } = {}) {
  const head = pr?.headRepository?.nameWithOwner;
  const base = pr?.baseRepository?.nameWithOwner;
  return {
    headIsSameRepo: pr?.isCrossRepository === false && typeof head === 'string' && !!head && head === base,
    repoMatches: typeof base === 'string' && !!base && record?.repo === base,
    prNumberMatches: Number.isSafeInteger(pr?.number) && pr.number > 0 && record?.prNumber === pr.number,
    baseShaIsAncestor: !!record?.baseSha && baseShaIsAncestor === true,
  };
}

/** Shared by clearance and arbitration. Missing path evidence retains the human hold. */
export function protectedPathsTouched({ changedPaths, decisionCardResolves = [], addedLines = [] } = {}) {
  if (!Array.isArray(changedPaths) || changedPaths.truncated === true
    || changedPaths.some(path => typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/'))) {
    return { touched: true, paths: [], detail: 'changed-paths-incomplete' };
  }
  const paths = changedPaths.filter(path => [...JUDGE_PROTECTED, ...RATIFICATION_PROTECTED].some(re => re.test(path)));
  if (paths.length) return { touched: true, paths, detail: paths };
  if (!Array.isArray(decisionCardResolves) || !Array.isArray(addedLines)) {
    return { touched: true, paths: [], detail: 'changed-paths-incomplete' };
  }
  if (decisionCardResolves.length) return { touched: true, paths: [...decisionCardResolves], detail: 'decision-card-resolved' };
  const rulings = addedLines.filter(({ path, line }) => /\.md$/i.test(path)
    && RULING_MARKERS.some(marker => line.startsWith(marker))).map(({ path }) => path);
  if (rulings.length) return { touched: true, paths: [...new Set(rulings)], detail: 'ruling-recorded' };
  return { touched: false, paths: [], detail: null };
}

export function decideJudgeClearance(input) {
  try {
    if (input?.switches?.judgeEnabled !== true) return refuse('kill-switch');
    const wait = input.switches.waitHours ?? 0;
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) return refuse('wait-not-elapsed', 'wait-invalid');
    if (wait > 0) {
      const parked = input.parkedAt == null ? NaN : Date.parse(input.parkedAt);
      if (!Number.isFinite(parked)) return refuse('wait-not-elapsed', 'parked-time-unknown');
      if (!Number.isFinite(input.now) || input.now - parked < wait * 3600000) return refuse('wait-not-elapsed');
    }
    const { pr } = input;
    const labels = labelNames(pr.labels);
    if (!labels.includes('review:human')) return refuse('not-human-gated');
    // Supplied GitHub author identities, never marker text, establish authorship.
    // The contract also accepts GitHub's reserved workflow principal: its workflow
    // definitions are protected, just like the shared automation's trust machinery.
    const trusted = new Set(trustedAdvisoryComments(pr.comments));
    const advisory = latestAdvisory((Array.isArray(pr.comments) ? pr.comments : []).filter(comment =>
      trusted.has(comment) || JUDGE_WORKFLOW_LOGINS.includes(comment?.author?.login ?? comment?.user?.login)));
    if (!labels.includes('advisory:accepted') || labels.includes('review:changes')
      || labels.includes('review:pending') || input.ciGreen !== true
      || advisory?.outcome !== 'accept' || !advisoryCoversHead(advisory, pr.headRefOid)
      || !Array.isArray(pr.statusCheckRollup) || pr.statusCheckRollup.some(check =>
        check.conclusion ? !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)
          : check.state !== 'SUCCESS')) return refuse('reviewers-not-accepted');
    const protectedResult = protectedPathsTouched(input);
    if (protectedResult.touched) return refuse('protected-list', protectedResult.detail);
    if (!Array.isArray(input.addedLines)) return refuse('error', 'added-lines-incomplete');
    for (const { path, line } of input.addedLines) {
      if (typeof path !== 'string' || typeof line !== 'string') return refuse('error', 'added-lines-incomplete');
      if (SECRET_PATTERNS.some(([re]) => new RegExp(re.source, re.flags).test(line))
        || (line.match(/[A-Za-z0-9_-]+/g) ?? []).some(isHighEntropyToken)) return refuse('secret-in-diff', path);
    }
    if (!Array.isArray(input.dispatchRecords) || input.dispatchRecords.length !== 1) return refuse('independence-unknown');
    const record = input.dispatchRecords[0];
    const derived = deriveRecordBinding({ record, pr, baseShaIsAncestor: input.recordBinding?.baseShaIsAncestor });
    if (Object.keys(derived).some(key => derived[key] !== true || input.recordBinding?.[key] !== true)
      || record.repo !== input.repo || record.headRef !== pr.headRefName) return refuse('independence-unknown', 'record-mismatch');
    const authorProvider = providerOf(record.executedProvider);
    const judgeProvider = providerOf(input.judge?.provider);
    const actor = parseAuthorActorId(pr.body);
    const delegation = parseDelegationMarker(pr.body);
    if (!authorProvider || !judgeProvider || !actor || actor !== record.sessionId || !delegation
      || !input.judge?.actorId) return refuse('independence-unknown');
    // PR-controlled evidence can only add doubt. A forged marker cannot conceal a same-provider author.
    if (authorProvider === judgeProvider) return refuse('same-provider');
    if (providerOf(delegation.provider) !== authorProvider
      || !Array.isArray(pr.commits) || (pr.commits.some(isAiCommit) && authorProvider !== 'anthropic')) return refuse('independence-unknown');
    const reviewerActors = (pr.comments ?? []).map(comment => parseClearerActorId([comment]));
    if (input.judge.actorId === actor || reviewerActors.includes(input.judge.actorId)) return refuse('same-actor');
    return { allowed: true, refusal: null, detail: null };
  } catch {
    return refuse('error');
  }
}
