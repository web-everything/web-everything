import { describe, it, expect } from 'vitest';
import * as t from '../dispatch-thresholds.mjs';
import * as c from '../dispatch-contracts.mjs';
import { DEFAULT_BACKDOWN_THRESHOLDS, selectSupervisionLevel } from '../provider-routing.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';

const profile = (extra = {}) => c.buildDispatchProfile({ taskType: 'doc-fix', estimatedLoc: 30, filesTouched: ['docs/readme.md'], acceptanceTestable: true, dependsOn: [], ...extra }).profile;
function row(i, unclean = false, provider = 'codex', model = 'gpt-6-astra') {
  const identity = { storyRef: '3383', round: 1, taskId: `t${i}`, attempt: 1 };
  const supervisor = { provider: 'claude', model: 'claude-opus-5-5', sessionId: 'supervisor' };
  const result = { ...identity, taskType: 'doc-fix', authorRef: 'author', provider, model,
    executor: provider === 'claude' ? 'claude-subagent' : 'codex-direct-task', supervisionLevel: 'full', supervisor, sessionName: null,
    status: 'landed', evidence: { pr: 1, tests: { command: 'test', passed: 1, failed: 0 } }, findings: [] };
  const verdict = { ...identity, mode: 'acting', supervisor, storyTaskType: 'doc-fix', verifiedBy: 'other', verdict: 'accept', findings: [] };
  const groundTruth = { ...identity, recordedBy: 'orchestrator', sources: [{ kind: 'independent-pr-review', outcome: 'clean', actorRef: 'review', verifiedBy: 'independent-claude' },
    ...(unclean ? [{ kind: 'rework-rounds', outcome: 'unclean', actorRef: 'counter', reworkRounds: 1, findings: ['Corrected missing assertion'] }] : [])] };
  const out = c.trialFromVerdict(result, verdict, { now: `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`, groundTruth });
  expect(out.ok).toBe(true); expect(validateScorecard(out.row).ok).toBe(true);
  return out.row;
}

