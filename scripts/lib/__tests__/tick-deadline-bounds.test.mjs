// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STEP_MIN_MS, boundExec, isBudgetError, makeDeadline, DRAIN_HARD_DEADLINE_MS } from '../tick-deadline.mjs';
import { fileIntoBatch } from '../../operations/card-batch-file.mjs';
import { gitIn } from '../../operations/card-batch-io.mjs';
import { drainPendingPrevention, landPreventionCard } from '../../operations/land-prevention-card.mjs';
import { readDrainCursor } from '../prevention-drain-cursor.mjs';
import { reconcileOwedPrevention } from '../prevention-filing-owed.mjs';
import { reconcileCardBatches } from '../../operations/card-batch-reconcile.mjs';
import { loadCardBatchPolicy } from '../card-batch-policy.mjs';
import { resolveCardBatchSettings, resolvePreventionBatchSettings } from '../card-batch-settings.mjs';
import { resetDrainCursorMemory } from '../prevention-drain-cursor.mjs';

const roots = [];
afterEach(() => { resetDrainCursorMemory(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const tmp = () => { const root = mkdtempSync(join(tmpdir(), 'tick-bounds-')); roots.push(root); return root; };

describe('boundExec', () => {
  it('caps every call at the time left, keeps a smaller caller timeout, and refuses to start with almost nothing left', () => {
    let t = 0; const calls = []; const deadline = makeDeadline(100_000, () => t);
    const exec = boundExec((cmd, args, options) => { calls.push(options.timeout); return 'ok'; }, deadline);
    exec('git', ['status']);
    exec('git', ['fetch'], { timeout: 5_000 });
    exec('git', ['fetch'], { timeout: 500_000 });
    t = 90_000; exec('git', ['gc']);
    expect(calls).toEqual([100_000, 5_000, 100_000, 10_000]);
    t = 99_500;
    expect(() => exec('git', ['gc'])).toThrow(/tick budget exhausted/);
    try { exec('git', ['gc']); } catch (error) { expect(isBudgetError(error)).toBe(true); }
  });
  it('without a deadline it is the identity', () => {
    const raw = vi.fn(); expect(boundExec(raw, undefined)).toBe(raw);
  });
  it('gitIn built on it passes the cap to git', () => {
    let seen; const git = gitIn('/x', boundExec((cmd, args, options) => { seen = options.timeout; return ''; }, makeDeadline(30_000, () => 0)));
    git(['rev-parse', 'HEAD']);
    expect(seen).toBe(30_000);
  });
});

describe('round-2 bounds', () => {
  it('boundExec kills with SIGKILL so a child that ignores SIGTERM cannot hold the tick', () => {
    let seen; boundExec((cmd, args, options) => { seen = options; return ''; }, makeDeadline(10_000, () => 0))('git', ['x']);
    expect(seen.killSignal).toBe('SIGKILL');
  });
  it('an expired budget starts NO git at all in fileIntoBatch (the fetch / rev-parse included)', async () => {
    const settings = resolveCardBatchSettings({ standard: loadCardBatchPolicy().filing, env: {} });
    const preventionSettings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    const admit = vi.fn();
    // no baseSha and a lane that does not exist: any git call would throw/log instead of returning the budget refusal
    const result = await fileIntoBatch({ laneDir: '/no/such/lane', cardPath: 'backlog/x1abcde-card.md', kind: 'prevention', actor: 'mechanical', source: { repo: 'org/repo' } },
      { settings, preventionSettings, log: () => {}, launch: () => {}, stateDir: '/state', admit, deadline: makeDeadline(500, () => 0) });
    expect(result).toEqual({ batched: false, retryable: true, reason: 'tick budget exhausted before admission' });
    expect(admit).not.toHaveBeenCalled();
  });
  it('the retry gap itself must fit: with many configured retries no sleep runs past the deadline', async () => {
    const settings = resolveCardBatchSettings({ standard: loadCardBatchPolicy().filing, env: {} });
    const preventionSettings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    let t = 0; const deadline = makeDeadline(60_000, () => t);
    const admit = vi.fn(async () => { t += 3_000; return { action: 'refuse', reason: 'lease-held' }; });
    const gaps = [];
    await fileIntoBatch({ laneDir: '/lane', cardPath: 'backlog/x1abcde-card.md', kind: 'prevention', actor: 'mechanical', source: { repo: 'org/repo' } },
      { settings, preventionSettings, baseSha: 'a'.repeat(40), log: () => {}, launch: () => {}, stateDir: '/state', admit, deadline, retries: 200,
        pause: async ms => { gaps.push(ms); t += ms; } });
    expect(t).toBeLessThanOrEqual(60_000);
    expect(gaps.every(ms => ms > 0)).toBe(true);
  });
  it('a card-specific deferral (own-PR / out of time) advances the owed cursor and the NEXT owed filing is still reached; only a pool-wide one ends the round', async () => {
    const root = tmp(); const dir = join(root, 'owed-prevention'); mkdirSync(dir);
    const keys = ['7', '8'].map(char => { const key = char.repeat(64); writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: char } })); return key; });
    const filed = []; const cursorPath = join(root, 'cursor.state');
    await reconcileOwedPrevention({ stateDir: root, cursorPath, hardDeadlineAt: 10 ** 12, now: () => 0, file: async input => { filed.push(input.title); return { ok: true, skipped: true, deferred: true, step: 'tick-deferred' }; } });
    expect(filed).toEqual(['7', '8']);
    expect(readDrainCursor(cursorPath).owed).toBe(`${keys[1]}.json`);
    const poolWide = []; resetDrainCursorMemory();
    await reconcileOwedPrevention({ stateDir: root, hardDeadlineAt: 10 ** 12, now: () => 0, file: async input => { poolWide.push(input.title); return { ok: true, skipped: true, deferred: true, step: 'acquire-deferred' }; } });
    expect(poolWide).toEqual(['7']);
    const uncapped = []; resetDrainCursorMemory();
    await reconcileOwedPrevention({ stateDir: root, file: async input => { uncapped.push(input.title); return { ok: true, skipped: true, deferred: true, step: 'tick-deferred' }; } });
    expect(uncapped).toEqual(['7']); // callers without a hard deadline keep the original rule: any deferral ends the round
  });
  it('the probe reports a card-specific owed deferral as a visible non-error result', async () => {
    const root = tmp(); writeFileSync(join(root, 'org-repo-prevention.json'), JSON.stringify({ seq: 9 }));
    const owedDir = join(root, 'owed-prevention'); mkdirSync(owedDir);
    const key = '9'.repeat(64); writeFileSync(join(owedDir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: 'x' } }));
    const results = await reconcileCardBatches({ stateDir: root, seal: async () => [], log: () => {}, drain: vi.fn(async () => ({ ok: true })),
      fileOwed: vi.fn(async () => ({ ok: true, skipped: true, deferred: true, step: 'tick-deferred' })), loadFilingSettings: () => ({ filingEnabled: true, drainCardsPerTick: 2 }) });
    expect(results).toContainEqual({ action: 'deferred', step: 'owed', reason: 'tick-deferred' });
    expect(results.some(result => result.action === 'error')).toBe(false);
  });
  it('the hard deadline counts from the health-watch tick\'s own sample when it is recent, else from now', async () => {
    const root = tmp(); mkdirSync(join(root, 'pending-prevention')); writeFileSync(join(root, 'pending-prevention/a.json'), '{}');
    writeFileSync(join(root, 'org-repo-prevention.json'), JSON.stringify({ seq: 9 }));
    const drain = vi.fn(async () => ({ ok: true }));
    const common = { stateDir: root, seal: async () => [], log: () => {}, drain, loadFilingSettings: () => ({ filingEnabled: true, drainCardsPerTick: 1 }) };
    await reconcileCardBatches({ ...common, clock: () => 100_000, now: 90_000 });
    expect(drain.mock.calls[0][1].drainLimit.hardDeadlineAt).toBe(90_000 + DRAIN_HARD_DEADLINE_MS);
    await reconcileCardBatches({ ...common, clock: () => 500_000, now: 90_000 }); // a stale sample is not trusted
    expect(drain.mock.calls[1][1].drainLimit.hardDeadlineAt).toBe(500_000 + DRAIN_HARD_DEADLINE_MS);
  });
});

