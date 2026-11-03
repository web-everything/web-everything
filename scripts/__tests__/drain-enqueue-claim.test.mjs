import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeFs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import * as claimModule from '../lib/drain-enqueue-claim.mjs';
import { createEnqueueClaims, withSerialEnqueueClaim } from '../lib/drain-enqueue-claim.mjs';
import { createActionStore } from '../operations/action-store.mjs';
import { assertActionRecord, transitionRecord } from '../operations/action-record.mjs';

const roots = [];
const temp = () => { const root = mkdtempSync(join(process.env.TMPDIR, 'enqueue-claim-')); roots.push(root); return root; };
const candidate = { repo: 'web-everything/web-everything', num: 7, headSha: 'head-a' };
const key = c => `${c.repo}#${c.num}@${c.headSha}`;
const claim = (claims, c = candidate, kind = 'serial') => claims.claim({ ...c, kind });
const make = (root = temp(), options = {}) => createEnqueueClaims({ root, dir: root, now: () => 100, isPidAlive: () => true, ...options });
const latest = root => createActionStore({ root }).list().at(-1);
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('action-store enqueue claims', () => {
  it('two claimants for one key have exactly one winner in the shared ledger', () => {
    const root = temp(); const a = claim(make(root)); const b = claim(make(root));
    expect(a).toMatchObject({ won: true, token: expect.any(String) });
    expect(b).toMatchObject({ won: false, reason: 'held' });
    expect(latest(root)).toMatchObject({ state: 'intent', ownerToken: a.token,
      evidence: { pid: process.pid, host: hostname(), kind: 'serial', key: key(candidate) } });
  });

  it('concurrent processes claiming the same key have exactly one winner', async () => {
    const root = temp(); const worker = join(root, 'worker.mjs');
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/lib/drain-enqueue-claim.mjs')).href;
    writeFileSync(worker, `import { createEnqueueClaims, claimOrFault } from ${JSON.stringify(moduleUrl)};
      process.send('ready');
      process.once('message', () => {
        process.send(claimOrFault(createEnqueueClaims({ root: process.argv[2], dir: process.argv[2] }),
          JSON.parse(process.argv[3]), { emit() {} }));
        process.disconnect();
      });`);
    const children = Array.from({ length: 4 }, () => fork(worker, [root, JSON.stringify({ ...candidate, kind: 'serial' })], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    try {
      let readyCount = 0;
      const answersPromise = Promise.all(children.map(child => new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
        child.on('error', reject);
        child.once('exit', code => { if (code) reject(new Error(`child exited ${code}: ${stderr}`)); });
        child.on('message', message => {
          if (message === 'ready') { if (++readyCount === children.length) children.forEach(c => c.send('claim')); }
          else resolve(message);
        });
      })));
      const answers = await answersPromise;
      expect(answers.filter(r => r.won)).toHaveLength(1);
      expect(answers.filter(r => !r.won).every(r => r.reason === 'held' || r.reason === 'claim-fault')).toBe(true);
    } finally { children.forEach(child => child.kill()); }
  }, 15_000);

  it('a paused live owner stays held beyond lease, ttl and any legacy age cap', () => {
    const root = temp(); claim(make(root));
    expect(claim(make(root, { now: () => 100_000_000, ttlMs: 10, hardTtlMs: 20 })))
      .toMatchObject({ won: false, reason: 'held' });
    expect(latest(root).attempt).toBe(1);
  });

  it('reconciles an expired dead same-host owner before allocating a new attempt', () => {
    const root = temp(); const a = claim(make(root, { pid: 123456 }));
    expect(claim(make(root, { now: () => 600_101, isPidAlive: () => false }))).toMatchObject({ won: true });
    const rows = createActionStore({ root }).list();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'terminal', outcome: 'abandoned-absent' });
    expect(rows[1].ownerToken).not.toBe(a.token);
  });

  it('does not reclaim a dead owner before lease expiry', () => {
    const root = temp(); claim(make(root));
    expect(claim(make(root, { isPidAlive: () => false }))).toMatchObject({ won: false, reason: 'held' });
  });

  it.each(['remote-host', 'throwing-probe', 'unknown-probe'])('holds uncertain owner liveness: %s', scenario => {
    const root = temp(); claim(make(root, scenario === 'remote-host' ? { host: 'remote.invalid' } : {}));
    const isPidAlive = scenario === 'throwing-probe' ? () => { throw new Error('unknown'); } : () => undefined;
    expect(claim(make(root, { now: () => 100_000_000, isPidAlive }))).toMatchObject({ won: false, reason: 'held' });
  });

  it.each(['corrupt', 'unreadable', 'inconsistent'])('async holds %s records forever; serial warns and fails open', fault => {
    const root = temp(); const claims = make(root); claim(claims);
    const store = createActionStore({ root }); const record = latest(root); const path = store.pathFor(record.resource, record.attempt);
    if (fault === 'unreadable') { rmSync(path); mkdirSync(path); }
    else writeFileSync(path, fault === 'corrupt' ? '{broken' : JSON.stringify({ ...record, attempt: 99 }));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const broken = make(root, { now: () => 100_000_000 });
    expect(claimModule.claimOrFault(broken, { ...candidate, kind: 'fast' }, { emit: vi.fn() }))
      .toEqual({ won: false, reason: 'claim-fault' });
    const run = vi.fn(() => ({ enqueued: true }));
    expect(withSerialEnqueueClaim(broken, candidate, run, { emit: vi.fn() })).toEqual({ enqueued: true });
    expect(run).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('proceeding fail-open'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('held fail-closed'));
  });

  it('enqueued terminal protects a different kind for ttl from doneAt, then expires', () => {
    const root = temp(); let clock = 100;
    const claims = make(root, { now: () => clock, ttlMs: 1000 }); const first = claim(claims);
    clock = 10_000; claims.markDone({ ...candidate, token: first.token });
    expect(latest(root)).toMatchObject({ state: 'terminal', outcome: 'enqueued', updatedAt: clock, evidence: { doneAt: clock } });
    clock = 11_000; expect(claim(claims, candidate, 'fast').reason).toBe('done-by-other');
    clock++; expect(claim(claims, candidate, 'fast').won).toBe(true);
  });

  it('rechecks terminal admission after allocation contention and refuses a different kind after the winner enqueues', () => {
    const root = temp(); const winner = make(root);
    const first = claim(winner); winner.release({ ...candidate, token: first.token });
    const resource = latest(root).resource;
    const store = createActionStore({ root });
    let interleaved = false;
    const openSync = vi.fn((path, flags) => {
      expect(path).toBe(store.pathFor(resource, 2));
      expect(flags).toBe('wx');
      expect(interleaved).toBe(false);
      interleaved = true;
      // The loser has read the released terminal and chosen attempt 2. Publish
      // the winner's claim AND completion before the loser's exclusive create.
      const won = claim(winner);
      expect(won.won).toBe(true);
      winner.markDone({ ...candidate, token: won.token });
      return nativeFs.openSync(path, flags); // Real EEXIST forces allocation retry.
    });
    const loser = createActionStore({ root, now: () => 100, fs: { ...nativeFs, openSync } });
    const canClaim = vi.fn(previous => previous.outcome !== 'enqueued'
      || previous.evidence.kind === 'fast' || 100 - previous.evidence.doneAt > 1000);
    const result = loser.claim({ resource, kind: 'enqueue', owner: 'loser',
      evidence: { pid: process.pid, host: hostname(), kind: 'fast', key: key(candidate) }, canClaim });
    expect(interleaved).toBe(true);
    expect(openSync).toHaveBeenCalledTimes(1);
    expect(canClaim.mock.calls.map(([record]) => record.outcome)).toEqual(['released', 'enqueued']);
    expect(result).toMatchObject({ ok: false, held: true,
      record: { attempt: 2, state: 'terminal', outcome: 'enqueued', evidence: { kind: 'serial' } } });
    expect(store.attempts(resource)).toHaveLength(2);
  });

  it('doneAt equals the terminal transition time even when each clock read advances', () => {
    const root = temp(); let clock = 100;
    const claims = make(root, { now: () => ++clock }); const first = claim(claims);
    claims.markDone({ ...candidate, token: first.token });
    const record = latest(root);
    expect(record.outcome).toBe('enqueued');
    expect(record.evidence.doneAt).toBe(record.updatedAt);
    expect(record.evidence.doneAt).toBe(record.history.at(-1).at);
  });

  it('the shared reconciler holds expired enqueue intent without an owner-liveness port', () => {
    const root = temp(); claim(make(root));
    const store = createActionStore({ root, now: () => 100_000_000 });
    expect(store.reconcile(latest(root))).toMatchObject({ ok: false, held: true });
    expect(latest(root).state).toBe('intent');
  });

  it('unavailable coordination root fails closed for async and warns before serial fail-open', () => {
    const root = join(temp(), 'not-a-directory'); writeFileSync(root, 'blocked');
    const claims = make(root); const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(claimModule.claimOrFault(claims, candidate, { emit: vi.fn() })).toEqual({ won: false, reason: 'claim-fault' });
    expect(claimModule.claimOrFault(claims, candidate, { mode: 'serial', emit: vi.fn() })).toEqual({ won: true });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('proceeding fail-open'));
  });

  it('same kind reclaims enqueued immediately; release also retires through the ledger', () => {
    const root = temp(); const claims = make(root); const first = claim(claims);
    claims.markDone({ ...candidate, token: first.token }); const next = claim(claims);
    expect(next.won).toBe(true); claims.release({ ...candidate, token: next.token });
    expect(latest(root)).toMatchObject({ state: 'terminal', outcome: 'released' });
    expect(claim(claims, candidate, 'fast').won).toBe(true);
  });

  it('ignores wrong and superseded tokens for release and markDone', () => {
    const root = temp(); const claims = make(root); const first = claim(claims);
    for (const op of ['release', 'markDone']) claims[op]({ ...candidate, token: 'wrong' });
    expect(claim(claims).reason).toBe('held');
    claims.release({ ...candidate, token: first.token }); const next = claim(claims);
    for (const op of ['release', 'markDone']) claims[op]({ ...candidate, token: first.token });
    expect(latest(root)).toMatchObject({ state: 'intent', ownerToken: next.token });
  });

  it('new head SHA, repository and PR number are independent', () => {
    const claims = make();
    for (const c of [candidate, { ...candidate, headSha: 'head-b' }, { ...candidate, num: 8 }, { ...candidate, repo: 'frontier-ui/frontierui' }]) expect(claim(claims, c).won).toBe(true);
  });

  it('property: serial enqueue list is identical with claims on vs off', () => {
    let seed = 44;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let trial = 0; trial < 40; trial++) {
      const candidates = Array.from({ length: random() % 30 }, () => ({ ...candidate, num: 1 + random() % 5, headSha: `head-${random() % 3}`, outcome: random() % 3 }));
      const run = enabled => {
        const claims = make(); const enqueued = [];
        for (const c of candidates) {
          const enqueue = () => { if (c.outcome === 0) throw new Error('enqueue failed'); if (c.outcome === 1) enqueued.push(key(c)); return { enqueued: c.outcome === 1 }; };
          try { if (enabled) withSerialEnqueueClaim(claims, c, enqueue); else enqueue(); } catch { /* Expected enqueue failure. */ }
        }
        return enqueued;
      };
      expect(run(true)).toEqual(run(false));
    }
  });
});

