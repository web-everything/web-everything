import { deliverItemDetachedProvider } from '../../operations/dispatch-providers/build.mjs';
import { defaultSpawnDetached, defaultSpawnDiagnosticDetached, DiagnosticTargetError, REPO_ROOT } from '../../operations/detached-dispatch.mjs';
import { routeDispatchProvider, defaultClaudeProvider, spawnAgentToCompletion, reserveBuildLane } from '../../operations/dispatch-lane-io.mjs';
import { cliRetryInfraBlocked, cliEffects } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { resumeOpen, infraRecoveryCard, parseInfraStore } from '../../conveyor/infra-blocked.mjs';
import * as prevention from '../prevention-landing-job.mjs';
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideRuntimeAdmission, assertRuntimeAdmitted, withRuntimeAdmission, setRuntimeAdmissionCards, withRuntimeAdmissionTick } from '../runtime-admission.mjs';
import { readBuildPrioritySettings } from '../build-queue.mjs';
import { routeHeldItems } from '../../conveyor/build-dispatch-hold-router.mjs';

const admission = { assertRuntimeAdmitted, withRuntimeAdmission };
const only = ids => ({ mode: 'only', only: true, ids });
it.each([
  [{ num: 12 }, only(['12']), true],
  [{ num: 13 }, only(['12']), false],
  [{ num: 13 }, only([]), false],
  [{ num: 13 }, { mode: 'lift', ids: [] }, true],
  [{ num: 13 }, {}, true],
  [{ num: 12 }, { held: true, mode: 'lift', ids: ['12'] }, false],
  [{ num: 12, bornAs: 'xabcdef0' }, only(['xabcdef0']), true],
  [{ num: 12, bornAs: 'xBAD' }, only(['xBAD']), false],
  [{ num: 12, id: 'xabcdef0-title' }, only(['xabcdef0']), true],
  [{ num: 12, id: '13-title' }, only(['13']), false],
  [{ num: 12, id: 'xBAD-title' }, only(['xBAD']), false],
  ...['13', 13, '#13', 'xabc'].map(bornAs => [{ num: 12, bornAs }, only([String(bornAs)]), false]),
])('pure admission for %j with %j is %s', (card, settings, admitted) => {
  for (const kind of ['build', 'prepare', 'route', 'resume']) expect(decideRuntimeAdmission(card, kind, settings).admitted).toBe(admitted);
});
it('held or unreadable settings fail closed with a repairable reason', () => {
  expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings: () => { throw new Error('EACCES'); } }))
    .toEqual({ admitted: false, reason: 'runtime-malformed' });
  expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings: () => undefined }).admitted).toBe(false);
});
it('fresh file reads see only → held → lift and environment never widens the runtime list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-admission-'));
  const runtimePath = join(dir, 'priority.json');
  const write = mode => writeFileSync(runtimePath, JSON.stringify({ ids: ['12'], mode, at: new Date().toISOString(), setBy: 'test', ttlHours: 24 }));
  const readSettings = () => readBuildPrioritySettings({ runtimePath, env: { WE_BUILD_PRIORITY: '12,13' } });
  try {
    write('only');
    expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings }).admitted).toBe(true);
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(false);
    writeFileSync(runtimePath, '{');
    expect(assertRuntimeAdmitted({ num: 12 }, 'build', { readSettings }).reason).toBe('runtime-malformed');
    write('lift');
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(true);
    rmSync(runtimePath);
    expect(assertRuntimeAdmitted({ num: 13 }, 'build', { readSettings }).admitted).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each([only([]), { held: true }])('hold routing admits no work or reservations with %j', async settings => {
  const spawnLand = vi.fn(), reserveRoute = vi.fn(), recordFinding = vi.fn();
  const result = await routeHeldItems({ plan: ['already-done', 'out-of-scope', 'other'].map(route => ({ num: '12', route })),
    readSettings: () => settings, spawnLand, reserveRoute, recordFinding });
  expect(result.every(r => r.action === 'runtime-refused')).toBe(true);
  expect(spawnLand).not.toHaveBeenCalled();
  expect(reserveRoute).not.toHaveBeenCalled();
  expect(recordFinding).not.toHaveBeenCalled();
});
it('records unique refusals on the row and logs once per tick', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = await withRuntimeAdmissionTick(() => only([]), async () => {
      assertRuntimeAdmitted({ num: 12 }, 'build');
      assertRuntimeAdmitted({ num: 12 }, 'build');
      assertRuntimeAdmitted({ num: 12 }, 'prepare');
      return {};
    });
    expect(result.runtimeRefused).toEqual([{ num: '12', kind: 'build', reason: 'runtime-only' }, { num: '12', kind: 'prepare', reason: 'runtime-only' }]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});

