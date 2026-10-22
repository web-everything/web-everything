// @vitest-environment node
/** Batch IO ordering, refusal and durable retry boundaries using injected transports. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireTerminalBatch } from '../card-batch-io.mjs';
import { publishBatch, sealDueBatches, HOLD_LABEL, VERIFY_UNRUN_CAP, resolveAdoptDescendantHead } from '../card-batch-seal-io.mjs';
import { loadCardBatchPolicy } from '../../lib/card-batch-policy.mjs';
import { resolveVerifyRetryMinutes } from '../../lib/card-batch-settings.mjs';
import { admissionLockRoot, admissionStatus, tryAcquireSlot } from '../../readiness/heavy-admission.mjs';
// Every git/gh call in this file is stubbed (no network); a bounded per-test timeout turns any hang into a failure.
vi.setConfig({ testTimeout: 30_000 });
const dirs = [];
afterEach(() => vi.unstubAllEnvs());
// git is stubbed through `exec`, so the proof's cat-file reader reports every blob missing: each read then takes the
// proof's `git show` fallback through the same stub (identical verdicts and errors; no real git on the fake .git).
const catFileAllMissing = (gitDir, specs) => Buffer.from(specs.map(spec => `${spec} missing\n`).join(''));
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
    opts: { exec, clock: () => 1000, policy, env: {}, catFile: catFileAllMissing }, read: () => { const saved = JSON.parse(readFileSync(statePath, 'utf8')); return saved.lastSealedState ? JSON.parse(readFileSync(saved.lastSealedState, 'utf8')) : saved; } };
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
  const [, out, err] = spawn.mock.calls[0][2].stdio;
  expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] });
  expect(out).toBe(err);
  expect(existsSync(`${f.statePath}.seal.log`)).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, sealedAt: 500, seal: { step: 'verify' } }));
  expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([f.statePath]);
});
it('an unopenable seal log never blocks the launch', async () => {
  const f = fixture(); const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn, open: () => { throw Error('EACCES'); } })).toEqual([f.statePath]);
  expect(spawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
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
])('treats a parsed verdict with %s as retryable, and defers (never holds) after the cap', async (_name, verdict) => {
  const f = fixture({ maxCards: 1 });
  const exec = (cmd, args, options) => (args[1] === 'verify' ? JSON.stringify({ verdict }) : f.exec(cmd, args, options));
  for (let attempt = 1; attempt < VERIFY_UNRUN_CAP; attempt++) {
    await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('verify unrun');
    expect(JSON.parse(readFileSync(f.statePath, 'utf8')).sealFailure).toBeUndefined();
  }
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('deferred');
  const saved = JSON.parse(readFileSync(f.statePath, 'utf8'));
  expect(saved.sealFailure).toBeUndefined();
  expect(saved.batchRef).toBeDefined();
  expect(Date.parse(saved.verifyRetryAfter)).toBe(1000 + 15 * 60_000);
  // Every caller honours the pause until it passes.
  const calls = f.calls.length;
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('deferred');
  expect(f.calls.length).toBe(calls);
  // Even after the pause passes, only the capacity-checked re-arm may clear it.
  expect((await publishBatch(f.input, { ...f.opts, exec, clock: () => 10 * 60 * 60_000 })).action).toBe('deferred');
  expect(f.calls.length).toBe(calls);
});
it('re-arm leaves a pause that was renewed after the scan', async () => {
  const f = fixture({ maxCards: 1 }); const spawn = vi.fn(fakeChild);
  unrunPausedState(f, 10_000);
  const renewed = new Date(900_000).toISOString();
  const racing = async () => { writeFileSync(f.statePath, JSON.stringify({ ...JSON.parse(readFileSync(f.statePath, 'utf8')), verifyRetryAfter: renewed })); return { freeCount: 1 }; };
  expect(await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: racing })).toEqual([]);
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).verifyRetryAfter).toBe(renewed);
});
const unrunPausedState = (f, retryAfter) => writeFileSync(f.statePath, JSON.stringify({ ...f.state, sealedAt: 500,
  seal: { step: 'record-sealed' }, verifyUnrun: VERIFY_UNRUN_CAP, verifyRetryAfter: new Date(retryAfter).toISOString() }));
it.each([
  ['all expired', [0, 1, 2], true],
  ['only fast slot expired', [2], true],
  ['all live', [], false],
])('default admission probe: %s', async (_name, expiredSlots, launches) => {
  const f = fixture({ maxCards: 1 });
  vi.stubEnv('LANE_POOL_ROOT', f.dir);
  vi.stubEnv('WE_HEAVY_ADMISSION_CAP', '2');
  vi.stubEnv('WE_HEAVY_ADMISSION_FAST_SLOTS', '1');
  const lockRoot = admissionLockRoot(f.dir);
  const now = 61 * 60_000;
  for (let slot = 0; slot < 3; slot++) {
    const acquiredAt = expiredSlots.includes(slot) ? 0 : now;
    expect(tryAcquireSlot({ lockRoot, cap: 2, slots: [slot], owner: `holder-${slot}`, pid: process.pid,
      nowMs: acquiredAt, nowIso: new Date(acquiredAt).toISOString() }).ok).toBe(true);
  }
  expect(admissionStatus({ lockRoot, cap: 2, fastSlots: 1, nowMs: now }).freeCount).toBe(0);
  unrunPausedState(f, 10_000);
  const spawn = vi.fn(fakeChild);
  expect(await sealDueBatches({ now, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual(launches ? [f.statePath] : []);
  expect(spawn).toHaveBeenCalledTimes(launches ? 1 : 0);
  expect(f.read().verifyRetryAfter).toBe(launches ? undefined : new Date(10_000).toISOString());
  const status = admissionStatus({ lockRoot, cap: 2, fastSlots: 1, nowMs: now });
  expect(status.held.every(holder => holder.owner.startsWith('holder-'))).toBe(true);
  expect(status.freeCount).toBe(launches ? 1 : 0);
});
it.each(['platform', 'repo', 'env'])('rejects an overflowing retry duration in the %s layer and retains the lower layer', layer => {
  const layers = { now: 1000, platform: { batchVerifyRetryMinutes: 7 }, repo: { batchVerifyRetryMinutes: 9 } };
  if (layer === 'platform') { layers.platform.batchVerifyRetryMinutes = 144000000000; delete layers.repo; }
  if (layer === 'repo') layers.repo.batchVerifyRetryMinutes = 144000000000;
  if (layer === 'env') layers.env = { WE_CARDS_BATCH_VERIFY_RETRY_MINUTES: '144000000000' };
  expect(resolveVerifyRetryMinutes(layers)).toBe({ platform: 15, repo: 7, env: 9 }[layer]);
});
it.each([0, -1, 1.5, true, '7', Number.MAX_SAFE_INTEGER, Infinity])('retains a valid lower retry layer for invalid duration %s', value => {
  expect(resolveVerifyRetryMinutes({ now: 1000, platform: { batchVerifyRetryMinutes: 7 },
    repo: { batchVerifyRetryMinutes: value } })).toBe(7);
});
it('accepts the last representable whole-minute duration and rejects the next minute', () => {
  const now = 1000;
  const lastMinutes = Math.floor((8_640_000_000_000_000 - now) / 60_000);
  expect(resolveVerifyRetryMinutes({ now, repo: { batchVerifyRetryMinutes: lastMinutes } })).toBe(lastMinutes);
  expect(resolveVerifyRetryMinutes({ now, platform: { batchVerifyRetryMinutes: 7 },
    repo: { batchVerifyRetryMinutes: lastMinutes + 1 } })).toBe(7);
});
it('records a durable pause on the third unrun verify despite an overflowing env setting', async () => {
  const f = fixture({ maxCards: 1 });
  vi.stubEnv('WE_CARDS_BATCH_VERIFY_RETRY_MINUTES', '144000000000');
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, verifyUnrun: VERIFY_UNRUN_CAP - 1 }));
  const exec = (cmd, args, options) => args[1] === 'verify'
    ? JSON.stringify({ verdict: { ok: false, unrun: 1 } }) : f.exec(cmd, args, options);
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('deferred');
  expect(f.read()).toMatchObject({ verifyUnrun: VERIFY_UNRUN_CAP, verifyRetryAfter: new Date(1000 + 15 * 60_000).toISOString() });
  expect(f.read().sealFailure).toBeUndefined();
});
it('re-arms a capacity-paused seal only after the pause and with a free heavy slot', async () => {
  const f = fixture({ maxCards: 1 }); const spawn = vi.fn(fakeChild);
  unrunPausedState(f, 10_000);
  const free = vi.fn(async () => ({ freeCount: 1 }));
  expect(await sealDueBatches({ now: 5000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: free })).toEqual([]);
  expect(await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: async () => ({ freeCount: 0 }) })).toEqual([]);
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).verifyUnrun).toBe(VERIFY_UNRUN_CAP);
  expect(await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: async () => { throw new Error('unreadable'); } })).toEqual([]);
  expect(await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: free })).toEqual([f.statePath]);
  const saved = JSON.parse(readFileSync(f.statePath, 'utf8'));
  expect(saved.verifyUnrun).toBeUndefined();
  expect(saved.verifyRetryAfter).toBeUndefined();
  expect(saved.sealedAt).toBe(500);
});
it('re-arm never races a running worker: a live batch lease blocks it and the pause is left untouched', async () => {
  const f = fixture({ maxCards: 1 }); const spawn = vi.fn(fakeChild);
  unrunPausedState(f, 10_000);
  const lockPath = `${f.statePath}.lock`;
  const held = JSON.stringify({ owner: 'seal:worker', expiresAt: 3_600_000, token: 'worker-token' });
  writeFileSync(lockPath, held);
  const before = readFileSync(f.statePath, 'utf8');
  const free = vi.fn(async () => ({ freeCount: 1 }));
  expect(await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: free })).toEqual([]);
  expect(spawn).not.toHaveBeenCalled();
  expect(readFileSync(f.statePath, 'utf8')).toBe(before);
  expect(readFileSync(lockPath, 'utf8')).toBe(held);
  // Once the worker's lease has expired the re-arm may proceed, and it releases its own lease afterwards.
  expect(await sealDueBatches({ now: 3_600_001, stateDir: f.dir, policy: f.opts.policy, spawn, readHeavyQueue: free })).toEqual([f.statePath]);
  expect(JSON.parse(readFileSync(f.statePath, 'utf8')).verifyRetryAfter).toBeUndefined();
  expect(existsSync(lockPath)).toBe(false);
});
it('a successful re-arm releases the batch lease for the worker it launches', async () => {
  const f = fixture({ maxCards: 1 });
  unrunPausedState(f, 10_000);
  await sealDueBatches({ now: 20_000, stateDir: f.dir, policy: f.opts.policy, spawn: vi.fn(fakeChild), readHeavyQueue: async () => ({ freeCount: 1 }) });
  expect(existsSync(`${f.statePath}.lock`)).toBe(false);
});
it('a verify that RAN and failed still holds permanently', async () => {
  const f = fixture({ maxCards: 1 });
  const exec = (cmd, args, options) => (args[1] === 'verify' ? JSON.stringify({ verdict: { ok: false, failed: 2, blocking: [{ why: 'failed' }] } }) : f.exec(cmd, args, options));
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('held');
  expect(f.read().sealFailure).toBeDefined();
  expect(f.read().verifyRetryAfter).toBeUndefined();
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

// ── #5680: a seal stuck mid-way on a PR that already MERGED ───────────────────────────────────────────────────
const MERGE = 'm'.repeat(40).replace(/m/g, 'd');
const MAIN = 'e'.repeat(40);
const RECORDED = '---\nkind: story\n---\n\n# Card 123\n\nSee backlog/123 and backlog/xold.\n';
const LANDED = '---\nbornAs: 123\nkind: story\n---\n\n# Card 123\n\nSee backlog/6597 and backlog/6311.\n';
const OLD = '---\nbornAs: xold\n---\n\n# Old card\n';
/** A merge tree on main: by default member `123` landed as backlog/6597 by content, and old card xold is #6311. */
const landedMain = ({ mergeFiles = { 'backlog/6597-card.md': LANDED, 'backlog/6311-old.md': OLD },
  recordedFiles = { 'backlog/123-card.md': RECORDED }, mergeOnMain = true, mergeOid = MERGE, recordedOid = null } = {}) => ({ mergeFiles, recordedFiles, mergeOnMain, mergeOid, recordedOid });