describe('round-4 bounds', () => {
  it('inside the tick the dedupe reads NO hosted-PR cards (no gh-throttle subprocess to escape the deadline); outside it still does', async () => {
    const seen = [];
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    const exec = (cmd, args) => (args[1] === 'acquire' ? JSON.stringify({ lane: 3, path: '/lane' }) : args[1] === 'file-item' ? JSON.stringify({ verdict: { num: 'x1abcde', rel: 'backlog/x1abcde-card.md' } }) : '');
    const common = { owedClaimed: true, exec, write: () => {}, pendingDir: tmp(), skipPendingDrain: true, batch: vi.fn(async () => ({ batched: true, batchRef: 'r' })), readFile: () => '#',
      loadFilingSettings: () => settings, loadPreventionBatchSettings: () => settings, acquireWait: () => 5_000,
      dedupe: (input, o) => { seen.push(o.readPrCards ? o.readPrCards('/lane') : 'default'); return null; } };
    const input = { title: 't', kind: 'task', size: '1', digest: 'd', scope: 's', queue: 'q', session: 's1' };
    await landPreventionCard(input, { ...common, drainLimit: { deadlineAt: 10 ** 9, hardDeadlineAt: 10 ** 9, now: () => 0 } });
    await landPreventionCard(input, common);
    expect(seen).toEqual([[], 'default']);
  });
  it('the acquire-cleanup release runs only inside a tick', async () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push(args); if (args[1] === 'acquire') throw Object.assign(new Error('x'), { killed: true }); return ''; };
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    await landPreventionCard({ title: 't', session: 'sess-uncapped' }, { owedClaimed: true, exec, write: () => {}, pendingDir: tmp(), skipPendingDrain: true,
      loadFilingSettings: () => settings, loadPreventionBatchSettings: () => settings, acquireWait: () => 5_000 });
    expect(calls.some(args => args[1] === 'release')).toBe(false);
  });
});

