// @vitest-environment node
/** Batch IO ordering, refusal and durable retry boundaries using injected transports. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishBatch, sealDueBatches, HOLD_LABEL, VERIFY_UNRUN_CAP } from '../card-batch-seal-io.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture({ maxCards = 2, red = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'batch-seal-')); dirs.push(dir);
  const statePath = join(dir, 'org-repo-prevention.json');
  const state = { batchRef: 'lane/card-batch-prevention-1', seq: 1, headSha: 'a'.repeat(40), openedAt: 0,
    members: [{ cardId: '123', source: { repo: 'org/repo', pr: 42 } }] };
  writeFileSync(statePath, JSON.stringify(state));
  mkdirSync(join(dir, '.git'));
  const calls = []; let draft = true;
  const exec = vi.fn((cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'ls-remote') return state.headSha + '\tref';
    if (args[0] === 'rev-parse') return args[1] === '--absolute-git-dir' ? join(dir, '.git') : state.headSha;
    if (args[1] === 'acquire') return JSON.stringify({ path: dir, lane: 3, holder: 'holder' });
    if (args[1] === 'verify') {
      if (!red) writeFileSync(join(dir, '.git/.lane-verify'), JSON.stringify({ sha: state.headSha, status: 'green' }));
      return JSON.stringify({ verdict: { ok: !red, blocking: ['red'] } });
    }
    if (args[1] === 'open-pr') return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 9 } }] } } });
    if (args[1] === 'view') return JSON.stringify({ isDraft: draft });
    if (args[1] === 'ready') draft = false;
    return '';
  });
  const policy = loadCardBatchPolicy({ prevention: { maxCards, maxAgeMinutes: 1 } });
  return { dir, statePath, state, calls, exec, input: { statePath, laneDir: dir },
    opts: { exec, clock: () => 1000, policy }, read: () => { const saved = JSON.parse(readFileSync(statePath, 'utf8')); return saved.lastSealedState ? JSON.parse(readFileSync(saved.lastSealedState, 'utf8')) : saved; } };
}
it('opens through park then immediately holds, and refreshes the body on later publication', async () => {
  const f = fixture();
  await publishBatch(f.input, f.opts);
  const index = f.calls.findIndex(call => call.includes('open-pr'));
  expect(f.calls[index]).toContain('--mode=park');
  expect(f.calls[index + 1]).toEqual(['gh', 'pr', 'edit', '9', '--repo', 'org/repo', '--add-label', HOLD_LABEL]);
  expect(f.calls.some(call => call.includes('create'))).toBe(false);
  await publishBatch(f.input, f.opts);
  expect(f.calls.at(-1)).toContain('--body-file');
});
it('refuses a live admission lease without commands', async () => {
  const f = fixture(); writeFileSync(f.statePath + '.lock', JSON.stringify({ token: 'other', expiresAt: 9000 }));
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'lease-held' });
  expect(f.exec).not.toHaveBeenCalled();
});
it('refuses remote drift before any publishing', async () => {
  const f = fixture(); f.state.headSha = 'b'.repeat(40);
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(f.calls).toHaveLength(1);
});
it('records red verification and leaves the PR draft and held, including retries', async () => {
  const f = fixture({ maxCards: 1, red: true });
  expect((await publishBatch(f.input, f.opts)).action).toBe('held');
  expect(f.read().sealFailure.reason).toContain('red');
  await publishBatch(f.input, f.opts);
  expect(f.calls.some(call => call.includes('--remove-label') || call.includes('ready') || call.includes('--mode=label-on-green'))).toBe(false);
  expect(f.calls.filter(call => call.includes('verify'))).toHaveLength(1);
  expect(f.calls.some(call => call.includes('release'))).toBe(true);
});
it.each(['open-draft', 'record-sealed', 'verify', 'remove-hold', 'ready', 'label-on-green'])('resumes after %s', async crashAt => {
  const f = fixture({ maxCards: 1 });
  await expect(publishBatch(f.input, { ...f.opts, crashAt })).rejects.toThrow('crash');
  expect((await publishBatch(f.input, f.opts)).action).toBe('sealed');
  expect(f.read().seal.step).toBe('label-on-green');
  expect(f.calls.filter(call => call.includes('verify'))).toHaveLength(1);
  expect(f.calls.filter(call => call.includes('ready'))).toHaveLength(1);
  expect(f.calls.filter(call => call.includes('--mode=label-on-green'))).toHaveLength(1);
});
it('age jobs are detached, unrefed and never awaited; unfinished seals are retried', async () => {
  const f = fixture(); const child = { once: vi.fn((event, callback) => { if (event === 'spawn') queueMicrotask(callback); }), unref: vi.fn(), then: () => { throw Error('awaited'); } };
  const spawn = vi.fn(() => child);
  expect(await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([f.statePath]);
  expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore' });
  expect(child.unref).toHaveBeenCalledOnce();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, sealedAt: 500, seal: { step: 'verify' } }));
  expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([f.statePath]);
});
it('rechecks the remote after verification and refuses drift without releasing the hold', async () => {
  const f = fixture({ maxCards: 1 });
  const original = f.exec;
  const exec = (cmd, args, options) => {
    const result = original(cmd, args, options);
    if (args[1] === 'verify') f.state.headSha = 'b'.repeat(40);
    return result;
  };
  expect(await publishBatch(f.input, { ...f.opts, exec })).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(f.calls.some(call => call.includes('--remove-label'))).toBe(false);
});
it('restores the actual green receipt if a released lane was reused before resuming', async () => {
  const f = fixture({ maxCards: 1 });
  await expect(publishBatch(f.input, { ...f.opts, crashAt: 'verify' })).rejects.toThrow('crash');
  writeFileSync(join(f.dir, '.git/.lane-verify'), JSON.stringify({ sha: 'other', status: 'red' }));
  expect((await publishBatch(f.input, f.opts)).action).toBe('sealed');
  expect(JSON.parse(readFileSync(join(f.dir, '.git/.lane-verify'), 'utf8'))).toMatchObject({ sha: f.state.headSha, status: 'green' });
  expect(f.calls.filter(call => call.includes('verify'))).toHaveLength(1);
});
it('recovers ready succeeding remotely before the local record is written', async () => {
  const f = fixture({ maxCards: 1 }); let crash = true;
  const exec = (cmd, args, options) => {
    const result = f.exec(cmd, args, options);
    if (args[1] === 'ready' && crash) { crash = false; throw Error('transport lost after ready'); }
    return result;
  };
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('transport lost');
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('sealed');
  expect(f.calls.filter(call => call.includes('ready'))).toHaveLength(1);
});
it('reports asynchronous spawn failures without waiting for verification', async () => {
  const f = fixture();
  const spawn = () => ({ once(event, callback) { if (event === 'error') queueMicrotask(() => callback(Error('spawn failed'))); }, unref() {} });
  await expect(sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn })).rejects.toThrow('spawn failed');
});
const fakeChild = () => ({ once: vi.fn((event, callback) => { if (event === 'spawn') queueMicrotask(callback); }), unref: vi.fn() });
it.each([
  ['below count, past age', { maxCards: 5, now: 60000, launches: true }],
  ['at count, past age', { maxCards: 1, now: 60000, launches: true }],
  ['over count, past age', { maxCards: 1, members: 3, now: 60000, launches: true }],
  ['at count, before age', { maxCards: 1, now: 1000, launches: true }],
  ['below count, before age', { maxCards: 5, now: 1000, launches: false }],
])('tick launches an unsealed batch that is due by any reason: %s', async (_name, { maxCards, members = 1, now, launches }) => {
  const f = fixture({ maxCards });
  const member = f.state.members[0];
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, members: Array.from({ length: members }, () => member) }));
  const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual(launches ? [f.statePath] : []);
});
it.each([
  ['a verify run that throws with no stdout (timeout / spawn error)', () => { throw Error('ETIMEDOUT'); }],
  ['a verify run that prints no JSON', () => 'not json'],
  ['a parsed result with no verdict', () => JSON.stringify({ error: 'lane torn down' })],
])('treats %s as retryable, never a terminal seal failure', async (_name, unrun) => {
  const f = fixture({ maxCards: 1 });
  let first = true;
  const exec = (cmd, args, options) => {
    if (args[1] === 'verify' && first) { first = false; return unrun(); }
    return f.exec(cmd, args, options);
  };
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow();
  const saved = JSON.parse(readFileSync(f.statePath, 'utf8'));
  expect(saved.sealFailure).toBeUndefined();
  expect(saved.lastSealedState).toBeUndefined();
  expect(f.calls.some(call => call.includes('release'))).toBe(true);
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('sealed');
  expect(f.read().seal.step).toBe('label-on-green');
});
it.each([
  ['unrun checks', { ok: false, failed: 0, unrun: 1, blocking: [{ why: 'did-not-run' }] }],
  ['an empty suite', { ok: false, failed: 0, unrun: 0, emptySuite: true, blocking: [] }],
  ['a did-not-run blocker', { ok: false, blocking: [{ why: 'did-not-run' }] }],
])('treats a parsed verdict with %s as retryable, and holds only after the cap', async (_name, verdict) => {
  const f = fixture({ maxCards: 1 });
  const exec = (cmd, args, options) => (args[1] === 'verify' ? JSON.stringify({ verdict }) : f.exec(cmd, args, options));
  for (let attempt = 1; attempt < VERIFY_UNRUN_CAP; attempt++) {
    await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('verify unrun');
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).sealFailure).toBeUndefined();
  }
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('held');
  expect(f.read().sealFailure.reason).toContain(`${VERIFY_UNRUN_CAP} times`);
});
it('still records a verdict that names a real failure as terminal at once, even alongside unrun checks', async () => {
  const f = fixture({ maxCards: 1 });
  const exec = (cmd, args, options) => (args[1] === 'verify'
    ? JSON.stringify({ verdict: { ok: false, failed: 1, unrun: 1, blocking: [{ why: 'did-not-run' }, { why: 'failed' }] } }) : f.exec(cmd, args, options));
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('held');
  expect(f.read().sealFailure.reason).toContain('failed');
});
it('tick keeps launching later batches when one state file is unreadable, then reports the error', async () => {
  const f = fixture({ maxCards: 5 });
  writeFileSync(join(f.dir, 'a-corrupt.json'), '{not json');
  const spawn = vi.fn(fakeChild);
  const error = await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn }).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.launched).toEqual([f.statePath]);
  expect(spawn).toHaveBeenCalledOnce();
});
it('refreshes the PR body on the retry that applies a missed hold', async () => {
  const f = fixture({ maxCards: 5 });
  let fail = true;
  const exec = (cmd, args, options) => {
    if (cmd === 'gh' && args.includes('--add-label') && fail) { fail = false; throw Error('rate limited'); }
    return f.exec(cmd, args, options);
  };
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('rate limited');
  await publishBatch(f.input, { ...f.opts, exec });
  expect(f.calls.at(-1)).toContain('--body-file');
});
it('records the PR before labelling, and a failed label is re-asserted before anything else on retry', async () => {
  const f = fixture({ maxCards: 5 });
  let fail = true;
  const exec = (cmd, args, options) => {
    if (cmd === 'gh' && args.includes('--add-label') && fail) { fail = false; throw Error('rate limited'); }
    return f.exec(cmd, args, options);
  };
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('rate limited');
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).pr).toBe(9);
  const before = f.calls.length;
  await publishBatch(f.input, { ...f.opts, exec });
  const retry = f.calls.slice(before).filter(call => call[0] === 'gh');
  expect(retry[0]).toEqual(['gh', 'pr', 'edit', '9', '--repo', 'org/repo', '--add-label', HOLD_LABEL]);
  expect(f.calls.filter(call => call.includes('--mode=park'))).toHaveLength(1);
});
it('tick relaunches a batch whose PR exists but whose hold was never confirmed, even if it is not yet due', async () => {
  const f = fixture({ maxCards: 5 });
  const state = { ...f.state, pr: 9 };
  writeFileSync(f.statePath, JSON.stringify(state));
  const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([f.statePath]);
  writeFileSync(f.statePath, JSON.stringify({ ...state, holdApplied: true }));
  expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([]);
});
it('keeps the sealed archive terminal when its job is explicitly retried', async () => {
  const f = fixture({ maxCards: 1 });
  await publishBatch(f.input, f.opts);
  const active = JSON.parse(readFileSync(f.statePath, 'utf8'));
  const archived = readFileSync(active.lastSealedState, 'utf8');
  expect((await publishBatch({ statePath: active.lastSealedState }, f.opts)).action).toBe('sealed');
  expect(readFileSync(active.lastSealedState, 'utf8')).toBe(archived);
});