const terminalFixture = (prState, main = landedMain()) => {
  const f = fixture();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, pr: 9, kind: 'prevention', repo: 'org/repo', holdApplied: false,
    restoreProtection: true, sealedAt: new Date(500).toISOString(), seal: { reason: 'count', step: 'record-sealed' } }));
  const head = main.recordedOid ?? f.state.headSha;
  const tree = sha => (sha === head ? main.recordedFiles : sha === main.mergeOid ? main.mergeFiles : null);
  // The PR reads as ready (not draft), so restoring protection really runs `ready --undo` — the step that fails live.
  const exec = vi.fn((cmd, args, options) => {
    if (args[1] === 'view' && args.includes('number,state,headRefName,mergeCommit')) {
      return JSON.stringify({ number: 9, state: prState, headRefName: f.state.batchRef, mergeCommit: { oid: main.mergeOid } });
    }
    if (args[1] === 'view' && args.includes('number,state,headRefName')) return JSON.stringify({ number: 9, state: prState, headRefName: f.state.batchRef });
    if (args[1] === 'view' && args.includes('mergeCommit')) return JSON.stringify({ mergeCommit: prState === 'MERGED' ? { oid: main.mergeOid } : null });
    if (args[1] === 'view' && args.includes('isDraft')) return JSON.stringify({ isDraft: false });
    if (cmd === 'git' && args[0] === 'fetch' && args.includes('refs/heads/main')) return '';
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD^{commit}') return `${MAIN}\n`;
    if (cmd === 'git' && args[0] === 'cat-file') return '';
    if (cmd === 'git' && args[0] === 'merge-base' && args[3] === MAIN) {
      if (args[2] === main.mergeOid && main.mergeOnMain) return '';
      throw Object.assign(new Error('not an ancestor'), { status: 1 });
    }
    if (cmd === 'git' && args[0] === 'ls-tree' && args[2] === '--') {
      // `ls-tree <sha> -- <path>`: the fixture's blob id for every existing path is the fixture rev-parse value.
      return (tree(args[1]) ?? {})[args[3]] === undefined ? '' : `100644 blob ${'a'.repeat(40)}\t${args[3]}\n`;
    }
    if (cmd === 'git' && args[0] === 'ls-tree') return Object.keys(tree(args[2]) ?? {}).join('\n');
    if (cmd === 'git' && args[0] === 'grep') {
      const hits = Object.entries(main.mergeFiles).filter(([, text]) => /^bornAs: [a-z0-9]+$/m.test(text)).map(([path]) => `${main.mergeOid}:${path}`);
      if (!hits.length) throw Object.assign(new Error('no match'), { status: 1 });
      return hits.join('\n');
    }
    if (cmd === 'git' && args[0] === 'show' && /^[0-9a-f]{40}:/.test(args[1])) {
      const [sha, path] = [args[1].slice(0, 40), args[1].slice(41)];
      const text = tree(sha)?.[path];
      if (text === undefined) throw new Error(`no such path ${path}`);
      return text;
    }
    return f.exec(cmd, args, options);
  });
  return { f, exec };
};
const undoFired = (exec) => exec.mock.calls.some(([, args]) => args.includes('--undo'));
// An explicit `undefined` is a real thrown value here, not "use the default".
const failUndo = (exec, ...thrown) => vi.fn((cmd, args, options) => {
  if (args.includes('--undo')) throw (thrown.length ? thrown[0] : new Error('pull request is merged'));
  return exec(cmd, args, options);
});
const quiet = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
const activeSlot = f => JSON.parse(readFileSync(f.statePath, 'utf8'));

