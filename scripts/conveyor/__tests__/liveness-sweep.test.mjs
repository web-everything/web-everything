// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LIVENESS_SWEEP_STANDARD as settings, LIVENESS_SWEEP_VALID, resolveLivenessSettings,
  parseRebuildLogLines, parseRebuildAlertsJsonl, parseVerifyHoldLines, findLiveOwner,
  detectStuck, planRecovery, recoveryRecord, attemptsFor, sweep } from '../liveness-sweep-core.mjs';
import { buildRoundExtensionComment } from '../round-extension-mark.mjs';
const fixture = (name) => readFileSync(new URL(`./fixtures/liveness-sweep/${name}`, import.meta.url), 'utf8');
const prFixture = (n) => JSON.parse(fixture(`pr-${n}.json`));
const now = '2026-10-13T18:00:00Z';
const old = '2026-10-13T15:00:00Z';
const pr = { repo: 'web-everything/web-everything', number: 42, movementSince: old };
const kind = (snapshot, name, at = now) => detectStuck(snapshot, settings, { now: at }).filter(f => f.kind === name);

describe('real liveness replays', () => {
  it('case a: refusal begins with the first conflict, retries then visibly escalates', () => {
    const snapshot = { rebuildAlerts: parseRebuildLogLines(fixture('case-a-drain-daemon.log'), { cloneKey: 'd7132fe6223895b4' }) };
    const findings = detectStuck(snapshot, settings, { now });
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding).toMatchObject({ kind: 'daemon-update-refused', since: '2026-10-13T16:53:05.195Z', evidence: { overlayPr: 5045 } });
    expect(planRecovery(finding, { settings })).toMatchObject({ rung: 'retry-self-update', enabled: true, safe: true });
    const ledger = [0, 1].map(() => recoveryRecord({ finding, plan: planRecovery(finding, { settings }), outcome: 'failed', at: '2026-10-13T17:40:00Z' }));
    const plan = sweep(snapshot, { settings, now, ledger })[0].plan;
    expect(plan).toMatchObject({ rung: 'refresh-stale-base', enabled: false, escalated: true, requires: 'PR #5169 operator ops', fallback: { rung: 'notify-operator', escalated: true } });
    expect(plan.op).toContain('refresh --pr=5045');
    expect(plan.reason).toContain('attempted 2×');
    expect(detectStuck(snapshot, settings, { now: '2026-10-13T17:10:00Z' })).toEqual([]);
  });
  it('case b: both finished verify gates remain held', () => {
    const findings = detectStuck({ verifyHolds: parseVerifyHoldLines(fixture('case-b-verify-daemon.log')) }, settings, { now: '2026-10-13T13:28:10.727Z' });
    expect(findings).toHaveLength(2);
    for (const [lane, prefix] of [['lane-1', 'job-verify-gate-bf3067dc-'], ['lane-5', 'job-verify-gate-20385d87-']]) {
      const f = findings.find(f => f.evidence.lane === lane);
      expect(f.since).toMatch(/^2026-10-12T22:2/);
      expect(f.evidence.jobId).toContain(prefix);
      expect(planRecovery(f, { settings })).toMatchObject({ rung: 'release-dead-lane', enabled: true, safe: true });
      expect(planRecovery(f, { settings }).op).toContain('release-lane --dir=');
    }
  });
  it('case c: cap stall needs an operator grant, and a live reviewer suppresses it', () => {
    const p = prFixture(5025);
    const findings = kind({ prs: [p], agents: [] }, 'pr-past-cap-fix-waiting', '2026-10-13T18:30:00Z');
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toMatchObject({ round: 7, cap: 5, reviewedSha: expect.stringMatching(/^8d3f2044/) });
    expect(planRecovery(findings[0], { settings })).toMatchObject({ rung: 'notify-operator', op: expect.stringContaining('extend-rounds') });
    expect(detectStuck({ prs: [p], agents: [{ name: 'review-5025', state: 'running' }] }, settings, { now })).toEqual([]);
    expect(kind({ prs: [p], agents: [{ name: 'refresh-5025', state: 'running' }] }, 'pr-past-cap-fix-waiting')).toHaveLength(1);
  });
  it('case d: red unowned PR is detect-only after sixty minutes', () => {
    const replay = (at) => { const p = prFixture(5172); return { prs: [{ ...p, state: 'OPEN', comments: p.comments.filter(c => c.createdAt < at) }], agents: [] }; };
    const findings = kind(replay('2026-10-13T15:30:00Z'), 'pr-red-unowned', '2026-10-13T15:30:00Z');
    expect(findings).toHaveLength(1);
    expect(findings[0].since).toBe('2026-10-13T14:07:46.000Z');
    expect(planRecovery(findings[0], { settings }).rung).toBe('notify-operator');
    expect(detectStuck(replay('2026-10-13T14:30:00Z'), settings, { now: '2026-10-13T14:30:00Z' })).toEqual([]);
  });
});

