/**
 * Card xccgzu5 — the fix daemon consumes the session watchdog's fixer-stuck events. Live 2026-10-08: ci-heal-4453 sat
 * idle for an hour on a verify for a commit it had already pushed, holding the fix claim and a reserved ci-heal slot,
 * while `[high] fixer-stuck pr:we#4453` stayed open because nothing read the event log.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { planFixerStuckReclaim, runFixerStuckReclaimPass, formatFixerStuckReclaimLines, transcriptLastActivityMs, readJsonl, RECLAIM_ACK_BY } from '../fixer-stuck-reclaim.mjs';
import { runTickAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const NOW = Date.parse('2026-10-08T15:40:00Z');
const SID = '5536e97f-1795-4eb5-9bd1-be2de08cebdc';
const PUSHED = '299805a8e8b296093ca432a54f119fca437dc1ca';
// The exact event the watchdog wrote for #4453.
const EVENT = {
  type: 'session-watchdog.fixer-stuck', v: 1, key: `we#4453|${SID}|stalled|2a2d454d13be533b1bd72519d1984bfb8a704c1d`,
  at: '2026-10-08T15:06:53.789Z', repo: 'we', pr: 4453, claimKind: 'fixing',
  session: { name: 'ci-heal-4453', id: '5536e97f', sessionId: SID }, classification: 'stalled', reason: 'idle',
  headSha: '2a2d454d13be533b1bd72519d1984bfb8a704c1d', ask: 'escalate-fixer',
};
const CLAIM = { owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: SID } };
const AWAIT = { v: 1, sessionId: SID, who: 'ci-heal-4453', pr: 4453, sha: PUSHED, requestedAt: '2026-10-08T15:11:32.206Z', kind: 'ci-heal' };
const base = {
  events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW,
  awaitFor: () => AWAIT, prHeadFor: () => PUSHED, lastActivityMsFor: () => Date.parse('2026-10-08T14:31:02Z'),
};

describe('planFixerStuckReclaim', () => {
  it('reclaims #4453: stalled, still holding the claim, waiting on a verify for a commit that is already the PR head', () => {
    const [row] = planFixerStuckReclaim(base);
    expect(row.decision).toBe('reclaim');
    expect(row.reason).toMatch(/already the PR head/);
  });

  it('holds while the await-verify harness owns a verify for an UNPUSHED commit', () => {
    const [row] = planFixerStuckReclaim({ ...base, prHeadFor: () => '2a2d454d13be533b1bd72519d1984bfb8a704c1d' });
    expect(row.decision).toBe('hold');
    expect(row.reason).toMatch(/unpushed/);
  });

  it('holds a stalled session that came back to life', () => {
    const [row] = planFixerStuckReclaim({ ...base, lastActivityMsFor: () => NOW - 5 * 60_000 });
    expect(row.decision).toBe('hold');
  });

  it('holds a stalled session whose activity is unknown (fail closed on missing evidence)', () => {
    for (const unknown of [null, undefined, NaN]) {
      const [row] = planFixerStuckReclaim({ ...base, lastActivityMsFor: () => unknown });
      expect(row.decision).toBe('hold');
      expect(row.reason).toMatch(/activity unknown/);
    }
  });

  describe('unbound claim (no sessionId): name match alone is not proof of the holder', () => {
    const unbound = (claimedAt) => [{ owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', ...(claimedAt ? { claimedAt } : {}) } }];
    it('acks a stale event that predates the claim (an earlier session of the same name)', () => {
      const [row] = planFixerStuckReclaim({ ...base, claims: unbound('2026-10-08T15:20:00Z') });
      expect(row.decision).toBe('ack');
      expect(row.reason).toMatch(/predates/);
    });
    it('still reclaims when the event is newer than the claim', () => {
      expect(planFixerStuckReclaim({ ...base, claims: unbound('2026-10-08T14:00:00Z') })[0].decision).toBe('reclaim');
    });
    it('holds when the claim time is unknown', () => {
      expect(planFixerStuckReclaim({ ...base, claims: unbound(null) })[0].decision).toBe('hold');
    });
    it('acks a different name', () => {
      const claims = [{ meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'someone-else', claimedAt: '2026-10-08T14:00:00Z' } }];
      expect(planFixerStuckReclaim({ ...base, claims })[0].decision).toBe('ack');
    });
  });

  it('one event whose reader throws is held and the others are still planned', () => {
    const second = { ...EVENT, key: 'k-second', pr: 4500, session: { name: 'ci-heal-4500', id: 'aaaaaaaa', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' } };
    const claims = [CLAIM, { meta: { kind: 'fixing', repo: 'we', pr: 4500, who: 'ci-heal-4500', sessionId: second.session.sessionId } }];
    const rows = planFixerStuckReclaim({ ...base, events: [EVENT, second], claims, awaitFor: (sid) => { if (sid === SID) throw new Error('await store unreadable'); return null; } });
    expect(rows.map((r) => [r.key, r.decision])).toEqual([[EVENT.key, 'hold'], ['k-second', 'reclaim']]);
    expect(rows[0].reason).toMatch(/planning failed.*await store unreadable/);
  });

  it('acks a superseded event (claim gone or held by another session) and skips acked keys', () => {
    expect(planFixerStuckReclaim({ ...base, claims: [] })[0].decision).toBe('ack');
    expect(planFixerStuckReclaim({ ...base, claims: [{ meta: { ...CLAIM.meta, sessionId: 'other' } }] })[0].decision).toBe('ack');
    expect(planFixerStuckReclaim({ ...base, acked: new Set([EVENT.key]) })).toEqual([]);
  });

  it('gives a waiting-loop event a grace period before reclaiming', () => {
    const loop = { ...EVENT, key: 'k2', classification: 'waiting-loop', at: new Date(NOW - 5 * 60_000).toISOString() };
    expect(planFixerStuckReclaim({ ...base, events: [loop], awaitFor: () => null })[0].decision).toBe('hold');
    const old = { ...loop, at: new Date(NOW - 20 * 60_000).toISOString() };
    expect(planFixerStuckReclaim({ ...base, events: [old], awaitFor: () => null })[0].decision).toBe('reclaim');
  });
});

describe('runFixerStuckReclaimPass', () => {
  const io = (over = {}) => {
    const acks = [];
    const calls = { stop: vi.fn(() => ({ stopped: true })), endFix: vi.fn(async () => ({ ok: true })), release: vi.fn(() => ({ released: [{ kind: 'ci-heal' }] })), clear: vi.fn(() => true) };
    return {
      acks, calls,
      opts: {
        env: {}, nowMs: NOW, readEvents: () => [EVENT], readAcked: () => new Set(), appendAck: (a) => acks.push(a),
        listClaims: () => [CLAIM], awaitFor: () => AWAIT, clearAwait: calls.clear, prHeadFor: () => PUSHED,
        lastActivityMsFor: () => Date.parse('2026-10-08T14:31:02Z'), stopSession: calls.stop, endFix: calls.endFix, releaseDispatch: calls.release, ...over,
      },
    };
  };

  it('stops the session, fix-ends its claim as that session, releases its dispatch claim, clears the await record, acks', async () => {
    const { opts, calls, acks } = io();
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toBe('reclaimed');
    expect(calls.stop).toHaveBeenCalledWith({ handle: '5536e97f' });
    expect(calls.endFix).toHaveBeenCalledWith(expect.objectContaining({ repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: SID }));
    expect(calls.release).toHaveBeenCalledWith({ repo: 'we', pr: 4453, who: 'ci-heal-4453' });
    expect(calls.clear).toHaveBeenCalled();
    expect(acks).toEqual([expect.objectContaining({ key: EVENT.key, by: RECLAIM_ACK_BY, action: 'reclaimed' })]);
    expect(formatFixerStuckReclaimLines(r)[0]).toMatch(/PR #4453 ci-heal-4453 — reclaim → reclaimed/);
  });

  it('kill switch WE_FIXER_STUCK_RECLAIM=0 reports only', async () => {
    const { opts, calls, acks } = io({ env: { WE_FIXER_STUCK_RECLAIM: '0' } });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toMatch(/report-only/);
    expect(calls.stop).not.toHaveBeenCalled();
    expect(acks).toEqual([]);
  });

  it('preserves ownership and leaves the event unacked when stopping fails', async () => {
    for (const stopSession of [() => { throw new Error('claude stop timed out'); }, () => ({ stopped: false })]) {
      const { opts, calls, acks } = io({ stopSession });
      const r = await runFixerStuckReclaimPass(opts);
      expect(r.rows[0].result).toBe('stop-failed');
      expect(r.rows[0].steps[0]).toMatch(/^stop-failed/);
      expect(calls.endFix).not.toHaveBeenCalled();
      expect(calls.release).not.toHaveBeenCalled();
      expect(calls.clear).not.toHaveBeenCalled();
      expect(acks).toEqual([]);
    }
  });

  it('a session with no stop handle is not reclaimed', async () => {
    const noHandle = { ...EVENT, session: { name: 'ci-heal-4453' } };
    const claim = { meta: { ...CLAIM.meta, sessionId: undefined, claimedAt: '2026-10-08T14:00:00Z' } };
    const { opts, calls, acks } = io({ readEvents: () => [noHandle], listClaims: () => [claim], stopSession: (o) => { if (!o.handle) throw new Error('needs a handle'); return { stopped: true }; } });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toBe('stop-failed');
    expect(calls.endFix).not.toHaveBeenCalled();
    expect(acks).toEqual([]);
  });

  it('continues reclaiming unrelated events after one event fails planning', async () => {
    const second = { ...EVENT, key: 'k-second', pr: 4500, session: { name: 'ci-heal-4500', id: 'aaaaaaaa', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444' } };
    const claim2 = { owner: 'fixer:ci-heal-4500', meta: { kind: 'fixing', repo: 'we', pr: 4500, who: 'ci-heal-4500', sessionId: second.session.sessionId } };
    const { opts, calls, acks } = io({
      readEvents: () => [EVENT, second], listClaims: () => [CLAIM, claim2],
      awaitFor: (sid) => { if (sid === SID) throw new Error('boom'); return null; },
    });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows.map((x) => x.decision)).toEqual(['hold', 'reclaim']);
    expect(r.rows[1].result).toBe('reclaimed');
    expect(calls.endFix).toHaveBeenCalledTimes(1);
    expect(acks).toEqual([expect.objectContaining({ key: 'k-second', action: 'reclaimed' })]);
  });

  it('does not ack when fix-end was refused, so the next tick retries', async () => {
    const { opts, calls, acks } = io({ endFix: async () => ({ ok: false, reason: 'not-holder' }) });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toBe('reclaim-incomplete');
    expect(acks).toEqual([]);
    // the fix claim is still held, so the dispatch claim and the await record must stay too
    expect(calls.release).not.toHaveBeenCalled();
    expect(calls.clear).not.toHaveBeenCalled();
  });
});

describe('transcriptLastActivityMs', () => {
  const mk = (lines) => {
    const dir = mkdtempSync(join(tmpdir(), 'stuck-reclaim-'));
    mkdirSync(join(dir, 'proj'));
    writeFileSync(join(dir, 'proj', `${SID}.jsonl`), lines.join('\n') + '\n');
    return dir;
  };
  const entry = (iso, pad = '') => JSON.stringify({ type: 'assistant', timestamp: iso, pad });

  it('reads only the tail window of a transcript larger than tailBytes, and still finds the newest timestamp', () => {
    const lines = [entry('2026-10-08T10:00:00.000Z', 'x'.repeat(5000)), entry('2026-10-08T14:31:02.000Z', 'y'.repeat(500)), entry('2026-10-08T14:45:00.000Z')];
    const dir = mk(lines);
    try {
      const reads = [];
      const readRange = (file, start, len) => { reads.push({ start, len }); return readFileSync(file).subarray(start, start + len).toString('utf8'); };
      const size = statSync(join(dir, 'proj', `${SID}.jsonl`)).size;
      const last = transcriptLastActivityMs(SID, { projectsDir: dir, tailBytes: 1024, readRange });
      expect(last).toBe(Date.parse('2026-10-08T14:45:00.000Z'));
      expect(reads).toEqual([{ start: size - 1024, len: 1024 }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('falls back to the file mtime when one entry is longer than the whole window (no timestamp parses)', () => {
    const dir = mk([entry('2026-10-08T14:45:00.000Z', 'z'.repeat(5000))]);
    try {
      const file = join(dir, 'proj', `${SID}.jsonl`);
      const last = transcriptLastActivityMs(SID, { projectsDir: dir, tailBytes: 1024 });
      expect(last).toBe(statSync(file).mtimeMs);
      expect(Number.isFinite(last)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads the whole file when it is smaller than the window', () => {
    const dir = mk([entry('2026-10-08T14:31:02.000Z')]);
    try {
      expect(transcriptLastActivityMs(SID, { projectsDir: dir })).toBe(Date.parse('2026-10-08T14:31:02.000Z'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is null when the transcript cannot be found', () => {
    const dir = mk([entry('2026-10-08T14:31:02.000Z')]);
    try {
      expect(transcriptLastActivityMs('aaaaaaaa-1111-2222-3333-444444444444', { projectsDir: dir })).toBeNull();
      expect(transcriptLastActivityMs(SID, { projectsDir: join(dir, 'missing') })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('readJsonl (append-only event/ack logs)', () => {
  it('reads only the tail window of a large log, drops the partial first line, and keeps the newest records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stuck-reclaim-log-'));
    try {
      const file = join(dir, 'log.jsonl');
      const rows = Array.from({ length: 200 }, (_, i) => JSON.stringify({ key: `k${i}`, pad: 'p'.repeat(100) }));
      writeFileSync(file, rows.join('\n') + '\n');
      const size = statSync(file).size;
      const reads = [];
      const readRange = (f, start, len) => { reads.push({ start, len }); return readFileSync(f).subarray(start, start + len).toString('utf8'); };
      const out = readJsonl(file, 2000, { tailBytes: 2048, readRange });
      expect(reads).toEqual([{ start: size - 2048, len: 2048 }]);
      expect(out.at(-1).key).toBe('k199');
      expect(out.length).toBeGreaterThan(5);
      expect(out.length).toBeLessThan(200);
      expect(out.every((r) => typeof r.key === 'string')).toBe(true);
      expect(readJsonl(join(dir, 'missing.jsonl'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('runTickAllRepos wiring', () => {
  it('runs the stuck-fixer reclaim before the ci-heal dispatch half, and returns its rows', async () => {
    const order = [];
    const empty = () => ({ dispatched: [], refusals: [] });
    const result = await runTickAllRepos({
      repos: ['web-everything/web-everything'],
      authGateOverride: () => ({ paused: false, reason: null }),
      awaitVerifyTick: async () => { order.push('await'); return { rows: [] }; },
      stuckFixerTick: async () => { order.push('reclaim'); return { rows: [{ pr: 4453, decision: 'reclaim', result: 'reclaimed' }] }; },
      fixTick: () => { order.push('fix'); return empty(); },
      ciHealTick: () => { order.push('ci-heal'); return empty(); },
      hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty,
      notesTick: () => ({ notes: [], refusals: [] }), notesDryRun: true,
    });
    expect(order.slice(0, 3)).toEqual(['await', 'reclaim', 'fix']);
    expect(order).toContain('ci-heal');
    expect(result.stuckFixers.rows[0].result).toBe('reclaimed');
  });
});