it('#5680: a stuck seal whose MERGED PR landed every card (proven by content) is archived and frees the slot', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  const exec = failUndo(base);
  const err = quiet();
  try {
    expect(await publishBatch(f.input, { ...f.opts, exec })).toMatchObject({ action: 'held', retired: true });
    expect(undoFired(exec)).toBe(true);
    expect(activeSlot(f)).toEqual({ seq: 1, lastSealedState: expect.stringContaining('sealed') });
    expect(f.read()).toMatchObject({ terminalPrState: 'MERGED', sealFailure: { terminalPrState: 'MERGED', reason: expect.stringContaining('step record-sealed') } });
    const spawn = vi.fn();
    expect(await sealDueBatches({ now: 1000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([]);
  } finally { err.mockRestore(); }
});
it('an unrenamed card at its admitted path with identical content also proves', async () => {
  const { f, exec: base } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/123-card.md': RECORDED } }));
  const err = quiet();
  try { expect(await publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).toMatchObject({ action: 'held', retired: true }); }
  finally { err.mockRestore(); }
});
it('the head-mismatch stuck path (merged branch deleted) uses the same proof', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), restoreProtection: undefined, holdApplied: true }));
  const exec = vi.fn((cmd, args, options) => (args[0] === 'ls-remote' ? '' : base(cmd, args, options)));
  const err = quiet();
  try {
    expect(await publishBatch(f.input, { ...f.opts, exec })).toMatchObject({ action: 'held', retired: true });
    expect(exec.mock.calls.some(([, args]) => args[1] === 'edit' || args[1] === 'ready')).toBe(false);
  } finally { err.mockRestore(); }
});