describe('enqueue-only terminal outcome exclusions', () => {
  const otherAction = () => createActionStore({ root: temp(), now: () => 100 }).claim({
    resource: 'web-everything/web-everything#pr:7', kind: 'review', owner: 'reviewer',
  }).record;

  it.each(['released', 'enqueued'])('transitionRecord rejects %s for a non-enqueue action', outcome => {
    const record = otherAction();
    expect(assertActionRecord(record)).toBe(record);
    expect(transitionRecord(record, { token: record.ownerToken, rev: record.rev,
      from: 'intent', to: 'terminal', patch: { outcome } }, 200))
      .toEqual({ ok: false, reason: 'illegal-outcome' });
  });

  it.each(['released', 'enqueued'])('assertActionRecord rejects persisted %s for a non-enqueue action', outcome => {
    const record = otherAction();
    const terminal = { ...record, rev: 2, state: 'terminal', outcome, updatedAt: 200,
      history: [...record.history, { state: 'terminal', at: 200, owner: record.owner }] };
    // The same persisted shape with a general action outcome is valid: only the
    // enqueue-specific outcome should make this otherwise consistent record fail.
    expect(assertActionRecord({ ...terminal, outcome: 'not-started' })).toMatchObject({ state: 'terminal' });
    expect(() => assertActionRecord(terminal)).toThrow('Invalid action record');
  });
});

