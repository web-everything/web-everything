// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainPendingPrevention } from '../../operations/land-prevention-card.mjs';
import { reconcileOwedPrevention } from '../prevention-filing-owed.mjs';
import { isNoLaneInTime, landPreventionCard } from '../../operations/land-prevention-card.mjs';
import { reconcileCardBatches } from '../../operations/card-batch-reconcile.mjs';
import { cursorSeed, drainCursorPath, readDrainCursor, resetDrainCursorMemory, rotateAfter } from '../prevention-drain-cursor.mjs';
import { resolvePreventionBatchSettings } from '../card-batch-settings.mjs';
import { loadCardBatchPolicy } from '../card-batch-policy.mjs';

const roots = [];
afterEach(() => { resetDrainCursorMemory(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(names = ['a', 'b', 'c']) {
  const root = mkdtempSync(join(tmpdir(), 'drain-cap-')); roots.push(root);
  const stateDir = join(root, 'state'); const lane = join(root, 'lane'); const pendingDir = join(stateDir, 'pending-prevention');
  mkdirSync(pendingDir, { recursive: true }); mkdirSync(lane);
  for (const name of names) {
    writeFileSync(join(pendingDir, `${name}.json`), JSON.stringify({ cardId: name, rel: `backlog/${name}-card.md`, content: `# ${name}`, idemKey: `k-${name}`, source: {} }));
  }
  return { root, stateDir, lane, pendingDir, cursorPath: drainCursorPath(stateDir), left: () => readdirSync(pendingDir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)) };
}
const exec = () => '';

describe('capped, round-robin pending drain', () => {
  it('starts at most maxCards cards per call and resumes after the last one handled', async () => {
    const f = fixture(); const seen = [];
    const batch = async input => { seen.push(input.cardPath); return { batched: true, batchRef: 'r' }; };
    const options = { pendingDir: f.pendingDir, exec, batch, write: () => {}, maxCards: 1, cursorPath: f.cursorPath };
    await drainPendingPrevention({ lane: f.lane }, options);
    expect(seen).toEqual(['backlog/a-card.md']);
    expect(f.left()).toEqual(['b', 'c']);
    await drainPendingPrevention({ lane: f.lane }, options);
    await drainPendingPrevention({ lane: f.lane }, options);
    expect(seen).toEqual(['backlog/a-card.md', 'backlog/b-card.md', 'backlog/c-card.md']);
    expect(f.left()).toEqual([]);
  });

  it('a permanently failing card goes behind the others: no head-of-line blocking, and it is retried in turn', async () => {
    const f = fixture(); const seen = [];
    const batch = async input => {
      seen.push(input.cardPath.split('/')[1][0]);
      if (input.cardPath.includes('/a-')) throw new Error('refused');
      return { batched: true, batchRef: 'r' };
    };
    const options = { pendingDir: f.pendingDir, exec, batch, write: () => {}, maxCards: 1, cursorPath: f.cursorPath };
    for (let tick = 0; tick < 4; tick++) await drainPendingPrevention({ lane: f.lane }, options);
    expect(seen).toEqual(['a', 'b', 'c', 'a']);
    expect(f.left()).toEqual(['a']); // b and c landed although a never does; a is still durable
  });

  it('never starts a card once the deadline has passed', async () => {
    const f = fixture(); let t = 0; const seen = [];
    const batch = async input => { seen.push(input.cardPath); t += 100; return { batched: true }; };
    await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, batch, write: () => {}, maxCards: 10,
      deadlineAt: 150, now: () => t, cursorPath: f.cursorPath });
    expect(seen).toHaveLength(2); // started at t=0 and t=100; at t=200 the deadline stops the third
    expect(f.left()).toEqual(['c']);
    await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, batch, write: () => {}, deadlineAt: 0, now: () => 1 });
    expect(seen).toHaveLength(2);
  });

  it('without a cap it drains the whole spool in order, as before', async () => {
    const f = fixture(); const seen = [];
    await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, write: () => {},
      batch: async input => { seen.push(input.cardPath); return { batched: true }; } });
    expect(seen).toHaveLength(3);
  });

  it('rotateAfter resumes behind the last handled name', () => {
    expect(rotateAfter(['a.json', 'b.json', 'c.json'], 'b.json')).toEqual(['c.json', 'a.json', 'b.json']);
    expect(rotateAfter(['a.json', 'b.json'], undefined)).toEqual(['a.json', 'b.json']);
  });
});