describe('the landing proof rejects every spoof and keeps the batch held with its original failure', () => {
  const held = async (main, { mismatch = false } = {}) => {
    const { f, exec: base } = terminalFixture('MERGED', main);
    if (mismatch) writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), restoreProtection: undefined, holdApplied: true }));
    const exec = mismatch ? vi.fn((cmd, args, options) => (args[0] === 'ls-remote' ? '' : base(cmd, args, options))) : failUndo(base);
    const err = quiet();
    try {
      const outcome = await publishBatch(f.input, { ...f.opts, exec }).then(v => ({ v }), e => ({ e }));
      if (mismatch) expect(outcome.v).toEqual({ action: 'refuse', reason: 'head-mismatch' });
      else { expect(outcome.e?.message).toBe('pull request is merged'); expect(undoFired(exec)).toBe(true); }
      expect(activeSlot(f).sealFailure).toBeUndefined();
      expect(activeSlot(f).lastSealedState).toBeUndefined();
      expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('not proven on main');
    } finally { err.mockRestore(); }
  };
  it('a commit message is never evidence: no matching file in the merge tree', () => held(landedMain({ mergeFiles: { 'backlog/6311-old.md': OLD } })));
  it('an unrelated file that merely shares the id prefix (different content)', () =>
    held(landedMain({ mergeFiles: { 'backlog/123-card.md': '---\nkind: story\n---\n\nsomething else\n' } })));
  it('a bornAs file whose content differs from the recorded card', () =>
    held(landedMain({ mergeFiles: { 'backlog/6597-card.md': LANDED.replace('# Card 123', '# Spoof'), 'backlog/6311-old.md': OLD } })));
  it('two files claiming the same card (ambiguous)', () =>
    held(landedMain({ mergeFiles: { 'backlog/6597-card.md': LANDED, 'backlog/6598-card.md': LANDED, 'backlog/6311-old.md': OLD } })));
  it('bornAs outside the front matter does not count', () =>
    held(landedMain({ mergeFiles: { 'backlog/6597-card.md': '---\nkind: story\n---\nbornAs: 123\n', 'backlog/6311-old.md': OLD } })));
  it('a merge commit that is not on main', () => held(landedMain({ mergeOnMain: false })));
  it('the recorded head lacks the member file', () => held(landedMain({ recordedFiles: {} })));
  it('the head-mismatch path rejects the same spoof', () => held(landedMain({ mergeFiles: { 'backlog/6311-old.md': OLD } }), { mismatch: true }));
  it('two members cannot be satisfied by one landed file', async () => {
    const { f, exec: base } = terminalFixture('MERGED', landedMain({
      recordedFiles: { 'backlog/123-card.md': RECORDED, 'backlog/456-card.md': RECORDED },
      mergeFiles: { 'backlog/123-card.md': RECORDED, 'backlog/6311-old.md': OLD } }));
    writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), members: [{ cardId: '123', source: { repo: 'org/repo' } }, { cardId: '456', source: { repo: 'org/repo' } }] }));
    const err = quiet();
    try {
      await expect(publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).rejects.toThrow('pull request is merged');
      expect(activeSlot(f).sealFailure).toBeUndefined();
    } finally { err.mockRestore(); }
  });
});

