/** Read-only judge sweep. IO supplies observations; classification and bundle construction are pure. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';

export const JUDGE_SWEEP_FACTS_OP = 'judge-sweep-facts';
export const JUDGE_SWEEP_REPO = CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug;

export const STALL_DEFAULTS = Object.freeze({ fixerInfraLoop: 3, needsHumanAgedHours: 6,
  draftWithdrawnAgedHours: 4, waitingFixerMinutes: 45, unownedMinutes: 45 });

/** First match wins, including when a worker is running on a PR already near its cap. */
function existingJudgment(pr, thresholds = STALL_DEFAULTS) {
  const limits = { ...STALL_DEFAULTS, ...thresholds };
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  const yes = reason => ({ needsJudgment: true, reason });
  const no = reason => ({ needsJudgment: false, reason });
  // Unknown evidence always needs attention. Operator fallback: inspect this PR's evidence and rerun.
  if (pr.evidenceErrors?.length) return yes('evidence-unavailable: inspect PR evidence and rerun');
  // A mandatory referral awaits a ruling even when a worker or CI is making progress.
  if (pr.openReferrals?.some(r => r.ruled === false && r.superseded !== true)) return yes('unruled-referral');
  if (Number.isFinite(pr.infraFailStreak) && pr.infraFailStreak >= limits.fixerInfraLoop) return yes('fixer-infra-loop');
  const headAge = Number.isFinite(pr.minutesSinceHeadChange) ? pr.minutesSinceHeadChange : pr.minutesSinceUpdate;
  if (labels.some(l => ['review-status:needs-human', 'status:needs-human'].includes(l))
    && headAge > limits.needsHumanAgedHours * 60) return yes('needs-human-aged');
  if ((pr.isDraft === true || labels.includes('review-status:draft-withdrawn'))
    && headAge > limits.draftWithdrawnAgedHours * 60) return yes('draft-withdrawn-aged');
  // With readable evidence and no unruled referral, a live fixer, CI, or recent fix-loop means the PR is moving.
  if (pr.fixerRunning) return no('fixer running');
  if (pr.inCi) return no('in CI');
  if (Number.isFinite(pr.minutesSinceFixLoop) && pr.minutesSinceFixLoop < 60) return no('fix-loop active (<60 min)');
  if (labels.includes('ready-to-merge')) return no('awaiting-merge');
  if (labels.includes('review:accepted') && labels.includes('review:human')) return yes('awaiting-operator');
  if (pr.fixerRunning === false && labels.some(l => ['status:answered-waiting-fixer', 'review:changes'].includes(l))
    && (pr.minutesSinceFixDispatch === null || (Number.isFinite(pr.minutesSinceFixDispatch)
      && pr.minutesSinceFixDispatch > limits.waitingFixerMinutes))) return yes('waiting-fixer-not-dispatched');
  const capHold = labels.some(l => /round-limit|cap-exhausted/.test(l));
  if (capHold || (Number.isInteger(pr.round) && Number.isInteger(pr.cap) && pr.round >= pr.cap)) return yes('at-cap');
  if (pr.redTeam?.latestOutcome === 'round-cap' && pr.redTeam.state === 'blocked'
    && (pr.round === null || pr.round >= pr.cap)) return yes('red-team-blocked-at-cap');
  const [latest, previous] = pr.verdictHistory ?? [];
  const keys = new Set((previous?.findings ?? []).map(f => f.key));
  if ((latest?.findings ?? []).some(f => f.key && keys.has(f.key)) || pr.ignoredFindingReturned === true) {
    return yes('finding-back-unfixed-more-than-once');
  }
  if (pr.latestVerdict?.accepted === true && pr.redTeam?.state === 'clear' && labels.includes('review:human')
    && pr.openReferrals?.length === 0 && pr.openSendBacks?.length === 0 && !pr.evidenceErrors?.length) {
    return yes('clean-and-owed-approval');
  }
  if (pr.minutesSinceUpdate > 45 && pr.fixerRunning === false && pr.owner === null) return yes('stalled>45min-no-owner');
  if (pr.owner) return no('owner present');
  if (labels.includes('review:accepted')) return no('awaiting merge');
  if (labels.includes('review:changes')) return no('waiting for fixes');
  if (pr.redTeam?.state === 'pending') return no('waiting on red team');
  return no('waiting on review');
}

const ownerAge = pr => Number.isFinite(pr.minutesSinceFixLoop) ? pr.minutesSinceFixLoop : pr.minutesSinceUpdate;

