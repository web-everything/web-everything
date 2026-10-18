// @vitest-environment node
/** Batch IO ordering, refusal and durable retry boundaries using injected transports. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishBatch, sealDueBatches, HOLD_LABEL, VERIFY_UNRUN_CAP, resolveAdoptDescendantHead } from '../card-batch-seal-io.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture({ maxCards = 2, red = false, descendant = false, descendantMessages = 'Repair CI\n',
  descendantChanges = ':100644 100644 abc def M\0backlog/123-card.md\0' } = {}) {
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
    if (args[0] === 'merge-base' && !descendant) throw Object.assign(new Error('not an ancestor'), { status: 1 });
    if (args[0] === 'log') return args.includes('--raw') ? descendantChanges : descendantMessages;
    if (args[0] === 'rev-parse') return args[1] === '--absolute-git-dir' ? join(dir, '.git') : state.headSha;
    if (args[1] === 'acquire') return JSON.stringify({ path: dir, lane: 3, holder: 'holder' });
    if (args[1] === 'verify') {
      if (!red) writeFileSync(join(dir, '.git/.lane-verify'), JSON.stringify({ sha: state.headSha, status: 'green' }));
      return JSON.stringify({ verdict: { ok: !red, blocking: ['red'] } });
    }
    if (args[1] === 'open-pr') return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 9 } }] } } });
    if (args[1] === 'view') return JSON.stringify({ isDraft: draft });
    if (args[1] === 'ready') draft = false;
    if (args.includes('--undo')) draft = true;
    return '';
  });
  const policy = loadCardBatchPolicy({ prevention: { maxCards, maxAgeMinutes: 1 } });
  return { dir, statePath, state, calls, exec, input: { statePath, laneDir: dir },
    opts: { exec, clock: () => 1000, policy, env: {} }, read: () => { const saved = JSON.parse(readFileSync(statePath, 'utf8')); return saved.lastSealedState ? JSON.parse(readFileSync(saved.lastSealedState, 'utf8')) : saved; } };
}
it('opens through park then immediately holds, and refreshes the body on later publication', async () => {
  const f = fixture();
  await publishBatch(f.input, f.opts);
  const index = f.calls.findIndex(call => call.includes('open-pr'));
  expect(f.calls[index]).toContain('--mode=park');
  // The held draft opens before any verify; pr-land's marker requirement is waived for it (live: refused `unverified`).
  const openOptions = f.exec.mock.calls.find(([, args]) => args[1] === 'open-pr')[2];
  expect(openOptions.env.WE_REQUIRE_VERIFIED).toBe('0');
  expect(f.calls[index + 1]).toEqual(['gh', 'pr', 'edit', '9', '--repo', 'org/repo', '--add-label', HOLD_LABEL]);
  expect(f.calls.some(call => call.includes('create'))).toBe(false);
  await publishBatch(f.input, f.opts);
  expect(f.calls.at(-1)).toContain('--body-file');
});
it('a remembered seal lane now leased by someone else falls back to any lane (live: lane-2 taken by a fix worker)', async () => {
  const f = fixture();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, sealLane: 2 }));
  const exec = vi.fn((cmd, args, options) => {
    if (args[1] === 'acquire' && args.includes('--lane=2')) throw new Error('lane-2 is leased by fix-4717');
    return f.exec(cmd, args, options);
  });
  await publishBatch(f.input, { ...f.opts, exec });
  const acquires = exec.mock.calls.filter(([, a]) => a[1] === 'acquire').map(([, a]) => a.some(x => x.startsWith('--lane=')));
  expect(acquires).toEqual([true, false]);
  expect(f.read().pr).toBe(9);
});
it('the sealing label-on-green keeps the verify requirement (no waiver)', async () => {
  const f = fixture({ maxCards: 1 });
  expect((await publishBatch(f.input, f.opts)).action).toBe('sealed');
  const [, args, options] = f.exec.mock.calls.find(([, a]) => a[1] === 'open-pr' && a.includes('--mode=label-on-green'));
  expect(args).toContain('--requireVerified=true');
  expect(options.env?.WE_REQUIRE_VERIFIED).toBeUndefined();
});
it('refuses a live admission lease without commands', async () => {
  const f = fixture(); writeFileSync(f.statePath + '.lock', JSON.stringify({ token: 'other', expiresAt: 9000 }));
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'lease-held' });
  expect(f.exec).not.toHaveBeenCalled();
});
it('refuses a non-descendant remote head before any publishing', async () => {
  const f = fixture(); f.state.headSha = 'b'.repeat(40);
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(f.read().headSha).toBe('a'.repeat(40));
  expect(f.read().adoptedHeads).toBeUndefined();
  expect(f.calls.some(call => call.includes('open-pr'))).toBe(false);
});
it('adopts a descendant remote head, journals it and verifies the new head before ready', async () => {
  const f = fixture({ maxCards: 1, descendant: true });
  const from = f.state.headSha;
  const previous = { from: 'older', to: from, at: 'earlier' };
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, adoptedHeads: [previous],
    verificationMarker: { sha: from, status: 'green' } }));
  f.state.headSha = 'b'.repeat(40);
  const exec = vi.fn((cmd, args, options) => {
    if (args[1] === 'acquire') {
      expect(f.read().headSha).toBe(f.state.headSha);
      expect(f.read().verificationMarker).toBeUndefined();
    }
    return f.exec(cmd, args, options);
  });
  const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    expect((await publishBatch(f.input, { ...f.opts, exec, remote: 'upstream' })).action).toBe('sealed');
    expect(f.read()).toMatchObject({ headSha: f.state.headSha, members: f.state.members,
      adoptedHeads: [previous, { from, to: f.state.headSha, at: new Date(1000).toISOString() }],
      verificationMarker: { sha: f.state.headSha, status: 'green' } });
    expect(exec.mock.calls.slice(0, 6).map(([, args]) => args)).toEqual([
      ['ls-remote', '--refs', 'upstream', `refs/heads/${f.state.batchRef}`],
      ['fetch', '--no-tags', 'upstream', `refs/heads/${f.state.batchRef}`],
      ['merge-base', '--is-ancestor', from, f.state.headSha],
      ['log', '--format=%B', `${from}..${f.state.headSha}`],
      ['log', '--format=', '--raw', '-z', '--no-renames', '--diff-merges=separate', `${from}..${f.state.headSha}`],
      ['ls-remote', '--refs', 'upstream', `refs/heads/${f.state.batchRef}`],
    ]);
    expect(exec.mock.calls.slice(0, 6).every(([, , options]) => options.cwd === f.dir)).toBe(true);
    expect(f.calls.findIndex(call => call.includes('verify'))).toBeLessThan(f.calls.findIndex(call => call.includes('ready')));
    expect(log.mock.calls.filter(([line]) => line.includes('adopted head'))).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`${f.state.batchRef}: ${from}→${f.state.headSha}`));
  } finally { log.mockRestore(); }
});
it('refuses a descendant range containing a coordinator commit without adopting or publishing', async () => {
  const f = fixture({ descendant: true,
    descendantMessages: 'Repair CI\n\nAdmit card 456\n\nCard-Batch: {"cardId":"456"}\n\nAnother repair\n' });
  const recorded = readFileSync(f.statePath, 'utf8');
  const from = f.state.headSha;
  f.state.headSha = 'b'.repeat(40);
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(readFileSync(f.statePath, 'utf8')).toBe(recorded);
  expect(f.read().adoptedHeads).toBeUndefined();
  expect(f.calls).toEqual([
    ['git', 'ls-remote', '--refs', 'origin', `refs/heads/${f.state.batchRef}`],
    ['git', 'fetch', '--no-tags', 'origin', `refs/heads/${f.state.batchRef}`],
    ['git', 'merge-base', '--is-ancestor', from, f.state.headSha],
    ['git', 'log', '--format=%B', `${from}..${f.state.headSha}`],
    ['git', 'ls-remote', '--refs', 'origin', `refs/heads/${f.state.batchRef}`],
  ]);
  expect(f.exec.mock.calls.every(([, , options]) => options.cwd === f.dir)).toBe(true);
});
it('refuses a descendant remote head when adoption is off', async () => {
  const f = fixture({ descendant: true });
  f.state.headSha = 'b'.repeat(40);
  expect(await publishBatch(f.input, { ...f.opts, env: { WE_CARD_BATCH_ADOPT_DESCENDANT_HEAD: 'off' } }))
    .toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(f.read().headSha).toBe('a'.repeat(40));
  expect(f.calls.every(call => call.includes('ls-remote'))).toBe(true);
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
it('tick keeps launching active batches when the sealed archive is corrupt, then reports the archive error', async () => {
  const f = fixture({ maxCards: 5 });
  mkdirSync(join(f.dir, 'sealed'));
  writeFileSync(join(f.dir, 'sealed', 'archive.json'), '{not json');
  const spawn = vi.fn(fakeChild);
  const error = await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn }).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.launched).toEqual([f.statePath]);
  expect(spawn).toHaveBeenCalledOnce();
});
it('tick keeps launching active batches when the sealed archive is unreadable as a directory', async () => {
  const f = fixture({ maxCards: 5 });
  writeFileSync(join(f.dir, 'sealed'), 'not a directory');
  const spawn = vi.fn(fakeChild);
  const error = await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn }).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.launched).toEqual([f.statePath]);
  expect(spawn).toHaveBeenCalledOnce();
});
it('tick treats a batch opened after the tick clock as age zero: no throw, no launch until due', async () => {
  const f = fixture({ maxCards: 5 });
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, openedAt: 5000 }));
  const iso = join(f.dir, 'org-repo-filing.json');
  writeFileSync(iso, JSON.stringify({ ...f.state, batchRef: 'lane/card-batch-filing-1', openedAt: new Date(5000).toISOString() }));
  const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([]);
  expect(spawn).not.toHaveBeenCalled();
});
it('tick still rejects a malformed openedAt rather than clamping it away', async () => {
  const f = fixture({ maxCards: 5 });
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, openedAt: 'yesterday' }));
  await expect(sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn: vi.fn(fakeChild) })).rejects.toThrow('openedAt');
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
  const opts = { ...f.opts, gh: async args => args.at(-1) === 'number,state,headRefName'
    ? JSON.stringify({ number: 9, headRefName: f.state.batchRef, state: 'MERGED' }) : f.exec('gh', args) };
  await publishBatch(f.input, opts);
  const active = JSON.parse(readFileSync(f.statePath, 'utf8'));
  const archived = readFileSync(active.lastSealedState, 'utf8');
  expect((await publishBatch({ statePath: active.lastSealedState }, opts)).action).toBe('sealed');
  expect(readFileSync(active.lastSealedState, 'utf8')).toBe(archived);
});

it.each([
  [{}, {}, 'on'],
  [{}, { cardBatch: { adoptDescendantHead: 'off' } }, 'off'],
  [{ WE_CARD_BATCH_ADOPT_DESCENDANT_HEAD: 'on' }, { cardBatch: { adoptDescendantHead: 'off' } }, 'on'],
  [{ WE_CARD_BATCH_ADOPT_DESCENDANT_HEAD: 'off' }, { cardBatch: { adoptDescendantHead: 'on' } }, 'off'],
  [{ WE_CARD_BATCH_ADOPT_DESCENDANT_HEAD: 'invalid' }, { cardBatch: { adoptDescendantHead: 'off' } }, 'off'],
  [{}, { cardBatch: { adoptDescendantHead: 'invalid' } }, 'on'],
])('resolves adoption from env %j and settings %j to %s', (env, settings, expected) => {
  expect(resolveAdoptDescendantHead({ env, read: () => settings })).toBe(expected);
});
it('defaults adoption on if settings cannot be read', () => {
  expect(resolveAdoptDescendantHead({ env: {}, read: () => { throw Error('unreadable'); } })).toBe('on');
});
it('reverifies an adopted head when resuming a seal that already verified the old head', async () => {
  const f = fixture({ maxCards: 1, descendant: true });
  await expect(publishBatch(f.input, { ...f.opts, crashAt: 'verify' })).rejects.toThrow('crash');
  f.state.headSha = 'b'.repeat(40);
  expect((await publishBatch(f.input, f.opts)).action).toBe('sealed');
  expect(f.calls.filter(call => call.includes('verify'))).toHaveLength(2);
  expect(f.read().verificationMarker.sha).toBe(f.state.headSha);
});

it.each([
  ['verifier edit', ':100644 100644 abc def M\0scripts/operations/run.mjs\0'],
  ['edit reverted later', ':100644 100644 abc def M\0scripts/operations/run.mjs\0\n:100644 100644 def abc M\0scripts/operations/run.mjs\0'],
  ['card symlink', ':100644 120000 abc def T\0backlog/123-card.md\0'],
  ['executable card', ':100644 100755 abc def M\0backlog/123-card.md\0'],
  ['rename out of backlog', ':100644 000000 abc 000 D\0backlog/123-card.md\0:000000 100644 000 def A\0scripts/operations/run.mjs\0'],
  ['nested path', ':000000 100644 000 def A\0backlog/sub/123-card.md\0'],
  ['newline path', ':100644 100644 abc def M\0backlog/123-card\n.md\0'],
])('refuses adoption of %s before acquiring or executing the checkout', async (_name, descendantChanges) => {
  const f = fixture({ descendant: true, descendantChanges });
  f.state.headSha = 'b'.repeat(40);
  expect(await publishBatch(f.input, f.opts)).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  expect(f.read().headSha).toBe('a'.repeat(40));
  expect(f.calls.every(call => call[0] === 'git')).toBe(true);
});

it.each(['remove-hold', 'ready'])('restores hold and draft before adopted verification after %s', async crashAt => {
  const f = fixture({ maxCards: 1, descendant: true });
  await expect(publishBatch(f.input, { ...f.opts, crashAt })).rejects.toThrow('crash');
  f.state.headSha = 'b'.repeat(40);
  const start = f.calls.length;
  const exec = (cmd, args, options) => {
    if (args[1] === 'verify') {
      const retry = f.calls.slice(start);
      expect(retry.some(call => call.includes('--add-label'))).toBe(true);
      expect(retry.some(call => call.includes('--undo'))).toBe(crashAt === 'ready');
      expect(retry.some(call => call.includes('--remove-label') || (call.includes('ready') && !call.includes('--undo')))).toBe(false);
      return JSON.stringify({ verdict: { ok: false, failed: 1, blocking: ['red adopted head'] } });
    }
    return f.exec(cmd, args, options);
  };
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('held');
});

it.each(['--add-label', '--undo'])('recovers a failed %s before refusing subsequent unsafe drift', async failedEffect => {
  const f = fixture({ maxCards: 1, descendant: true });
  await expect(publishBatch(f.input, { ...f.opts, crashAt: 'ready' })).rejects.toThrow('crash');
  f.state.headSha = 'b'.repeat(40);
  const exec = (cmd, args, options) => {
    if (args.includes(failedEffect)) throw Error('protection unavailable');
    return f.exec(cmd, args, options);
  };
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('protection unavailable');
  expect(f.read().restoreProtection).toBe(true);
  f.state.headSha = 'c'.repeat(40);
  const start = f.calls.length;
  const unsafe = (cmd, args, options) => args.includes('--raw')
    ? ':100644 100644 abc def M\0scripts/operations/run.mjs\0' : f.exec(cmd, args, options);
  expect(await publishBatch(f.input, { ...f.opts, exec: unsafe })).toEqual({ action: 'refuse', reason: 'head-mismatch' });
  const retry = f.calls.slice(start);
  expect(retry[0]).toContain('--add-label');
  expect(retry.some(call => call.includes('--undo'))).toBe(true);
  expect(retry.some(call => call.includes('verify') || call.includes('acquire'))).toBe(false);
  expect(f.read().restoreProtection).toBeUndefined();
  expect(f.read().holdApplied).toBe(true);
});


it.each(['MERGED', 'CLOSED'])('does not relaunch or publish an archived terminal %s PR', async terminalPrState => {
  const f = fixture();
  const archiveDir = join(f.dir, 'sealed'); mkdirSync(archiveDir);
  const archived = join(archiveDir, 'org-repo-1-prevention.json');
  writeFileSync(archived, JSON.stringify({ ...f.state, sealedAt: '2026-10-18', pr: 272, terminalPrState, seal: { step: 'label-on-green' } }));
  writeFileSync(f.statePath, JSON.stringify({ seq: 1, lastSealedState: archived }));
  const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([]);
  expect(spawn).not.toHaveBeenCalled();
  expect((await publishBatch({ statePath: archived }, { ...f.opts, gh: async () => JSON.stringify({
    number: 272, headRefName: f.state.batchRef, state: terminalPrState,
  }) })).action).toBe('sealed');
  expect(f.exec).not.toHaveBeenCalled();
});

it.each(['OPEN', 'wrong-pr', 'incomplete'])('a terminal archive hint still requires a complete seal and a fresh exact terminal PR: %s', async scenario => {
  const f = fixture();
  const state = { ...f.state, pr: 272, sealedAt: '2026-10-18', terminalPrState: 'MERGED',
    seal: { step: scenario === 'incomplete' ? 'ready' : 'label-on-green' } };
  writeFileSync(f.statePath, JSON.stringify(state));
  const gh = vi.fn(async () => JSON.stringify({ number: scenario === 'wrong-pr' ? 999 : 272,
    headRefName: state.batchRef, state: scenario === 'OPEN' ? 'OPEN' : 'MERGED' }));
  expect(await publishBatch(f.input, { ...f.opts, gh })).toEqual({ action: 'refuse', reason: 'batch-sealed' });
  expect(f.exec).not.toHaveBeenCalled();
  expect(gh).toHaveBeenCalledTimes(scenario === 'incomplete' ? 0 : 1);
});

it.each(['OPEN', 'UNKNOWN', null, undefined, 'unreadable', 'wrong-pr', 'wrong-branch'])(
  'never retires a sealed active batch on fresh %s evidence despite a cached terminal hint', async scenario => {
    const f = fixture();
    const state = { ...f.state, pr: 272, sealedAt: '2026-10-18', terminalPrState: 'MERGED', seal: { step: 'label-on-green' } };
    writeFileSync(f.statePath, JSON.stringify(state));
    const before = readFileSync(f.statePath, 'utf8');
    const gh = vi.fn(async () => {
      if (scenario === 'unreadable') throw Error('offline');
      return JSON.stringify({ number: scenario === 'wrong-pr' ? 999 : 272,
        headRefName: scenario === 'wrong-branch' ? 'other' : state.batchRef,
        state: ['wrong-pr', 'wrong-branch'].includes(scenario) ? 'MERGED' : scenario });
    });
    expect(await publishBatch(f.input, { ...f.opts, gh })).toMatchObject({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.statePath, 'utf8')).toBe(before);
    expect(gh).toHaveBeenCalledOnce();
  });

it('retires an active cached terminal hint only after a fresh exact PR read, retaining archive and narration', async () => {
  const f = fixture();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, pr: 272, sealedAt: '2026-10-18', terminalPrState: 'MERGED', seal: { step: 'label-on-green' } }));
  const gh = vi.fn(async () => JSON.stringify({ number: 272, headRefName: f.state.batchRef, state: 'MERGED' }));
  const log = vi.fn();
  expect((await publishBatch(f.input, { ...f.opts, gh, log })).action).toBe('sealed');
  expect(JSON.parse(readFileSync(f.statePath))).toMatchObject({ seq: 1, lastSealedState: expect.any(String) });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('GitHub MERGED: retired'));
});
