/** The lifecycle table is data; these tests keep it honest against the manifest and the core derivation. */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DAEMON_MANIFEST } from '../../../skills-src/conveyor/daemon-manifest.mjs';
import { PR_STATE_PHASES } from '../../lib/pr-state-core.mjs';
import { LIFECYCLE_STATES, LIFECYCLE_STATE_NAMES, RESIDENT_OWNERS, HUMAN_HOLD_CI_RED, renderLabels, canTransition, lifecycleRow } from '../pr-lifecycle.mjs';

const root = resolve(import.meta.dirname, '../../..');
const manifestHas = id => Object.keys(DAEMON_MANIFEST).some(k => k === id || k.startsWith(`${id}-`));

describe('pr-lifecycle table', () => {
  it('covers every core phase plus the human-hold + red-check state, once each', () => {
    expect([...LIFECYCLE_STATE_NAMES].sort()).toEqual([...PR_STATE_PHASES, HUMAN_HOLD_CI_RED].sort());
    expect(new Set(LIFECYCLE_STATE_NAMES).size).toBe(LIFECYCLE_STATE_NAMES.length);
  });
  it.each(LIFECYCLE_STATES.map(r => [r.state, r]))('%s has a real owner', (_s, row) => {
    const resident = Object.hasOwn(RESIDENT_OWNERS, row.owner);
    expect(resident || manifestHas(row.owner), `owner ${row.owner}`).toBe(true);
    if (resident && RESIDENT_OWNERS[row.owner]) expect(existsSync(resolve(root, RESIDENT_OWNERS[row.owner]))).toBe(true);
  });
  it.each(LIFECYCLE_STATES.map(r => [r.state, r]))('%s: every next is a declared state, nothing reads labels', (_s, row) => {
    for (const n of row.next) expect(LIFECYCLE_STATE_NAMES).toContain(n);
    expect(row.derivedFrom.length).toBeGreaterThan(0);
    expect(row.derivedFrom.join(' ')).not.toMatch(/label/);
  });
  it.each(LIFECYCLE_STATES.map(r => [r.state, r]))('%s has renderLabels and a time budget', (_s, row) => {
    expect(Array.isArray(row.renderLabels)).toBe(true);
    expect(renderLabels(row.state)).toEqual(row.renderLabels);
    expect(row.maxTimeInState === null || row.maxTimeInState > 0).toBe(true);
  });
  it('terminal states have no exits, and others can reach a terminal state', () => {
    expect(lifecycleRow('MERGED').next).toEqual([]);
    expect(lifecycleRow('CLOSED').next).toEqual([]);
    for (const r of LIFECYCLE_STATES) if (r.next.length) expect(r.next).toContain(r.next.includes('MERGED') ? 'MERGED' : 'CLOSED');
  });
  it('the human-hold + red-check case is declared and owned', () => {
    expect(lifecycleRow(HUMAN_HOLD_CI_RED)).toMatchObject({ owner: 'ci-red-recovery-watch' });
    expect(canTransition(HUMAN_HOLD_CI_RED, 'WAITING-CI')).toBe(true);
    expect(canTransition('MERGED', 'IN-REVIEW')).toBe(false);
  });
});