/** Responsibility is independent of stall classification: an absent dispatch has no active fixer. */
export function deriveNextOwner(pr, thresholds = STALL_DEFAULTS) {
  const judgment = existingJudgment(pr, thresholds);
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  const result = (nextOwner, nextStep) => ({ nextOwner, nextStep });
  if (judgment.needsJudgment && judgment.reason !== 'waiting-fixer-not-dispatched') {
    return result('judge', 'Inspect PR evidence and rule on the outstanding judgment.');
  }
  if (pr.fixerRunning) return result('fixer', 'Complete the active repair and publish its result.');
  if (labels.includes('ready-to-merge')) return result('drain', 'Merge after required gates pass.');
  if (labels.some(l => ['review:accepted', 'review:human', 'status:needs-you'].includes(l))) {
    return result('operator', 'Inspect the PR and provide the required operator decision.');
  }
  if (pr.redTeam?.state === 'pending' || labels.includes('red-team:pending')) {
    return result('red-team', 'Complete the pending red-team review.');
  }
  if (labels.some(l => ['review:pending', 'status:awaiting-review'].includes(l))) {
    return result('review', 'Complete the pending review.');
  }
  if (labels.some(l => ['status:answered-waiting-fixer', 'review:changes'].includes(l))
    && Number.isFinite(pr.minutesSinceFixDispatch) && pr.minutesSinceFixDispatch >= 0
    && pr.minutesSinceFixDispatch <= (thresholds.waitingFixerMinutes ?? STALL_DEFAULTS.waitingFixerMinutes)) {
    return result('fixer', 'Complete the dispatched repair.');
  }
  if (pr.isDraft === true || labels.some(l =>
    ['review-status:draft-withdrawn', 'status:needs-human', 'review-status:needs-human'].includes(l))) {
    return result('orchestrator', 'Inspect the hold and assign the next responsible worker.');
  }
  return result('nobody', 'Inspect the PR and assign its next responsible worker.');
}

export function needsJudgment(pr, thresholds = STALL_DEFAULTS) {
  const judgment = existingJudgment(pr, thresholds);
  if (judgment.reason === 'waiting on review' && !pr.owner && !pr.inCi
    && ownerAge(pr) > (thresholds.unownedMinutes ?? STALL_DEFAULTS.unownedMinutes)
    && ['nobody', 'orchestrator'].includes(deriveNextOwner(pr, thresholds).nextOwner)) {
    return { needsJudgment: true, reason: 'unowned: inspect PR and assign the next responsible worker' };
  }
  return judgment;
}

export function buildJudgeSweepBundle({ generatedAt, elapsedMs, prs, thresholds }) {
  const rows = prs.map(pr => {
    const { verdictHistory, ignoredFindingReturned, fixerRunning, inCi, owner, ...facts } = pr;
    return { ...facts, ...needsJudgment(pr, thresholds), ...deriveNextOwner(pr, thresholds), ownerSince: ownerAge(pr) };
  });
  const count = rows.filter(pr => pr.needsJudgment).length;
  return { generatedAt, elapsedMs, counts: { needsJudgment: count, noAction: rows.length - count }, prs: rows };
}

export function judgeSweepFactsOperation({ readFacts } = {}) {
  if (typeof readFacts !== 'function') throw new TypeError('judge-sweep-facts needs a readFacts reader');
  return op(JUDGE_SWEEP_FACTS_OP, {
    input: { repo: { type: 'string', required: false, default: JUDGE_SWEEP_REPO },
      'check-coverage': { type: 'string', required: false } },
    verdictFrom: 'bundle',
    read: compute({ reads: ['input.repo', 'input.check-coverage'],
      fn: ({ input }) => {
        return readFacts({ repo: input.repo, checkCoverage: input['check-coverage'] });
      } }),
    bundle: compute({ reads: ['findings.read'], fn: ({ findings }) => buildJudgeSweepBundle(findings.read) }),
  });
}

/** Validate both sides before counting distinct covered PRs. */
export function checkSweepCoverage(bundle, report) {
  const valid = n => Number.isSafeInteger(n) && n > 0;
  if (!Array.isArray(bundle?.prs) || bundle.prs.some(pr => !valid(pr?.number))
    || !Array.isArray(report) || report.some(n => !valid(n))) throw new TypeError('Invalid coverage PR numbers');
  const numbers = [...new Set(bundle.prs.map(pr => pr.number))];
  const reported = new Set(report);
  const missing = numbers.filter(n => !reported.has(n)).sort((a, b) => a - b);
  return { missing, covered: numbers.length - missing.length };
}

export function parseReportPrNumbers(text) {
  if (typeof text !== 'string') throw new TypeError('Coverage report must be text');
  return [...text.matchAll(/(?:#|\bPR\s+)([1-9]\d*)\b/g)].map(m => Number(m[1]));
}

/** The ordinary CLI prints exactly the bundle, with or without --json. */
export function finishJudgeSweep({ run, code, lines }, { readFile } = {}) {
  if (code !== 0) return { code, lines };
  const reportPath = run?.input?.['check-coverage'];
  if (reportPath !== undefined) {
    try {
      const text = readFile ? readFile(reportPath, 'utf8') : run.findings?.read?.coverageReport;
      const { missing, covered } = checkSweepCoverage(run.verdict, parseReportPrNumbers(text));
      return { code: missing.length ? 1 : 0, lines: [missing.length
        ? `Coverage missing: ${missing.map(n => `#${n}`).join(', ')}; inspect report and rerun.`
        : `Coverage complete: ${covered} PRs.`] };
    } catch {
      return { code: 1, lines: ['Coverage report unreadable or invalid; inspect report and rerun.'] };
    }
  }
  // JSON already escapes C0 controls; escape the remaining terminal and bidi controls without changing the data.
  const json = run?.verdict && JSON.stringify(run.verdict).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return code === 0 && json ? { code, lines: [json] } : { code, lines };
}
