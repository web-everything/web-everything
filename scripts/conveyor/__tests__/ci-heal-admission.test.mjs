import { describe, it, expect } from 'vitest';
import { admitCiHeal } from '../ci-heal-admission.mjs';

const gate = cls => ({ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE',
  ...(cls ? { mergeGateAdmission: { class: cls, why: 'fixture', jobId: 123 } } : {}) });
const testCheck = { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' };
const codeqlFailure = { checkRunId: '456', alerts: [] };
const required = (rollup, extra = {}) => admitCiHeal({ reason: 'required',
  failingRequired: rollup.map(r => r.name), rollup, mainState: 'unknown', ...extra });
const admitted = (classes, basis = 'real') => ({ admitted: true, classes, basis });
const refused = reason => ({ admitted: false, reason, why: expect.any(String) });

describe('CI-heal ordered admission table', () => {
  it('codeql admits a present CodeQL failure', () => {
    expect(admitCiHeal({ reason: 'codeql', failingRequired: [], rollup: [], codeqlFailure,
      mainState: 'red' })).toEqual(admitted(['real']));
  });
  it('codeql without a CodeQL failure refuses no-failing-check even with required reds', () => {
    expect(admitCiHeal({ reason: 'codeql', failingRequired: ['test'], rollup: [testCheck],
      mainState: 'green' })).toEqual(refused('no-failing-check'));
  });
  it('required with an empty failing set refuses no-failing-check', () => {
    expect(admitCiHeal({ reason: 'required', failingRequired: [], rollup: [testCheck],
      codeqlFailure, mainState: 'green' })).toEqual(refused('no-failing-check'));
  });
  it('a non-gate required failure classes real and admits', () => {
    expect(required([testCheck])).toEqual(admitted(['real']));
  });
  it('a review-gate-only failure refuses review-hold', () => {
    expect(required([{ ...testCheck, name: 'review-gate' }])).toEqual(refused('review-hold'));
  });
  it('a review-class merge-gate refuses review-hold', () => {
    expect(required([gate('review')])).toEqual(refused('review-hold'));
  });
  it.each(['unreadable', undefined])('an unreadable or unannotated merge-gate (%s) refuses closed', cls => {
    expect(required([gate(cls)])).toEqual(refused('x-merge-gate-unreadable'));
  });
  it('main+test admits', () => {
    const out = required([gate('main'), testCheck], { mainState: 'red' });
    expect(out).toEqual(admitted(expect.arrayContaining(['main', 'real'])));
  });
  it('main+CodeQL admits at the codeql site', () => {
    expect(admitCiHeal({ reason: 'codeql', failingRequired: ['merge-gate'], rollup: [gate('main')],
      codeqlFailure, mainState: 'red' })).toEqual(admitted(['real']));
  });
  it('unreadable+test admits', () => {
    expect(required([gate('unreadable'), testCheck])).toEqual(admitted(expect.arrayContaining(['unreadable', 'real'])));
  });
  it('readable real merge-gate only admits', () => {
    expect(required([gate('real')])).toEqual(admitted(['real']));
  });
  it('main hold admits when mainState green', () => {
    expect(required([gate('main')], { mainState: 'green' })).toEqual(admitted(['main'], 'main-green'));
  });
  it('mainState unknown refuses main-red', () => {
    expect(required([gate('main')])).toEqual(refused('main-red'));
  });
  it('mainState red refuses main-red', () => {
    expect(required([gate('main')], { mainState: 'red' })).toEqual(refused('main-red'));
  });
  it('no main-fix-priority exemption: main hold with mainState red refuses even for the main-fix PR', () => {
    // Admission has no PR-priority input: the main-fix PR is subject to the same main-only rule.
    expect(required([gate('main')], { mainState: 'red' })).toEqual(refused('main-red'));
    expect(required([testCheck], { mainState: 'red' })).toEqual(admitted(['real']));
  });
  it('main takes precedence over review, and unreadable over review', () => {
    expect(required([gate('main'), { ...testCheck, name: 'review-gate' }],
      { mainState: 'red' })).toEqual(refused('main-red'));
    expect(required([gate(), { ...testCheck, name: 'review-gate' }])).toEqual(refused('x-merge-gate-unreadable'));
  });
  it('refusal reasons are only the closed four', () => {
    const outcomes = [required([]), required([gate('review')]), required([gate('main')]), required([gate()])];
    expect(new Set(outcomes.map(o => o.reason))).toEqual(new Set([
      'review-hold', 'main-red', 'no-failing-check', 'x-merge-gate-unreadable',
    ]));
    for (const out of outcomes) expect(out).toEqual(refused(out.reason));
  });
});
