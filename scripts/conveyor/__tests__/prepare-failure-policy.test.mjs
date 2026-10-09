import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPrepareFailure, recordPrepareFailure, readFailureState, validatePrepareRelease, releasedAttempt, readPrepareReleases, releaseDuePrepareRetries, takePrepareRouteHolds } from '../prepare-failure-policy.mjs';
import { planScaffold, shapeScaffoldRead } from '../../operations/scaffold.mjs';
import { writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('readPrepareReleases against a real git history', () => {
  it('keeps ancestor entries and drops non-ancestor or malformed ones without throwing', () => {
    const repo = mkdtempSync(join(tmpdir(), 'prepare-releases-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'fix');
      const fixCommit = git('rev-parse', 'HEAD');
      const good = { target: '1', attempt: 'run:a', cause: 'result-lost', evidence: 'x', fixCommit };
      const notAncestor = { ...good, attempt: 'run:b', fixCommit: 'f'.repeat(40) };
      const path = join(repo, 'releases.json');
      writeFileSync(path, JSON.stringify({ releases: [good, notAncestor, { target: '1' }] }));
      const invalid = [];
      expect(readPrepareReleases(path, repo, { onInvalid: entry => invalid.push(entry) })).toEqual([good]);
      expect(invalid).toHaveLength(2);
      writeFileSync(path, 'not json');
      expect(readPrepareReleases(path, repo)).toEqual([]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('prepare failure evidence and durable decisions', () => {
  let dir, path, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prepare-policy-')); path = join(dir, 'state.json'); fileCard = vi.fn(() => ({ ok: true, handle: 'pid:42' })); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it.each([
    [{ stoppedBeforeCompletion: true }, 'agent-stopped-early'],
    [{ sessionAbsent: true }, 'no-session'],
    [{ resultAuthored: true, resultDiscarded: true }, 'result-lost'],
    [{ error: 'HTTP 429 rate limit' }, 'infra-transient'],
    [{ error: 'ECONNRESET' }, 'infra-transient'],
    [{ error: 'wrapper-failed' }, 'unknown'],
    [{ error: 'timeout' }, 'unknown'],
    [{ resultDiscarded: true }, 'unknown'],
  ])('records evidence %j as %s', async (evidence, cause) => {
    const row = await recordPrepareFailure({ num: '1', attempt: 'run:a', stage: 'result', evidence }, { path, fileCard });
    expect(row.cause).toBe(cause);
    expect(row.held).toBe(cause !== 'infra-transient');
    expect(Object.values(readFailureState(path).failures)[0].evidence).toEqual(evidence);
    expect(classifyPrepareFailure(evidence)).toBe(cause);
  });
  it('only retries observed infrastructure faults, at most twice across restarts; rereads consume no budget', async () => {
    const input = { num: '1', stage: 'dispatch', evidence: { error: 'ECONNRESET' } };
    const first = await recordPrepareFailure({ ...input, attempt: 'a' }, { path, fileCard });
    expect(first.retry).toBe(true);
    expect(await recordPrepareFailure({ ...input, attempt: 'a' }, { path, fileCard })).toEqual(first);
    expect((await recordPrepareFailure({ ...input, attempt: 'b' }, { path, fileCard })).retry).toBe(true);
    expect((await recordPrepareFailure({ ...input, attempt: 'c' }, { path, fileCard })).held).toBe(true);
    expect(fileCard).not.toHaveBeenCalled();
  });
  it('holds unknowns and files once per distinct cause across items and restarts', async () => {
    for (const num of ['1', '2', '1']) await recordPrepareFailure({ num, attempt: 'a', stage: 'result', evidence: { causeKey: 'missing-worker-result' } }, { path, fileCard });
    expect(fileCard).toHaveBeenCalledTimes(1);
    expect(Object.values(readFailureState(path).failures).every(f => f.held && !f.retry && f.prevention.status === 'queued')).toBe(true);
  });
  it('a corrupt ledger degrades to empty state and keeps the bytes for diagnosis instead of throwing', () => {
    writeFileSync(path, '{"failures": {');
    expect(readFailureState(path)).toEqual({ failures: {}, cards: {} });
    expect(readdirSync(dir).some(n => n.includes('.corrupt-'))).toBe(true);
  });
  // #x0h3pe4 wiring: `file-item` now refuses a sized task/feature, so the card this filer hands to
  // `fileCard` must survive the REAL `planScaffold` — the mocked `fileCard` above would never notice.
  it('the prevention card it files is accepted by the real planScaffold (not refused as a sized task)', async () => {
    await recordPrepareFailure({ num: '1', attempt: 'a', stage: 'result', evidence: { causeKey: 'missing-worker-result' } }, { path, fileCard });
    const [card] = fileCard.mock.calls[0];
    const read = shapeScaffoldRead({ existingIds: ['001'], today: '2026-10-08', dir: '/repo/backlog' });
    const verdict = planScaffold(read, { ...card });
    expect(verdict.content).toMatch(/^size: 2$/m);
  });
  it('records filing failure without claiming success or blind respawning', async () => {
    fileCard.mockImplementation(() => { throw new Error('spawn refused'); });
    const input = { num: '1', attempt: 'a', stage: 'result' };
    expect((await recordPrepareFailure(input, { path, fileCard })).prevention.status).toBe('failed');
    await recordPrepareFailure(input, { path, fileCard });
    expect(fileCard).toHaveBeenCalledTimes(1);
  });
  it('refuses uncited, unknown-cause, or unapplied releases and binds accepted releases to exact attempt', () => {
    const entry = { target: '1', attempt: 'run:a', cause: 'result-lost', evidence: 'observed stamp error and repair', fixCommit: 'a'.repeat(40) };
    expect(() => validatePrepareRelease({ ...entry, fixCommit: '' }, () => true)).toThrow(/refused/);
    expect(() => validatePrepareRelease({ ...entry, cause: 'unknown' }, () => true)).toThrow(/refused/);
    expect(() => validatePrepareRelease(entry, () => false)).toThrow(/ancestor/);
    const releases = [validatePrepareRelease(entry, () => true)];
    expect(releasedAttempt(releases, '1', 'run:a')).toBe(true);
    expect(releasedAttempt(releases, '1', 'run:b')).toBe(false);
    expect(releasedAttempt(releases, 'route:prepare', 'run:a')).toBe(false);
  });
});

describe('builder-starved-2 — a prepare that never got a lane is infrastructure, not the card', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prepare-lane-infra-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const terminal = "I couldn't acquire lane 57, so no prepare pass was done on #4560.\n- `lane-pool.mjs acquire` failed with `could not determine an origin URL`.";
  it('classifies the lane-acquire origin failure as infra-transient', () => {
    expect(classifyPrepareFailure({ error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal, reason: 'prepare-unstamped' }, 'result')).toBe('infra-transient');
  });
  it('releases an old held `unknown` record of that failure (the live #4560 hold)', async () => {
    const path = join(dir, 'prepare-failures.json');
    writeFileSync(path, JSON.stringify({ failures: { '4560:run x:result': { num: '4560', attempt: 'run x', stage: 'result', cause: 'unknown',
      evidence: { error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal, reason: 'prepare-unstamped' },
      retry: false, held: true, recordedAt: '2026-10-07T12:00:00.000Z' } }, cards: {} }));
    const { releaseDuePrepareRetries } = await import('../prepare-failure-policy.mjs');
    expect(releaseDuePrepareRetries({ path, now: Date.parse('2026-10-07T19:00:00Z') })).toEqual(['4560']);
    expect(readFailureState(path).failures['4560:run x:result']).toMatchObject({ held: false, retry: true, cause: 'infra-transient', healedFrom: 'unknown' });
  });
});

// Live 2026-10-09 16:47Z: the builder's last tick listed 28 held prepares, each held after ONE attempt. Every shape
// below is copied from that ledger (we:.operations/coordination/prepare-failures.json), trimmed.
describe('held prepares (live 2026-10-09) — each failure class is handled, never held silently', () => {
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prepare-held-')); path = join(dir, 'prepare-failures.json'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const sha = '10fedba67afc9550fb9a6592282603117284c0c2';
  const laneBusy = { error: 'unexpected error: could not acquire a lane: ✗ lane-10 is leased by review-4484 (review-loop) @ 2026-10-08T22:25:28.468Z — a LIVE lease; --force does not override it (#2337).', sessionAbsent: true, resultAuthored: false, resultDiscarded: false, reason: 'prepare-unstamped' };
  const orphan = { error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal: 'Prefixing the bare paths so the gate passes.', stoppedBeforeCompletion: false, reason: 'prepare-unstamped' };
  const refLock = { reason: "Command failed: git fetch -q origin main\nerror: cannot lock ref 'refs/remotes/origin/main': is at a04b734 but expected adde7a6\n" };
  const untrusted = { error: 'claude could not be started (workspace not trusted for /Users/x/workspace/.operations/dispatch/3fa49e22) — no agent exists', reason: 'prepare-unstamped' };
  const ownCard = { error: "not built: the worker edited the item's own backlog card — refusing", sessionAbsent: false, resultAuthored: true, resultDiscarded: true, reason: 'prepare-unstamped' };
  const alreadyDone = { error: `prepare requires a card-only diff; worker report: already-done — delivered by commit '${sha}', which explicitly references this card's birth ID`, reason: 'prepare-unstamped' };
  const orphanDone = { error: 'build-dispatch-orphan-adopt: dispatch retired (prepare-unstamped)', terminal: '#4444 prepare-item → already-done — 4e75771b7 (#487 single-kind-axis migration) plus the validateBacklogItem rules.', reason: 'prepare-unstamped' };
  const couldNot = { error: 'prepare requires a card-only diff; worker report: **could-not-prepare** — #4355 leaves a genuine policy choice unresolved: boost within the tier, or pin?', reason: 'prepare-unstamped' };
  it.each([
    ['lane busy (a LIVE lease)', laneBusy, 'result', 'infra-transient'],
    ['orphan-adopt retirement', orphan, 'result', 'infra-transient'],
    ['raw git ref lock at the stamp stage', refLock, 'stamp', 'infra-transient'],
    ['workspace not trusted', untrusted, 'result', 'infra-transient'],
    ['prepare judged by a superseded card rule', ownCard, 'result', 'infra-transient'],
    ['worker report: already-done with a commit', alreadyDone, 'result', 'already-done'],
    ['orphan terminal: already-done with a commit', orphanDone, 'result', 'already-done'],
    ['worker report: could-not-prepare', couldNot, 'result', 'needs-you'],
  ])('%s classifies as %s', (_, evidence, stage, cause) => expect(classifyPrepareFailure(evidence, stage)).toBe(cause));
  it('a genuinely unrecognised failure is still unknown (held + diagnose card)', () => {
    expect(classifyPrepareFailure({ error: 'wrapper-failed' }, 'result')).toBe('unknown');
    expect(classifyPrepareFailure({ error: 'prepare requires a card-only diff; worker report: I rewrote the card' }, 'result')).toBe('unknown');
  });
  it('a fresh already-done is routed to the resolve hold, a fresh could-not-prepare is held as needs-you; neither files a diagnose card', async () => {
    const fileCard = vi.fn();
    const done = await recordPrepareFailure({ num: '4560', attempt: 'run a', stage: 'result', evidence: alreadyDone }, { path, fileCard });
    expect(done).toMatchObject({ cause: 'already-done', held: false, retry: true, routeHold: `spec already done on main: commit ${sha}` });
    const needs = await recordPrepareFailure({ num: '4355', attempt: 'run b', stage: 'result', evidence: couldNot }, { path, fileCard });
    expect(needs).toMatchObject({ cause: 'needs-you', held: true, retry: false });
    expect(needs.holdReason).toMatch(/^needs-you: prepare blocked \(needs-ruling\) - /);
    expect(fileCard).not.toHaveBeenCalled();
    // The route hold is handed out once (the daemon places it right after recording).
    expect(takePrepareRouteHolds({ path })).toEqual([]);
  });
  it('re-classifies the live held ledger on the next tick: transients retry (bounded), already-done routes, could-not-prepare is needs-you', () => {
    const held = (num, stage, cause, evidence) => [`${num}:run ${num}:${stage}`, { num, attempt: `run ${num}`, stage, cause, evidence, retry: false, held: true, recordedAt: '2026-10-09T00:00:00.000Z' }];
    writeFileSync(path, JSON.stringify({ cards: {}, failures: Object.fromEntries([
      held('4425', 'result', 'no-session', laneBusy),
      held('4414', 'result', 'unknown', orphan),
      held('4341', 'stamp', 'unknown', refLock),
      held('4426', 'result', 'unknown', untrusted),
      held('4392', 'result', 'result-lost', ownCard),
      held('4560', 'result', 'unknown', alreadyDone),
      held('4355', 'result', 'unknown', couldNot),
      held('4423', 'result', 'no-session', laneBusy),
      // #4423 already spent its infra budget: it stays held.
      ['4423:a:dispatch', { num: '4423', attempt: 'a', stage: 'dispatch', cause: 'infra-transient', evidence: {}, retry: true, held: false }],
      ['4423:b:dispatch', { num: '4423', attempt: 'b', stage: 'dispatch', cause: 'infra-transient', evidence: {}, retry: true, held: false }],
      held('9999', 'result', 'unknown', { error: 'wrapper-failed' }),
    ]) }));
    const released = releaseDuePrepareRetries({ path, now: Date.parse('2026-10-09T17:00:00Z') });
    expect(released.sort()).toEqual(['4341', '4392', '4414', '4425', '4426', '4560']);
    const f = readFailureState(path).failures;
    for (const n of ['4425', '4414', '4426', '4392']) expect(f[`${n}:run ${n}:result`]).toMatchObject({ cause: 'infra-transient', held: false, retry: true });
    expect(f['4341:run 4341:stamp']).toMatchObject({ cause: 'infra-transient', held: false, retry: true, healedFrom: 'unknown' });
    expect(f['4560:run 4560:result']).toMatchObject({ cause: 'already-done', held: false, retry: true, routeHold: `spec already done on main: commit ${sha}` });
    expect(f['4355:run 4355:result']).toMatchObject({ cause: 'needs-you', held: true, retry: false });
    expect(f['4355:run 4355:result'].holdReason).toMatch(/^needs-you: /);
    expect(f['4423:run 4423:result']).toMatchObject({ held: true });
    expect(f['9999:run 9999:result']).toMatchObject({ cause: 'unknown', held: true });
    expect(takePrepareRouteHolds({ path })).toEqual([{ num: '4560', reason: `spec already done on main: commit ${sha}` }]);
    expect(takePrepareRouteHolds({ path })).toEqual([]);
    // Idempotent: a second tick changes nothing.
    expect(releaseDuePrepareRetries({ path, now: Date.parse('2026-10-09T17:01:00Z') })).toEqual([]);
  });
  // Live 2026-10-09: #4354/#4411/#4476/#4488 stopped could-not-prepare, the operator ruled (a `## Ruling` landed on
  // each card on main), and the holds never moved. A card edit on origin/main AFTER the hold releases it, so the
  // next prepare reads the ruling; an edit from before the hold, or none, keeps it held.
  it('a needs-you hold is released when the card changed on origin/main after the hold, and only then', () => {
    const held = (num, recordedAt) => [`${num}:run ${num}:result`, { num, attempt: `run ${num}`, stage: 'result', cause: 'needs-you',
      evidence: couldNot, holdReason: 'needs-you: prepare blocked (needs-ruling) - x', retry: false, held: true, recordedAt }];
    writeFileSync(path, JSON.stringify({ cards: {}, failures: Object.fromEntries([
      held('4354', '2026-10-09T00:35:58.789Z'), held('4411', '2026-10-07T22:32:41.990Z'), held('4500', '2026-10-09T18:00:00.000Z'),
    ]) }));
    const ruling = { '4354': { commit: 'a'.repeat(40), at: '2026-10-09T17:00:32Z' }, '4411': { commit: 'b'.repeat(40), at: '2026-10-09T17:08:52Z' },
      // #4500's card last changed BEFORE its hold: no ruling yet.
      '4500': { commit: 'c'.repeat(40), at: '2026-10-09T12:00:00Z' } };
    const asked = [];
    const cardChange = (num, since) => { asked.push([num, since]); const c = ruling[num]; return c && Date.parse(c.at) > Date.parse(since) ? c : null; };
    const released = releaseDuePrepareRetries({ path, now: Date.parse('2026-10-09T19:00:00Z'), cardChange });
    expect(released.sort()).toEqual(['4354', '4411']);
    expect(asked).toContainEqual(['4354', '2026-10-09T00:35:58.789Z']);
    const f = readFailureState(path).failures;
    expect(f['4354:run 4354:result']).toMatchObject({ held: false, retry: true, releasedBy: { cardChange: 'a'.repeat(40), at: '2026-10-09T17:00:32Z' } });
    expect(f['4500:run 4500:result']).toMatchObject({ held: true, cause: 'needs-you' });
    // Idempotent; and without a card-change reader nothing is released.
    expect(releaseDuePrepareRetries({ path, now: Date.parse('2026-10-09T19:01:00Z'), cardChange })).toEqual([]);
  });
  it('a card-change reader that throws keeps the hold (fail closed) and never stops the tick', () => {
    writeFileSync(path, JSON.stringify({ cards: {}, failures: { '4354:r:result': { num: '4354', attempt: 'r', stage: 'result', cause: 'needs-you',
      evidence: couldNot, retry: false, held: true, recordedAt: '2026-10-09T00:00:00Z' } } }));
    expect(releaseDuePrepareRetries({ path, now: Date.now(), cardChange: () => { throw new Error('git broke'); } })).toEqual([]);
    expect(readFailureState(path).failures['4354:r:result']).toMatchObject({ held: true });
  });
  it('a needs-you hold is releasable by a reviewed, commit-cited release entry', () => {
    const entry = { target: '4355', attempt: 'run 4355', cause: 'needs-you', evidence: 'ruled in the card', fixCommit: 'a'.repeat(40) };
    expect(validatePrepareRelease(entry, () => true)).toEqual(entry);
  });
});
