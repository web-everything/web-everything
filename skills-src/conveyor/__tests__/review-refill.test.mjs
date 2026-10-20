/**
 * @file skills-src/conveyor/__tests__/review-refill.test.mjs
 * @description Card x3mfxzv (v2) - shadow refill from the last pass's queue: setting cascade, debounce, queue build,
 *   revalidation, single-flight with the pass, fail-closed paths, the idle-minutes comparison, and a proof that the
 *   module can write nothing and fetch nothing. Every effect is injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewRefill, createPassLock, createGhPrReader, resolveRefillMode, QUEUE_MAX_AGE_MS } from '../review-refill.mjs';

const tmpSettings = (obj) => { const p = join(mkdtempSync(join(tmpdir(), 'refill-')), 's.json'); writeFileSync(p, JSON.stringify(obj)); return p; };
const isolatedEnv = (extra = {}) => ({ WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), 'no-such-platform-prefs.json'), ...extra });
const HEAD = (n) => `${String(n).padStart(40, 'a')}`;

/** A pass over repo o/r that owed PRs 1..4, dispatched #1, left 2,3,4 queued. */
function runPass(h, { dispatched = [{ repo: 'o/r', prNumber: 1 }], owed = [1, 2, 3, 4], repo = 'o/r', labels = {} } = {}) {
  const tap = h.r.tapPlan(h.downstream);
  tap({ repo, plan: { dispatch: owed.map((n) => ({ kind: 'review', prNumber: n })), refusals: [] },
    rawPrs: owed.map((n) => ({ number: n, headRefOid: HEAD(n), labels: labels[n] ?? [] })) });
  h.r.notePass({ dispatched, notStarted: [] });
}

function rig({ mode = 'shadow', budgetLeft = 3, view = (n) => ({ state: 'OPEN', headRefOid: HEAD(n) }) } = {}) {
  let t = 1_000_000;
  const logs = [];
  const timers = [];
  let live = 8;
  let liveThrows = false;
  let budgetNull = false;
  const reads = [];
  const downstream = vi.fn();
  const r = createReviewRefill({
    budget: () => { if (liveThrows) throw new Error('ps failed'); return budgetNull ? null : { live, left: budgetLeft, max: 8 }; },
    order: (reviews) => [...reviews].sort((a, b) => a.prNumber - b.prNumber),
    readPr: ({ repo, pr }) => { reads.push(`${repo}#${pr}`); return view(pr); },
    log: (l) => logs.push(l),
    settings: () => ({ mode, source: 'test' }),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
    clearTimer: () => {}, setPoll: () => ({ unref() {} }), clearPoll: () => {},
  });
  return {
    r, logs, timers, reads, downstream,
    setLive: (n) => { live = n; }, advance: (ms) => { t += ms; }, setThrow: (b) => { liveThrows = b; }, setBudgetNull: (b) => { budgetNull = b; },
    fire: () => { const h = timers.shift(); h.fn(); },
  };
}
function freeSlot(h, to = 7) { h.r.poll(); h.setLive(to); h.r.poll(); }

describe('resolveRefillMode', () => {
  it('standard is off with no settings', () => {
    expect(resolveRefillMode({ env: isolatedEnv(), toolPath: '/nonexistent.json' })).toEqual({ mode: 'off', source: 'standard' });
  });
  it('the settings file sets shadow and names its source', () => {
    const r = resolveRefillMode({ env: isolatedEnv(), toolPath: tmpSettings({ refillOnCompletion: 'shadow' }) });
    expect(r.mode).toBe('shadow');
    expect(r.source).not.toBe('standard');
  });
  it('env beats the file; an invalid value never overrides', () => {
    const p = tmpSettings({ refillOnCompletion: 'shadow' });
    expect(resolveRefillMode({ env: isolatedEnv({ WE_REVIEW_REFILL_ON_COMPLETION: 'off' }), toolPath: p }).mode).toBe('off');
    expect(resolveRefillMode({ env: isolatedEnv({ WE_REVIEW_REFILL_ON_COMPLETION: 'bogus' }), toolPath: p }).mode).toBe('shadow');
    expect(resolveRefillMode({ env: isolatedEnv(), toolPath: tmpSettings({ refillOnCompletion: 'bogus' }) }).mode).toBe('off');
  });
  it('a throwing cascade fails closed to off', () => {
    expect(resolveRefillMode({ cascade: () => { throw new Error('x'); } }).mode).toBe('off');
  });
});