describe('retries re-run the proof and never report a refusal as held', () => {
  const recorded = (f) => writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), restoreProtection: undefined, holdApplied: true,
    sealFailure: { reason: 'PR MERGED before the seal finished', terminalPrState: 'MERGED' } }));
  it('a recorded MERGED failure whose cards are no longer provable is refused, not retired', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/6311-old.md': OLD } }));
    recorded(f);
    const err = quiet();
    try {
      expect(await publishBatch(f.input, { ...f.opts, exec })).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' });
      expect(activeSlot(f).lastSealedState).toBeUndefined();
    } finally { err.mockRestore(); }
  });
  it('a recorded MERGED failure whose proof read fails propagates that error; the next attempt retires', async () => {
    const { f, exec: base } = terminalFixture('MERGED');
    recorded(f);
    const down = new Error('gh down');
    let reads = 0;
    const exec = vi.fn((cmd, args, options) => {
      if (args[1] === 'view' && args.includes('number,state,headRefName,mergeCommit') && ++reads === 1) throw down;
      return base(cmd, args, options);
    });
    const err = quiet();
    try {
      await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toBe(down);
      expect(activeSlot(f).lastSealedState).toBeUndefined();
      expect(await publishBatch(f.input, { ...f.opts, exec })).toMatchObject({ action: 'held', retired: true });
      expect(exec.mock.calls.some(([, args]) => args.includes('--add-label'))).toBe(false);
    } finally { err.mockRestore(); }
  });
  it('a first-run retirement whose proof read fails propagates that error; the retry then retires without re-holding', async () => {
    const { f, exec: base } = terminalFixture('MERGED');
    const down = new Error('gh down');
    let reads = 0;
    const exec = failUndo(vi.fn((cmd, args, options) => {
      if (args[1] === 'view' && args.includes('number,state,headRefName,mergeCommit') && ++reads === 2) throw down;
      return base(cmd, args, options);
    }));
    const err = quiet();
    try {
      await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toBe(down);
      expect(activeSlot(f)).toMatchObject({ pr: 9, sealFailure: { terminalPrState: 'MERGED' } });
      const adds = exec.mock.calls.filter(([, args]) => args.includes('--add-label')).length;
      expect(await publishBatch(f.input, { ...f.opts, exec })).toMatchObject({ action: 'held', retired: true });
      expect(exec.mock.calls.filter(([, args]) => args.includes('--add-label')).length).toBe(adds);
    } finally { err.mockRestore(); }
  });
});