describe('pure rules and recovery safety', () => {
  it('resolves validated leaves through all layers and freezes defaults', () => {
    const r = resolveLivenessSettings({ platform: { prNoMovementMinutes: 90 }, tool: { rungs: { 'refresh-stale-base': true }, laneHeldMinutes: 0 }, envValues: { maxRungAttempts: 3 } });
    expect(r.settings).toMatchObject({ laneHeldMinutes: 30, maxRungAttempts: 3, prNoMovementMinutes: 90, rungs: { 'refresh-stale-base': true, 'retry-self-update': true } });
    expect(r.sources['rungs.refresh-stale-base']).toBe('tool');
    expect(r.invalid).toContain('tool.laneHeldMinutes=0');
    expect(Object.isFrozen(settings.rungs)).toBe(true);
    expect(LIVENESS_SWEEP_VALID.rungs({ x: false })).toBe(true);
    expect(LIVENESS_SWEEP_VALID.rungs({ x: 1 })).toBe(false);
    expect(resolveLivenessSettings({ tool: { rungs: { 'retry-self-update': 'yes' } } }).settings.rungs['retry-self-update']).toBe(true);
    expect(JSON.parse(readFileSync(new URL('../../settings/liveness-sweep.json', import.meta.url), 'utf8')).livenessSweep).toEqual(settings);
  });
  it('ignores chatter, human waits, drafts, closed PRs and missing timestamps', () => {
    expect(kind({ prs: [pr] }, 'pr-no-movement')).toHaveLength(1);
    for (const extra of [{ labels: [{ name: 'review:human' }] }, { isDraft: true }, { state: 'CLOSED' }]) expect(detectStuck({ prs: [{ ...pr, ...extra }] }, settings, { now })).toEqual([]);
    expect(kind({ prs: [{ number: 42, comments: [{ createdAt: old, body: 'status\nfirst' }, { createdAt: now, body: 'status\nsecond' }] }] }, 'pr-no-movement')).toHaveLength(1);
    expect(detectStuck({ prs: [{ number: 42 }] }, settings, { now })).toEqual([]);
    expect(detectStuck({}, settings, { now })).toEqual([]);
  });
  it('matches only live known owner names and whole PR tokens', () => {
    for (const name of ['fix-42', 'ci-heal-repo-42-work', 'takeover-repo-42']) expect(findLiveOwner([{ name, state: 'running' }], 42)?.name).toBe(name);
    for (const name of ['fix-420', 'random-42', 'review-142']) expect(findLiveOwner([{ name, state: 'running' }], 42)).toBeUndefined();
    for (const state of ['done', 'stopped', 'failed']) expect(findLiveOwner([{ name: 'fix-42', state }], 42)).toBeUndefined();
  });
  it('uses latest check runs, not historical failures, and excludes review-labelled red PRs', () => {
    const p = { ...pr, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', completedAt: old }, { name: 'test', conclusion: 'FAILURE', completedAt: '2026-10-13T14:00:00Z' }] };
    expect(kind({ prs: [p] }, 'pr-red-unowned')).toEqual([]);
    expect(kind({ prs: [{ ...p, labels: [{ name: 'status:ci-red' }] }] }, 'pr-red-unowned')).toHaveLength(1);
    expect(kind({ prs: [{ ...p, labels: [{ name: 'status:ci-red' }, { name: 'review:pending' }] }] }, 'pr-red-unowned')).toEqual([]);
  });
  it('honours authenticated extensions and matching short reviewed heads', () => {
    const p = { ...pr, headRefOid: 'abcdef1234', labels: [{ name: 'review-round:5' }], comments: [{ createdAt: old, body: '<!-- reviewed-sha: abcdef -->' }] };
    expect(kind({ prs: [p] }, 'pr-past-cap-fix-waiting')).toEqual([]);
    const grant = { author: { login: 'chalbert' }, createdAt: old, body: buildRoundExtensionComment({ repo: pr.repo, pr: 42, by: 1, actor: 'chalbert', channel: 'cli', reason: 'fix', at: old }) };
    expect(kind({ prs: [{ ...p, headRefOid: '999999', comments: [...p.comments, grant] }] }, 'pr-past-cap-fix-waiting')).toEqual([]);
  });
  it('parses JSONL defensively; merges state and alert refusals; adoption clears them', () => {
    const alerts = parseRebuildAlertsJsonl(`bad\n${JSON.stringify({ at: old, kind: 'clone-held-stale', detail: { reason: 'still-rejected', broken: { failed: 'branch (PR #12)' } } })}`, { cloneKey: 'c' });
    const states = [{ cloneKey: 'c', clone: 'drain', rejected: { at: old, reason: 'branch (PR #12)' }, adopted: { at: '2026-10-13T14:00:00Z' }, inProgress: null }];
    expect(detectStuck({ rebuildAlerts: alerts, rebuildStates: states }, settings, { now })).toHaveLength(1);
    expect(detectStuck({ rebuildStates: states }, settings, { now })[0].evidence.overlayPr).toBe(12);
    expect(detectStuck({ rebuildAlerts: [...alerts, { cloneKey: 'c', at: now, kind: 'ready-candidate-adopted' }], rebuildStates: states }, settings, { now })).toEqual([]);
    expect(parseRebuildLogLines('noise\n2026-10-13T15:00:00Z daemon-rebuild: clone-held-stale {bad}', { cloneKey: 'c' })).toEqual([]);
    expect(parseVerifyHoldLines('noise')).toEqual([]);
  });
  it('only reports fresh finished lane holds and dead old claims', () => {
    const hold = { at: old, pool: 'p', lane: 'lane-1', finished: true };
    expect(detectStuck({ verifyHolds: [hold] }, settings, { now })).toEqual([]);
    expect(detectStuck({ verifyHolds: [hold, { ...hold, at: now, finished: false }] }, settings, { now })).toEqual([]);
    const records = ['dead', 'unknown', 'live'].map(verdict => ({ kind: 'claim', id: verdict, verdict, ageMs: 61 * 60000, hasUnsafeWork: true }));
    const findings = detectStuck({ staleRecords: records }, settings, { now });
    expect(findings).toHaveLength(1);
    expect(findings[0].subject).toBe('claim:dead');
    expect(planRecovery(findings[0], { settings })).toMatchObject({ rung: 'release-dead-claim', enabled: false, safe: false, fallback: { rung: 'notify-operator' } });
  });
  it('counts only real attempts in the current finding lifetime and exhausts the ladder', () => {
    const f = { kind: 'daemon-update-refused', subject: 'clone:c', since: old, evidence: { overlayPr: 12 } };
    const ledger = ['dry-run', 'succeeded', 'failed', 'refused', 'escalated'].map(outcome => ({ ...f, at: now, rung: 'retry-self-update', outcome }));
    expect(attemptsFor([...ledger, { ...ledger[1], at: '2026-10-13T14:00:00Z' }, { ...ledger[1], subject: 'other' }], f)).toHaveLength(3);
    const attempts = ['retry-self-update', 'refresh-stale-base'].flatMap(rung => [{ rung, outcome: 'failed' }, { rung, outcome: 'refused' }]);
    expect(planRecovery(f, { settings, attempts })).toMatchObject({ rung: 'notify-operator', escalated: true, op: 'rebase PR #12' });
    expect(() => recoveryRecord({ finding: f, plan: planRecovery(f, { settings }), outcome: 'bogus', at: now })).toThrow();
  });
  it('never enables a rung whose op is not on main yet, even when its setting is on', () => {
    const f = { kind: 'daemon-update-refused', subject: 'clone:c', since: old, evidence: { overlayPr: 12 } };
    const on = { ...settings, rungs: { ...settings.rungs, 'refresh-stale-base': true } };
    const attempts = [{ rung: 'retry-self-update', outcome: 'failed' }, { rung: 'retry-self-update', outcome: 'failed' }];
    expect(planRecovery(f, { settings: on, attempts })).toMatchObject({ rung: 'refresh-stale-base', enabled: false, requires: 'PR #5169 operator ops' });
  });
  it('a rejection followed by later rebuild activity is moving, not stuck', () => {
    const states = [{ cloneKey: 'c', rejected: { at: old, reason: 'x' }, adopted: null, inProgress: null }];
    expect(detectStuck({ rebuildStates: states }, settings, { now })).toHaveLength(1);
    const later = { cloneKey: 'c', at: '2026-10-13T16:00:00Z', kind: 'rebuild-job-started', detail: {} };
    expect(detectStuck({ rebuildStates: states, rebuildAlerts: [later] }, settings, { now })).toEqual([]);
  });
  it('one finding per stalled PR: a specific kind suppresses the generic no-movement guard', () => {
    const red = { ...pr, labels: [{ name: 'status:ci-red' }], statusCheckRollup: [{ name: 't', conclusion: 'FAILURE', completedAt: old }] };
    expect(detectStuck({ prs: [red] }, settings, { now }).map(f => f.kind)).toEqual(['pr-red-unowned']);
  });
  it('standard plans enable only the two safe automatic rungs and operator notification', () => {
    for (const name of ['daemon-update-refused', 'verify-lane-held', 'pr-past-cap-fix-waiting', 'pr-red-unowned', 'pr-no-movement', 'claim-holder-gone']) {
      const f = { kind: name, subject: 'test', evidence: { repo: pr.repo, number: 42, dir: '~/lanes/lane-1' } };
      const plan = planRecovery(f, { settings });
      if (plan.enabled && plan.rung !== 'notify-operator') expect(['retry-self-update', 'release-dead-lane']).toContain(plan.rung);
      if (name === 'pr-past-cap-fix-waiting') expect(plan.op).toContain('--actor=<operator> --channel=<channel>');
    }
  });
});

// IO seams: no subprocess, shared ledger, desktop notification or host lock in these tests.
import { vi } from 'vitest';
import { stepMovement, prFingerprint, runSweep, createExecutors, main, gatherSnapshot, loadSettings } from '../liveness-sweep.mjs';
import movementSmell from '../health-smells/pr-no-movement.mjs';
import { validateSmellShape } from '../health-smells-shape.mjs';

describe('a recovery taking effect is not re-planned', () => {
  it('case b: a release that succeeded after the last HEALTH line drops the finding; a newer line re-opens it', () => {
    const holds = parseVerifyHoldLines(fixture('case-b-verify-daemon.log'));
    const at = '2026-10-13T13:28:10.727Z';
    const lane1 = sweep({ verifyHolds: holds }, { settings, now: at }).find(r => r.finding.evidence.lane === 'lane-1').finding;
    const released = recoveryRecord({ finding: lane1, plan: { rung: 'release-dead-lane', enabled: true }, outcome: 'succeeded', at: '2026-10-13T13:30:00Z' });
    const later = '2026-10-13T13:40:00Z';
    expect(sweep({ verifyHolds: holds }, { settings, now: later, ledger: [released] }).map(r => r.finding.evidence.lane)).toEqual(['lane-5']);
    const again = [...holds, { ...holds.find(h => h.lane === 'lane-1'), at: '2026-10-13T13:35:00Z' }];
    expect(sweep({ verifyHolds: again }, { settings, now: later, ledger: [released] }).map(r => r.finding.evidence.lane).sort()).toEqual(['lane-1', 'lane-5']);
  });
  it('case a: once a retry is scheduled (retryAt set) or a rebuild is in flight, the clone is not stuck', () => {
    const rebuildAlerts = parseRebuildLogLines(fixture('case-a-drain-daemon.log'), { cloneKey: 'd7132fe6223895b4' });
    const state = { cloneKey: 'd7132fe6223895b4', rejected: { at: '2026-10-13T16:53:05.195Z', reason: 'x', retryAt: '2026-10-13T17:50:00Z' }, adopted: null, inProgress: null };
    expect(detectStuck({ rebuildAlerts, rebuildStates: [state] }, settings, { now })).toEqual([]);
    expect(detectStuck({ rebuildAlerts, rebuildStates: [{ ...state, rejected: { ...state.rejected, retryAt: undefined }, inProgress: { startedAt: now } }] }, settings, { now })).toEqual([]);
  });
});

describe('liveness movement memory', () => {
  it('tracks first sight, unchanged fingerprints, label changes and closed PR removal', () => {
    const p = { repo: pr.repo, number: 42, headRefOid: 'abc', labels: [] };
    const first = stepMovement({}, [p], old);
    expect(first.prs[0]).not.toHaveProperty('movementSince');
    expect(stepMovement(first.store, [p], now).prs[0].movementSince).toBe(old);
    const changed = stepMovement(first.store, [{ ...p, labels: [{ name: 'review:pending' }] }], now);
    expect(changed.prs[0].movementSince).toBe(now);
    expect(changed.store[`${p.repo}#42`].since).toBe(now);
    expect(stepMovement(first.store, [{ ...p, state: 'CLOSED' }], now)).toEqual({ store: {}, prs: [] });
  });
  it('ignores check ordering and obsolete runs while tracking head and current conclusions', () => {
    const checks = [{ name: 'a', conclusion: 'FAILURE', completedAt: old }, { name: 'a', conclusion: 'SUCCESS', completedAt: now }];
    const p = { headRefOid: 'abc', labels: [{ name: 'b' }, { name: 'a' }], statusCheckRollup: checks };
    expect(prFingerprint(p)).toBe(prFingerprint({ ...p, labels: [...p.labels].reverse(), statusCheckRollup: [...checks].reverse() }));
    expect(prFingerprint(p)).toBe(prFingerprint({ ...p, statusCheckRollup: [checks[1]] }));
    expect(prFingerprint(p)).not.toBe(prFingerprint({ ...p, headRefOid: 'def' }));
  });
});

describe('liveness sweep IO execution', () => {
  const caseA = () => ({ rebuildAlerts: parseRebuildLogLines(fixture('case-a-drain-daemon.log'), { cloneKey: 'c' }) });
  it('dry-runs real case a and b without executing, notifying or recording', async () => {
    const exec = vi.fn(), notify = vi.fn(), appendLedger = vi.fn();
    for (const [snapshot, at] of [[caseA(), now], [{ verifyHolds: parseVerifyHoldLines(fixture('case-b-verify-daemon.log')) }, '2026-10-13T13:28:10.727Z']]) {
      const { results } = await runSweep({ snapshot, settings, now: at, executors: { 'retry-self-update': exec, 'release-dead-lane': exec }, notify, appendLedger });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => r.outcome === 'dry-run')).toBe(true);
    }
    expect(exec).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled(); expect(appendLedger).not.toHaveBeenCalled();
  });
  it('executes an enabled rung once and appends a system recovery', async () => {
    const exec = vi.fn(() => ({ outcome: 'succeeded', detail: 'scheduled' })), appendLedger = vi.fn();
    await runSweep({ snapshot: caseA(), settings, now, apply: true, executors: { 'retry-self-update': exec }, appendLedger });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(appendLedger).toHaveBeenCalledWith(expect.objectContaining({ actor: 'system', outcome: 'succeeded', rung: 'retry-self-update' }));
  });
  it('never executes requires plans, and escalates only once per episode with the exact fallback op', async () => {
    const snapshot = caseA(), finding = sweep(snapshot, { settings, now })[0].finding;
    const ledger = [0, 1].map(() => ({ kind: finding.kind, subject: finding.subject, at: now, rung: 'retry-self-update', outcome: 'failed' }));
    const exec = vi.fn(), notify = vi.fn(), appendLedger = row => ledger.push(row);
    const args = { snapshot, settings: { ...settings, rungs: { ...settings.rungs, 'refresh-stale-base': true } }, now, ledger, apply: true, executors: { 'refresh-stale-base': exec }, notify, appendLedger };
    const first = await runSweep(args);
    expect(first.results[0].plan.requires).toBeTruthy(); expect(exec).not.toHaveBeenCalled();
    expect(ledger.at(-1)).toMatchObject({ actor: 'system', outcome: 'escalated', rung: 'notify-operator', detail: { op: first.results[0].plan.fallback.op } });
    await runSweep(args); expect(notify).toHaveBeenCalledTimes(1);
  });
  it('deduplicates direct notifications and records delivery failures', async () => {
    const ledger = [], notify = vi.fn(() => { throw new Error('desktop unavailable'); });
    const args = { snapshot: { prs: [pr] }, settings, now, apply: true, ledger, notify, appendLedger: row => ledger.push(row) };
    await runSweep(args); await runSweep(args);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(ledger[0]).toMatchObject({ outcome: 'escalated', detail: { error: 'desktop unavailable', op: expect.stringContaining('stale-state') } });
  });
});

