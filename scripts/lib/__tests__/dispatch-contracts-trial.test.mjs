import { describe, it, expect } from 'vitest';
import * as c from '../dispatch-contracts.mjs';
import { selectSupervisionLevel } from '../provider-routing.mjs';
import { validateScorecard } from '../../conveyor/run-scorecard-store.mjs';

const execution = (extra = {}) => ({ authorRef: 'author', supervisionLevel: 'full', supervisor: { provider: 'claude', model: 'claude-opus-5', sessionId: 'supervisor' }, sessionName: null, taskId: 'a', storyRef: '3383', round: 1, attempt: 1, taskType: 'doc-fix', status: 'landed', provider: 'codex', model: 'gpt-5', executor: 'codex-direct-task', evidence: { pr: 42, tests: { command: 'vitest', passed: 1, failed: 0 } }, findings: [], ...extra });
const verdict = (extra = {}) => ({ mode: 'acting', storyTaskType: 'doc-fix', supervisor: { provider: 'claude', model: 'claude-opus-5', sessionId: 'supervisor' }, taskId: 'a', storyRef: '3383', round: 1, attempt: 1, verdict: 'accept', findings: [], verifiedBy: 'independent-claude', ...extra });
const now = '2026-09-20T12:30:00.000Z';
const profile = () => c.buildDispatchProfile({ taskType: 'doc-fix', estimatedLoc: 30, filesTouched: ['docs/readme.md'], acceptanceTestable: true, dependsOn: [] }).profile;
const groundTruth = (extra = {}) => ({ taskId: 'a', storyRef: '3383', round: 1, recordedBy: 'orchestrator', sources: [{ kind: 'independent-pr-review', outcome: 'clean', actorRef: 'reviewer', verifiedBy: 'independent-claude' }], ...extra });
const trial = (r, v, opts = {}) => c.trialFromVerdict(r, v, { groundTruth: groundTruth({ taskId: r?.taskId, storyRef: r?.storyRef, round: r?.round }), ...opts });