it.each([only([]), { held: true }, only(['13'])])('infra recovery refuses before exec and reports the retained card with %j', async settings => {
  const exec = vi.fn();
  const stored = [{ num: '12', ref: 'lane/12' }];
  const report = await withRuntimeAdmissionTick(() => settings, async () => cliRetryInfraBlocked({ exec, readEntries: () => stored }));
  expect(exec).not.toHaveBeenCalled();
  expect(report.failed).toEqual([{ num: '12', refused: true, reason: settings.held ? 'runtime-malformed' : 'runtime-only' }]);
  expect(report.runtimeRefused).toHaveLength(1);
  expect(stored).toEqual([{ num: '12', ref: 'lane/12' }]);
});
it('infra recovery refuses an unchecked group and scopes admitted retries to one card', async () => {
  const exec = vi.fn(() => JSON.stringify({ retried: ['12'] }));
  const entry = { num: '12', groupMembers: ['13'] };
  const refused = await withRuntimeAdmissionTick(() => only(['12']), async () => cliRetryInfraBlocked({ exec, readEntries: () => [entry] }));
  expect(exec).not.toHaveBeenCalled();
  expect(refused.failed[0]).toMatchObject({ num: '12', refused: true });
  await withRuntimeAdmissionTick(() => only(['12', '13']), async () => cliRetryInfraBlocked({ exec, readEntries: () => [entry] }));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1][0]).toMatch(/build-dispatch-daemon\.mjs$/);
  expect(exec.mock.calls[0][1].slice(-3)).toEqual(['--infra-retry', 'retry', '--num=12']);
});
it('infra recovery rechecks settings in resumeOpen before any subprocess, including unreadable settings', () => {
  for (const readSettings of [() => only([]), () => ({ held: true }), () => { throw new Error('unreadable'); }, () => only(['12'])]) {
    const exec = vi.fn();
    const result = resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12' }, { admission, exec, readSettings });
    expect(result).toMatchObject({ ok: false, refused: true });
    expect(exec).not.toHaveBeenCalled();
  }
});
it('resumeOpen publishes only after admitting lead and every group member', () => {
  const sha = 'a'.repeat(40);
  const exec = vi.fn((cmd, argv) => cmd === 'git' ? sha : JSON.stringify({ pr: 77 }));
  expect(resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12', sha }, { admission, exec, readSettings: () => only(['12', '13']) }))
    .toMatchObject({ ok: true, prNumber: 77 });
  expect(exec.mock.calls.at(-1)[0]).toBe('node');
  expect(exec.mock.calls.at(-1)[1]).toContain('--label-on-green');
});
it('historical infra records recover group membership from the original dispatch and refuse missing evidence', () => {
  const entry = { num: '12', builderContext: 'historical' };
  const readContext = () => ({ entry: { payload: { num: '12', groupMembers: ['13'] } } });
  expect(infraRecoveryCard(entry, { readContext }).groupMembers).toEqual(['13']);
  expect(() => infraRecoveryCard(entry, { readContext: () => null })).toThrow(/unproven/);
  expect(() => infraRecoveryCard(entry)).toThrow(/unproven/);
  const exec = vi.fn();
  expect(resumeOpen(entry, { admission, exec, readContext: () => { throw new Error('missing run'); }, readSettings: () => only(['12']) }).refused).toBe(true);
  expect(exec).not.toHaveBeenCalled();
  expect(parseInfraStore(JSON.stringify([{ num: '12', groupMembers: ['13'] }]))[0].groupMembers).toEqual(['13']);
});
it('unknown prepare diagnostics still file once under an empty runtime allowlist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-diagnostic-'));
  const file = vi.spyOn(prevention, 'spawnPreventionLandingJob').mockReturnValue({ ok: true });
  vi.stubEnv('WE_COORDINATION_ROOT', dir);
  try {
    const effects = cliEffects();
    const input = { num: '12', attempt: 'one', stage: 'stamp', evidence: { error: 'unrecognized failure' } };
    const report = await withRuntimeAdmissionTick(() => only([]), async () => effects.recordPrepareFailure(input));
    expect(report.prevention.status).toBe('queued');
    expect(file).toHaveBeenCalledTimes(1);
    expect(file.mock.calls[0][0].num).toBeUndefined();
    await effects.recordPrepareFailure(input);
    expect(file).toHaveBeenCalledTimes(1);
  } finally { file.mockRestore(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});