describe('silent cascade and start-up log', () => {
  it('resolving the mode never writes to console.error, even when the cascade log is forced on', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = resolveRefillMode({ env: isolatedEnv({ WE_POLICY_CASCADE_LOG: '1' }), toolPath: tmpSettings({ refillOnCompletion: 'shadow' }) });
      expect(r.mode).toBe('shadow');
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('passes the cascade a silent logger', () => {
    let seen;
    resolveRefillMode({ env: isolatedEnv(), toolPath: '/nonexistent.json', cascade: (_p, _t, o) => { seen = o; return { value: { refillOnCompletion: 'off' }, sources: {} }; } });
    expect(typeof seen.log).toBe('function');
    expect(seen.log('x')).toBeUndefined();
  });
  it('start() logs the resolved setting and source once through the injected log', () => {
    const h = rig();
    h.r.start(); h.r.start();
    expect(h.logs.filter((l) => l.startsWith('refill: review.refillOnCompletion=shadow (test)'))).toHaveLength(1);
  });
});

describe('aborted and skipped passes', () => {
  it('a pass that aborts leaves no plans behind, so a later skipped pass builds no queue', async () => {
    const h = rig();
    await expect(h.r.guardPass(async () => {
      h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [{ kind: 'review', prNumber: 2 }] }, rawPrs: [{ number: 2, headRefOid: HEAD(2) }] });
      throw new Error('abort');
    })).rejects.toThrow('abort');
    h.advance(QUEUE_MAX_AGE_MS + 1000);
    h.r.notePass({ skipped: true });
    expect(h.r._state().queue).toBeNull();
    freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
  });
  it('plans captured before a pass starts are dropped when the next pass begins', async () => {
    const h = rig();
    h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [{ kind: 'review', prNumber: 2 }] }, rawPrs: [{ number: 2, headRefOid: HEAD(2) }] });
    await h.r.guardPass(async () => { h.r.notePass({ dispatched: [] }); });
    expect(h.r._state().queue).toBeNull();
  });
  it('a skipped pass keeps the older queue and does not refresh its age', () => {
    const h = rig();
    runPass(h);
    const before = h.r._state().queue.at;
    h.advance(10 * 60_000);
    h.r.notePass({ skipped: true });
    expect(h.r._state().queue.at).toBe(before);
  });
  it('the queue ages from plan capture, not from the end of the pass', () => {
    const h = rig();
    h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [{ kind: 'review', prNumber: 2 }, { kind: 'review', prNumber: 3 }] },
      rawPrs: [{ number: 2, headRefOid: HEAD(2) }, { number: 3, headRefOid: HEAD(3) }] });
    h.advance(20 * 60_000);          // an 20-minute pass
    h.r.notePass({ dispatched: [] });
    expect(h.r._state().queue.at).toBe(1_000_000);
    h.advance(6 * 60_000);           // 26 min since capture, only 6 since the pass ended
    freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
  });
});

describe('queue from the last pass', () => {
  it('taps the plan, calls the existing consumer unchanged, and queues undispatched reviews in the pass order', () => {
    const h = rig();
    runPass(h);
    expect(h.downstream).toHaveBeenCalledTimes(1);
    expect(h.r._state().queue.rows.map((x) => x.prNumber)).toEqual([2, 3, 4]);
    expect(h.r._state().queue.rows[0].head).toBe(HEAD(2));
  });
  it('tapPlan works with no downstream consumer', () => {
    const h = rig();
    expect(() => h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [] }, rawPrs: [] })).not.toThrow();
  });
  it('a pass with no plan seen leaves no queue (fail closed)', () => {
    const h = rig();
    h.r.notePass({ dispatched: [] });
    expect(h.r._state().queue).toBeNull();
  });
  it('non-review rows are not queued', () => {
    const h = rig();
    h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [{ kind: 'fix', prNumber: 5 }, { kind: 'review', prNumber: 6 }] }, rawPrs: [{ number: 6, headRefOid: HEAD(6) }] });
    h.r.notePass({ dispatched: [] });
    expect(h.r._state().queue.rows.map((x) => x.prNumber)).toEqual([6]);
  });
});

