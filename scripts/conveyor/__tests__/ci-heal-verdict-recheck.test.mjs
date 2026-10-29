import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredCheckStates, contradictingChecks, notCiBreakContradicted, unsettledRequiredChecks, ciGreenForEscalation, resolveVoidNeedsHumanWhenCiGreen, resolveCiHealVerdictSettings } from '../ci-heal-verdict-recheck.mjs';
import * as verdictRecheck from '../ci-heal-verdict-recheck.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/ci-heal-verdict/pr4535-2026-10-09.json'), 'utf8'));
const input = { escalation: { outcome: 'not-a-ci-break', headSha: fixture.headRefOid }, headSha: fixture.headRefOid,
  rollup: fixture.statusCheckRollup, requiredChecks: fixture.requiredChecks };
const green = fixture.requiredChecks.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));

describe('requiredCheckStates shared predicate regressions', () => {
  it.each([false, true])('partial attempt metadata cannot hide newer rollup evidence (reverse=%s)', reverse => {
    for (const [olderMetadata, newerMetadata] of [
      [{ run_attempt: 1, id: 100 }, {}],
      [{ run_id: 100, id: 100 }, {}],
      [{ run_attempt: '1', id: '100' }, {}],
      [{ run_attempt: 'invalid', id: 100 }, {}],
      [{}, { run_attempt: 1, id: 100 }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: null }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: 'invalid' }],
      [{ run_attempt: 1, id: 100 }, { run_id: 200 }],
      [{ run_attempt: 1, id: 100 }, { run_attempt: 1 }],
      [{ run_id: 100, run_attempt: 1, id: 100 }, { run_id: 100 }],
    ]) {
      for (const conclusion of ['FAILURE', 'CANCELLED', 'SUCCESS']) {
        const rows = [
          { __typename: 'CheckRun', name: 'TEST', status: 'COMPLETED', conclusion: conclusion === 'SUCCESS' ? 'FAILURE' : 'SUCCESS',
            completedAt: '2026-10-28T01:00:00Z', ...olderMetadata },
          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion,
            completedAt: '2026-10-28T02:00:00Z', ...newerMetadata },
        ];
        const evidence = { ...input, requiredChecks: ['test'], rollup: [
          ...(reverse ? rows.toReversed() : rows),
          { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
        ] };
        const expected = { red: [], pending: [], missing: [], green: [] };
        expected[conclusion === 'FAILURE' ? 'red' : conclusion === 'CANCELLED' ? 'pending' : 'green'] = ['test'];
        expect(requiredCheckStates(evidence)).toEqual(expected);
        expect(contradictingChecks(evidence)).toEqual(expected.red);
        expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(conclusion !== 'FAILURE');
        expect(ciGreenForEscalation(evidence)).toBe(conclusion === 'SUCCESS');
      }
    }
  });

  it.each([false, true])('partial attempt metadata cannot hide an in-flight required check (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 1, id: 100, completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'IN_PROGRESS', conclusion: null },
    ];
    const evidence = { ...input, requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows };
    expect(requiredCheckStates(evidence)).toEqual({ red: [], pending: ['test'], missing: [], green: [] });
    expect(ciGreenForEscalation(evidence)).toBe(false);
    expect(contradictingChecks(evidence)).toEqual([]);
  });

  it.each([false, true])('unrelated attempt metadata cannot hide a timestamped required failure (reverse=%s)', reverse => {
    const rows = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    for (const optional of [[], [{ name: 'unrelated-optional', status: 'COMPLETED', conclusion: 'SUCCESS', id: 100, run_attempt: 1 }]]) {
      const rollup = [...(reverse ? rows.toReversed() : rows), ...optional];
      const evidence = { ...input, requiredChecks: ['test'], rollup };
      expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
      expect(contradictingChecks(evidence)).toEqual(['test']);
      expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
      expect(ciGreenForEscalation(evidence)).toBe(false);
    }
  });

  it.each([false, true])('complete decisive ranks still beat timestamps when secondary ranks are partial (reverse=%s)', reverse => {
    for (const [olderMetadata, newerMetadata] of [
      [{ run_attempt: 1, id: 100 }, { run_attempt: 2 }],
      [{ run_id: 100, run_attempt: 2, id: 100 }, { run_id: 200 }],
      [{ run_id: 100, run_attempt: 2, id: 100 }, { id: 200 }],
    ]) {
      const rows = [
        { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T02:00:00Z', ...olderMetadata },
        { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z', ...newerMetadata },
      ];
      expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
        .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
    }
  });

  it.each([false, true])('a newer workflow run supersedes an earlier rerun across verdict readers (reverse=%s)', reverse => {
    const runs = [
      { name: 'test', run_id: 100, run_attempt: 2, id: 1001, status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test', run_id: 200, run_attempt: 1, id: 2001, status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    const evidence = { ...input, requiredChecks: ['test'], rollup: [
      ...(reverse ? runs.toReversed() : runs),
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] };
    expect(requiredCheckStates(evidence)).toEqual({ red: ['test'], pending: [], missing: [], green: [] });
    expect(contradictingChecks(evidence)).toEqual(['test']);
    expect(verdictRecheck.gateOnlyRedStates(evidence).gateOnlyRed).toBe(false);
    expect(ciGreenForEscalation(evidence)).toBe(false);
  });

  it.each([false, true])('timestamp and attempt ranking coexist per normalized name (reverse=%s)', reverse => {
    const rows = [
      { name: 'TEST', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2, id: 1 },
      { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1, id: 99 },
      { __typename: 'StatusContext', context: 'legacy', state: 'SUCCESS', completedAt: '2026-10-28T01:00:00Z' },
      { __typename: 'StatusContext', context: 'LEGACY', state: 'FAILURE', completedAt: '2026-10-28T02:00:00Z' },
    ];
    expect(requiredCheckStates({ requiredChecks: ['Test', 'build', 'Legacy'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['Test', 'Legacy'], pending: [], missing: [], green: ['build'] });
  });

  it.each([false, true])('legacy metadata cannot displace a CheckRun from the preferred tier (reverse=%s)', reverse => {
    const rows = [
      { __typename: 'CheckRun', name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-10-28T01:00:00Z' },
      { context: 'test', state: 'SUCCESS', id: 100, run_attempt: 2 },
    ];
    expect(requiredCheckStates({ requiredChecks: ['test'], rollup: reverse ? rows.toReversed() : rows }))
      .toEqual({ red: ['test'], pending: [], missing: [], green: [] });
  });

  it.each(['CANCELLED', 'STALE'])('required %s is pending, never red or missing', conclusion => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion },
    ] })).toEqual({ red: [], pending: ['Test'], missing: [], green: [] });
  });

  it.each([false, true])('numeric run_attempt beats timestamps in either row order (reverse=%s)', reverse => {
    const rollup = [
      { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 2, id: 10,
        startedAt: '2026-10-09T02:00:00Z', completedAt: '2026-10-09T02:01:00Z' },
      { name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 1, id: 99,
        startedAt: '2026-10-09T04:00:00Z', completedAt: '2026-10-09T04:01:00Z' },
    ];
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: reverse ? rollup.toReversed() : rollup }))
      .toEqual({ red: [], pending: [], missing: [], green: ['Test'] });
  });

  it('the latest failed attempt cannot be hidden by an older green attempt', () => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion: 'FAILURE', run_attempt: 2 },
      { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS', run_attempt: 1 },
    ] })).toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
  });

  it('an unknown completed conclusion fails closed red with its original-case name', () => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion: 'FUTURE_UNKNOWN_CONCLUSION' },
    ] })).toEqual({ red: ['Test'], pending: [], missing: [], green: [] });
  });

  it.each([
    ['SUCCESS', 'green'], ['FAILURE', 'red'], ['ERROR', 'red'], ['PENDING', 'pending'], ['EXPECTED', 'pending'],
  ])('legacy StatusContext %s remains %s and preserves original case', (state, bucket) => {
    const expected = { red: [], pending: [], missing: [], green: [] };
    expected[bucket] = ['Legacy-CI'];
    expect(requiredCheckStates({ ...input, requiredChecks: ['Legacy-CI'], rollup: [
      { __typename: 'StatusContext', context: 'Legacy-CI', state },
    ] })).toEqual(expected);
  });

  it('missing contains only required names with no row, preserving all result names and the four-field shape', () => {
    expect(requiredCheckStates({ ...input, requiredChecks: ['Test', 'Build', 'Absent'], rollup: [
      { name: 'Test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Build', status: 'IN_PROGRESS', conclusion: null },
      { name: 'Optional', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] })).toEqual({ red: [], pending: ['Build'], missing: ['Absent'], green: ['Test'] });
  });
});

