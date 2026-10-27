// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retireBatch } from '../card-batch-io.mjs';
import { reconcileCardBatches, resolveReconcileIntervalMin, main } from '../card-batch-reconcile.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'batch-reconcile-')); roots.push(stateDir);
  const path = join(stateDir, 'org-repo-prevention.json');
  const state = { seq: 9, batchRef: 'lane/card-batch-prevention-9', headSha: 'a'.repeat(40),
    repo: 'org/repo', kind: 'prevention', sealedAt: '2026-10-18T12:00:00Z', pr: 272, seal: { step: 'label-on-green' }, members: [] };
  writeFileSync(path, JSON.stringify(state));
  return { stateDir, path, state, seal: vi.fn(async () => []), drain: vi.fn(), log: () => {}, loadFilingSettings: () => ({ filingEnabled: true }) };
}

describe('reconcileCardBatches', () => {
  it.each(['OPEN', 'unreadable', 'unknown', null, undefined, '', 'merged', 'wrong-pr', 'wrong-branch'])('keeps %s state untouched', async status => {
    const f = fixture(); f.state.terminalPrState = 'MERGED'; writeFileSync(f.path, JSON.stringify(f.state));
    const before = readFileSync(f.path, 'utf8');
    const results = await reconcileCardBatches({ ...f, gh: async () => {
      if (status === 'unreadable') throw Error('offline');
      return JSON.stringify({ number: status === 'wrong-pr' ? 999 : 272,
        headRefName: status === 'wrong-branch' ? 'other' : 'lane/card-batch-prevention-9',
        state: ['wrong-pr', 'wrong-branch'].includes(status) ? 'MERGED' : status });
    } });
    expect(results[0]).toMatchObject({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    expect(f.drain).not.toHaveBeenCalled();
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it.each(['identity', 'lease', 'expired'])('preserves the %s guard', async scenario => {
    const f = fixture();
    if (scenario === 'identity') { f.state.repo = 'wrong/repo'; writeFileSync(f.path, JSON.stringify(f.state)); }
    const gh = vi.fn(async () => '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}');
    let clock = 100;
    if (scenario === 'lease') writeFileSync(`${f.path}.lock`, JSON.stringify({ token: 'other', expiresAt: 1000 }));
    if (scenario === 'expired') gh.mockImplementation(async () => { clock = 1000; return '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}'; });
    const before = readFileSync(f.path, 'utf8');
    await reconcileCardBatches({ ...f, gh, clock: () => clock, leaseMs: 50 });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    if (scenario !== 'expired') expect(gh).not.toHaveBeenCalled();
  });
  it('continues past corrupt states and never scans sealed archives', async () => {
    const f = fixture(); writeFileSync(join(f.stateDir, 'aaa.json'), '{');
    mkdirSync(join(f.stateDir, 'sealed')); writeFileSync(join(f.stateDir, 'sealed', 'bad.json'), '{');
    const results = await reconcileCardBatches({ ...f, gh: async () => '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}' });
    expect(results.map(result => result.action)).toEqual(['error', 'retired']);
    expect(JSON.parse(readFileSync(f.path))).toMatchObject({ seq: 9, lastSealedState: expect.any(String) });
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it('drains an open slot using the scoped state directory and then flushes', async () => {
    const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9, lastSealedState: 'archive' }));
    mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
    const batch = vi.fn();
    f.drain.mockImplementation(async (input, options) => {
      expect(input.drainPending).toBe(true);
      await options.batch({ cardPath: 'backlog/card.md' }, {});
      expect(f.seal).not.toHaveBeenCalled();
      return { ok: true };
    });
    await reconcileCardBatches({ ...f, batch });
    expect(batch).toHaveBeenCalledWith({ cardPath: 'backlog/card.md' }, { stateDir: f.stateDir });
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it('dry-run leaves state and leases untouched and does not invoke external operations', async () => {
    const f = fixture(); const gh = vi.fn(); const before = readFileSync(f.path, 'utf8');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await main(['--dry-run', '--json'], { ...f, gh })).toBe(0); }
    finally { output.mockRestore(); }
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    for (const fn of [gh, f.seal, f.drain]) expect(fn).not.toHaveBeenCalled();
  });
});

it.each([undefined, null, 0, -1, 1.5, '10', 5, 12])('reads interval %s with positive integer fallback', value => {
  expect(resolveReconcileIntervalMin({ read: () => ({ cardBatch: { reconcileIntervalMin: value } }) }))
    .toBe(Number.isSafeInteger(value) && value > 0 ? value : 5);
});


it('reports drain and seal failures independently', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9 }));
  mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
  f.drain.mockResolvedValue({ ok: false, reason: 'lane unavailable' });
  f.seal.mockRejectedValue(Error('seal failed'));
  expect(await reconcileCardBatches(f)).toEqual([
    { action: 'error', step: 'drain', reason: 'lane unavailable' },
    { action: 'error', step: 'seal', reason: 'seal failed' },
  ]);
});