describe('shadow refill', () => {
  it('logs would-dispatch for the next queued PR after the debounce, with one read per candidate', () => {
    const h = rig();
    runPass(h);
    freeSlot(h);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(15_000);
    h.fire();
    expect(h.logs.some((l) => /refill-shadow: would dispatch #2 now \(o\/r; slot freed at .*live 8->7/.test(l))).toBe(true);
    expect(h.reads).toEqual(['o/r#2']);
  });
  it('several freed seats take several queued PRs in order, capped by cap room', () => {
    const h = rig({ budgetLeft: 2 });
    runPass(h);
    h.r.poll(); h.setLive(4); h.r.poll(); h.fire();
    expect(h.logs.filter((l) => l.includes('would dispatch')).map((l) => l.match(/#(\d+)/)[1])).toEqual(['2', '3']);
  });
  it('several quick exits collapse into one debounced flush', () => {
    const h = rig();
    runPass(h);
    h.r.poll(); h.setLive(7); h.r.poll(); h.setLive(6); h.r.poll();
    expect(h.timers).toHaveLength(1);
  });
  it('off mode does nothing at all', () => {
    const h = rig({ mode: 'off' });
    runPass(h);
    freeSlot(h);
    expect(h.timers).toHaveLength(0);
    expect(h.r._state().queue).toBeNull();
  });
  it('on mode runs as shadow and says so', () => {
    const h = rig({ mode: 'on' });
    runPass(h); freeSlot(h); h.fire();
    expect(h.logs.some((l) => /on is not built yet, running as shadow/.test(l))).toBe(true);
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(true);
  });
  it('logs the setting and its source once', () => {
    const h = rig();
    h.r.poll(); h.r.poll(); h.r.poll();
    expect(h.logs.filter((l) => l.startsWith('refill: review.refillOnCompletion=shadow (test)'))).toHaveLength(1);
  });
});

describe('revalidation and fail closed', () => {
  it('skips a PR that is no longer open and takes the next', () => {
    const h = rig({ view: (n) => (n === 2 ? { state: 'MERGED', headRefOid: HEAD(2) } : { state: 'OPEN', headRefOid: HEAD(n) }) });
    runPass(h); freeSlot(h); h.fire();
    expect(h.logs.filter((l) => l.includes('would dispatch')).map((l) => l.match(/#(\d+)/)[1])).toEqual(['3']);
  });
  it('skips a PR whose head moved since the plan', () => {
    const h = rig({ view: (n) => ({ state: 'OPEN', headRefOid: n === 2 ? HEAD(99) : HEAD(n) }) });
    runPass(h); freeSlot(h); h.fire();
    expect(h.logs.some((l) => l.includes('would dispatch #2'))).toBe(false);
    expect(h.logs.some((l) => l.includes('would dispatch #3'))).toBe(true);
  });
  it('skips a PR whose read throws; takes none when every read fails', () => {
    const h = rig({ view: () => { throw new Error('gh down'); } });
    runPass(h); freeSlot(h); h.fire();
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(false);
    expect(h.r.lock.holder()).toBeNull();
  });
  it('a plan row without a head is never taken', () => {
    const h = rig();
    h.r.tapPlan(null)({ repo: 'o/r', plan: { dispatch: [{ kind: 'review', prNumber: 8 }] }, rawPrs: [{ number: 8 }] });
    h.r.notePass({ dispatched: [] });
    freeSlot(h); h.fire();
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(false);
  });
  it('bounds the reads per flush', () => {
    const h = rig({ view: () => ({ state: 'CLOSED', headRefOid: 'x' }) });
    runPass(h, { owed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], dispatched: [] });
    freeSlot(h); h.fire();
    expect(h.reads.length).toBeLessThanOrEqual(6);
  });
  it('an unreadable process list is not read as a completion', () => {
    const h = rig();
    runPass(h);
    h.r.poll(); h.setThrow(true); h.r.poll(); h.setThrow(false); h.r.poll();
    expect(h.timers).toHaveLength(0);
  });
  it('an unknown or uncapped budget reads nothing', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.setBudgetNull(true); h.fire();
    expect(h.reads).toEqual([]);
  });
  it('no free cap room reads nothing', () => {
    const h = rig({ budgetLeft: 0 });
    runPass(h); freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
  });
  it('a queue older than its max age is not trusted', () => {
    const h = rig();
    runPass(h);
    h.advance(QUEUE_MAX_AGE_MS + 1000);
    freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
  });
  it('no queue yet means nothing happens', () => {
    const h = rig();
    freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
  });
  it('does not flush again inside the minimum gap; it retries later', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.fire();
    h.setLive(6); h.r.poll(); h.fire();
    expect(h.reads).toEqual(['o/r#2']);
    expect(h.timers).toHaveLength(1);
    h.advance(31_000); h.fire();
    expect(h.reads).toEqual(['o/r#2', 'o/r#3']);
  });
});

describe('single-flight with the pass', () => {
  it('the refill skips while a pass holds the lock and reads nothing', async () => {
    const h = rig();
    runPass(h);
    let release;
    const pass = h.r.guardPass(() => new Promise((res) => { release = res; }));
    await Promise.resolve();
    expect(h.r.lock.holder()).toBe('pass');
    freeSlot(h); h.fire();
    expect(h.reads).toEqual([]);
    release(); await pass;
    expect(h.r.lock.holder()).toBeNull();
  });
  it('the pass waits for an in-flight refill and then runs; they never overlap', async () => {
    const order = [];
    const lock = createPassLock();
    const relRefill = lock.tryAcquire('refill');
    const pass = lock.acquire('pass').then((rel) => { order.push('pass-start'); rel(); order.push('pass-end'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    order.push('refill-end'); relRefill();
    await pass;
    expect(order).toEqual(['refill-end', 'pass-start', 'pass-end']);
  });
  it('tryAcquire refuses a second holder; release is idempotent', () => {
    const lock = createPassLock();
    const a = lock.tryAcquire('a');
    expect(lock.tryAcquire('b')).toBeNull();
    a(); a();
    expect(lock.tryAcquire('b')).toBeTypeOf('function');
  });
  it('a pass that throws still releases the lock', async () => {
    const h = rig();
    await expect(h.r.guardPass(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(h.r.lock.holder()).toBeNull();
  });
});

describe('idle-minutes comparison', () => {
  it('logs minutes saved when the next pass dispatches a would-dispatched PR', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.fire();
    h.advance(10 * 60_000);
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 2 }] });
    expect(h.logs.some((l) => /pass dispatched #2 .* 10\.0 min after .*upper bound.*total 10\.0/.test(l))).toBe(true);
  });
  it('uses the real dispatch time when the pass records one', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.fire();
    h.advance(10 * 60_000);
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 2, at: 1_000_000 + 4 * 60_000 }] });
    expect(h.logs.some((l) => /4\.0 min after the refill would have;/.test(l))).toBe(true);
  });
  it('ignores PRs it never planned', () => {
    const h = rig();
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 99 }] });
    expect(h.logs.some((l) => l.includes('pass dispatched'))).toBe(false);
  });
  it('drops a would-dispatch the pass never confirmed', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.fire();
    h.advance(31 * 60_000);
    h.setLive(6); h.r.poll(); h.fire();
    expect(h.logs.some((l) => /o\/r#2 was never dispatched by a pass within 30 min/.test(l))).toBe(true);
  });
});