it('direct delivery ports refuse an empty allowlist before providers, agents or lane acquisition', async () => {
  const effect = vi.fn();
  await withRuntimeAdmissionTick(() => only([]), async () => {
    const card = { num: '12', launchKind: 'build', lane: 1, sessionSlug: 'conveyor-12' };
    for (const launch of [
      () => routeDispatchProvider(card, { agent: effect }),
      () => defaultClaudeProvider(card, { spawnAgent: effect }),
      () => spawnAgentToCompletion([], {}, { card, spawnFn: effect }),
      () => reserveBuildLane(card, { enabled: true, run: effect }),
    ]) expect(launch).toThrow(/runtime admission refused/);
    expect(effect).not.toHaveBeenCalled();
    return {};
  });
});

it('a damaged historical infra identity is retained and a healthy following entry still executes', async () => {
  const entries = [{ num: '12', builderContext: '{' }, { num: '13' }];
  const before = structuredClone(entries);
  const exec = vi.fn(() => JSON.stringify({ retried: ['13'] }));
  const result = await withRuntimeAdmissionTick(() => only(['12', '13']), async () =>
    cliRetryInfraBlocked({ exec, readEntries: () => entries }));
  expect(result.failed).toEqual([{ num: '12', refused: true, reason: 'unproven infra recovery identity',
    detail: 'Entry retained; repair its original dispatch context before retrying.' }]);
  expect(result.retried).toEqual(['13']);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1].slice(-2)).toEqual(['retry', '--num=13']);
  expect(entries).toEqual(before);
});

it('launch admission reads once for the whole group and never partially launches', () => {
  const effect = vi.fn(() => 'launched');
  const readSettings = vi.fn(() => only(['12']));
  const result = withRuntimeAdmission({ num: 12, groupMembers: [12, 13] }, 'draft-recovery', effect, { readSettings });
  expect(result).toMatchObject({ outcome: 'runtime-refused', runtimeRefused: [{ num: '13', kind: 'draft-recovery', reason: 'runtime-only' }] });
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(effect).not.toHaveBeenCalled();
  expect(withRuntimeAdmission({ num: 12, groupMembers: [12, 13] }, 'draft-recovery', effect, { readSettings: () => only(['12', '13']) })).toBe('launched');
  expect(effect).toHaveBeenCalledTimes(1);
});
it.each([null, {}, '13', [null], [undefined], [''], ['12', {}], ['not-a-card'], ['xBAD'], [NaN], [Infinity], [1.5], ['12\n'], Array(1)].map(groupMembers => [groupMembers]))('malformed group %j refuses with operator-repair evidence', groupMembers => {
  const effect = vi.fn();
  expect(withRuntimeAdmission({ num: 12, groupMembers }, 'build', effect, { readSettings: () => ({ mode: 'lift' }) }))
    .toMatchObject({ outcome: 'runtime-refused', reason: 'runtime-malformed' });
  expect(effect).not.toHaveBeenCalled();
});
it.each([undefined, [], ['12', 13, 'xabc123']].map(groupMembers => [groupMembers]))('valid or absent group %j launches exactly once', groupMembers => {
  const effect = vi.fn(() => 'launched');
  expect(withRuntimeAdmission({ num: 12, groupMembers }, 'build', effect, { readSettings: () => ({ mode: 'lift' }) })).toBe('launched');
  expect(effect).toHaveBeenCalledTimes(1);
});
it('infra publish rechecks after git reads revoke the whole allowlist', () => {
  const sha = 'a'.repeat(40);
  let settings = only(['12', '13']);
  const exec = vi.fn((command) => {
    if (command === 'git') { settings = only([]); return sha; }
    throw new Error('pr-land must never launch');
  });
  const result = resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12', sha }, { admission, exec, readSettings: () => settings });
  expect(result).toMatchObject({ outcome: 'runtime-refused', ok: false, refused: true });
  expect(exec).toHaveBeenCalledTimes(2);
  expect(exec.mock.calls.every(([command]) => command === 'git')).toBe(true);
});

