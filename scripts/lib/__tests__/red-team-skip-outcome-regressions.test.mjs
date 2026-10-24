// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRedTeamSkip, settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { publishAttention, replay } from '../../operations/needs-you-feed.mjs';
import { writeJsonAtomic } from '../atomic-json-file.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-skip-regressions-'));
  roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const input = { repo: 'web-everything/web-everything', pr: 5872, head: 'a'.repeat(40), readHead: 'a'.repeat(40), comments: [] };
  const io = { env, postComment: vi.fn(), publishNeedsYou: vi.fn(), log: vi.fn() };
  const markerDir = join(redTeamStatusDir(env), 'skip-published');
  const markers = () => existsSync(markerDir) ? readdirSync(markerDir) : [];
  const settle = (redTeam, overrides = {}) => settleRedTeamSkip({ ...input, redTeam, io, ...overrides });
  const pendingDir = join(redTeamStatusDir(env), 'skip-pending');
  const pending = () => existsSync(pendingDir) ? readdirSync(pendingDir) : [];
  return { input, io, markers, settle, pending, pendingDir };
}

function pendingRecord(input, reason, attemptId) {
  const identity = [input.repo, input.pr, input.head, reason];
  if (attemptId) identity.push(attemptId);
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { name: `${key}.json`, item: { repo: input.repo, pr: input.pr, head: input.head,
    kind: `red-team-skip-${key.slice(0, 26)}`, reason: `red team skipped (${reason}); not cleared`, title: '',
    ...(attemptId ? { attemptId } : {}) } };
}