it('skips the pending drain while filing is paused and reports a paused state, not an error', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9 }));
  mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
  const results = await reconcileCardBatches({ ...f, loadFilingSettings: () => ({ filingEnabled: false }) });
  expect(f.drain).not.toHaveBeenCalled();
  expect(results).toEqual([{ action: 'paused', step: 'drain', reason: 'prevention filing paused by prevention.filingEnabled' }]);
  expect(results.some(result => result.action === 'error')).toBe(false);
  expect(f.seal).toHaveBeenCalledOnce();
});

it('stays quiet when filing is paused and nothing is pending', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9 }));
  expect(await reconcileCardBatches({ ...f, loadFilingSettings: () => ({ filingEnabled: false }) })).toEqual([]);
});

it('still reports a real drain failure as an error when filing is enabled', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9 }));
  mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
  f.drain.mockRejectedValue(Error('boom'));
  expect(await reconcileCardBatches(f)).toEqual([{ action: 'error', step: 'drain', reason: 'boom' }]);
});

it('defaults the interval when settings cannot be read', () => {
  expect(resolveReconcileIntervalMin({ read: () => { throw Error('unreadable'); } })).toBe(5);
});

it.each(['OPEN', 'MERGED', 'CLOSED', null, undefined, 'UNKNOWN'])(
  'the archive writer refuses an unverified terminalPrState hint %s', terminalPrState => {
    const f = fixture(); const before = readFileSync(f.path, 'utf8');
    expect(() => retireBatch(f.path, f.state, { repo: 'org/repo', kind: 'prevention', held: () => true, terminalPrState }))
      .toThrow('batch-sealed');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
  });