describe('shared enqueue claim wiring', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/merge-ai-prs.mjs'), 'utf8');
  const start = source.indexOf('  function enqueueWithSameHeadGuard(');
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  const helper = source.slice(start, end);

  it('keeps the only strategy enqueue inside the shared helper', () => {
    expect(helper.match(/mergeStrategy\.enqueue\(/g)).toHaveLength(1);
    expect(source.slice(0, start) + source.slice(end)).not.toMatch(/mergeStrategy\.enqueue\(/);
  });

  it('takes the identity claim after the same-head guard', () => {
    expect(helper).toMatch(/withSerialEnqueueClaim\(enqueueClaims,\s*\{ repo: c\.repo \?\? localSlug, num: c\.num, headSha: sha \}/);
    expect(helper.indexOf('mqSameHeadGuard(')).toBeLessThan(helper.indexOf('withSerialEnqueueClaim('));
    expect(helper.indexOf('withSerialEnqueueClaim(')).toBeLessThan(helper.indexOf('mergeStrategy.enqueue('));
  });

  it('creates the claim store beside the helper without a JSON or dry-run gate', () => {
    const initStart = source.indexOf('  let enqueueClaims;');
    const init = source.slice(initStart, start);
    expect(initStart).toBeGreaterThan(-1);
    expect(init).toContain('try { enqueueClaims = createEnqueueClaims(); }');
    expect(init).not.toMatch(/AS_JSON|DRY_RUN/);
    expect(source.match(/createEnqueueClaims\(\)/g)).toHaveLength(1);
  });

  it('both enqueue sites call the shared helper directly', () => {
    expect(source).toMatch(/enqueue:\s*\(c, sha, entry\) => enqueueWithSameHeadGuard\(c, sha,/);
    expect(source).toMatch(/if \(mergeStrategy\.enqueues\(c\.repo\)\) return enqueueWithSameHeadGuard\(c, traceHeadSha,/);
  });


});

describe('serial enqueue claim diagnostics', () => {
  const warning = op => `drain-enqueue-claim: ${op} failed for web-everything/web-everything#7@head-a: broken storage — proceeding fail-open\n`;

  it('warns on initialization failure at the serial call site and leaves claims disabled', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/merge-ai-prs.mjs'), 'utf8');
    const start = source.indexOf('try { enqueueClaims = createEnqueueClaims(); }');
    const end = source.indexOf('\n  function enqueueWithSameHeadGuard(', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const stderr = { write: vi.fn() };
    const initialize = new Function('createEnqueueClaims', 'process', `let enqueueClaims; ${source.slice(start, end)}; return enqueueClaims;`);
    expect(initialize(() => { throw new Error('broken\nstorage'); }, { stderr })).toBeUndefined();
    expect(stderr.write.mock.calls).toEqual([['drain-enqueue-claim: initialization failed: broken storage — proceeding fail-open\n']]);
  });

  it('still enqueues and warns once with a daemon event when claim throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const emit = vi.fn(); const run = vi.fn(() => ({ enqueued: true }));
    const claims = { claim() { throw new Error('broken\nstorage'); } };
    expect(withSerialEnqueueClaim(claims, candidate, run, { emit })).toEqual({ enqueued: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls).toEqual([[warning('claim')]]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ repo: candidate.repo, pr: 7,
      detail: { op: 'claim', headSha: 'head-a', message: 'broken storage' } }));
  });

  it.each([true, false])('preserves the enqueue result and warns on bookkeeping errors (enqueued: %s)', enqueued => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const op = enqueued ? 'markDone' : 'release';
    const claims = { claim: () => ({ won: true, token: 'owned' }),
      [op]: vi.fn(() => { throw new Error('broken storage'); }) };
    const result = { enqueued };
    expect(withSerialEnqueueClaim(claims, candidate, () => result, { emit() { throw new Error('event failed'); } })).toBe(result);
    expect(claims[op]).toHaveBeenCalledWith({ ...candidate, token: 'owned' });
    expect(stderr.mock.calls).toEqual([[warning(op)]]);
  });

  it('preserves the original enqueue error when release also throws and warns', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const error = new Error('enqueue failed');
    const claims = { claim: () => ({ won: true, token: 'owned' }), release() { throw new Error('broken storage'); } };
    expect(() => withSerialEnqueueClaim(claims, candidate, () => { throw error; }, { emit: () => Promise.reject(new Error('event failed')) })).toThrow(error);
    expect(stderr.mock.calls).toEqual([[warning('release')]]);
  });

  it.each(['claim', 'release', 'markDone'])('warns when %s returns lock-busy without changing the serial outcome', op => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const claims = { claim: () => ({ won: true, token: 'owned' }), [op]: () => ({ won: false, reason: 'lock-busy' }) };
    const result = { enqueued: op === 'markDone' }; const run = vi.fn(() => result);
    expect(withSerialEnqueueClaim(claims, candidate, run, { emit: vi.fn() })).toEqual(op === 'claim' ? { skipped: 'claimed-elsewhere' } : result);
    expect(run).toHaveBeenCalledTimes(op === 'claim' ? 0 : 1);
    expect(stderr.mock.calls).toEqual([[warning(op).replace('broken storage', 'lock-busy')]]);
  });
});