describe('gateOnlyRedStates', () => {
  it.each(['review-gate', 'merge-gate'])('includes red %s even when absent from the required roster', name => {
    expect(verdictRecheck.gateOnlyRedStates({ ...input, rollup: [
      ...green, { name, status: 'COMPLETED', conclusion: 'FAILURE' },
    ] })).toEqual({ gateOnlyRed: true, red: [name] });
  });

  it('recognizes both gates red together', () => {
    const result = verdictRecheck.gateOnlyRedStates({ ...input, rollup: [
      ...green, ...['review-gate', 'merge-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'FAILURE' })),
    ] });
    expect(result.gateOnlyRed).toBe(true);
    expect(result.red.toSorted()).toEqual(['merge-gate', 'review-gate']);
  });

  it('a real required failure alongside a red gate is not gate-only red', () => {
    const result = verdictRecheck.gateOnlyRedStates({ requiredChecks: ['test'], rollup: [
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ] });
    expect(result.gateOnlyRed).toBe(false);
    expect(result.red.toSorted()).toEqual(['review-gate', 'test']);
  });

  it('no red checks is not gate-only red', () => {
    expect(verdictRecheck.gateOnlyRedStates({ ...input, rollup: green }))
      .toEqual({ gateOnlyRed: false, red: [] });
  });
});

describe('required check verdict recheck', () => {
  it('contradicts the real #4535 verdict only for test', () => {
    expect(contradictingChecks(input)).toEqual(['test']);
    expect(notCiBreakContradicted(input)).toBe(true);
    expect(requiredCheckStates(input).red).toEqual(['test']);
  });
  it('review-gate red alone never contradicts', () => {
    const rollup = [...fixture.statusCheckRollup.filter((r) => r.name === 'review-gate' && r.conclusion === 'FAILURE'), ...green];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: [...fixture.requiredChecks, 'review-gate'] })).toEqual([]);
  });
  it.each([{ outcome: 'needs-human', headSha: fixture.headRefOid }, { outcome: 'not-a-ci-break', headSha: 'abcdef0123456789' }])('ignores unrelated escalation %j', (escalation) => {
    expect(contradictingChecks({ ...input, escalation })).toEqual([]);
  });
  it('matches an abbreviated escalation head', () => expect(contradictingChecks({ ...input, escalation: { ...input.escalation, headSha: fixture.headRefOid.slice(0, 9) } })).toEqual(['test']));
  it('the latest run wins even when the old red appears last in the array', () => {
    const rollup = [
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-09T04:00:00Z', completedAt: '2026-10-09T04:01:00Z' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-10-09T02:00:00Z', completedAt: '2026-10-09T02:01:00Z' },
    ];
    expect(contradictingChecks({ ...input, rollup, requiredChecks: ['test'] })).toEqual([]);
  });
  it('cannot declare not-a-ci-break while the fixture checks are unfinished', () => {
    const rollup = fixture.statusCheckRollup.filter((r) => r.startedAt <= fixture.escalationAt)
      .map((r) => r.completedAt > fixture.escalationAt ? { ...r, status: 'IN_PROGRESS', conclusion: null } : r);
    const result = unsettledRequiredChecks({ ...input, rollup });
    expect([...result.pending, ...result.missing]).toEqual(expect.arrayContaining(['test', 'daemon-soak']));
    expect(result.red).toEqual([]);
  });
  it('unknown required set claims nothing red', () => expect(contradictingChecks({ ...input, requiredChecks: [] })).toEqual([]));
  it('legacy StatusContext failures count', () => {
    expect(contradictingChecks({ ...input, rollup: [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }] })).toEqual(['test']);
  });
});