describe('zero writes, zero fetches', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../review-refill.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('the module imports no writer, no git, no reconcile, no lane-pool', () => {
    const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../../scripts/lib/policy-cascade.mjs', 'node:child_process', 'node:fs', 'node:path', 'node:url']);
    expect(code.match(/import \{([^}]*)\} from 'node:fs'/)[1].trim()).toBe('readFileSync');
    expect(code.match(/import \{([^}]*)\} from 'node:child_process'/)[1].trim()).toBe('execFileSync');
  });
  it('no write, git or lane call appears in the code', () => {
    for (const bad of [/writeFile/, /appendFile/, /rename/, /mkdir/, /unlink/, /\bgit\b/, /fetch/, /lane-pool/, /reconcile/i, /spawn/, /\bexecSync\b/]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
  });
  it('the only outside command is a read-only `gh pr view`', () => {
    const exec = vi.fn(() => JSON.stringify({ state: 'OPEN', headRefOid: 'abc' }));
    expect(createGhPrReader({ exec })({ repo: 'o/r', pr: 5 })).toEqual({ state: 'OPEN', headRefOid: 'abc' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe('gh');
    expect(exec.mock.calls[0][1]).toEqual(['pr', 'view', '5', '--repo', 'o/r', '--json', 'state,headRefOid']);
  });
  it('a full cycle makes exactly one read per taken candidate and nothing else', () => {
    const h = rig();
    runPass(h); freeSlot(h); h.fire();
    expect(h.reads).toEqual(['o/r#2']);
  });
});