it('the stuck path keeps the original failure when the PR is not merged (a clean negative)', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  const exec = vi.fn((cmd, args, options) => {
    if (args.includes('--undo')) throw new Error('protection unavailable');
    if (args[1] === 'view' && args.includes('number,state,headRefName')) return JSON.stringify({ number: 9, state: 'OPEN', headRefName: 'lane/card-batch-prevention-1' });
    return base(cmd, args, options);
  });
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('protection unavailable');
  expect(undoFired(exec)).toBe(true);
  expect(activeSlot(f).sealFailure).toBeUndefined();
});
it.each([
  ['a GitHub read that throws', () => { throw new Error('gh timeout'); }, 'gh timeout'],
  ['a GitHub read that returns bad JSON', () => '{not json', /JSON/],
])('inside recovery, %s propagates unchanged (not the original failure)', async (_name, view, expected) => {
  const { f, exec: base } = terminalFixture('MERGED');
  const exec = failUndo(vi.fn((cmd, args, options) => (args[1] === 'view' && args.includes('number,state,headRefName') ? view() : base(cmd, args, options))));
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow(expected);
  expect(undoFired(exec)).toBe(true);
  expect(activeSlot(f).sealFailure).toBeUndefined();
});
it('inside recovery, a failed marker save propagates unchanged (not the original failure)', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  // The lease is lost after the proof passes: save() throws lease-held before the marker is written.
  const exec = failUndo(vi.fn((cmd, args, options) => {
    if (cmd === 'git' && args[0] === 'merge-base') rmSync(`${f.statePath}.lock`, { force: true });
    return base(cmd, args, options);
  }));
  const err = quiet();
  try {
    await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toThrow('lease-held');
    expect(activeSlot(f).sealFailure).toBeUndefined();
  } finally { err.mockRestore(); }
});
it.each([['a string', 'boom'], ['a plain object', { message: 'obj boom' }], ['undefined', undefined]])(
  'a stuck step that throws %s is rethrown unchanged (same value) when recovery does not complete', async (_name, value) => {
    const { f, exec: base } = terminalFixture('OPEN');
    const outcome = await publishBatch(f.input, { ...f.opts, exec: failUndo(base, value) }).then(v => ({ fulfilled: v }), e => ({ rejected: e }));
    expect('fulfilled' in outcome).toBe(false);
    expect(Object.is(outcome.rejected, value)).toBe(true);
  });
it('ID-rewrite tolerance replaces whole tokens only: backlog/xold001extra is not rewritten by xold001→#6311', async () => {
  const recorded = '---\nkind: story\n---\n\nSee backlog/xold001extra.\n';
  // If the rewrite reached inside the longer id, the recorded text would read backlog/6311extra and match this spoof.
  const spoof = '---\nbornAs: 123\nkind: story\n---\n\nSee backlog/6311extra.\n';
  const { f, exec: base } = terminalFixture('MERGED', landedMain({ recordedFiles: { 'backlog/123-card.md': recorded },
    mergeFiles: { 'backlog/6597-card.md': spoof, 'backlog/6311-old.md': '---\nbornAs: xold001\n---\n' } }));
  const err = quiet();
  try {
    await expect(publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).rejects.toThrow('pull request is merged');
    expect(activeSlot(f).sealFailure).toBeUndefined();
  } finally { err.mockRestore(); }
});
it('whole-token rewrite still applies at a token boundary (backlog/xold001 followed by punctuation)', async () => {
  const recorded = '---\nkind: story\n---\n\nSee backlog/xold001, backlog/xold001-slug.md.\n';
  const landed = '---\nbornAs: 123\nkind: story\n---\n\nSee backlog/6311, backlog/6311-slug.md.\n';
  const { f, exec: base } = terminalFixture('MERGED', landedMain({ recordedFiles: { 'backlog/123-card.md': recorded },
    mergeFiles: { 'backlog/6597-card.md': landed, 'backlog/6311-old.md': '---\nbornAs: xold001\n---\n' } }));
  const err = quiet();
  try { expect(await publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).toMatchObject({ action: 'held', retired: true }); }
  finally { err.mockRestore(); }
});
it('a same-content file at a different path without bornAs never matches', async () => {
  const { f, exec: base } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/123-other-slug.md': RECORDED, 'backlog/6311-old.md': OLD } }));
  const err = quiet();
  try {
    await expect(publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).rejects.toThrow('pull request is merged');
    expect(activeSlot(f).sealFailure).toBeUndefined();
  } finally { err.mockRestore(); }
});
it('a proof exception on retry propagates instead of becoming a refusal', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), restoreProtection: undefined, holdApplied: true,
    sealFailure: { reason: 'PR MERGED before the seal finished', terminalPrState: 'MERGED' } }));
  const boom = new Error('git ls-tree failed');
  const exec = vi.fn((cmd, args, options) => { if (cmd === 'git' && args[0] === 'ls-tree') throw boom; return base(cmd, args, options); });
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toBe(boom);
  expect(activeSlot(f).lastSealedState).toBeUndefined();
});
it('a started seal whose PR is CLOSED is left exactly as today (no failure recorded, no retire)', async () => {
  const { f, exec } = terminalFixture('CLOSED');
  await publishBatch(f.input, { ...f.opts, exec: failUndo(exec) }).catch(() => {});
  expect(activeSlot(f).sealFailure).toBeUndefined();
  expect(activeSlot(f).lastSealedState).toBeUndefined();
});
it('a MERGED view for a different branch is not trusted', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  const exec = failUndo(vi.fn((cmd, args, options) => (args[1] === 'view' && args.includes('number,state,headRefName')
    ? JSON.stringify({ number: 9, state: 'MERGED', headRefName: 'lane/other', mergeCommit: { oid: MERGE } }) : base(cmd, args, options))));
  await publishBatch(f.input, { ...f.opts, exec }).catch(() => {});
  expect(activeSlot(f).sealFailure).toBeUndefined();
});
it('a started seal whose PR is still open resumes as before', async () => {
  const f = fixture();
  writeFileSync(f.statePath, JSON.stringify({ ...f.state, pr: 9, kind: 'prevention', repo: 'org/repo', holdApplied: true,
    sealedAt: new Date(500).toISOString(), seal: { reason: 'count', step: 'record-sealed' } }));
  const exec = vi.fn((cmd, args, options) => (args[1] === 'view' && args.includes('number,state,headRefName')
    ? JSON.stringify({ number: 9, state: 'OPEN', headRefName: f.state.batchRef }) : f.exec(cmd, args, options)));
  expect((await publishBatch(f.input, { ...f.opts, exec })).action).toBe('sealed');
  expect(f.read().sealFailure).toBeUndefined();
  // Not stuck: the only PR-state read is the existing post-seal terminal retirement, after label-on-green.
  const reads = exec.mock.calls.map(([, a], i) => (a.includes('number,state,headRefName') ? i : -1)).filter(i => i >= 0);
  const sealed = exec.mock.calls.findIndex(([, a]) => a[1] === 'open-pr' && a.includes('--mode=label-on-green'));
  expect(reads).toHaveLength(1);
  expect(reads[0]).toBeGreaterThan(sealed);
});
it('#5680: protection re-armed by head adoption that fails on a merged PR takes the same recovery (proof on the adopted head)', async () => {
  const advertised = 'b'.repeat(40);
  const { f, exec: base } = terminalFixture('MERGED', landedMain({ recordedOid: advertised }));
  writeFileSync(f.statePath, JSON.stringify({ ...activeSlot(f), restoreProtection: undefined, holdApplied: true }));
  const exec = vi.fn((cmd, args, options) => {
    if (args[0] === 'ls-remote') return `${advertised}\tref`;
    if (args[0] === 'merge-base' && args[3] === advertised) return '';
    if (args[0] === 'log') return args.includes('--raw') ? ':100644 100644 abc def M\0backlog/123-card.md\0' : 'Repair CI\n';
    if (args.includes('--undo')) throw new Error('pull request is merged');
    return base(cmd, args, options);
  });
  const err = quiet();
  try {
    expect(await publishBatch(f.input, { ...f.opts, exec })).toMatchObject({ action: 'held', retired: true });
    expect(undoFired(exec)).toBe(true);
    expect(f.read()).toMatchObject({ headSha: advertised, terminalPrState: 'MERGED', sealFailure: { terminalPrState: 'MERGED' } });
  } finally { err.mockRestore(); }
});