describe('risk thresholds and sampling', () => {
  it('returns fresh frozen thresholds, with medium matching router policy', () => {
    // medium is a spread of DEFAULT_BACKDOWN_THRESHOLDS, which gained `k` under #3889 (Rule 5 of #3690);
    // low/high are their own literals and stay without it.
    expect(t.GRADUATION_THRESHOLDS_BY_RISK).toEqual({ low: { minCleanStreak: 2, requireInformativeTrial: false }, medium: { minCleanStreak: 5, requireInformativeTrial: true, k: 3 }, high: { minCleanStreak: 8, requireInformativeTrial: true } });
    expect(t.thresholdsForRisk('medium')).toEqual(DEFAULT_BACKDOWN_THRESHOLDS);
    for (const risk of ['low', 'medium', 'high', 'constructor', null, {}]) {
      const threshold = t.thresholdsForRisk(risk);
      expect(Object.isFrozen(threshold)).toBe(true);
      expect(threshold).not.toBe(t.thresholdsForRisk(risk));
      expect(threshold).toEqual(t.GRADUATION_THRESHOLDS_BY_RISK[['low', 'medium', 'high'].includes(risk) ? risk : 'high']);
    }
    expect(Object.isFrozen(t.GRADUATION_THRESHOLDS_BY_RISK)).toBe(true);
    expect(Object.isFrozen(t.SPOT_CHECK_SAMPLE_RATE_BY_RISK)).toBe(true);
  });
  it('deterministically samples the stated shares with inline FNV-1a', () => {
    expect(t.SPOT_CHECK_SAMPLE_RATE_BY_RISK).toEqual({ low: 500, medium: 250, high: 1000 });
    for (const risk of ['low', 'medium', 'high']) {
      let samples = 0;
      for (let i = 0; i < 2000; i++) {
        const key = Object.freeze({ storyRef: 'x1', round: 1, taskId: `t${i}` });
        const sample = t.spotCheckSample(key, risk);
        expect(sample).toEqual(t.spotCheckSample(key, risk));
        expect(sample.bucket).toBeGreaterThanOrEqual(0); expect(sample.bucket).toBeLessThan(1000);
        expect(sample.ratePermille).toBe(t.SPOT_CHECK_SAMPLE_RATE_BY_RISK[risk]);
        if (sample.sampled) samples++;
      }
      expect(Math.abs(samples / 2000 - t.SPOT_CHECK_SAMPLE_RATE_BY_RISK[risk] / 1000)).toBeLessThanOrEqual(0.04);
      if (risk === 'high') expect(samples).toBe(2000);
    }
    // Cross-check 32-bit imul overflow using independent arbitrary-precision arithmetic.
    const reference = [...'x1\n1\nt0'].reduce((hash, ch) => ((hash ^ BigInt(ch.charCodeAt(0))) * 16777619n) & 0xffffffffn, 2166136261n);
    expect(Number(reference % 1000n)).toBe(215);
    expect(t.spotCheckSample({ storyRef: 'x1', round: 1, taskId: 't0' }, 'low')).toEqual({ sampled: true, bucket: Number(reference % 1000n), ratePermille: 500 });
  });
  it('fails sampling closed on invalid keys and risks', () => {
    const good = { storyRef: 'x1', round: 1, taskId: 't1' }, closed = { sampled: true, bucket: null, ratePermille: 1000 };
    for (const key of [null, {}, [], { ...good, storyRef: 'a-b' }, { ...good, storyRef: 'a/b' }, { ...good, round: 0 }, { ...good, round: '1' }, { ...good, taskId: '/' }]) expect(t.spotCheckSample(key, 'low')).toEqual(closed);
    for (const risk of [undefined, null, {}, 'constructor', 'extreme']) expect(t.spotCheckSample(good, risk)).toEqual(closed);
  });
  it('labels the never-spot-check prefixes and fails invalid profiles closed', () => {
    expect(Object.keys(t.NEVER_SPOT_CHECK_PATH_PREFIXES)).toEqual(['statute', 'gateSelf', 'irreversible']);
    for (const group of Object.values(t.NEVER_SPOT_CHECK_PATH_PREFIXES)) {
      expect(Object.isFrozen(group)).toBe(true);
      for (const path of group) expect(t.isNeverSpotCheckPath(`${path}suffix`)).toBe(true);
    }
    expect(t.isNeverSpotCheckPath('docs/readme.md')).toBe(false);
    for (const input of [undefined, null, [], {}, { risk: 'low' }, { risk: 'low', filesTouched: [] }, { risk: 'low', filesTouched: [null] }, { risk: 'low', filesTouched: ['../a'] }, { risk: 'low', filesTouched: ['/a'] }, { risk: 'low', filesTouched: Array(1) }, { risk: 'unknown', filesTouched: ['a'] }]) expect(t.neverSpotCheck(input)).toBe(true);
    expect(t.neverSpotCheck(profile())).toBe(false);
  });
});