describe('periodic terminal-recovery deadline', () => {
  it('shares tick-start time across many slots, bounds subprocess timeouts, and stops before the next slot after expiry', async () => {
    const f = fixture();
    const snapshots = new Map([[f.path, readFileSync(f.path, 'utf8')]]);
    for (let i = 0; i < 8; i++) {
      const repo = `org/repo-${i}`, path = join(f.stateDir, `org-repo-${i}-prevention.json`);
      const text = JSON.stringify({ ...f.state, repo });
      writeFileSync(path, text); snapshots.set(path, text);
    }
    // An expired scan must not reach even a corrupt trailing slot.
    writeFileSync(join(f.stateDir, 'zzz-corrupt.json'), '{');
    let t = 60_000; const calls = [], logs = [];
    const recoveryExec = (cmd, args, options) => {
      calls.push({ cmd, args, options, at: t }); t += options.timeout;
      return JSON.stringify({ number: 272, state: 'OPEN', headRefName: f.state.batchRef });
    };
    const fileOwed = vi.fn();
    const results = await reconcileCardBatches({ ...f, now: 10_000, clock: () => t,
      leaseMs: 180_000, recoveryExec, fileOwed, log: line => logs.push(line) });
    expect(t).toBe(130_000);
    expect(calls.map(call => call.options.timeout)).toEqual([30_000, 30_000, 10_000]);
    expect(calls.every(call => call.cmd === 'gh' && call.at < 130_000 && call.options.killSignal === 'SIGKILL')).toBe(true);
    expect(results).toHaveLength(3);
    expect(results.at(-1)).toMatchObject({ action: 'deferred', step: 'terminal-recovery' });
    expect(results.some(result => result.action === 'error')).toBe(false);
    expect(logs.join(' ')).toContain('held for the next tick');
    for (const [path, text] of snapshots) {
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(existsSync(`${path}.lock`)).toBe(false);
    }
    expect(f.drain).not.toHaveBeenCalled(); expect(fileOwed).not.toHaveBeenCalled();
    expect(f.seal).toHaveBeenCalledOnce();
  });

  it('starts no subprocess and skips corrupt slots when the tick-start deadline is already exhausted, while still flushing', async () => {
    const f = fixture(); writeFileSync(f.path, '{');
    const recoveryExec = vi.fn(); const gh = vi.fn();
    const results = await reconcileCardBatches({ ...f, now: 10_000, clock: () => 130_000, recoveryExec, gh });
    expect(results).toEqual([{ statePath: f.path, action: 'deferred', step: 'terminal-recovery',
      reason: 'tick deadline exhausted; remaining terminal batches held for the next tick' }]);
    expect(gh).not.toHaveBeenCalled(); expect(recoveryExec).not.toHaveBeenCalled();
    expect(readFileSync(f.path, 'utf8')).toBe('{');
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    expect(f.seal).toHaveBeenCalledOnce();
  });

  it('bounds cumulative CLOSED member recovery, preserves the slot and releases its lease when the shared deadline expires', async () => {
    const f = fixture();
    f.state.members = ['xone', 'xtwo'].map((cardId, i) => ({ cardId, idemKey: cardId,
      commitSha: String(i + 1).repeat(40), source: { repo: 'org/repo' } }));
    writeFileSync(f.path, JSON.stringify(f.state));
    const before = readFileSync(f.path, 'utf8');
    let t = 108_000; const calls = [];
    const recoveryExec = (cmd, args, options) => {
      calls.push({ cmd, args, options, at: t }); t += 2_000;
      if (cmd === 'gh') return JSON.stringify({ number: 272, state: 'CLOSED', headRefName: f.state.batchRef });
      if (args[0] === 'rev-parse') return 'e'.repeat(40);
      if (args[0] === 'show' && args[1] === '-s') {
        const member = f.state.members.find(m => m.commitSha === args.at(-1));
        return 'Card-Batch: ' + JSON.stringify({ ...member, kind: 'prevention', batchRef: f.state.batchRef,
          cardPath: `backlog/${member.cardId}-card.md` });
      }
      if (args[0] === 'diff-tree') return 'A\0backlog/xone-card.md\0';
      if (args[0] === 'ls-tree') return args[1] === 'e'.repeat(40) ? '' : '100644 blob abc';
      if (args[0] === 'show') return Buffer.from('# card');
      return '';
    };
    const results = await reconcileCardBatches({ ...f, now: 10_000, clock: () => t,
      leaseMs: 180_000, recoveryExec, log: () => {} });
    expect(t).toBe(130_000);
    expect(calls).toHaveLength(11);
    expect(calls.at(-1).args).toContain(f.state.members[1].commitSha);
    for (const call of calls) {
      expect(call.at).toBeLessThan(130_000);
      expect(call.options).toMatchObject({ timeout: 130_000 - call.at, killSignal: 'SIGKILL' });
    }
    expect(results).toEqual([{ statePath: f.path, action: 'deferred', step: 'terminal-recovery',
      reason: 'tick deadline exhausted; remaining terminal batches held for the next tick' }]);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    expect(existsSync(join(f.stateDir, 'pending-prevention'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
    expect(f.seal).toHaveBeenCalledOnce();
  });
});