describe('every terminal retirement of a MERGED-mid-seal batch recomputes the proof; nothing stored is evidence', () => {
  const recordedState = (f, extra = {}) => {
    const state = { ...activeSlot(f), restoreProtection: undefined, holdApplied: true,
      sealFailure: { reason: 'PR MERGED before the seal finished', terminalPrState: 'MERGED', ...extra } };
    writeFileSync(f.statePath, JSON.stringify(state));
    return state;
  };
  const reconcileRetire = (f, exec, state) => retireTerminalBatch(state, { kind: 'prevention', source: { repo: 'org/repo' }, laneDir: f.dir }, {
    statePath: f.statePath, stateDir: f.dir, gh: args => exec('gh', args), git: args => exec('git', args), held: () => true, log: () => {},
    catFile: catFileAllMissing });
  const forged = { mergeProof: { merge: MERGE, members: [{ cardId: '123', path: 'backlog/6597-card.md', blob: 'a'.repeat(40) }] }, proven: true };
  it('reconcile retires when the cards are proven from scratch', async () => {
    const { f, exec } = terminalFixture('MERGED');
    expect(await reconcileRetire(f, exec, recordedState(f))).toMatchObject({ action: 'retired' });
  });
  it('tampered state claiming a proof is ignored: with the card not landed, reconcile refuses', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/6311-old.md': OLD } }));
    expect(await reconcileRetire(f, exec, recordedState(f, forged))).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' });
    expect(activeSlot(f).lastSealedState).toBeUndefined();
  });
  it('retargeted state (a forged proof naming another path) is ignored: the real landing is what is checked', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/9999-elsewhere.md': RECORDED, 'backlog/6311-old.md': OLD } }));
    const retargeted = { mergeProof: { merge: MERGE, members: [{ cardId: '123', path: 'backlog/9999-elsewhere.md', blob: 'a'.repeat(40) }] } };
    expect(await reconcileRetire(f, exec, recordedState(f, retargeted))).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' });
  });
  it('an unrelated existing file (same content, other path, no bornAs) cannot satisfy a member at reconcile', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/777-unrelated.md': RECORDED, 'backlog/6311-old.md': OLD } }));
    expect(await reconcileRetire(f, exec, recordedState(f))).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' });
  });
  it('reconcile refuses when the merge commit is not on main (clean exit-1 no)', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeOnMain: false }));
    expect(await reconcileRetire(f, exec, recordedState(f))).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' });
  });
  it.each([
    ['fetch', args => args[0] === 'fetch'],
    ['rev-parse', args => args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD^{commit}'],
    ['merge-base', args => args[0] === 'merge-base'],
    ['ls-tree', args => args[0] === 'ls-tree'],
    ['grep', args => args[0] === 'grep'],
    ['show', args => args[0] === 'show'],
  ])('a status-128 git failure at %s propagates out of reconcile retirement (not a refusal)', async (_step, match) => {
    const { f, exec: base } = terminalFixture('MERGED');
    const boom = Object.assign(new Error('fatal: bad object'), { status: 128 });
    const exec = vi.fn((cmd, args, options) => { if (cmd === 'git' && match(args)) throw boom; return base(cmd, args, options); });
    await expect(reconcileRetire(f, exec, recordedState(f))).rejects.toBe(boom);
    expect(activeSlot(f).lastSealedState).toBeUndefined();
  });
  it('a GitHub read failure propagates out of reconcile retirement', async () => {
    const { f, exec: base } = terminalFixture('MERGED');
    const down = new Error('gh down');
    const exec = vi.fn((cmd, args, options) => { if (cmd === 'gh') throw down; return base(cmd, args, options); });
    await expect(reconcileRetire(f, exec, recordedState(f))).rejects.toBe(down);
  });
  it('the seal job stores no proof with the terminal marker', async () => {
    const { f, exec: base } = terminalFixture('MERGED');
    const err = quiet();
    try {
      expect(await publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).toMatchObject({ action: 'held', retired: true });
      expect(f.read().sealFailure).toEqual({ reason: expect.any(String), at: expect.any(String), terminalPrState: 'MERGED' });
    } finally { err.mockRestore(); }
  });
  it('an unproven first run records nothing, and reconcile cannot retire it either', async () => {
    const { f, exec: base } = terminalFixture('MERGED', landedMain({ mergeFiles: { 'backlog/6311-old.md': OLD } }));
    const err = quiet();
    try {
      await expect(publishBatch(f.input, { ...f.opts, exec: failUndo(base) })).rejects.toThrow('pull request is merged');
      expect(activeSlot(f).sealFailure).toBeUndefined();
      expect(await reconcileRetire(f, base, activeSlot(f))).toEqual({ action: 'refuse', reason: 'batch-sealed' });
    } finally { err.mockRestore(); }
  });
  it('a status-128 git failure during the seal-job retry propagates', async () => {
    const { f, exec: base } = terminalFixture('MERGED');
    recordedState(f);
    const boom = Object.assign(new Error('fatal: bad object'), { status: 128 });
    const exec = vi.fn((cmd, args, options) => { if (cmd === 'git' && args[0] === 'merge-base') throw boom; return base(cmd, args, options); });
    await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toBe(boom);
    expect(activeSlot(f).lastSealedState).toBeUndefined();
  });
  it('a clean negative (merge commit not an ancestor of main) is a refusal on seal-job retry', async () => {
    const { f, exec } = terminalFixture('MERGED', landedMain({ mergeOnMain: false }));
    recordedState(f);
    const err = quiet();
    try { expect(await publishBatch(f.input, { ...f.opts, exec })).toEqual({ action: 'refuse', reason: 'cards-not-proven-on-main' }); }
    finally { err.mockRestore(); }
  });
});