describe('round-3 bounds', () => {
  it('a pending card whose work ran out of tick time still moves the cursor past it', async () => {
    const root = tmp(); const pendingDir = join(root, 'p'); mkdirSync(pendingDir);
    for (const name of ['a', 'b']) writeFileSync(join(pendingDir, `${name}.json`), JSON.stringify({ cardId: name, rel: `backlog/${name}-card.md`, content: '#', idemKey: name, source: {} }));
    const cursorPath = join(root, 'cursor.state'); const budget = Object.assign(new Error('out'), { code: 'TICK_BUDGET' });
    await drainPendingPrevention({ lane: root }, { pendingDir, exec: () => { throw budget; }, batch: vi.fn(), write: () => {}, maxCards: 1, cursorPath });
    expect(readDrainCursor(cursorPath).pending).toBe('a.json');
  });
  it('a killed acquire releases any lane it claimed without reporting, by this run\'s unique session', async () => {
    const calls = [];
    const exec = (cmd, args) => { calls.push(args); if (args[1] === 'acquire') throw Object.assign(new Error('x'), { killed: true }); return ''; };
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    const result = await landPreventionCard({ title: 't', session: 'sess-unique' }, { owedClaimed: true, exec, write: () => {}, pendingDir: tmp(), skipPendingDrain: true,
      loadFilingSettings: () => settings, loadPreventionBatchSettings: () => settings, drainLimit: { hardDeadlineAt: 10 ** 9, deadlineAt: 10 ** 9, now: () => 0 }, acquireWait: () => 5_000 });
    expect(result).toMatchObject({ ok: true, deferred: true });
    expect(calls.some(args => args[1] === 'release' && args.includes('--all') && args.includes('--session=sess-unique'))).toBe(true);
  });
});

describe('fileIntoBatch lease wait', () => {
  const settings = resolveCardBatchSettings({ standard: loadCardBatchPolicy().filing, env: {} });
  const preventionSettings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
  const base = { laneDir: '/lane', cardPath: 'backlog/x1abcde-card.md', kind: 'prevention', actor: 'mechanical', source: { repo: 'org/repo' } };
  const options = extra => ({ settings, preventionSettings, baseSha: 'a'.repeat(40), log: () => {}, launch: () => {}, stateDir: '/state', ...extra });

  it('waits for a held lease only as long as the time left: never past the deadline, then the card is retryable (kept in the spool)', async () => {
    let t = 0; const deadline = makeDeadline(120_000, () => t);
    const admit = vi.fn(async () => ({ action: 'refuse', reason: 'lease-held' }));
    const pauses = [];
    const result = await fileIntoBatch(base, options({ admit, deadline, retries: 30, pause: async ms => { pauses.push(ms); t += 30_000; } }));
    expect(result).toMatchObject({ batched: false, retryable: true });
    expect(t).toBeLessThanOrEqual(120_000);
    expect(admit.mock.calls.length).toBeLessThan(31);
    expect(admit.mock.calls.every(call => call[1].deadline === deadline)).toBe(true);
    expect(deadline.left()).toBeGreaterThanOrEqual(0);
  });
  it('does not even start an admission with less than the minimum left', async () => {
    const admit = vi.fn();
    const result = await fileIntoBatch(base, options({ admit, deadline: makeDeadline(STEP_MIN_MS.admit - 1, () => 0) }));
    expect(admit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ batched: false, retryable: true });
  });
  it('without a deadline the retry behaviour is unchanged', async () => {
    const admit = vi.fn(async () => ({ action: 'refuse', reason: 'lease-held' }));
    await fileIntoBatch(base, options({ admit, retries: 3, pause: async () => {} }));
    expect(admit).toHaveBeenCalledTimes(4);
    expect(admit.mock.calls[0][1].deadline).toBeUndefined();
  });
});

