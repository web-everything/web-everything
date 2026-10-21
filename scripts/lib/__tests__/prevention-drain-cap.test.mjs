// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainPendingPrevention } from '../../operations/land-prevention-card.mjs';
import { reconcileOwedPrevention } from '../prevention-filing-owed.mjs';
import { reconcileCardBatches } from '../../operations/card-batch-reconcile.mjs';
import { drainCursorPath, readDrainCursor, rotateAfter } from '../prevention-drain-cursor.mjs';
import { resolvePreventionBatchSettings } from '../card-batch-settings.mjs';
import { loadCardBatchPolicy } from '../card-batch-policy.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
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
    expect(drain.mock.calls[0][1].drainLimit).toMatchObject({ maxCards: 3, deadlineAt: 61_000, cursorPath: f.cursorPath });
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

  it('skips the owed step\'s own spool drain (the probe drains the spool in its own capped slice)', async () => {
    const f = tickFixture(); owedPending(f); const fileOwed = vi.fn(async () => ({ ok: true, skipped: true }));
    await reconcileCardBatches({ ...base(f), drain: vi.fn(async () => ({ ok: true })), fileOwed, loadFilingSettings: settings() });
    expect(fileOwed).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ skipPendingDrain: true }));
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