it('a first-attempt proof git failure (not a clean no) propagates instead of the original failure', async () => {
  const { f, exec: base } = terminalFixture('MERGED');
  const boom = Object.assign(new Error('fatal: bad object'), { status: 128 });
  const exec = failUndo(vi.fn((cmd, args, options) => { if (cmd === 'git' && args[0] === 'merge-base' && args[3] === MAIN) throw boom; return base(cmd, args, options); }));
  await expect(publishBatch(f.input, { ...f.opts, exec })).rejects.toBe(boom);
  expect(activeSlot(f).sealFailure).toBeUndefined();
});

it('launches the seal worker as the worker App role even when the caller is the read-only observer', async () => {
  const f = fixture(); const spawn = vi.fn(fakeChild);
  const prior = process.env.WE_GITHUB_APP_ROLE; process.env.WE_GITHUB_APP_ROLE = 'observer';
  try { expect(await sealDueBatches({ now: 60000, stateDir: f.dir, policy: f.opts.policy, spawn })).toEqual([f.statePath]); }
  finally { if (prior === undefined) delete process.env.WE_GITHUB_APP_ROLE; else process.env.WE_GITHUB_APP_ROLE = prior; }
  expect(spawn.mock.calls[0][2].env.WE_GITHUB_APP_ROLE).toBe('worker');
  expect(spawn.mock.calls[0][2].env.PATH).toBe(process.env.PATH);
});