describe('lane acquire under the cap', () => {
  const input = { drainPending: true, session: 's' };
  const options = (f, exec, acquireWaitMs) => ({ pendingDir: f.pendingDir, exec, write: () => {}, loadFilingSettings: () => ({ filingEnabled: true }),
    loadPreventionBatchSettings: () => ({ filingEnabled: true }), drainLimit: { acquireWaitMs, maxCards: 1 } });
  it('waits no longer than the remaining budget and bounds the child with it', async () => {
    const f = fixture(); const exec = vi.fn(() => { throw Object.assign(new Error('no free lane after 5000ms'), {}); });
    const result = await landPreventionCard(input, options(f, exec, 5000));
    const [, args, execOptions] = exec.mock.calls[0];
    expect(args).toContain('--wait-ms=5000');
    expect(execOptions.timeout).toBeLessThan(20_000); // wait + slack, never the 3-minute default
    expect(result).toMatchObject({ ok: true, deferred: true, step: 'acquire-deferred' });
  });
  it('a killed (timed out) acquire leaves every card in the spool and is not an error', async () => {
    const f = fixture(); const exec = vi.fn(() => { throw Object.assign(new Error('spawnSync node ETIMEDOUT'), { killed: true, code: 'ETIMEDOUT' }); });
    const result = await landPreventionCard(input, options(f, exec, 1000));
    expect(result.ok).toBe(true);
    expect(f.left()).toEqual(['a', 'b', 'c']);
  });
  it('recognises the pool\'s diagnostic on stderr of a REAL child failure (message holds only the command line)', async () => {
    const f = fixture();
    const exec = () => { throw Object.assign(new Error('Command failed: node lane-pool.mjs acquire --purpose=prevention-card'), { status: 1, stderr: Buffer.from('lane-pool: no free lane in pool after 5000ms\n') }); };
    expect(await landPreventionCard(input, options(f, exec, 5000))).toMatchObject({ ok: true, deferred: true });
  });
  it('an owed filing\'s acquire is bounded too, and a deferred one stays owed (skipped, so never marked done)', async () => {
    const f = fixture([]); const exec = vi.fn(() => { throw Object.assign(new Error('x'), { killed: true }); });
    const result = await landPreventionCard({ title: 't', session: 's' }, { ...options(f, exec, undefined), owedClaimed: true, acquireWait: () => 7000 });
    expect(exec.mock.calls[0][1]).toContain('--wait-ms=7000');
    expect(result).toMatchObject({ ok: true, skipped: true, deferred: true });
  });
  it('classifies lane-pool\'s actual diagnostics: contention and all-busy defer, a provisioning failure stays an error', async () => {
    const contention = 'no lane within 5000ms in pool "web-everything" — a different acquire\'s shared acquirability scan was still running (lock contention)';
    const busy = 'no free lane in pool "web-everything" (12 all held/dirty) — release one or `provision` more';
    const provision = 'no free lane in pool "web-everything" — every candidate this call tried was claimed but failed to provision (see the warnings above)';
    expect([contention, busy, provision].map(isNoLaneInTime)).toEqual([true, true, false]);
    for (const [message, deferred] of [[contention, true], [busy, true], [provision, false]]) {
      const f = fixture();
      const exec = () => { throw Object.assign(new Error('Command failed: node lane-pool.mjs acquire'), { status: 1, stderr: Buffer.from(`${message}\n`) }); };
      const result = await landPreventionCard(input, options(f, exec, 5000));
      expect(result.deferred === true).toBe(deferred);
      expect(result.ok).toBe(deferred);
    }
  });
  it('any other acquire failure is still an error', async () => {
    const f = fixture(); const exec = () => { throw new Error('lane-pool crashed'); };
    expect(await landPreventionCard(input, options(f, exec, 1000))).toMatchObject({ ok: false, step: 'acquire' });
  });
  it('the probe passes min(remaining budget, 30s) as the acquire wait', async () => {
    const f = fixture(['a']); writeFileSync(join(f.stateDir, 'org-repo-prevention.json'), JSON.stringify({ seq: 9 }));
    const drain = vi.fn(async () => ({ ok: true }));
    const common = { stateDir: f.stateDir, seal: async () => [], log: () => {}, drain, loadFilingSettings: () => ({ filingEnabled: true }) };
    await reconcileCardBatches({ ...common, clock: () => 0, drainBudgetMs: 60_000 });
    expect(drain.mock.calls[0][1].drainLimit.acquireWaitMs).toBe(30_000);
    await reconcileCardBatches({ ...common, clock: () => 0, drainBudgetMs: 12_000 });
    expect(drain.mock.calls[1][1].drainLimit.acquireWaitMs).toBe(12_000);
  });
});