describe('liveness safe executors', () => {
  it('schedules retry under the lock and refuses duplicate, cleared and unavailable-lock retries', async () => {
    const state = { rejected: {} }, write = vi.fn();
    const lock = vi.fn(async (clone, fn) => ({ ok: true, value: await fn() }));
    const executor = createExecutors({ now, withWriteLock: lock, readRebuildState: () => state, writeRebuildState: write })['retry-self-update'];
    const f = { evidence: { clone: '/tmp/clone' } };
    expect((await executor(f)).outcome).toBe('succeeded');
    expect(lock).toHaveBeenCalledWith('/tmp/clone', expect.any(Function), { waitMs: 60_000 });
    expect(state.rejected).toEqual({ retryAt: now, retryScheduledBy: 'system:liveness-sweep' });
    expect((await executor(f)).detail).toContain('already scheduled'); expect(write).toHaveBeenCalledTimes(1);
    state.rejected = null; expect((await executor(f)).outcome).toBe('refused');
    const unavailable = createExecutors({ withWriteLock: async () => ({ ok: false, reason: 'busy' }), readRebuildState: vi.fn() });
    expect(await unavailable['retry-self-update'](f)).toEqual({ outcome: 'refused', detail: 'busy' });
    expect((await executor({ evidence: {} })).detail).toBe('clone root unknown');
  });
  it('proves no gate pid before releasing, refuses unknown ps and passes system attribution', async () => {
    const release = vi.fn(() => ({ claim: { id: 'job' }, setAside: [], stillHeld: [] }));
    const find = vi.fn(() => [123]);
    const executor = createExecutors({ findLaneGatePidsDefault: find, verifyJobsDir: () => '/tmp/jobs', releaseLaneByOperator: release })['release-dead-lane'];
    const f = { evidence: { dir: '/tmp/lane', finished: true } };
    expect((await executor(f)).detail).toContain('123'); expect(release).not.toHaveBeenCalled();
    find.mockImplementation(() => { throw new Error('ps failed'); });
    expect((await executor(f)).detail).toBe('ps unreadable — cannot prove'); expect(release).not.toHaveBeenCalled();
    find.mockReturnValue([]); expect((await executor(f)).outcome).toBe('succeeded');
    expect(release).toHaveBeenCalledWith({ jobsDir: '/tmp/jobs', dir: '/tmp/lane', who: 'system:liveness-sweep' });
    release.mockReturnValue({ claim: null, setAside: [], stillHeld: [] }); expect((await executor(f)).detail).toBe('nothing held');
    release.mockReturnValue({ refused: 'alive' }); expect((await executor(f)).detail).toBe('alive');
    expect((await executor({ evidence: { dir: '/tmp/lane', finished: false } })).outcome).toBe('refused');
  });
});