describe('red-team skip pre-review regressions', () => {
  it('pending retry re-sanitizes and bounds reason and title before publication', () => {
    const f = fixture();
    const { name, item } = pendingRecord(f.input, 'x'.repeat(80));
    item.reason = `red team skipped (${'x'.repeat(5000)}\x1b\u202e); not cleared`;
    item.title = '\x1b\u202e' + 't'.repeat(5000);
    mkdirSync(f.pendingDir, { recursive: true });
    writeJsonAtomic(join(f.pendingDir, name), item);
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledOnce();
    const published = f.io.publishNeedsYou.mock.calls[0][0];
    expect(published.reason).toBe(`red team skipped (${'x'.repeat(80)}); not cleared`);
    expect(published.title.length).toBeLessThanOrEqual(200);
    expect(published.title).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(JSON.parse(readFileSync(join(f.pendingDir, '..', 'skip-published', name), 'utf8'))).toEqual(published);
  });

  it('pending record with a valid-shaped kind but mismatched content key is quarantined', () => {
    const f = fixture();
    const { name, item } = pendingRecord(f.input, 'original');
    item.reason = 'red team skipped (changed); not cleared';
    mkdirSync(f.pendingDir, { recursive: true });
    writeJsonAtomic(join(f.pendingDir, name), item);
    expect(f.settle({ status: 'skipped', policy: 'card-only' }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou).not.toHaveBeenCalled();
    expect(f.pending()).toEqual([`${name}.bad`]);
    expect(f.markers()).toEqual([]);
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('quarantined'));
  });

  it('unreadable pending metadata is quarantined without blocking a valid pending record', () => {
    const f = fixture();
    mkdirSync(f.pendingDir, { recursive: true });
    const broken = `${'0'.repeat(64)}.json`;
    symlinkSync(join(f.pendingDir, 'missing-target'), join(f.pendingDir, broken));
    const { name, item } = pendingRecord(f.input, 'valid after dangling symlink');
    writeJsonAtomic(join(f.pendingDir, name), item);
    expect(f.settle({ status: 'skipped', policy: 'card-only' }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou.mock.calls).toEqual([[item]]);
    expect(f.markers()).toEqual([name]);
    expect(f.pending()).toEqual([`${broken}.bad`]);
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('quarantined'));
    const logCount = f.io.log.mock.calls.length;
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.log).toHaveBeenCalledTimes(logCount);
  });

  it('legacy unknown-head pending records without attempt identity are quarantined', () => {
    const f = fixture();
    const { name, item } = pendingRecord({ ...f.input, head: 'unknown' }, 'missing head', 'old-run');
    delete item.attemptId;
    mkdirSync(f.pendingDir, { recursive: true });
    writeJsonAtomic(join(f.pendingDir, name), item);
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).not.toHaveBeenCalled();
    expect(f.pending()).toEqual([`${name}.bad`]);
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('missing pending attempt identity'));
  });

  it('unknown-head pending records retain their attempt identity across retries', () => {
    const f = fixture();
    f.io.publishNeedsYou.mockImplementationOnce(() => { throw Error('offline'); });
    f.settle({ status: 'skipped', reason: 'missing head' }, { head: 'unknown', runId: 'attempt-1' });
    const name = f.pending()[0];
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.pending()).toEqual([]);
    expect(f.markers()).toEqual([name]);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing policy', { status: 'skipped', reason: 'red team skipped: card-only' }],
    ['missing status', { policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['disabled status', { status: 'disabled', policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['error status', { status: 'error', policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['unknown policy', { status: 'skipped', policy: 'other', reason: 'red team skipped: card-only' }],
    ['unstructured input', 'red team skipped: card-only'],
  ])('policy predicate requires both structured fields: %s cannot clear', (_name, redTeam) => {
    const f = fixture();
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou.mock.calls[0][0]).toMatchObject({ kind: `red-team-skip-${createHash('sha256').update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, classifyRedTeamSkip(redTeam).reason])).digest('hex').slice(0, 26)}`,
      reason: expect.stringMatching(/^red team skipped \(.+\); not cleared$/) });
    expect(planRedTeamStatusLabels({ ...f.input, labels: ['red-team:pending'] }).add).not.toBe('red-team:clear');
  });

  it.each(['provider', 'comment failure'])('sanitizes and bounds %s reasons before publication and deterministic deduplication', source => {
    const f = fixture();
    const reason = '\n\x1b[31m\u202e\u2066' + 'x'.repeat(5000);
    if (source === 'comment failure') f.io.postComment.mockImplementation(() => { throw Error(reason); });
    const redTeam = source === 'provider' ? { status: 'error', reason } : { status: 'skipped', policy: 'card-only' };
    f.settle(redTeam);
    const item = f.io.publishNeedsYou.mock.calls[0][0];
    expect(item.reason).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(item.reason.length).toBeLessThanOrEqual('red team skipped (); not cleared'.length + 80);
    const embedded = item.reason.slice('red team skipped ('.length, -'); not cleared'.length);
    expect(embedded).toHaveLength(80);
    const key = createHash('sha256').update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, embedded])).digest('hex');
    expect(item.kind).toBe(`red-team-skip-${key.slice(0, 26)}`);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
  });

  it('failed publication leaves no marker; retry succeeds before deduplication begins', () => {
    const f = fixture(), redTeam = { status: 'skipped', reason: 'provider unavailable' };
    f.io.publishNeedsYou.mockImplementationOnce(() => { throw Error('feed unavailable'); });
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.markers()).toEqual([]);
    expect(f.io.log).toHaveBeenCalledTimes(1);
    f.io.publishNeedsYou.mockImplementationOnce(() => {
      // A marker written before publication would suppress a later retry after failure.
      expect(f.markers()).toEqual([]);
    });
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.markers()).toHaveLength(1);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.io.postComment).not.toHaveBeenCalled();
  });

  it('distinct reasons on one head survive real feed deduplication', () => {
    const f = fixture(), path = join(mkdtempSync(join(tmpdir(), 'skip-feed-')), 'feed.jsonl');
    roots.push(join(path, '..'));
    f.io.publishNeedsYou.mockImplementation(item => publishAttention(item, { path }));
    for (const reason of ['provider unavailable', 'budget unavailable']) {
      f.settle({ status: 'skipped', reason });
      const key = createHash('sha256').update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, reason])).digest('hex');
      expect(f.io.publishNeedsYou.mock.lastCall[0].kind).toBe(`red-team-skip-${key.slice(0, 26)}`);
    }
    expect(replay({ path })).toHaveLength(2);
    expect(f.markers()).toHaveLength(2);
  });

  it('colliding 32-bit reason prefixes produce two real feed lines with 40-character kinds', () => {
    const f = fixture(), path = join(f.pendingDir, '..', 'feed.jsonl');
    f.io.publishNeedsYou.mockImplementation(item => publishAttention(item, { path }));
    const reasons = ['provider unavailable 28932', 'provider unavailable 49224'];
    const keys = reasons.map(reason => createHash('sha256').update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, reason])).digest('hex'));
    expect(keys[0].slice(0, 8)).toBe(keys[1].slice(0, 8));
    reasons.forEach(reason => f.settle({ status: 'skipped', reason }));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(replay({ path }).map(item => item.kind)).toEqual(keys.map(key => `red-team-skip-${key.slice(0, 26)}`));
    expect(replay({ path }).every(item => item.kind.length === 40 && !item.kind.includes(':'))).toBe(true);
  });

  it('failed publication persists the item before publishing and another PR retries it exactly once', () => {
    const f = fixture(), redTeam = { status: 'skipped', reason: 'provider unavailable' };
    f.io.publishNeedsYou.mockImplementationOnce(item => {
      expect(f.pending()).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(f.pendingDir, f.pending()[0]), 'utf8'))).toEqual(item);
      throw Error('feed unavailable');
    });
    f.settle(redTeam);
    expect(f.pending()).toHaveLength(1);
    expect(f.markers()).toEqual([]);
    const firstItem = f.io.publishNeedsYou.mock.calls[0][0];
    f.settle({ status: 'skipped', policy: 'card-only' }, { pr: 5873 });
    expect(f.io.publishNeedsYou.mock.calls).toEqual([[firstItem], [firstItem]]);
    expect(f.pending()).toEqual([]);
    expect(f.markers()).toHaveLength(1);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
  });

  it('pending retry failure does not block current policy settlement or discard the item', () => {
    const f = fixture();
    f.io.publishNeedsYou.mockImplementation(() => { throw Error('feed unavailable'); });
    f.settle({ status: 'skipped', reason: 'quota exhausted' });
    expect(f.settle({ status: 'skipped', policy: 'card-only' }, { pr: 5873 }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.pending()).toHaveLength(1);
    expect(f.markers()).toEqual([]);
    expect(f.io.postComment).toHaveBeenCalledTimes(1);
  });

  it('flushes at most 25 pending records and leaves overflow for the next settlement', () => {
    const f = fixture();
    f.io.publishNeedsYou.mockImplementation(() => { throw Error('feed unavailable'); });
    for (let n = 0; n < 27; n++) f.settle({ status: 'skipped', reason: `pending ${n}` });
    expect(f.pending()).toHaveLength(27);
    f.io.publishNeedsYou.mockReset();
    expect(f.settle({ status: 'skipped', policy: 'card-only' }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(25);
    expect(f.pending()).toHaveLength(2);
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('remaining records retry on the next settlement'));
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(27);
    expect(f.pending()).toEqual([]);
  });

  it('unparseable pending evidence is quarantined and cannot prevent current settlement', () => {
    const f = fixture();
    f.settle({ status: 'skipped', reason: 'provider unavailable' });
    writeFileSync(join(f.pendingDir, `${'f'.repeat(64)}.json`), '{bad json');
    expect(f.settle({ status: 'skipped', policy: 'card-only' }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.pending()).toEqual([`${'f'.repeat(64)}.json.bad`]);
    expect(f.io.log).toHaveBeenCalled();
  });

  it('30 invalid records do not consume the attempt budget; one valid record publishes and poison is never rescanned', () => {
    const f = fixture();
    mkdirSync(f.pendingDir, { recursive: true });
    for (let n = 0; n < 30; n++) {
      const path = join(f.pendingDir, `${n.toString(16).padStart(64, '0')}.json`);
      writeJsonAtomic(path, n % 2 ? { repo: 'invalid' } : {});
      if (n % 2 === 0) writeFileSync(path, '{broken');
      utimesSync(path, 1, 1);
    }
    const { name, item } = pendingRecord(f.input, 'pending valid');
    writeJsonAtomic(join(f.pendingDir, name), item);
    expect(f.settle({ status: 'skipped', policy: 'card-only' }).outcome).toBe('policy-clear');
    expect(f.io.publishNeedsYou.mock.calls).toEqual([[item]]);
    expect(f.markers()).toEqual([name]);
    expect(f.pending()).toHaveLength(30);
    expect(f.pending().every(name => name.endsWith('.json.bad'))).toBe(true);
    const logCount = f.io.log.mock.calls.length;
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.log).toHaveBeenCalledTimes(logCount);
  });

  it.each([100, 4_000_000_000])('failed valid publications count toward 25 attempts and rotate oldest-first across settlements (mtime=%s)', baseTime => {
    const f = fixture(), items = [];
    mkdirSync(f.pendingDir, { recursive: true });
    for (let n = 0; n < 30; n++) {
      const { name, item } = pendingRecord(f.input, `valid ${n}`);
      items.push(item);
      const path = join(f.pendingDir, name);
      writeJsonAtomic(path, item);
      // Reverse filename order to prove that age, rather than directory order, wins.
      utimesSync(path, baseTime - n, baseTime - n);
    }
    f.io.publishNeedsYou.mockImplementation(() => { throw Error('feed unavailable'); });
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou.mock.calls.map(([item]) => item)).toEqual(items.slice(5).reverse());
    expect(f.pending()).toHaveLength(30);
    expect(f.io.log).toHaveBeenCalledWith(expect.stringContaining('remaining records retry on the next settlement'));
    f.io.publishNeedsYou.mockReset();
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(25);
    expect(f.io.publishNeedsYou.mock.calls.slice(0, 5).map(([item]) => item)).toEqual(items.slice(0, 5).reverse());
    expect(f.pending()).toHaveLength(5);
  });

  it('already-published pending records are removed without republication', () => {
    const f = fixture();
    f.settle({ status: 'skipped', reason: 'provider unavailable' });
    const item = f.io.publishNeedsYou.mock.calls[0][0];
    writeJsonAtomic(join(f.pendingDir, f.markers()[0]), item);
    f.settle({ status: 'skipped', policy: 'card-only' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.pending()).toEqual([]);
  });

  it.each([undefined, null, 'unknown', 'abc'])('policy cannot clear without a real head (%s)', head => {
    const f = fixture();
    expect(f.settle({ status: 'skipped', policy: 'card-only' }, { head, runId: 'attempt' }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ head: 'unknown' }));
  });

  it.each([undefined, null, 'unknown', 'abc', 'b'.repeat(40)])('policy cannot clear an unbound reviewed read (%s)', readHead => {
    const f = fixture();
    expect(f.settle({ status: 'skipped', policy: 'card-only' }, { readHead })).toEqual({
      outcome: 'non-policy', reason: 'policy skip head not bound to the reviewed read',
    });
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({
      head: f.input.head, reason: 'red team skipped (policy skip head not bound to the reviewed read); not cleared',
    }));
  });

  it('policy read head binding is case-insensitive', () => {
    const f = fixture();
    expect(f.settle({ status: 'skipped', policy: 'card-only' }, { readHead: f.input.head.toUpperCase() }).outcome).toBe('policy-clear');
    expect(f.io.postComment).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou).not.toHaveBeenCalled();
  });

  it('unknown-head skips without runId both publish with fresh attempt identities', () => {
    const f = fixture(), path = join(f.pendingDir, '..', 'feed.jsonl');
    f.io.publishNeedsYou.mockImplementation(item => publishAttention(item, { path }));
    for (let n = 0; n < 2; n++) f.settle({ status: 'skipped', reason: 'missing head' }, { head: 'unknown' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.markers()).toHaveLength(2);
    const items = replay({ path });
    expect(items).toHaveLength(2);
    expect(items.every(item => item.head === 'unknown')).toBe(true);
    expect(new Set(items.map(item => item.kind)).size).toBe(2);
  });

  it('unknown heads deduplicate within a run but retain different attempts', () => {
    const f = fixture();
    for (const runId of ['run-1', 'run-1', 'run-2']) f.settle({ status: 'skipped', reason: 'missing head' }, { head: 'unknown', runId });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.markers()).toHaveLength(2);
    expect(new Set(f.io.publishNeedsYou.mock.calls.map(([item]) => item.kind)).size).toBe(2);
    expect(f.io.publishNeedsYou.mock.calls.every(([item]) => item.head === 'unknown')).toBe(true);
  });

  it.each(['repo', 'pr', 'head', 'reason'])('successful publication deduplicates by repo/PR/head/reason: changing %s publishes again', field => {
    const f = fixture(), reason = 'provider unavailable';
    const redTeam = { status: 'skipped', reason };
    f.settle(redTeam);
    const expectedKey = createHash('sha256')
      .update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, reason])).digest('hex');
    expect(f.markers()).toEqual([`${expectedKey}.json`]);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    const changed = { repo: 'frontier-ui/frontierui', pr: 5873, head: 'b'.repeat(40), reason: 'missing input' };
    const next = field === 'reason' ? { ...redTeam, reason: changed.reason } : redTeam;
    const overrides = field === 'reason' ? {} : { [field]: changed[field] };
    f.settle(next, overrides);
    f.settle(next, overrides);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.markers()).toHaveLength(2);
    expect(f.io.postComment).not.toHaveBeenCalled();
  });
});