describe('explicit claim fault policy', () => {
  const faults = [
    ['undefined store', () => undefined],
    ['throwing store', () => ({ claim() { throw new Error('broken storage'); } })],
    ['missing claim method', () => ({})],
    ['undefined result', () => ({ claim: () => undefined })],
    ['incomplete result', () => ({ claim: () => ({}) })],
    ['reported fault', () => ({ claim: () => ({ won: false, reason: 'claim-fault' }) })],
    ['lock fault', () => ({ claim: () => ({ won: false, reason: 'lock-busy' }) })],
  ];
  it.each(faults)('async fails closed on %s and warns visibly', (_name, store) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(claimModule.claimOrFault(store(), { ...candidate, kind: 'fast' }, { mode: 'async', emit: vi.fn() }))
      .toEqual({ won: false, reason: 'claim-fault' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-closed'));
  });
  it.each(faults)('serial fails open on %s and warns visibly', (name, store) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = claimModule.claimOrFault(store(), candidate, { mode: 'serial', emit: vi.fn() });
    expect(result).toEqual(name === 'lock fault' ? { won: false, reason: 'lock-busy' } : { won: true });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });
  it.each(['serial', 'async'])('%s preserves ownership wins and explicit refusals', mode => {
    for (const result of [{ won: true, token: 'owned' }, ...['held', 'done-by-other', 'unreadable-record'].map(reason => ({ won: false, reason }))]) {
      const claims = { claim: vi.fn(() => result) };
      expect(claimModule.claimOrFault(claims, candidate, { mode })).toBe(result);
      expect(claims.claim).toHaveBeenCalledWith(candidate);
    }
  });
  it('serial wrapper enqueues and warns when the store is undefined', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const run = vi.fn(() => ({ enqueued: true }));
    expect(withSerialEnqueueClaim(undefined, candidate, run, { emit: vi.fn() })).toEqual({ enqueued: true });
    expect(run).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });
});