describe('PR no-movement smell', () => {
  it('validates shape, detects real cap stall without state and suppresses a live fixer', () => {
    expect(validateSmellShape(movementSmell, 'pr-no-movement.mjs')).toBe(movementSmell);
    const { state: ignored, ...p } = prFixture(5025);
    const ctx = { now: Date.parse('2026-10-13T18:30:00Z') };
    const rows = movementSmell.evaluate({ prs: [p], agents: [] }, ctx);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ breach: true, measure: { kind: 'pr-past-cap-fix-waiting' } });
    expect(rows[0].recommendation).toContain('extend-rounds');
    expect(movementSmell.evaluate({ prs: [p], agents: [{ name: 'fix-5025', state: 'running' }] }, ctx)[0].breach).toBe(false);
  });
});

describe('liveness CLI and optional gathering', () => {
  it('resolves env settings over injected tool/platform layers', () => {
    const result = loadSettings({ readTool: () => ({ livenessSweep: { laneHeldMinutes: 12 } }), readPlatform: () => ({ laneHeldMinutes: 20 }), env: { WE_LIVENESS_SWEEP_LANE_HELD_MINUTES: '40', WE_LIVENESS_SWEEP_RUNGS: 'bad' } });
    expect(result.settings.laneHeldMinutes).toBe(40); expect(result.sources.laneHeldMinutes).toBe('env'); expect(result.invalid.length).toBeGreaterThan(0);
  });
  it('prints one JSON object, defaults to dry-run and reports CLI errors with exit 1', async () => {
    const stdout = vi.fn(), stderr = vi.fn(), notify = vi.fn(), appendLedger = vi.fn();
    const deps = { now, stdout, stderr, notify, appendLedger, env: {}, readTool: () => ({}), readPlatform: () => undefined, gatherSnapshot: async () => ({ snapshot: { prs: [pr] }, ledger: [], errors: [{ source: 'agents', error: 'offline' }] }) };
    expect(await main(['--json'], deps)).toBe(0); expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ mode: 'DRY RUN', now, findings: [{ outcome: 'dry-run' }], errors: [{ source: 'agents' }] });
    expect(notify).not.toHaveBeenCalled(); expect(appendLedger).not.toHaveBeenCalled();
    expect(await main(['--unknown'], deps)).toBe(1); expect(stderr).toHaveBeenCalled();
  });
  it('isolates failing sources, falls back to gh and persists movement in dry-run', async () => {
    const write = vi.fn(), exec = vi.fn(() => JSON.stringify([{ number: 42, labels: ['a'], statusCheckRollup: [{ context: 'ci', conclusion: 'SUCCESS' }] }]));
    const result = await gatherSnapshot({ now, ledger: '/tmp/ledger', movementStore: '/tmp/movement' }, {
      homedir: () => '/tmp/home', env: {}, repos: { we: { slug: pr.repo } }, readSharedOpenPrs: () => { throw new Error('shared unavailable'); }, execFileSync: exec,
      cachedClaudeAgents: () => { throw new Error('agents unavailable'); }, daemonCloneRoots: () => [], readTail: () => '',
      readFile: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; }, writeMovementStore: write,
    });
    expect(result.snapshot.prs[0]).toMatchObject({ repo: pr.repo, labels: [{ name: 'a' }], statusCheckRollup: [{ name: 'ci' }] });
    expect(result.errors.map(e => e.source)).toEqual([`prs:${pr.repo}:shared`, 'agents']); expect(write).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toContain('--limit');
  });
});