describe('landPreventionCard inside the tick', () => {
  const LANE_OUT = JSON.stringify({ lane: 3, path: '/lane' });
  const FILED = JSON.stringify({ verdict: { num: 'x1abcde', rel: 'backlog/x1abcde-card.md' } });
  function run({ left = 110_000, onExec, batch, dedupe = () => null, sleep = async () => {} } = {}) {
    let t = 0; const calls = [];
    const exec = vi.fn((cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      const verb = args[1] === 'acquire' || args[1] === 'release' ? args[1] : args[1] === 'file-item' ? 'file-item' : args[0];
      const custom = onExec?.(verb, { set: value => { t = value; }, args, options });
      if (custom !== undefined) return custom;
      if (verb === 'acquire') return LANE_OUT;
      if (verb === 'file-item') return FILED;
      return '';
    });
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    const root = tmp(); mkdirSync(join(root, 'p'));
    const hardAt = left; // clock starts at 0, so `left` is the hard deadline
    const promise = landPreventionCard({ title: 't', kind: 'task', size: '1', digest: 'd', scope: 's', queue: 'q', session: 's1' }, {
      owedClaimed: true, exec, write: () => {}, pendingDir: join(root, 'p'), sleep, dedupe, batch, skipPendingDrain: true,
      loadFilingSettings: () => settings, loadPreventionBatchSettings: () => settings,
      readFile: () => '# card', drainLimit: { deadlineAt: hardAt, hardDeadlineAt: hardAt, now: () => t },
      acquireWait: () => 5_000 });
    return { promise, calls, exec, tick: () => t };
  }
  const batched = vi.fn(async () => ({ batched: true, batchRef: 'r' }));

  it('every subprocess is capped at the tick time left, including the lane release', async () => {
    const { promise, calls } = run({ left: 110_000, batch: batched });
    const result = await promise;
    expect(result).toMatchObject({ ok: true, step: 'batched' });
    for (const call of calls.filter(entry => entry.args[1] === 'acquire' || entry.args[1] === 'file-item')) {
      expect(call.options.timeout).toBeLessThanOrEqual(110_000);
    }
    expect(calls.find(entry => entry.args[1] === 'file-item').options.timeout).toBeLessThanOrEqual(120_000);
    const release = calls.find(entry => entry.args[1] === 'release');
    expect(release.options.timeout).toBeGreaterThanOrEqual(5_000);
    expect(release.options.timeout).toBeLessThanOrEqual(30_000);
  });

  it('defers (stays owed) when the time left cannot cover dedupe + file-item + admission, and releases the lane', async () => {
    const { promise, calls } = run({ left: STEP_MIN_MS.dedupe + STEP_MIN_MS.fileItem + STEP_MIN_MS.admit - 1 + 0, batch: batched });
    // the acquire itself needs 1s+; give it room by starting the clock at 0 with the hard deadline just under the sum
    const result = await promise;
    expect(result).toMatchObject({ ok: true, skipped: true, deferred: true });
    expect(calls.some(entry => entry.args[1] === 'file-item')).toBe(false);
    expect(calls.some(entry => entry.args[1] === 'release')).toBe(true);
  });

  it('a file-item that outlives the deadline is a deferral, not an error', async () => {
    const { promise } = run({ left: 100_000, batch: batched,
      onExec: (verb, ctx) => { if (verb === 'file-item') { ctx.set(101_000); throw Object.assign(new Error('timed out'), { killed: true, code: 'ETIMEDOUT' }); } } });
    expect(await promise).toMatchObject({ ok: true, deferred: true, step: 'budget-deferred' });
  });

  it('the batch call carries the deadline and its lease-wait pause is min(30s, time left)', async () => {
    let received; const sleeps = [];
    const batch = vi.fn(async (input, opts) => { received = opts; await opts.pause(); return { batched: true, batchRef: 'r' }; });
    const { promise } = run({ left: 100_000, batch, sleep: async ms => { sleeps.push(ms); } });
    await promise;
    expect(received.deadline).toBeDefined();
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
    expect(sleeps[0]).toBeLessThanOrEqual(100_000 - STEP_MIN_MS.admit);
  });

  it('a filing that would need its own PR (batching disabled) is deferred inside the tick: no commit, verify or open-pr', async () => {
    const batch = vi.fn(async () => ({ batched: false, disabled: true, reason: 'off' }));
    const { promise, calls } = run({ left: 110_000, batch });
    expect(await promise).toMatchObject({ ok: true, deferred: true, step: 'tick-deferred' });
    expect(calls.some(entry => entry.args[0] === 'commit' || entry.args[1] === 'commit' || entry.args.includes('verify') || entry.args.includes('open-pr'))).toBe(false);
  });

  it('outside a tick nothing is bounded: the original timeouts stand', async () => {
    const calls = [];
    const exec = (cmd, args, options = {}) => { calls.push({ args, options }); return args[1] === 'acquire' ? LANE_OUT : args[1] === 'file-item' ? FILED : ''; };
    const settings = resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, repo: { filingEnabled: true }, env: {} });
    const root = tmp();
    await landPreventionCard({ title: 't', kind: 'task', size: '1', digest: 'd', scope: 's', queue: 'q', session: 's1' }, {
      owedClaimed: true, exec, write: () => {}, pendingDir: root, dedupe: () => null, batch: batched,
      loadFilingSettings: () => settings, loadPreventionBatchSettings: () => settings });
    expect(calls.find(entry => entry.args[1] === 'acquire').options.timeout).toBe(3 * 60_000);
    expect(calls.find(entry => entry.args[1] === 'file-item').options.timeout).toBe(2 * 60_000);
    expect(calls.find(entry => entry.args[1] === 'release').options.timeout).toBe(3 * 60_000);
  });
});

