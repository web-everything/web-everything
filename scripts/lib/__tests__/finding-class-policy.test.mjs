import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfirmedBreaks } from '../red-team-gate.mjs';
import { describe, it, expect } from 'vitest';
import { FINDING_CLASSES, classAction, stricterClass, readFindingClassPolicy } from '../finding-class-policy.mjs';
import { deriveVerdict, foldRedTeamVerdict } from '../jury-core.mjs';

describe('finding class policy', () => {
  it('fails closed for missing, unknown and invalid classes', () => {
    for (const findingClass of [undefined, null, '', 'unknown', 'constructor', {}, 1]) {
      expect(classAction({ findingClass, classBasis: 'evidence' })).toBe('fix-now');
    }
    expect(classAction(null)).toBe('fix-now');
    expect(FINDING_CLASSES).toHaveLength(6);
  });
  it('maps all six built-in classes without storing an action', () => {
    for (const [index, findingClass] of FINDING_CLASSES.entries()) {
      const f = { findingClass, classBasis: 'evidence' };
      expect(classAction(f)).toBe(index < 3 ? 'fix-now' : 'defer-card');
      expect(f).not.toHaveProperty('action');
    }
  });
  it('carries live operator policy to confirmed-break readers and does not cache it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finding-policy-'));
    const path = join(dir, 'operator.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: path };
    try {
      writeFileSync(path, JSON.stringify({ findingClasses: { 'theoretical-race': 'fix-now' } }));
      expect(readConfirmedBreaks({ env, path: join(dir, 'absent.json') }).value.findingClasses).toEqual({ 'theoretical-race': 'fix-now' });
      writeFileSync(path, JSON.stringify({ findingClasses: { 'theoretical-race': 'defer-card' } }));
      expect(readConfirmedBreaks({ env, path: join(dir, 'absent.json') }).value.findingClasses).toEqual({ 'theoretical-race': 'defer-card' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires a non-empty string basis before deferring', () => {
    for (const classBasis of [undefined, null, '', '  ', 1])
      expect(classAction({ findingClass: 'theoretical-race', classBasis })).toBe('fix-now');
    expect(classAction({ findingClass: 'theoretical-race', classBasis: 'requires overlapping writes' })).toBe('defer-card');
  });
  it('honours live overrides but locks reachable security unless explicitly allowed', () => {
    const f = { findingClass: 'security-reachable-today', classBasis: 'reachable endpoint' };
    expect(classAction(f, { [f.findingClass]: 'defer-card', allowSecurityDefer: 'true' })).toBe('fix-now');
    expect(classAction(f, { [f.findingClass]: 'defer-card', allowSecurityDefer: true })).toBe('defer-card');
    expect(classAction({ ...f, findingClass: 'theoretical-race' }, { 'theoretical-race': 'fix-now' })).toBe('fix-now');
    expect(classAction({ ...f, findingClass: 'theoretical-race' }, { 'theoretical-race': 'invalid' })).toBe('fix-now');
  });
  it('chooses the stricter class; unclassified wins and ties retain the first', () => {
    expect(stricterClass('theoretical-race', 'live-reproduced')).toBe('live-reproduced');
    expect(stricterClass('live-reproduced', 'security-reachable-today')).toBe('live-reproduced');
    expect(stricterClass('attacker-same-user', 'coverage-or-style')).toBe('attacker-same-user');
    expect(stricterClass('theoretical-race', undefined)).toBeUndefined();
    expect(stricterClass('unknown', 'live-reproduced')).toBeUndefined();
    expect(stricterClass('live-reproduced', 'theoretical-race → defer-card (basis: x)')).toBeUndefined();
  });
  it('a retained class that needs a fix keeps the finding fix-now across policy changes', () => {
    const f = { findingClass: 'live-reproduced', alsoClasses: ['correctness-in-normal-use'], classBasis: 'basis' };
    const policy = { 'live-reproduced': 'defer-card' };
    expect(classAction(f, policy)).toBe('fix-now');
    expect(classAction(f, { ...policy, 'correctness-in-normal-use': 'defer-card' })).toBe('defer-card');
    expect(classAction({ ...f, alsoClasses: ['bogus', 'live-reproduced'] }, policy)).toBe('defer-card');
  });
  it('reads only operator preferences through the shared reader', () => {
    const policy = readFindingClassPolicy({ env: { WE_PLATFORM_PREFERENCES_FILE: '/operator/prefs.json' },
      readFile: () => JSON.stringify({ findingClasses: { 'theoretical-race': 'fix-now' } }) });
    expect(policy).toEqual({ 'theoretical-race': 'fix-now' });
  });
  it('keeps deferred findings outstanding without a recorded card and ruling', () => {
    const f = { summary: 'race', findingClass: 'theoretical-race', classBasis: 'requires concurrency' };
    expect(foldRedTeamVerdict({ ran: true, findings: [f], findingClasses: {} })).toBe('changes');
    for (const evidence of [{ cardId: '123' }, { ruling: 'defer' },
      { cardId: ' ', ruling: 'defer' }, { cardId: '123', ruling: ' ' },
      { cardId: 123, ruling: 'defer' }, { cardId: '123', ruling: true }]) {
      expect(foldRedTeamVerdict({ ran: true, findings: [{ ...f, ...evidence }], findingClasses: {} })).toBe('changes');
    }
    const recorded = { ...f, cardId: '123', ruling: 'defer to recorded card' };
    expect(foldRedTeamVerdict({ ran: true, findings: [recorded], findingClasses: {} })).toBe('accept');
    expect(foldRedTeamVerdict({ ran: true, findings: [f, { summary: 'unknown' }], findingClasses: {} })).toBe('changes');
    expect(foldRedTeamVerdict({ ran: true, findings: [recorded, { summary: 'unknown' }], findingClasses: {} })).toBe('changes');
    expect(foldRedTeamVerdict({ ran: false, findings: [f], findingClasses: {} })).toBe('needs-human');
  });
  it.each(['bogus', '1234567', 'x12345', '123\n'])('rejects a malformed deferral card id: %j', (cardId) => {
    const f = { summary: 'race', findingClass: 'theoretical-race', classBasis: 'concurrency', cardId, ruling: 'defer' };
    expect(foldRedTeamVerdict({ ran: true, findings: [f], findingClasses: {} })).toBe('changes');
  });
  it.each(['must fix before deferring', 'needs a fix', 'should fix', 'not deferred'])('rejects a ruling against deferral: %s', (ruling) => {
    const f = { summary: 'race', findingClass: 'theoretical-race', classBasis: 'concurrency', cardId: '123', ruling };
    expect(foldRedTeamVerdict({ ran: true, findings: [f], findingClasses: {} })).toBe('changes');
  });
  it('keeps prevention outstanding on a recorded deferral, including an unresolved finding', () => {
    const f = { summary: 'race', findingClass: 'theoretical-race', classBasis: 'concurrency',
      cardId: 'xabc123', ruling: 'defer to card', outcome: 'fixed',
      prevention: 'add a concurrency guard', preventionCaptured: false, impactIfUnfixed: 'unrecoverable' };
    expect(deriveVerdict({ findings: [f] })).toBe('prevention-outstanding');
    expect(foldRedTeamVerdict({ ran: true, findings: [f], findingClasses: {} })).toBe('prevention-outstanding');
    expect(foldRedTeamVerdict({ ran: true, findings: [{ ...f, outcome: 'skipped' }], findingClasses: {} })).toBe('prevention-outstanding');
    expect(foldRedTeamVerdict({ ran: true, findings: [{ ...f, outcome: 'skipped', preventionCaptured: true }], findingClasses: {} })).toBe('accept');
    expect(foldRedTeamVerdict({ ran: false, findings: [f], findingClasses: {} })).toBe('needs-human');
  });

});