it('nested launch re-reads the injected reader after intermediate work revokes admission', () => {
  let settings = only(['12', '13']);
  const effect = vi.fn();
  const result = withRuntimeAdmission({ num: 12, groupMembers: [13] }, 'build', () => {
    settings = only(['12']);
    return withRuntimeAdmission({ num: 12, groupMembers: [13] }, 'build', effect);
  }, { readSettings: () => settings });
  expect(result).toMatchObject({ outcome: 'runtime-refused' });
  expect(effect).not.toHaveBeenCalled();
});

it.each(['12', '13', '14'])('nested lead-only boundaries retain every outer roster and their own identity when %s is revoked', revoked => {
  let settings = only(['12', '13', '14']);
  const readSettings = vi.fn(() => settings);
  const effect = vi.fn();
  const result = withRuntimeAdmission({ num: 12, groupMembers: [12, 13] }, 'build', () =>
    withRuntimeAdmission({ num: 14 }, 'prepare', () => {
      settings = only(['12', '13', '14'].filter(num => num !== revoked));
      return withRuntimeAdmission({ num: 12 }, 'build', effect);
    }), { readSettings });
  expect(result).toMatchObject({ outcome: 'runtime-refused' });
  expect(result.runtimeRefused).toContainEqual({ num: revoked, kind: revoked === '14' ? 'prepare' : 'build', reason: 'runtime-only' });
  expect(readSettings).toHaveBeenCalledTimes(3);
  expect(effect).not.toHaveBeenCalled();
});

it('refuses a caller that omits known persisted group membership', async () => {
  const effect = vi.fn();
  await withRuntimeAdmissionTick(() => ({ mode: 'lift' }), async () => {
    setRuntimeAdmissionCards([{ num: '12', groupMembers: ['13'] }]);
    expect(withRuntimeAdmission({ num: '12' }, 'build', effect)).toMatchObject({ outcome: 'runtime-refused', reason: 'runtime-malformed' });
    expect(effect).not.toHaveBeenCalled();
    return {};
  });
});

it('batch launch preserves each persisted group and invokes an admitted batch once', () => {
  const cards = [{ num: '12', groupMembers: ['13'] }, { num: '14' }];
  const effect = vi.fn(() => 'launched');
  expect(withRuntimeAdmission(cards, 'route', effect, { readSettings: () => only(['12', '14']) }))
    .toMatchObject({ outcome: 'runtime-refused' });
  expect(effect).not.toHaveBeenCalled();
  expect(withRuntimeAdmission(cards, 'route', effect, { readSettings: () => only(['12', '13', '14']) })).toBe('launched');
  expect(effect).toHaveBeenCalledTimes(1);
});
it.each([[], 'bad settings', Promise.resolve({})].map(settings => [settings]))('non-object or async settings fail closed: %j', settings => {
  const effect = vi.fn();
  expect(withRuntimeAdmission({ num: 12 }, 'build', effect, { readSettings: () => settings }))
    .toMatchObject({ outcome: 'runtime-refused', reason: 'runtime-malformed' });
  expect(effect).not.toHaveBeenCalled();
});

