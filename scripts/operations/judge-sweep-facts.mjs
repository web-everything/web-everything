/** Read-only judge sweep. IO supplies observations; classification and bundle construction are pure. */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const JUDGE_SWEEP_FACTS_OP = 'judge-sweep-facts';
export const JUDGE_SWEEP_REPO = 'web-everything/web-everything';

/** First match wins, including when a worker is running on a PR already near its cap. */
export function needsJudgment(pr) {
  const yes = reason => ({ needsJudgment: true, reason });
  const no = reason => ({ needsJudgment: false, reason });
  // A live fixer claim, CI in flight, or a fix-loop event under 60 min old means the PR is moving: nothing to judge.
  if (pr.fixerRunning) return no('fixer running');
  if (pr.inCi) return no('in CI');
  if (Number.isFinite(pr.minutesSinceFixLoop) && pr.minutesSinceFixLoop < 60) return no('fix-loop active (<60 min)');
  const capHold = pr.labels.some(l => /round-limit|cap-exhausted/.test(l));
  if (capHold || (Number.isInteger(pr.round) && Number.isInteger(pr.cap) && pr.round >= pr.cap)) return yes('at-cap');
  if (pr.redTeam?.latestOutcome === 'round-cap' && pr.redTeam.state === 'blocked'
    && (pr.round === null || pr.round >= pr.cap)) return yes('red-team-blocked-at-cap');
  const [latest, previous] = pr.verdictHistory ?? [];
  const keys = new Set((previous?.findings ?? []).map(f => f.key));
  if ((latest?.findings ?? []).some(f => f.key && keys.has(f.key)) || pr.ignoredFindingReturned === true) {
    return yes('finding-back-unfixed-more-than-once');
  }
  if (pr.latestVerdict?.accepted === true && pr.redTeam?.state === 'clear' && pr.labels.includes('review:human')
    && pr.openReferrals?.length === 0 && pr.openSendBacks?.length === 0 && !pr.evidenceErrors?.length) {
    return yes('clean-and-owed-approval');
  }
  if (pr.minutesSinceUpdate > 45 && pr.fixerRunning === false && pr.owner === null) return yes('stalled>45min-no-owner');
  // Unknown is never silently classified as healthy. Operator fallback: inspect this PR's evidence and rerun.
  if (pr.evidenceErrors?.length) return yes('evidence-unavailable: inspect PR evidence and rerun');
  if (pr.owner) return no('owner present');
  if (pr.labels.includes('review:accepted')) return no('awaiting merge');
  if (pr.labels.includes('review:changes')) return no('waiting for fixes');
  if (pr.redTeam?.state === 'pending') return no('waiting on red team');
  return no('waiting on review');
}

export function buildJudgeSweepBundle({ generatedAt, elapsedMs, prs }) {
  const rows = prs.map(pr => {
    const { verdictHistory, ignoredFindingReturned, fixerRunning, inCi, owner, ...facts } = pr;
    return { ...facts, ...needsJudgment(pr) };
  });
  const count = rows.filter(pr => pr.needsJudgment).length;
  return { generatedAt, elapsedMs, counts: { needsJudgment: count, noAction: rows.length - count }, prs: rows };
}

export function judgeSweepFactsOperation({ readFacts } = {}) {
  if (typeof readFacts !== 'function') throw new TypeError('judge-sweep-facts needs a readFacts reader');
  return op(JUDGE_SWEEP_FACTS_OP, {
    input: { repo: { type: 'string', required: false, default: JUDGE_SWEEP_REPO } },
    verdictFrom: 'bundle',
    read: compute({ reads: ['input.repo'], fn: ({ input }) => readFacts(input) }),
    bundle: compute({ reads: ['findings.read'], fn: ({ findings }) => buildJudgeSweepBundle(findings.read) }),
  });
}

/** The CLI prints exactly the bundle, with or without --json. */
export function finishJudgeSweep({ run, code, lines }) {
  // JSON already escapes C0 controls; escape the remaining terminal and bidi controls without changing the data.
  const json = run?.verdict && JSON.stringify(run.verdict).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return code === 0 && json ? { code, lines: [json] } : { code, lines };
}
