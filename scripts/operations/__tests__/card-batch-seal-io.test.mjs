// @vitest-environment node
/** Batch IO ordering, refusal and durable retry boundaries using injected transports. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishBatch, sealDueBatches, HOLD_LABEL } from '../card-batch-seal-io.mjs';
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
it('keeps the sealed archive terminal when its job is explicitly retried', async () => {
  const f = fixture({ maxCards: 1 });
  await publishBatch(f.input, f.opts);
  const active = JSON.parse(readFileSync(f.statePath, 'utf8'));
  const archived = readFileSync(active.lastSealedState, 'utf8');
  expect((await publishBatch({ statePath: active.lastSealedState }, f.opts)).action).toBe('sealed');
  expect(readFileSync(active.lastSealedState, 'utf8')).toBe(archived);
});