describe('fairness without a writable cursor, and the shared allowance', () => {
  it('a cursor that cannot be persisted still rotates the start (time-seeded), so a refused head cannot starve the rest', async () => {
    const f = fixture(); const seen = [];
    const batch = async input => { const id = input.cardPath.split('/')[1][0]; seen.push(id); if (id === 'a') throw new Error('refused'); return { batched: true }; };
    const cursorPath = join(f.root, 'no-such-dir', 'cursor.state');
    for (const now of [0, 60_000, 120_000]) {
      await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, batch, write: () => {}, maxCards: 1, cursorPath, now: () => now });
    }
    expect(seen).toContain('b');
    expect(f.left()).not.toContain('b');
  });
  it('a cursor WRITE that fails (directory writable) still advances past the refused card, in memory', async () => {
    const f = fixture(); const seen = [];
    const batch = async input => { const id = input.cardPath.split('/')[1][0]; seen.push(id); if (id === 'a') throw new Error('refused'); return { batched: true }; };
    mkdirSync(join(f.root, 'cursor.state')); // renaming a file over a directory fails: every write errors, the directory stays writable
    const cursorPath = join(f.root, 'cursor.state');
    resetDrainCursorMemory();
    for (let tick = 0; tick < 3; tick++) await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, batch, write: () => {}, maxCards: 1, cursorPath });
    expect(seen).toContain('b');
    expect(f.left()).not.toContain('b');
    expect(readdirSync(f.root).filter(name => name.endsWith('.tmp'))).toEqual([]); // failed temporaries are cleaned up
  });
  it('the unpersistable-cursor start does not align with the tick period', () => {
    resetDrainCursorMemory();
    const starts = new Set();
    for (let tick = 0; tick < 12; tick++) starts.add(cursorSeed(join(tmpdir(), 'no-such-dir-x', 'cursor.state')) % 5);
    expect(starts.size).toBeGreaterThan(1);
  });
  it('a card admission is not started when the deadline passed during the ls-tree', async () => {
    const f = fixture(['a']); let t = 0; const batch = vi.fn(async () => ({ batched: true }));
    await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, batch, write: () => {}, deadlineAt: 60_000, now: () => t,
      exec: () => { t = 61_000; return ''; } });
    expect(batch).not.toHaveBeenCalled();
    expect(f.left()).toEqual(['a']);
  });
  it('an owed filing whose acquire used up the deadline is deferred, not run, and its lane is released', async () => {
    const f = fixture([]); let t = 0; const calls = [];
    const exec = (cmd, args) => { calls.push(args[1]); if (args[1] === 'acquire') { t = 61_000; return JSON.stringify({ lane: 3, path: f.lane }); } return ''; };
    const result = await landPreventionCard({ title: 't', session: 's' }, { owedClaimed: true, exec, write: () => {}, skipPendingDrain: true,
      loadFilingSettings: () => ({ filingEnabled: true }), drainLimit: { deadlineAt: 60_000, now: () => t }, acquireWait: () => 30_000 });
    expect(result).toMatchObject({ ok: true, skipped: true, deferred: true });
    expect(calls).toEqual(['acquire', 'release']);
  });
  it('rotateAfter: a seed rotates only when there is no cursor value', () => {
    expect(rotateAfter(['a', 'b', 'c'], undefined, 1)).toEqual(['b', 'c', 'a']);
    expect(rotateAfter(['a', 'b', 'c'], undefined, undefined)).toEqual(['a', 'b', 'c']);
    expect(rotateAfter(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });
  it('one counter caps pending and owed together', async () => {
    const f = fixture(['a', 'b']); owedKeys(f); const counter = { left: 1 }; const seen = [];
    await drainPendingPrevention({ lane: f.lane }, { pendingDir: f.pendingDir, exec, write: () => {}, counter,
      batch: async input => { seen.push(input.cardPath); return { batched: true }; } });
    const filed = [];
    await reconcileOwedPrevention({ stateDir: f.stateDir, counter, file: async input => { filed.push(input.title); return { ok: true, skipped: true }; } });
    expect(seen).toHaveLength(1);
    expect(filed).toEqual([]);
  });
  it('a filing deferred for want of a lane keeps its place and ends the owed round', async () => {
    const f = fixture([]); const keys = owedKeys(f); const filed = [];
    await reconcileOwedPrevention({ stateDir: f.stateDir, cursorPath: f.cursorPath,
      file: async input => { filed.push(input.title); return { ok: true, skipped: true, deferred: true }; } });
    expect(filed).toEqual(['1']);
    expect(readDrainCursor(f.cursorPath).owed).toBeUndefined();
    expect(keys).toHaveLength(2);
  });
  function owedKeys(f) {
    const dir = join(f.stateDir, 'owed-prevention'); mkdirSync(dir, { recursive: true });
    return ['1', '2'].map(char => {
      const key = char.repeat(64);
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: char } }));
      return key;
    });
  }
});