describe('drain steps respect the hard deadline', () => {
  it('a pending card is not started with less than the minimum left; the ls-tree is bounded', async () => {
    const root = tmp(); const pendingDir = join(root, 'p'); mkdirSync(pendingDir);
    writeFileSync(join(pendingDir, 'a.json'), JSON.stringify({ cardId: 'a', rel: 'backlog/a-card.md', content: '#', idemKey: 'k', source: {} }));
    const exec = vi.fn(() => ''); const batch = vi.fn(async () => ({ batched: true }));
    await drainPendingPrevention({ lane: root }, { pendingDir, exec, batch, write: () => {}, hardDeadlineAt: STEP_MIN_MS.pendingCard - 1, now: () => 0 });
    expect(exec).not.toHaveBeenCalled();
    await drainPendingPrevention({ lane: root }, { pendingDir, exec, batch, write: () => {}, hardDeadlineAt: STEP_MIN_MS.pendingCard + 1, now: () => 0 });
    expect(batch).toHaveBeenCalledOnce();
  });
  it('an owed filing is not started with less than the minimum left', async () => {
    const root = tmp(); const dir = join(root, 'owed-prevention'); mkdirSync(dir);
    const key = '5'.repeat(64);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: 'x' } }));
    const file = vi.fn(async () => ({ ok: true, skipped: true }));
    await reconcileOwedPrevention({ stateDir: root, file, hardDeadlineAt: STEP_MIN_MS.owedFiling - 1, now: () => 0 });
    expect(file).not.toHaveBeenCalled();
    await reconcileOwedPrevention({ stateDir: root, file, hardDeadlineAt: STEP_MIN_MS.owedFiling + 1, now: () => 0 });
    expect(file).toHaveBeenCalledOnce();
  });
  it('the probe sets the hard deadline to 120s from the START of the tick and hands it to both drain steps', async () => {
    const root = tmp(); mkdirSync(join(root, 'pending-prevention'));
    writeFileSync(join(root, 'pending-prevention/a.json'), '{}');
    writeFileSync(join(root, 'org-repo-prevention.json'), JSON.stringify({ seq: 9 }));
    const owedDir = join(root, 'owed-prevention'); mkdirSync(owedDir);
    const key = '6'.repeat(64);
    writeFileSync(join(owedDir, `${key}.json`), JSON.stringify({ key, status: 'owed', input: { owedKey: key, title: 'x' } }));
    const drain = vi.fn(async () => ({ ok: true })); const fileOwed = vi.fn(async () => ({ ok: true, skipped: true }));
    await reconcileCardBatches({ stateDir: root, seal: async () => [], log: () => {}, drain, fileOwed, clock: () => 5_000,
      loadFilingSettings: () => ({ filingEnabled: true, drainCardsPerTick: 2 }) });
    expect(DRAIN_HARD_DEADLINE_MS).toBe(120_000);
    expect(drain.mock.calls[0][1].drainLimit.hardDeadlineAt).toBe(5_000 + DRAIN_HARD_DEADLINE_MS);
    expect(fileOwed.mock.calls[0][1].drainLimit.hardDeadlineAt).toBe(5_000 + DRAIN_HARD_DEADLINE_MS);
  });
});