describe('trial conversion', () => {
  it('produces the exact store-compatible row and deterministic key', () => {
    const out = trial(execution(), verdict(), { now });
    expect(out).toEqual({ ok: true, idempotencyKey: 'mech-trial:3383:r1:a', row: {
      v: 1, outcome: 'landed', scoredAt: now, rubricVersion: 'mechanical-dispatch.1', provider: 'codex', model: 'gpt-5', subjectClass: 'work-agent', role: 'work', dispatchKind: 'mechanical-task', criteriaEvaluated: 0, score: null, deductions: [], item: 3383, pr: 42, handle: '3383/r1/a', taskDescription: 'mechanical task 3383/r1/a', taskType: 'doc-fix', verifiedBy: 'independent-claude', findings: null, retroactive: false, idempotencyKey: 'mech-trial:3383:r1:a',
    } });
    expect(validateScorecard(out.row)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(trial(execution(), verdict(), { now }))).toBe(JSON.stringify(out));
    const replay = trial(execution(), verdict(), { now: '2026-09-21T00:00:00Z' });
    expect(replay.idempotencyKey).toBe(out.idempotencyKey);
    expect({ ...replay.row, scoredAt: now }).toEqual(out.row);
    expect(trial(execution({ attempt: 2 }), verdict({ attempt: 2 }), { now }).idempotencyKey).toBe(out.idempotencyKey);
  });
  it('maps outcomes and opaque references while preserving the task trust unit', () => {
    for (const [kind, outcome] of [['rework-rounds', 'reworked'], ['ci', 'rejected'], ['revert', 'rejected'], ['independent-pr-review', 'rejected']]) {
      const gt = groundTruth({ storyRef: 'we#3383' });
      gt.sources.push({ kind, outcome: 'unclean', actorRef: 'independent', findings: ['First issue', 'Second issue'], ...(kind === 'rework-rounds' ? { reworkRounds: 1 } : {}), ...(kind === 'independent-pr-review' ? { verifiedBy: 'claude-subagent' } : {}) });
      const out = trial(execution({ storyRef: 'we#3383', taskType: 'bugfix' }), verdict({ storyRef: 'we#3383' }), { now, groundTruth: gt });
      expect(out.row).toMatchObject({ item: null, outcome, taskType: 'bugfix', findings: 'First issue; Second issue' });
      expect(validateScorecard(out.row).ok).toBe(true);
    }
    expect(trial(execution({ evidence: { sha: 'abcdef0', tests: { command: 'test', passed: 0, failed: 0 } } }), verdict(), { now }).row.pr).toBeNull();
  });
  it.each([undefined, '', 'today', '2026-09-20', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-10T00:00:00Z', '2026-13-10T00:00:00Z', '2026-09-00T00:00:00Z', '2026-09-20T24:00:00Z', '2026-09-20T00:60:00Z', '2026-09-20T00:00:60Z', '2026-09-20T00:00:00+24:00', '2026-09-20T00:00:00+00:60', 42])('rejects invalid timestamp %s', (value) => {
    expect(trial(execution(), verdict(), { now: value })).toMatchObject({ ok: false, reason: expect.stringContaining('now') });
  });
  it.each(['2024-02-29T00:00:00Z', '2000-02-29T00:00:00Z', '2026-09-20T12:00:00-04:00'])('accepts explicit ISO timestamps %s', (value) => expect(trial(execution(), verdict(), { now: value }).ok).toBe(true));
  it('names missing provenance and rejects executor mismatch', () => {
    for (const field of ['provider', 'model', 'executor', 'authorRef']) expect(trial(execution({ [field]: undefined }), verdict(), { now })).toMatchObject({ ok: false, reason: expect.stringContaining(`missing provenance: ${field}`) });
    expect(trial(execution(), verdict(), { now, groundTruth: undefined }).reason).toContain('missing provenance: verifiedBy');
    expect(trial(execution({ executor: 'claude-subagent' }), verdict(), { now }).reason).toContain('executor/provider mismatch');
  });
  it('refuses non-landed or mismatched trials and permits Claude authors', () => {
    expect(trial(execution({ status: 'blocked', evidence: {} }), verdict(), { now }).reason).toContain('landed');
    expect(trial(execution(), verdict({ attempt: 2 }), { now }).reason).toContain('does not match');
    expect(trial(execution({ provider: 'claude', model: 'claude-sonnet-5-5', executor: 'claude-subagent' }), verdict({ verifiedBy: 'other' }), { now }).ok).toBe(true);
  });
  it('denies secret-shaped model and findings without redacting or leaking them', () => {
    const secret = 'AKI' + 'AABCDEFGHIJKLMNOP';
    for (const [r, v] of [[execution({ model: secret }), verdict()], [execution(), verdict({ findings: [secret] })], [execution({ findings: [secret] }), verdict()]]) {
      const out = trial(r, v, { now });
      expect(out.ok).toBe(false); expect(out.reason).toContain('publish scrub'); expect(out.reason).not.toContain(secret); expect(out.row).toBeUndefined();
    }
  });
  it('does not throw for malformed or cyclic input, or mutate frozen inputs', () => {
    const cyclic = {}; cyclic.findings = [cyclic];
    for (const value of [null, [], 'x', 1, cyclic]) expect(trial(value, value, { now }).ok).toBe(false);
    const r = execution(), v = verdict();
    Object.freeze(r.findings); Object.freeze(r.evidence.tests); Object.freeze(r.evidence); Object.freeze(r); Object.freeze(v.findings); Object.freeze(v);
    expect(trial(r, v, Object.freeze({ now })).ok).toBe(true);
  });
});