describe('owed filings under the cap', () => {
  function owedDir(stateDir, keys) {
    const dir = join(stateDir, 'owed-prevention'); mkdirSync(dir, { recursive: true });
    return keys.map(char => {
      const key = char.repeat(64);
      // The identity check recomputes the key from the input, so use the stored owedKey form.
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: char } }));
      return key;
    });
  }
  it('files at most maxFilings per call, round-robin, and stops at the deadline', async () => {
    const f = fixture([]); const keys = owedDir(f.stateDir, ['1', '2', '3']); const filed = [];
    const file = async input => { filed.push(input.title); return { ok: true, skipped: true }; };
    const options = { stateDir: f.stateDir, file, maxFilings: 1, cursorPath: f.cursorPath };
    await reconcileOwedPrevention(options); await reconcileOwedPrevention(options); await reconcileOwedPrevention(options);
    expect(filed).toEqual(['1', '2', '3']);
    expect(readDrainCursor(f.cursorPath).owed).toBe(`${keys[2]}.json`);
    await reconcileOwedPrevention({ ...options, deadlineAt: 0, now: () => 1 });
    expect(filed).toHaveLength(3);
  });
});

describe('the probe tick', () => {
  const settings = extra => () => ({ filingEnabled: true, drainCardsPerTick: 1, ...extra });
  function tickFixture() {
    const f = fixture(['a', 'b']);
    writeFileSync(join(f.stateDir, 'org-repo-prevention.json'), JSON.stringify({ seq: 9 }));
    return f;
  }
  const base = f => ({ stateDir: f.stateDir, seal: vi.fn(async () => []), log: () => {} });

  it('hands the drain its cap, a deadline from the tick start, and the cursor; seals AFTER draining', async () => {
    const f = tickFixture(); const order = [];
    const drain = vi.fn(async () => { order.push('drain'); return { ok: true }; });
    const seal = vi.fn(async () => { order.push('seal'); return []; });
    await reconcileCardBatches({ ...base(f), seal, drain, loadFilingSettings: settings({ drainCardsPerTick: 3 }), clock: () => 1000, drainBudgetMs: 60_000 });
    expect(drain.mock.calls[0][1].drainLimit).toMatchObject({ counter: { left: 3 }, deadlineAt: 61_000, cursorPath: f.cursorPath });
    expect(order).toEqual(['drain', 'seal']);
  });

  it('does not start the drain when the budget is already spent', async () => {
    const f = tickFixture(); const drain = vi.fn(async () => ({ ok: true }));
    await reconcileCardBatches({ ...base(f), drain, loadFilingSettings: settings(), drainBudgetMs: 0 });
    expect(drain).not.toHaveBeenCalled();
  });

  it('paused is unchanged: a paused result, no drain, no owed scan', async () => {
    const f = tickFixture(); const drain = vi.fn(); const fileOwed = vi.fn();
    owedPending(f);
    const results = await reconcileCardBatches({ ...base(f), drain, fileOwed, loadFilingSettings: () => ({ filingEnabled: false }) });
    expect(results).toEqual([{ action: 'paused', step: 'drain', reason: 'prevention filing paused by prevention.filingEnabled' }]);
    expect(drain).not.toHaveBeenCalled();
    expect(fileOwed).not.toHaveBeenCalled();
  });

  function owedPending(f) {
    const dir = join(f.stateDir, 'owed-prevention'); mkdirSync(dir, { recursive: true });
    const key = '7'.repeat(64);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: 'o' } }));
  }

  it('owed filings progress even while the spool keeps the budget: the two take turns going first', async () => {
    const f = tickFixture(); owedPending(f);
    let t = 0; const calls = [];
    // Each drain eats the whole budget, so whichever step runs second has nothing left.
    const drain = vi.fn(async () => { calls.push('pending'); t += 70_000; return { ok: true }; });
    const fileOwed = vi.fn(async () => { calls.push('owed'); t += 70_000; return { ok: true, skipped: true }; });
    const tick = () => reconcileCardBatches({ ...base(f), drain, fileOwed, loadFilingSettings: settings(), clock: () => t });
    await tick(); await tick();
    expect(calls).toEqual(['pending', 'owed']);
    expect(readDrainCursor(f.cursorPath).next).toBe('pending');
  });

  it('an owed filing does NOT drain the spool itself inside the tick (operator ruling 2026-10-20): the probe drains it in its own slice', async () => {
    const f = tickFixture(); owedPending(f); const fileOwed = vi.fn(async () => ({ ok: true, skipped: true }));
    await reconcileCardBatches({ ...base(f), drain: vi.fn(async () => ({ ok: true })), fileOwed, loadFilingSettings: settings(), clock: () => 0 });
    const options = fileOwed.mock.calls[0][1];
    expect(options.skipPendingDrain).toBe(true);
    expect(options.drainLimit).toMatchObject({ deadlineAt: 60_000 });
    expect(options.acquireWait()).toBe(30_000); // an owed filing's acquire is bounded too
  });

  it('ONE allowance per tick across both steps: an owed filing that took it leaves the spool drain none, and it does not even acquire', async () => {
    const f = tickFixture(); owedPending(f);
    writeFileSync(f.cursorPath, JSON.stringify({ next: 'owed' }));
    const drain = vi.fn(async () => ({ ok: true }));
    await reconcileCardBatches({ ...base(f), drain, fileOwed: vi.fn(async () => ({ ok: true, skipped: true })), loadFilingSettings: settings() });
    expect(drain).not.toHaveBeenCalled();
  });

  it('an owed-first deferral (no lane) ends the tick: the pending drain does not acquire', async () => {
    const f = tickFixture(); owedPending(f);
    writeFileSync(f.cursorPath, JSON.stringify({ next: 'owed' }));
    const drain = vi.fn(async () => ({ ok: true }));
    const results = await reconcileCardBatches({ ...base(f), drain, loadFilingSettings: settings(),
      fileOwed: vi.fn(async () => ({ ok: true, skipped: true, deferred: true })) });
    expect(drain).not.toHaveBeenCalled();
    expect(results.some(result => result.action === 'error')).toBe(false);
  });

  it('the pending acquire wait is the LIVE remaining budget, read at the acquire', async () => {
    const f = tickFixture(); let t = 0;
    const drain = vi.fn(async (input, options) => { t = 45_000; return { ok: true, live: options.drainLimit.acquireWait() }; });
    await reconcileCardBatches({ ...base(f), drain, loadFilingSettings: settings(), clock: () => t });
    expect(drain.mock.calls[0][1].drainLimit.acquireWaitMs).toBe(30_000); // the snapshot
    expect(await drain.mock.results[0].value).toMatchObject({ live: 15_000 }); // the live value after time passed
  });

  it('owed work opens the standalone spool slice even when every top-level slot is sealed (the retry the skipped nested drain used to give)', async () => {
    const f = tickFixture(); owedPending(f);
    writeFileSync(join(f.stateDir, 'org-repo-prevention.json'), JSON.stringify({ seq: 9, batchRef: 'lane/card-batch-prevention-9', sealedAt: '2026-10-18T12:00:00Z', pr: 0 }));
    const drain = vi.fn(async () => ({ ok: true }));
    await reconcileCardBatches({ ...base(f), drain, fileOwed: vi.fn(async () => ({ ok: true, skipped: true })), loadFilingSettings: settings() });
    expect(drain).toHaveBeenCalledOnce();
  });
  it('without owed work a sealed-only state still does not open the slice (unchanged from base)', async () => {
    const f = tickFixture();
    writeFileSync(join(f.stateDir, 'org-repo-prevention.json'), JSON.stringify({ seq: 9, batchRef: 'lane/card-batch-prevention-9', sealedAt: '2026-10-18T12:00:00Z', pr: 0 }));
    const drain = vi.fn(async () => ({ ok: true }));
    await reconcileCardBatches({ ...base(f), drain, loadFilingSettings: settings() });
    expect(drain).not.toHaveBeenCalled();
  });

  it('the budget counts from the START of the tick: terminal-PR recovery that used it leaves no drain', async () => {
    const f = tickFixture(); let t = 0;
    writeFileSync(join(f.stateDir, 'org-slow-prevention.json'), JSON.stringify({ seq: 1, batchRef: 'lane/card-batch-prevention-1', headSha: 'a'.repeat(40),
      repo: 'org/slow', kind: 'prevention', sealedAt: '2026-10-18T12:00:00Z', pr: 7, seal: { step: 'label-on-green' }, members: [] }));
    const gh = async () => { t += 70_000; return JSON.stringify({ number: 7, headRefName: 'lane/card-batch-prevention-1', state: 'OPEN' }); };
    const drain = vi.fn(async () => ({ ok: true }));
    await reconcileCardBatches({ ...base(f), gh, drain, loadFilingSettings: settings(), clock: () => t });
    expect(drain).not.toHaveBeenCalled();
  });

  it('no lane in time ends the drain for this tick: the owed step does not queue for the same pool, and nothing errors', async () => {
    const f = tickFixture(); owedPending(f); const fileOwed = vi.fn();
    const drain = vi.fn(async () => ({ ok: true, skipped: true, deferred: true, step: 'acquire-deferred' }));
    const results = await reconcileCardBatches({ ...base(f), drain, fileOwed, loadFilingSettings: settings() });
    expect(fileOwed).not.toHaveBeenCalled();
    expect(results.some(result => result.action === 'error')).toBe(false);
  });
});

describe('prevention.drainCardsPerTick cascade', () => {
  const standard = loadCardBatchPolicy().prevention;
  it('defaults to 1 from the standard and cascades like the other keys, ignoring invalid values', () => {
    expect(resolvePreventionBatchSettings({ standard, env: {} })).toMatchObject({ drainCardsPerTick: 1, sources: { drainCardsPerTick: 'standard' } });
    expect(resolvePreventionBatchSettings({ standard, repo: { drainCardsPerTick: 2 }, env: {} })).toMatchObject({ drainCardsPerTick: 2, sources: { drainCardsPerTick: 'repo' } });
    expect(resolvePreventionBatchSettings({ standard, repo: { drainCardsPerTick: 2 }, env: { WE_PREVENTION_DRAIN_CARDS_PER_TICK: '3' } }))
      .toMatchObject({ drainCardsPerTick: 3, sources: { drainCardsPerTick: 'env' } });
    expect(resolvePreventionBatchSettings({ standard, repo: { drainCardsPerTick: 0 }, env: {} }))
      .toMatchObject({ drainCardsPerTick: 1, invalid: ['repo.drainCardsPerTick'] });
  });
});