it.each(['lead', 'member'])('mechanical marker read revoking the %s prevents the spawn', async revoked => {
  let settings = only(['12', '13']);
  const spawnDetached = vi.fn(() => ({ pid: 7 }));
  await withRuntimeAdmissionTick(() => settings, async () => {
    const result = deliverItemDetachedProvider({ num: '12', groupMembers: ['13'], lane: 1, sessionSlug: 'test' }, {
      readDeliveryAgentMarker: () => { settings = only(revoked === 'lead' ? ['13'] : ['12']); return null; },
      spawnDetached, logPathFor: () => 'fixture.log',
    });
    expect(result).toMatchObject({ outcome: 'runtime-refused' });
    expect(spawnDetached).not.toHaveBeenCalled();
    settings = only(['12', '13']);
    expect(deliverItemDetachedProvider({ num: '12', groupMembers: ['13'], lane: 1, sessionSlug: 'test' }, {
      readDeliveryAgentMarker: () => null, spawnDetached, logPathFor: () => 'fixture.log',
    })).toBe('pid:7');
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    return {};
  });
});
it('detached primitive rechecks admission after opening its log', async () => {
  let settings = only(['12', '13']);
  const spawn = vi.fn(() => ({ pid: 7 }));
  await withRuntimeAdmissionTick(() => settings, async () => {
    const result = defaultSpawnDetached([], { logPath: 'fixture.log', card: { num: '12', groupMembers: ['13'] } }, {
      ensureDir: () => {}, openLog: () => { settings = only(['12']); return 1; }, closeLog: () => {}, spawn,
    });
    expect(result).toMatchObject({ outcome: 'runtime-refused' });
    expect(spawn).not.toHaveBeenCalled();
    return {};
  });
});

it('diagnostic card filing still spawns under an empty runtime allowlist', async () => {
  const spawn = vi.fn(() => ({ pid: 7, unref() {} }));
  const closeLog = vi.fn();
  await withRuntimeAdmissionTick(() => only([]), async () => {
    expect(defaultSpawnDiagnosticDetached([join(REPO_ROOT, 'scripts/operations/land-prevention-card.mjs')], { logPath: 'fixture.log' }, {
      ensureDir: () => {}, openLog: () => 123, closeLog, spawn,
    }).pid).toBe(7);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(closeLog).toHaveBeenCalledWith(123);
    return {};
  });
});

it.each([
  'deliver-item-wrapper.mjs', 'worker-wrapper.mjs', 'dispatch-lane.mjs',
  'build-dispatch.mjs', 'prepare-item.mjs', 'fix-pr.mjs', 'ci-heal-pr-dispatch.mjs',
  'unknown.mjs', '../elsewhere/land-prevention-card.mjs',
])('diagnostic spawner rejects %s before any admission read or IO', async target => {
  const readSettings = vi.fn(() => only([]));
  const spawn = vi.fn(), ensureDir = vi.fn(), openLog = vi.fn();
  await withRuntimeAdmissionTick(readSettings, async () => {
    expect(() => defaultSpawnDiagnosticDetached([`scripts/operations/${target}`, '--num=9999'],
      { cwd: REPO_ROOT, logPath: 'fixture.log' }, { spawn, ensureDir, openLog }))
      .toThrow(DiagnosticTargetError);
    expect(readSettings).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(ensureDir).not.toHaveBeenCalled();
    expect(openLog).not.toHaveBeenCalled();
    return {};
  });
});

it.each([[], null, ['--eval', 'anything'], ['--import=anything', 'scripts/operations/land-prevention-card.mjs']].map(argv => [argv]))(
  'diagnostic spawner refuses missing targets and Node options: %j', argv => {
    expect(() => defaultSpawnDiagnosticDetached(argv)).toThrow(DiagnosticTargetError);
  });