describe('resolveCiHealVerdictSettings', () => {
  it.each([['off', 'on', false], ['on', 'off', true]])('env %s overrides file %s', (env, file, value) => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_RECHECK_NOT_CI_BREAK: env }, { read: () => JSON.stringify({ ciHealVerdict: { recheckNotCiBreak: file } }) })).toMatchObject({ recheckNotCiBreak: value });
  });
  it('malformed settings fail closed', () => expect(resolveCiHealVerdictSettings({}, { read: () => '{' })).toMatchObject({ recheckNotCiBreak: false }));
  it('checked-in settings enable rechecking', () => expect(resolveCiHealVerdictSettings({})).toMatchObject({ recheckNotCiBreak: true }));
});


describe('void needs-human settings and green evidence', () => {
  const resolve = (platform, repo, env = {}) => resolveVoidNeedsHumanWhenCiGreen(env, {
    platformPath: 'platform', path: 'repo',
    read: path => JSON.stringify({ ciHealVerdict: { voidNeedsHumanWhenCiGreen: path === 'platform' ? platform : repo } }),
  });
  it('cascades standard → platform → repo → env', () => {
    expect(resolve()).toMatchObject({ value: true, source: 'standard' });
    expect(resolve('off')).toMatchObject({ value: false, source: 'platform' });
    expect(resolve('off', 'on')).toMatchObject({ value: true, source: 'repo' });
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ value: false, source: 'env' });
  });
  it('fails closed on invalid layers with reasons', () => {
    const result = resolve('off', 'invalid', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'bad' });
    expect(result).toMatchObject({ value: false, source: 'repo' });
    expect(result.ignored).toEqual([expect.objectContaining({ source: 'repo', reason: expect.any(String) }), expect.objectContaining({ source: 'env', reason: expect.any(String) })]);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: () => '{' })).toMatchObject({ value: false, source: 'platform' });
  });
  it.each(['{', 'null', '[]', '{"ciHealVerdict":null}', '{"ciHealVerdict":[]}', '{"ciHealVerdict":{"voidNeedsHumanWhenCiGreen":true}}'])('invalid document %s cannot be overridden on', document => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      platformPath: 'platform', path: 'repo', read: path => path === 'platform' ? document : '{}',
    }).value).toBe(false);
  });
  it.each(['EACCES', 'EIO'])('unreadable platform %s cannot be overridden on', code => {
    expect(resolveVoidNeedsHumanWhenCiGreen({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }, {
      read: () => { throw Object.assign(new Error(code), { code }); },
    }).value).toBe(false);
  });
  it('allows absent optional platform preferences but fails closed on a missing repo file', () => {
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { platformPath: 'platform', read: path => path === 'platform' ? missing() : '{}' }).value).toBe(true);
    expect(resolveVoidNeedsHumanWhenCiGreen({}, { read: missing }).value).toBe(false);
  });
  it('exposes the resolved boolean and source', () => {
    expect(resolveCiHealVerdictSettings({ WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'off' })).toMatchObject({ voidNeedsHumanWhenCiGreen: false, voidNeedsHumanSource: 'env' });
  });
  it('invalid repo or env cannot silently restore the default on', () => {
    expect(resolve('on', 'invalid').value).toBe(false);
    expect(resolve('on', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'invalid' }).value).toBe(false);
    expect(resolve('invalid', 'on', { WE_CI_HEAL_VOID_NEEDS_HUMAN_WHEN_CI_GREEN: 'on' }).value).toBe(false);
  });
  it('requires a known, settled required set, excluding review-gate', () => {
    const checks = ['test', 'review-gate'];
    const rollup = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
    expect(ciGreenForEscalation({ rollup, requiredChecks: checks })).toBe(true);
    for (const conclusion of ['FAILURE', 'TIMED_OUT']) expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], conclusion }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [{ ...rollup[0], status: 'IN_PROGRESS' }], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup: [], requiredChecks: checks })).toBe(false);
    expect(ciGreenForEscalation({ rollup, requiredChecks: [] })).toBe(false);
  });
});