describe('real ground-truth trials through risk-based routing', () => {
  it.each(['low', 'medium', 'high'])('uses the %s streak and resets on calibration misses', risk => {
    const { minCleanStreak, requireInformativeTrial, k } = t.thresholdsForRisk(risk);
    // #3889 (Rule 5 of #3690): once a miss is on record, restoration needs a rootCause note in its own
    // field AND the post-miss bar (minCleanStreak + k), not just minCleanStreak — same rootCause+extend
    // pattern already applied in provider-routing.test.mjs. `informative: true` is likewise the row's own
    // recorded field (#3888, rule 4) rather than inferred from outcome/findings.
    const postMissBar = minCleanStreak + (typeof k === 'number' ? k : DEFAULT_BACKDOWN_THRESHOLDS.k);
    const missRow = requireInformativeTrial
      ? { ...row(0, true), informative: true, rootCause: 'Diagnosed: assertion ordering flaked under load; fixed and root-caused.' }
      : null;
    const cleanCount = requireInformativeTrial ? postMissBar : minCleanStreak;
    const rows = [...(missRow ? [missRow] : []), ...Array.from({ length: cleanCount }, (_, i) => row(i + 1))];
    expect(selectSupervisionLevel('codex', 'gpt-6-astra', 'doc-fix', rows.slice(0, -1), t.thresholdsForRisk(risk)).level).toBe('full');
    expect(selectSupervisionLevel('codex', 'gpt-6-astra', 'doc-fix', rows, t.thresholdsForRisk(risk)).level).toBe('spot-check');
    const p = profile({ risk });
    expect(c.routeDispatch(p, { stage: 'task', scorecards: rows.slice(0, -1) }).supervision).toBe('full');
    expect(c.routeDispatch(p, { stage: 'task', scorecards: rows }).supervision).toBe(risk === 'high' ? 'full' : 'spot-check');
    if (risk === 'high') expect(c.routeDispatch(p, { stage: 'task', scorecards: rows }).auditTrail.some(a => a.criterion === 'never-spot-check')).toBe(true);
    const miss = row(25, true);
    expect(selectSupervisionLevel('codex', 'gpt-6-astra', 'doc-fix', [...rows, miss], t.thresholdsForRisk(risk)).level).toBe('full');
    expect(c.routeDispatch(p, { stage: 'task', scorecards: [...rows, miss] }).supervision).toBe('full');
    if (requireInformativeTrial) expect(selectSupervisionLevel('codex', 'gpt-6-astra', 'doc-fix', rows.slice(1), t.thresholdsForRisk(risk)).level).toBe('full');
  });
  it('never spot-checks high-risk, statute, gate-self or irreversible tasks after 20 cleans', () => {
    // #3889 (Rule 5): the miss needs a rootCause note + informative:true (rule 4) so this triple otherwise
    // WOULD graduate to spot-check on 20 clean trials — the point of the test is that the never-spot-check
    // override still forces 'full' even then; 20 clean trials clears any plausible post-miss bar.
    const rootCause = 'Diagnosed: assertion ordering flaked under load; fixed and root-caused.';
    const rows = [{ ...row(0, true), informative: true, rootCause }, ...Array.from({ length: 20 }, (_, i) => row(i + 1))];
    for (const p of [profile({ risk: 'high' }), ...['docs/agent/a.md', 'scripts/check-standards.mjs', '.github/workflows/deploy.yml'].map(path => profile({ filesTouched: [path] }))]) {
      const out = c.routeDispatch(p, { stage: 'task', scorecards: rows });
      expect(out.supervision).toBe('full'); expect(out.spotCheck).toBeNull();
    }
    // Exercise statute forcing on a graduated native story rung as well.
    const native = [{ ...row(0, true, 'claude', 'claude-opus-5-5'), informative: true, rootCause }, ...Array.from({ length: 20 }, (_, i) => row(i + 1, false, 'claude', 'claude-opus-5-5'))];
    const out = c.routeDispatch(profile({ filesTouched: ['docs/agent/a.md'] }), { stage: 'story', kind: 'prepare', scorecards: native });
    expect(out.supervision).toBe('full'); expect(out.auditTrail.some(a => a.criterion === 'never-spot-check')).toBe(true);
  });
  it('returns sampling metadata only for graduated work with a valid key', () => {
    const p = profile(), scorecards = [row(1), row(2)], taskKey = { storyRef: '3383', round: 1, taskId: 'a' };
    expect(c.routeDispatch(p, { stage: 'task', scorecards, taskKey }).spotCheck).toEqual(t.spotCheckSample(taskKey, 'low'));
    for (const key of [undefined, {}, { ...taskKey, storyRef: 'bad-ref' }]) expect(c.routeDispatch(p, { stage: 'task', scorecards, taskKey: key }).spotCheck).toBeNull();
    expect(c.routeDispatch(p, { stage: 'task', taskKey }).spotCheck).toBeNull();
    expect(c.routeDispatch(p, { stage: 'story', kind: 'build', scorecards, taskKey }).spotCheck).toBeNull();
  });
});
