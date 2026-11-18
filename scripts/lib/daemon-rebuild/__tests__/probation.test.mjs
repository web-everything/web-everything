import { describe, expect, it } from 'vitest';

// Adapted from origin/lane/blue-green-s2-probation-r928's probation fixture:
// retain its heads, adoption clock and previous-tick checks, not its clone-wide boot record.
const ADOPTED_AT = Date.parse('2026-11-15T12:00:00.000Z');
const GOOD = 'a'.repeat(40), FAILED = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const iso = ms => new Date(ms).toISOString();
const modulePath = '../probation.mjs';
const core = () => import(modulePath);
const closure = blob => ({ complete: true, files: { 'worker.mjs': blob } });
const registered = ['worker', 'review', 'healthy'].map(id => ({ id }));
const options = {
  adoptionId: '11111111-1111-4111-8111-111111111111',
  sha: FAILED, provenGood: GOOD, adoptedAt: iso(ADOPTED_AT), registered,
  readClosure: (daemon, sha) => closure(daemon.id === 'healthy' ? GOOD : sha),
};
const proof = (pid = 101, daemonId = 'worker') => ({
  boot: { daemonId, pid, head: FAILED, startedAt: iso(ADOPTED_AT) },
  tick: { daemonId, pid, head: FAILED, lastTickDoneAt: iso(ADOPTED_AT + 1) },
});
const now = ADOPTED_AT + 2;

describe('R986 I1 frozen owed set and per-daemon proofs (pure core)', () => {
  it('healthy unaffected sibling ticking does NOT promote the unproven changed daemon', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const p = freezeProbation(options);
    const next = recordProof(p, 'healthy', proof(303, 'healthy'), now);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pending', owed: ['worker', 'review'] });
  });

  it('proof from a non-owed daemon never counts and never deletes or narrows probation', async () => {
    const { freezeProbation, recordProof } = await core();
    const p = freezeProbation(options);
    expect(recordProof(p, 'healthy', proof(303, 'healthy'), now)).toBe(p);
    expect(recordProof(p, 'unknown', proof(404, 'unknown'), now)).toBe(p);
    expect(p.owed).toEqual(['worker', 'review']);
    expect(p.records).toEqual({});
  });

  it('empty owed set promotes immediately with no boot or tick evidence', async () => {
    const { freezeProbation, evaluateProbation } = await core();
    const p = freezeProbation({ ...options, readClosure: () => closure(GOOD) });
    expect(p.owed).toEqual([]);
    expect(evaluateProbation(p, ADOPTED_AT)).toEqual({ action: 'pass' });
  });

  it('every owed daemon must prove with its own pid; one proof cannot discharge two daemons', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const p = freezeProbation(options);
    const first = recordProof(p, 'worker', proof(101), now);
    expect(evaluateProbation(first, now)).toEqual({ action: 'pending', owed: ['review'] });
    expect(recordProof(first, 'review', proof(101), now)).toBe(first);
    const second = recordProof(first, 'review', proof(202, 'review'), now);
    expect(evaluateProbation(second, now)).toEqual({ action: 'pass' });
    expect(Object.keys(second.records)).toEqual(['worker', 'review']);
    expect(second.owed).toEqual(p.owed);
    expect(p.records).toEqual({});
    expect(() => second.owed.pop()).toThrow();
  });

  it.each(['pid', 'head', 'before-adoption', 'before-boot', 'future', 'unapproved-head', 'missing-start', 'wrong-daemon', 'wrong-boot-daemon'])(
    'rejects invalid previous tick evidence: %s', async kind => {
      const { freezeProbation, recordProof, evaluateProbation } = await core();
      const p = freezeProbation({ ...options, registered: [{ id: 'worker' }] });
      const evidence = proof();
      if (kind === 'pid') evidence.tick.pid++;
      if (kind === 'head') evidence.tick.head = OTHER;
      if (kind === 'before-adoption') evidence.boot.startedAt = iso(ADOPTED_AT - 1);
      if (kind === 'before-boot') evidence.tick.lastTickDoneAt = iso(ADOPTED_AT);
      if (kind === 'future') evidence.tick.lastTickDoneAt = iso(now + 60_001);
      if (kind === 'unapproved-head') evidence.boot.head = GOOD;
      if (kind === 'missing-start') delete evidence.boot.startedAt;
      if (kind === 'wrong-daemon') evidence.tick.daemonId = 'healthy';
      if (kind === 'wrong-boot-daemon') evidence.boot.daemonId = 'healthy';
      expect(recordProof(p, 'worker', evidence, now)).toBe(p);
      expect(evaluateProbation(p, now).action).toBe('pending');
    },
  );

  it('freezes owed at adoption despite later roster, closure, and proof changes', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const roster = [{ id: 'worker' }];
    let changed = true;
    const p = freezeProbation({ ...options, registered: roster, readClosure: (_, sha) => closure(changed ? sha : GOOD) });
    roster.length = 0;
    changed = false;
    const evidence = proof();
    const next = recordProof(p, 'worker', evidence, now);
    evidence.tick.head = OTHER;
    expect(next.owed).toEqual(['worker']);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pass' });
  });

  it.each([null, { complete: false, files: {} }, { complete: true, files: {} }])(
    'unknown/incomplete closure owes proof rather than silently promoting: %j', async unknown => {
      const { freezeProbation, evaluateProbation } = await core();
      const p = freezeProbation({ ...options, readClosure: () => unknown });
      expect(p.owed).toEqual(['worker', 'review', 'healthy']);
      expect(evaluateProbation(p, now).action).toBe('pending');
    },
  );

  it('closure read failure owes proof; changed import membership also owes proof', async () => {
    const { freezeProbation } = await core();
    expect(freezeProbation({ ...options, readClosure() { throw new Error('unreadable'); } }).owed).toHaveLength(3);
    expect(freezeProbation({ ...options, readClosure: (_, sha) => ({
      complete: true, files: sha === GOOD ? { 'old.mjs': GOOD } : { 'new.mjs': GOOD },
    }) }).owed).toHaveLength(3);
  });

  it('unknown or duplicate roster refuses adoption with an operator-visible fallback', async () => {
    const { freezeProbation } = await core();
    for (const roster of [null, [{ id: 'worker' }, { id: 'worker' }], [{}]]) {
      expect(() => freezeProbation({ ...options, registered: roster })).toThrow(/operator.*roster/i);
    }
  });

  it('old single-record persisted state fails closed and requires operator recovery', async () => {
    const { evaluateProbation } = await core();
    expect(evaluateProbation({ ...options, version: 1, bootPid: 101, boots: 0 }, now))
      .toEqual({ action: 'pending', reason: 'invalid-probation: operator recovery required' });
  });
});