describe('liveness gather paths and human output', () => {
  it('reads bounded daemon and verify tails, maps clone evidence and optional stale records', async () => {
    const tail = vi.fn(path => path.endsWith('.alerts.jsonl') ? JSON.stringify({ at: old, kind: 'clone-held-stale', detail: { reason: 'still-rejected' } }) : fixture('case-b-verify-daemon.log'));
    const exec = vi.fn(() => JSON.stringify({ verdict: { records: [{ verdict: 'dead' }] } }));
    const result = await gatherSnapshot({ now, noMovementStore: true, selfSyncDir: '/tmp/sync', verifyLog: '/tmp/verify', withStaleState: true, ledger: '/tmp/ledger' }, {
      homedir: () => '/tmp/home', env: {}, repos: {}, cachedClaudeAgents: () => '[]', daemonCloneRoots: () => [{ root: '/tmp/clone' }], cloneKey: () => 'key',
      readTail: tail, execFileSync: exec, readFile: path => path.endsWith('.rebuild.json') ? JSON.stringify({ rejected: { at: old } }) : 'bad\n{"outcome":"failed"}',
    });
    expect(result.errors).toEqual([]);
    expect(result.snapshot.rebuildStates[0]).toMatchObject({ cloneKey: 'key', clone: '/tmp/clone' });
    expect(result.snapshot.rebuildAlerts[0].clone).toBe('/tmp/clone');
    expect(tail).toHaveBeenCalledWith('/tmp/sync/key.alerts.jsonl', 256 * 1024);
    expect(tail).toHaveBeenCalledWith('/tmp/verify', 512 * 1024);
    expect(result.ledger).toEqual([{ outcome: 'failed' }]);
    expect(exec.mock.calls[0][2].timeout).toBe(240_000);
  });
  it('prints the header, cascade, plans, count and errors in order', async () => {
    const stdout = vi.fn();
    expect(await main([], { now, stdout, env: {}, readTool: () => ({}), readPlatform: () => undefined,
      gatherSnapshot: async () => ({ snapshot: { prs: [pr] }, ledger: [], errors: [{ source: 'agents', error: 'offline' }] }) })).toBe(0);
    const lines = stdout.mock.calls.map(c => c[0]);
    expect(lines[0]).toContain('liveness-sweep · DRY RUN ·');
    expect(lines[1]).toContain('policy-cascade · livenessSweep');
    expect(lines[2]).toContain('stuck since'); expect(lines[3]).toContain('notify-operator [enabled]');
    expect(lines[4]).toBe('  outcome: dry-run'); expect(lines.at(-2)).toBe('1 finding(s)'); expect(lines.at(-1)).toContain('offline');
  });
});
