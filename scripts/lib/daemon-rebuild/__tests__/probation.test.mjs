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
  it.each(['evaluate', 'record', 'evaluate records first', 'record records first'])(
    'records getter cannot pop owed during %s', async transition => {
      const { freezeProbation, recordProof, evaluateProbation } = await core();
      const restored = JSON.parse(JSON.stringify(freezeProbation(options)));
      const input = transition.endsWith('records first') ? { records: undefined, ...restored } : restored;
      let reads = 0;
      Object.defineProperty(input, 'records', { enumerable: true, get() {
        reads++;
        input.owed.pop();
        return { worker: proof() };
      } });
      const result = transition.startsWith('evaluate') ? evaluateProbation(input, now)
        : evaluateProbation(recordProof(input, 'worker', proof(), now), now);
      expect(result).toEqual({ action: 'pending', owed: ['review'] });
      expect(reads).toBe(1);
    },
  );

  it('an adoption callback getter cannot shrink the roster even when it is the first key', async () => {
    const { freezeProbation, evaluateProbation } = await core();
    const roster = [{ id: 'worker' }, { id: 'review' }];
    const input = { readClosure: undefined, ...options, registered: roster };
    Object.defineProperty(input, 'readClosure', { enumerable: true, get() {
      roster.pop();
      return options.readClosure;
    } });
    expect(evaluateProbation(freezeProbation(input), now))
      .toEqual({ action: 'pending', owed: ['worker', 'review'] });
  });

  it.each(['boot', 'tick', 'nested boot', 'nested tick'])(
    'throwing evidence getter is an identity-preserving no-op: %s', async site => {
      const { freezeProbation, recordProof } = await core();
      const input = freezeProbation(options);
      const evidence = proof();
      const nested = site.startsWith('nested ');
      const key = site.replace('nested ', '');
      Object.defineProperty(nested ? evidence[key] : evidence, nested ? 'pid' : key,
        { enumerable: true, get() { throw new Error('unreadable evidence'); } });
      expect(recordProof(input, 'worker', evidence, now)).toBe(input);
    },
  );

  it.each(['adoptionId', 'registered', 'readClosure'])(
    'unreadable adoption input returns the original input: %s', async key => {
      const { freezeProbation } = await core();
      const input = { ...options };
      Object.defineProperty(input, key, { enumerable: true, get() { throw new Error('unreadable'); } });
      expect(freezeProbation(input)).toBe(input);
    },
  );

  it.each(['cycle', 'function'])(
    'uncopyable evidence fails closed without silently stripping fields: %s', async kind => {
      const { freezeProbation, recordProof } = await core();
      const input = freezeProbation(options);
      const evidence = proof();
      evidence.boot.extra = kind === 'cycle' ? evidence : () => {};
      expect(recordProof(input, 'worker', evidence, now)).toBe(input);
    },
  );

  it.each(['complete', 'files', 'blob'])(
    'unreadable closure data always leaves the daemon owed: %s', async site => {
      const { freezeProbation, evaluateProbation } = await core();
      const value = closure(GOOD);
      Object.defineProperty(site === 'blob' ? value.files : value,
        site === 'blob' ? 'worker.mjs' : site,
        { enumerable: true, get() { throw new Error('unreadable closure'); } });
      const input = freezeProbation({ ...options, registered: [{ id: 'worker' }], readClosure: () => value });
      expect(evaluateProbation(input, now)).toEqual({ action: 'pending', owed: ['worker'] });
    },
  );

  it('sanitization never executes a serialization hook to hide invalid state fields', async () => {
    const { freezeProbation, validateProbation, recordProof, evaluateProbation } = await core();
    const plain = JSON.parse(JSON.stringify(freezeProbation(options)));
    let calls = 0;
    const input = { ...plain, toJSON() { calls++; return { ...plain, owed: [], records: {} }; } };
    expect(validateProbation(input, now)).toBe('state-fields');
    expect(recordProof(input, 'worker', proof(), now)).toBe(input);
    expect(evaluateProbation(input, now).action).toBe('pending');
    expect(calls).toBe(0);
  });

  it('aliased evidence is copied once even when a getter changes on subsequent reads', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const input = JSON.parse(JSON.stringify(freezeProbation(options)));
    const evidence = proof();
    let reads = 0;
    Object.defineProperty(evidence.boot, 'pid', { enumerable: true, get: () => ++reads === 1 ? 101 : 999 });
    input.records.worker = evidence;
    const next = recordProof(input, 'worker', evidence, now);
    // Vitest's negated object identity matcher deep-compares for diagnostic hints,
    // invoking the input getter again. Compare identity before entering the matcher.
    expect(next === input).toBe(false);
    expect(reads).toBe(1);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pending', owed: ['review'] });
  });

  it('oversized input fails closed with operator recovery and identity-preserving no-ops', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const optionsTooLarge = { ...options, registered: new Array(100_001) };
    expect(freezeProbation(optionsTooLarge)).toBe(optionsTooLarge);
    const state = { ...freezeProbation(options), owed: new Array(100_001) };
    expect(recordProof(state, 'worker', proof(), now)).toBe(state);
    expect(evaluateProbation(state, now)).toEqual({ action: 'pending', reason: expect.stringMatching(/operator recovery required/) });
  });

  describe.each(['shared wrapper', 'shared files', 'independent results'])('%s closure reads', reuse => {
    it.each(['blob', 'membership', 'incomplete', 'empty', 'invalid blob', 'unchanged'])(
      'preserves the proven-good evidence before the adopted read: %s', async variant => {
        const { freezeProbation, evaluateProbation } = await core();
        const shared = { complete: true, files: {} };
        const p = freezeProbation({ ...options, registered: [{ id: 'worker' }], readClosure(_, sha) {
          const before = sha === GOOD;
          const files = reuse === 'independent results' ? {} : shared.files;
          delete files['worker.mjs'];
          delete files['old.mjs'];
          if (!(before && variant === 'empty')) {
            const path = before && variant === 'membership' ? 'old.mjs' : 'worker.mjs';
            files[path] = before && variant === 'invalid blob' ? 'invalid'
              : variant === 'blob' ? sha : GOOD;
          }
          const complete = !(before && variant === 'incomplete');
          if (reuse === 'shared wrapper') {
            shared.complete = complete;
            return shared;
          }
          return { complete, files };
        } });
        expect(evaluateProbation(p, now)).toEqual(variant === 'unchanged'
          ? { action: 'pass' } : { action: 'pending', owed: ['worker'] });
        expect(p.owed).toEqual(variant === 'unchanged' ? [] : ['worker']);
      },
    );
  });

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

  it('a tick completed in the future of now is not proof', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const p = freezeProbation(options);
    expect(recordProof(p, 'worker', proof(101, 'worker'), ADOPTED_AT)).toBe(p);
    expect(evaluateProbation(p, ADOPTED_AT)).toMatchObject({ action: 'pending' });
  });

  it('a sparse roster (holes) refuses adoption instead of an empty owed set', async () => {
    const { freezeProbation } = await core();
    expect(() => freezeProbation({ ...options, registered: new Array(1) })).toThrow();
  });

  it('a sparse owed array in persisted state fails closed, never pass', async () => {
    const { freezeProbation, evaluateProbation } = await core();
    const p = freezeProbation(options);
    expect(evaluateProbation({ ...p, owed: new Array(1) }, now)).toMatchObject({ action: 'pending' });
  });

  describe('validateProbation: one validator, every rule fails closed', () => {
    const base = async () => {
      const { freezeProbation, recordProof } = await core();
      const p = recordProof(recordProof(freezeProbation(options), 'worker', proof(101, 'worker'), now),
        'review', proof(102, 'review'), now);
      return JSON.parse(JSON.stringify(p));
    };
    const rec = (p, id = 'worker') => p.records[id];
    const rules = [
      ['now-not-finite', p => p, NaN],
      ['state-fields', p => ({ ...p, extra: 1 })],
      ['version', p => ({ ...p, version: 1 })],
      ['adoption-id', p => ({ ...p, adoptionId: '' })],
      ['adopted-sha', p => ({ ...p, sha: 'x' })],
      ['proven-good', p => ({ ...p, provenGood: 'x' })],
      ['adopted-at', p => ({ ...p, adoptedAt: iso(now + 1000) })],
      ['owed-type', p => ({ ...p, owed: 'worker' })],
      ['owed-names', p => ({ ...p, owed: ['worker', 5] })],
      ['owed-duplicate', p => ({ ...p, owed: ['worker', 'worker'] })],
      ['owed-names', p => ({ ...p, owed: new Array(2) })],
      ['records-type', p => ({ ...p, records: [] })],
      ['record-not-owed', p => ({ ...p, records: { ...p.records, healthy: rec(p) } })],
      ['record-fields', p => { rec(p).extra = 1; return p; }],
      ['boot-fields', p => { rec(p).boot.extra = 1; return p; }],
      ['tick-fields', p => { delete rec(p).tick.head; return p; }],
      ['record-daemon', p => { rec(p).boot.daemonId = 'review'; return p; }],
      ['pid-type', p => { rec(p).boot.pid = '101'; return p; }],
      ['pid-mismatch', p => { rec(p).tick.pid = 999; return p; }],
      ['pid-shared', p => { rec(p, 'review').boot.pid = 101; rec(p, 'review').tick.pid = 101; return p; }],
      ['record-head', p => { rec(p).tick.head = OTHER; return p; }],
      ['time-type', p => { rec(p).boot.startedAt = 5; return p; }],
      ['start-before-adoption', p => { rec(p).boot.startedAt = iso(ADOPTED_AT - 1); return p; }],
      ['tick-not-after-boot', p => { rec(p).tick.lastTickDoneAt = rec(p).boot.startedAt; return p; }],
      ['time-in-future', p => { rec(p).tick.lastTickDoneAt = iso(now + 1); return p; }],
    ];
    it.each(rules)('%s', async (rule, mutate, at = now) => {
      const { validateProbation, evaluateProbation, recordProof } = await core();
      const good = await base();
      expect(validateProbation(good, now)).toBeNull();
      const bad = mutate(JSON.parse(JSON.stringify(good)));
      expect(validateProbation(bad, at)).toBe(rule);
      expect(evaluateProbation(bad, at).action).toBe('pending');
      expect(recordProof(bad, 'review', proof(102, 'review'), at)).toBe(bad);
    });
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

  it('a proof transition on state restored from JSON never aliases or freezes the caller input', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const restored = JSON.parse(JSON.stringify(recordProof(freezeProbation(options), 'worker', proof(101), now)));
    const next = recordProof(restored, 'review', proof(202, 'review'), now);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pass' });
    expect(next).not.toBe(restored);
    expect(next.owed).not.toBe(restored.owed);
    expect(next.records.worker.boot).not.toBe(restored.records.worker.boot);
    expect(next.records.worker.tick).not.toBe(restored.records.worker.tick);
    for (const part of [next, next.owed, next.records, next.records.worker, next.records.worker.boot,
      next.records.worker.tick, next.records.review.boot, next.records.review.tick]) expect(Object.isFrozen(part)).toBe(true);
    // The caller's restored input stays its own, mutable object: no freezing as a side effect.
    expect(Object.isFrozen(restored.owed)).toBe(false);
    expect(Object.isFrozen(restored.records.worker.boot)).toBe(false);
    restored.owed.pop();
    restored.owed.push('ghost');
    restored.records.worker.boot.pid = 999;
    expect(next.owed).toEqual(['worker', 'review']);
    expect(next.records.worker.boot.pid).toBe(101);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pass' });
    // A restored state with only one proof stays pending after its input is mutated.
    const half = JSON.parse(JSON.stringify(freezeProbation(options)));
    const one = recordProof(half, 'worker', proof(101), now);
    half.owed.pop();
    half.owed.pop();
    expect(evaluateProbation(one, now)).toEqual({ action: 'pending', owed: ['review'] });
  });

  it('a proof transition never aliases the caller evidence objects', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const evidence = proof(101);
    const next = recordProof(freezeProbation({ ...options, registered: [{ id: 'worker' }] }), 'worker', evidence, now);
    evidence.boot.pid = 5;
    evidence.tick.head = OTHER;
    expect(next.records.worker.boot.pid).toBe(101);
    expect(next.records.worker.tick.head).toBe(FAILED);
    expect(Object.isFrozen(evidence.boot)).toBe(false);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pass' });
  });

  it('a non-enumerable record the validator never saw cannot discharge an owed daemon', async () => {
    const { freezeProbation, recordProof, evaluateProbation, validateProbation } = await core();
    const s = JSON.parse(JSON.stringify(recordProof(freezeProbation(options), 'worker', proof(101), now)));
    Object.defineProperty(s.records, 'review', { value: 'junk', enumerable: false });
    expect(validateProbation(s, now)).toBeNull();
    expect(evaluateProbation(s, now)).toEqual({ action: 'pending', owed: ['review'] });
    const next = recordProof(s, 'review', proof(202, 'review'), now);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pass' });
    expect(Object.keys(next.records)).toEqual(['worker', 'review']);
  });

  it('an owed getter that changes between reads cannot narrow what is decided or returned', async () => {
    const { freezeProbation, recordProof, evaluateProbation } = await core();
    const shifty = () => {
      const s = JSON.parse(JSON.stringify(freezeProbation(options)));
      let reads = 0;
      Object.defineProperty(s, 'owed', { enumerable: true, get: () => (++reads === 1 ? ['worker', 'review'] : ['worker']) });
      return s;
    };
    expect(evaluateProbation(shifty(), now)).toEqual({ action: 'pending', owed: ['worker', 'review'] });
    const next = recordProof(shifty(), 'worker', proof(101), now);
    expect(next.owed).toEqual(['worker', 'review']);
    expect(evaluateProbation(next, now)).toEqual({ action: 'pending', owed: ['review'] });
    const empty = shifty();
    let reads = 0;
    Object.defineProperty(empty, 'owed', { enumerable: true, get: () => (++reads === 1 ? ['worker', 'review'] : []) });
    expect(evaluateProbation(empty, now)).toEqual({ action: 'pending', owed: ['worker', 'review'] });
    const throwing = shifty();
    Object.defineProperty(throwing, 'owed', { enumerable: true, get: () => { throw new Error('unreadable'); } });
    expect(evaluateProbation(throwing, now)).toMatchObject({ action: 'pending', reason: expect.stringMatching(/^invalid-probation: state-fields/) });
    expect(recordProof(throwing, 'worker', proof(101), now)).toBe(throwing);
  });

  it('a roster that changes between reads cannot drop a daemon from the owed set', async () => {
    const { freezeProbation } = await core();
    let reads = 0;
    const roster = new Proxy([{ id: 'worker' }, { id: 'review' }], {
      get(target, key, receiver) { if (key === 'length' && ++reads > 1) return 1; return Reflect.get(target, key, receiver); },
    });
    expect(freezeProbation({ ...options, registered: roster }).owed).toEqual(['worker', 'review']);
    const renamed = [{ id: 'worker' }];
    const p = freezeProbation({ ...options, registered: renamed, readClosure(daemon, sha) {
      try { daemon.id = 'ghost'; } catch { /* frozen copy */ }
      return closure(sha);
    } });
    expect(p.owed).toEqual(['worker']);
    expect(renamed[0].id).toBe('worker');
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
      .toEqual({ action: 'pending', reason: expect.stringMatching(/^invalid-probation: .*operator recovery required$/) });
  });
});
