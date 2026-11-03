// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reduceLabelState, normalizeLabelSet } from '../pr-label-state.mjs';

describe('PR label state reducer', () => {
  describe.each(['labels', 'add', 'remove'])('%s input validation', field => {
    it.each([
      ['null', null], ['string', 'bug'], ['object', { name: 'bug' }],
      ['number', 42], ['boolean', false],
    ])('throws TypeError for a non-array %s input', (_kind, value) => {
      const reduce = () => reduceLabelState({ labels: [], [field]: value });
      expect(reduce).toThrow(TypeError);
      expect(reduce).toThrow(`${field} must be a label array`);
    });

    it.each([
      ['null entry', null], ['undefined entry', undefined], ['missing name', {}],
      ['empty string', ''], ['empty name', { name: '' }],
      ['non-string name', { name: 42 }], ['number entry', 42], ['boolean entry', false],
    ])('throws TypeError for a malformed label: %s', (_kind, value) => {
      const reduce = () => reduceLabelState({ labels: [], [field]: ['bug', value] });
      expect(reduce).toThrow(TypeError);
      expect(reduce).toThrow(`${field} contains an unreadable label`);
    });
  });

  it('throws TypeError when the existing labels input is missing', () => {
    expect(() => reduceLabelState({})).toThrow(TypeError);
    expect(() => normalizeLabelSet(undefined)).toThrow(TypeError);
  });

  it('review changes strips readiness even with both clearance labels', () => {
    const r = reduceLabelState({ labels: ['ready-to-merge', 'review:accepted', 'red-team:clear'], add: ['review:changes'] });
    expect(r.labels).not.toContain('ready-to-merge');
    expect(r.remove).toContain('ready-to-merge');
    expect(r.violations).toContain('review-changes-ready');
  });
  it.each([[], ['review:accepted'], ['red-team:clear']])('refuses readiness without both clearances: %j', (...labels) => {
    const r = reduceLabelState({ labels, add: ['ready-to-merge'] });
    expect(r.labels).not.toContain('ready-to-merge');
    expect(r.add).not.toContain('ready-to-merge');
    expect(r.violations).toContain('ready-without-clearance');
  });
  it('checks clearances after applying removals', () => {
    const r = reduceLabelState({ labels: ['review:accepted', 'red-team:clear', 'ready-to-merge'], remove: ['red-team:clear'] });
    expect(r.remove).toEqual(['red-team:clear', 'ready-to-merge']);
  });
  it.each(['review:accepted', 'review:pending', 'review:changes'])('clearance opt-out still enforces changes and one status: %s', review => {
    const r = reduceLabelState({ labels: ['ready-to-merge', review, 'status:red-team', 'status:awaiting-ci'], enforceClearance: false });
    expect(r.labels.includes('ready-to-merge')).toBe(review !== 'review:changes');
    expect(r.remove).toEqual(review === 'review:changes' ? ['ready-to-merge', 'status:red-team'] : ['status:red-team']);
    expect(r.labels.filter(label => label.startsWith('status:'))).toEqual(['status:awaiting-ci']);
    expect(r.violations).not.toContain('ready-without-clearance');
  });
  it('keeps the last requested status, even if it was already present', () => {
    const r = reduceLabelState({ labels: ['status:red-team', 'status:fixing'], add: ['status:awaiting-ci', 'status:red-team'] });
    expect(r.labels).toEqual(['status:red-team']);
    expect(r.add).toEqual([]);
    expect(r.remove).toEqual(['status:fixing']);
    expect(r.violations).toContain('multiple-status');
  });
  it('single-status opt-out preserves existing and added statuses while honoring explicit removals', () => {
    const r = reduceLabelState({
      labels: ['status:red-team', 'status:fixing', 'status:at-round-limit', 'status:ci-red'],
      add: ['status:awaiting-ci', 'status:red-team'], remove: ['status:ci-red'], enforceSingleStatus: false,
    });
    expect(r).toEqual({
      labels: ['status:red-team', 'status:fixing', 'status:at-round-limit', 'status:awaiting-ci'],
      add: ['status:awaiting-ci'], remove: ['status:ci-red'], violations: [],
    });
  });
  it('normalizes PR #6288 using lexical status precedence independent of input order', () => {
    const labels = ['ready-to-merge', 'review:changes', 'red-team:blocked', 'status:awaiting-ci', 'status:red-team'];
    const normalized = normalizeLabelSet(labels);
    expect(normalized).toEqual(['review:changes', 'red-team:blocked', 'status:awaiting-ci']);
    expect(normalizeLabelSet([...labels].reverse()).filter(l => l.startsWith('status:'))).toEqual(['status:awaiting-ci']);
    expect(normalizeLabelSet(normalized)).toEqual(normalized);
  });
  it('is a no-op on consistent sets and never mutates inputs', () => {
    const labels = Object.freeze(['bug', 'review:accepted', 'red-team:clear', 'ready-to-merge', 'status:awaiting-ci']);
    expect(reduceLabelState({ labels })).toEqual({ labels, add: [], remove: [], violations: [] });
    expect(reduceLabelState({ labels, add: ['bug'], remove: ['absent'] }).labels).toEqual(labels);
  });
  it('accepts GitHub label objects and produces replayable deltas', () => {
    const labels = ['ready-to-merge', 'status:z', 'status:a'];
    const r = reduceLabelState({ labels: labels.map(name => ({ name })), add: ['review:changes'] });
    expect([...labels.filter(l => !r.remove.includes(l)), ...r.add]).toEqual(r.labels);
    expect(reduceLabelState({ labels: r.labels })).toEqual({ labels: r.labels, add: [], remove: [], violations: [] });
  });
});