describe('ground truth and graduation', () => {
  it('validates independent source kinds and aggregates fail closed', () => {
    expect(c.validateGroundTruth(groundTruth())).toEqual({ ok: true, errors: [] });
    expect(c.groundTruthOutcome(groundTruth())).toBe('clean');
    expect(c.outcomeFromGroundTruth(groundTruth())).toBe('landed');
    expect(c.verifiedByFromGroundTruth(groundTruth())).toBe('independent-claude');
    for (const kind of c.GROUND_TRUTH_KINDS) for (const outcome of ['clean', 'unclean']) {
      const source = { kind, outcome, actorRef: 'actor', ...(kind === 'independent-pr-review' ? { verifiedBy: 'other' } : {}), ...(kind === 'rework-rounds' ? { reworkRounds: outcome === 'clean' ? 0 : 2 } : {}) };
      const gt = groundTruth({ sources: [source] });
      expect(c.validateGroundTruth(gt).ok).toBe(true);
      expect(c.groundTruthOutcome(gt)).toBe(outcome);
      expect(c.outcomeFromGroundTruth(gt)).toBe(outcome === 'clean' ? 'landed' : kind === 'rework-rounds' ? 'reworked' : 'rejected');
    }
    for (const gt of [null, {}, [], groundTruth({ taskId: '/' }), groundTruth({ storyRef: 'a-b' }), groundTruth({ round: 0 }), groundTruth({ recordedBy: 'supervisor' }), groundTruth({ sources: [] }), groundTruth({ sources: {} })]) {
      expect(c.validateGroundTruth(gt).ok).toBe(false); expect(c.groundTruthOutcome(gt)).toBe('unclean'); expect(c.outcomeFromGroundTruth(gt)).toBe('rejected');
    }
    for (const extra of [{ kind: 'bad' }, { outcome: 'bad' }, { actorRef: '' }, { verifiedBy: undefined }, { verifiedBy: 'bad' }, { findings: [''] }, { findings: ['x'.repeat(2001)] }, { findings: {} }, { kind: 'rework-rounds' }, { kind: 'rework-rounds', reworkRounds: -1 }, { kind: 'rework-rounds', reworkRounds: 0.5 }, { kind: 'rework-rounds', reworkRounds: 1 }, { kind: 'rework-rounds', reworkRounds: 0, outcome: 'unclean' }]) {
      expect(c.validateGroundTruth(groundTruth({ sources: [{ ...groundTruth().sources[0], ...extra }] })).ok).toBe(false);
    }
    expect(c.outcomeFromGroundTruth(groundTruth({ sources: [...groundTruth().sources, { kind: 'rework-rounds', outcome: 'unclean', actorRef: 'counter', reworkRounds: 1 }, { kind: 'ci', outcome: 'unclean', actorRef: 'ci' }] }))).toBe('rejected');
  });
  it('never grades a verdict alone or without an independent review', () => {
    expect(c.isGraduationGrade(execution(), verdict())).toBe(false);
    expect(c.isGraduationGrade(execution(), verdict(), groundTruth())).toBe(true);
    expect(c.isGraduationGrade(execution(), verdict({ verifiedBy: 'other' }), groundTruth())).toBe(true);
    expect(c.isGraduationGrade(execution(), verdict({ mode: 'shadow' }), groundTruth())).toBe(false);
    for (const sources of [[{ kind: 'ci', outcome: 'clean', actorRef: 'ci' }], [{ ...groundTruth().sources[0], verifiedBy: 'other' }]]) expect(c.isGraduationGrade(execution(), verdict(), groundTruth({ sources }))).toBe(false);
    expect(c.isGraduationGrade(execution({ provider: 'claude', model: 'claude-sonnet-5-5', executor: 'claude-subagent' }), verdict(), groundTruth())).toBe(true);
  });
  it('requires distinct processes for every independent signal', () => {
    for (const actorRef of ['author', 'supervisor']) expect(c.isGraduationGrade(execution(), verdict(), groundTruth({ sources: [...groundTruth().sources, { kind: 'ci', actorRef, outcome: 'clean' }] }))).toBe(false);
    expect(c.isGraduationGrade(execution({ authorRef: 'supervisor' }), verdict(), groundTruth())).toBe(false);
    expect(c.isGraduationGrade(execution(), verdict({ supervisor: { provider: 'claude', model: 'm', sessionId: null } }), groundTruth())).toBe(false);
  });
  it('grades only final landed accepts with matching identities', () => {
    for (const v of ['rework', 'reject']) expect(c.isGraduationGrade(execution(), verdict({ verdict: v, findings: ['fix'] }), groundTruth())).toBe(false);
    for (const status of ['blocked', 'failed']) expect(c.isGraduationGrade(execution({ status, evidence: {} }), verdict(), groundTruth())).toBe(false);
    for (const [key, value] of [['taskId', 'b'], ['storyRef', '42'], ['round', 2], ['attempt', 2]]) {
      expect(c.verdictMatchesResult(execution(), verdict({ [key]: value }))).toBe(false);
      expect(c.gradeGraduation(execution(), verdict({ [key]: value }), groundTruth()).reasons).toContain('verdict does not match result identity');
      if (key !== 'attempt') expect(c.groundTruthMatches(execution(), groundTruth({ [key]: value }))).toBe(false);
    }
    expect(c.verdictMatchesResult({}, {})).toBe(false);
    expect(c.groundTruthMatches({}, {})).toBe(false);
  });
  it('reports every failed rule in fixed order', () => {
    expect(c.gradeGraduation(execution({ model: '', status: 'blocked', evidence: {}, authorRef: 'supervisor' }), verdict({ taskId: 'b', mode: 'shadow', verdict: 'reject', findings: ['fix'] }), groundTruth({ storyRef: '42', sources: [{ kind: 'ci', outcome: 'clean', actorRef: 'ci' }] })).reasons).toEqual([
      'result: model is required', 'verdict does not match result identity', 'ground truth does not match result identity', 'graduation requires acting verdict', 'graduation requires accept', 'graduation requires landed status', 'ground truth requires independent-pr-review graduation verifier', 'author, supervisor and ground truth actors must be independent',
    ]);
  });
  it('deduplicates all findings and fails closed on secret ground truth', () => {
    const gt = groundTruth({ sources: [{ ...groundTruth().sources[0], findings: ['one', 'two'] }] });
    expect(trial(execution({ findings: ['two', 'three'] }), verdict({ findings: ['one'] }), { now, groundTruth: gt }).row.findings).toBe('one; two; three');
    gt.sources[0].findings = ['AKI' + 'AABCDEFGHIJKLMNOP'];
    expect(trial(execution(), verdict(), { now, groundTruth: gt }).reason).toContain('publish scrub');
  });
  it('a self-verified batch never graduates: no verdict-only, other-verified or author-verified trial produces a row', () => {
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const r = execution({ taskId: `t${i}` }), v = verdict({ taskId: `t${i}`, verifiedBy: 'independent-claude' });
      const gtBase = groundTruth({ taskId: `t${i}` });
      const attempts = [
        c.trialFromVerdict(r, v, { now }),
        c.trialFromVerdict(r, v, { now, groundTruth: { ...gtBase, sources: [{ kind: 'independent-pr-review', outcome: 'clean', actorRef: 'reviewer', verifiedBy: 'other' }] } }),
        c.trialFromVerdict(r, v, { now, groundTruth: { ...gtBase, sources: [{ kind: 'independent-pr-review', outcome: 'clean', actorRef: r.authorRef, verifiedBy: 'independent-claude' }] } }),
      ];
      refused += attempts.filter((a) => !a.ok).length;
    }
    expect(refused).toBe(18);
    expect(c.routeDispatch(profile(), { stage: 'task', scorecards: [] }).supervision).toBe('full');
  });
});

// #4359 — the sonnet-tier pin, asserted against the REAL constant rather than a fixture literal. Every other
// `'claude-sonnet-5-5'` in this file's fixtures is a hard-coded string that would stay green whether or not the
// constant itself changed; this is the one test that actually reads `CLAUDE_NATIVE_MODEL_BY_TIER` and would
// fail if the pin regressed to the old id (found by /converge's red-team, #4359).
describe('sonnet-tier dispatch pin', () => {
  it('CLAUDE_NATIVE_MODEL_BY_TIER.sonnet and the matching SUPERVISOR_CANDIDATES entry name the current sonnet id', () => {
    expect(c.CLAUDE_NATIVE_MODEL_BY_TIER.sonnet).toBe('claude-sonnet-5-5');
    const entry = c.SUPERVISOR_CANDIDATES.find((s) => s.backend === 'claude-native' && s.tier === 'sonnet');
    expect(entry.id).toBe('claude-sonnet-5-5');
    expect(entry.model).toBe(c.CLAUDE_NATIVE_MODEL_BY_TIER.sonnet);
  });
});
