import { routeDispatchProvider, defaultClaudeProvider, spawnAgentToCompletion, reserveBuildLane } from '../../operations/dispatch-lane-io.mjs';
import { cliRetryInfraBlocked, cliEffects } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { resumeOpen, infraRecoveryCard, parseInfraStore } from '../../conveyor/infra-blocked.mjs';
import * as prevention from '../prevention-landing-job.mjs';
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideRuntimeAdmission, assertRuntimeAdmitted, withRuntimeAdmission } from '../runtime-admission.mjs';
import { readBuildPrioritySettings } from '../build-queue.mjs';
import { routeHeldItems } from '../../conveyor/build-dispatch-hold-router.mjs';

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
    const result = await withRuntimeAdmission(() => only([]), async () => {
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
  const report = await withRuntimeAdmission(() => settings, async () => cliRetryInfraBlocked({ exec, readEntries: () => stored }));
  expect(exec).not.toHaveBeenCalled();
  expect(report.failed).toEqual([{ num: '12', refused: true, reason: settings.held ? 'runtime-malformed' : 'runtime-only' }]);
  expect(report.runtimeRefused).toHaveLength(1);
  expect(stored).toEqual([{ num: '12', ref: 'lane/12' }]);
});
it('infra recovery refuses an unchecked group and scopes admitted retries to one card', async () => {
  const exec = vi.fn(() => JSON.stringify({ retried: ['12'] }));
  const entry = { num: '12', groupMembers: ['13'] };
  const refused = await withRuntimeAdmission(() => only(['12']), async () => cliRetryInfraBlocked({ exec, readEntries: () => [entry] }));
  expect(exec).not.toHaveBeenCalled();
  expect(refused.failed[0]).toMatchObject({ num: '12', refused: true });
  await withRuntimeAdmission(() => only(['12', '13']), async () => cliRetryInfraBlocked({ exec, readEntries: () => [entry] }));
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1].slice(-2)).toEqual(['retry', '--num=12']);
});
it('infra recovery rechecks settings in resumeOpen before any subprocess, including unreadable settings', () => {
  for (const readSettings of [() => only([]), () => ({ held: true }), () => { throw new Error('unreadable'); }, () => only(['12'])]) {
    const exec = vi.fn();
    const result = resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12' }, { exec, readSettings });
    expect(result).toMatchObject({ ok: false, refused: true });
    expect(exec).not.toHaveBeenCalled();
  }
});
it('resumeOpen publishes only after admitting lead and every group member', () => {
  const sha = 'a'.repeat(40);
  const exec = vi.fn((cmd, argv) => cmd === 'git' ? sha : JSON.stringify({ pr: 77 }));
  expect(resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12', sha }, { exec, readSettings: () => only(['12', '13']) }))
    .toMatchObject({ ok: true, prNumber: 77 });
  expect(exec.mock.calls.at(-1)[0]).toBe('node');
  expect(exec.mock.calls.at(-1)[1]).toContain('--label-on-green');
});
it('historical infra records recover group membership from the original dispatch and refuse missing evidence', () => {
  const entry = { num: '12', builderContext: 'historical' };
  const readContext = () => ({ entry: { payload: { num: '12', groupMembers: ['13'] } } });
  expect(infraRecoveryCard(entry, { readContext }).groupMembers).toEqual(['13']);
  expect(() => infraRecoveryCard(entry, { readContext: () => null })).toThrow(/unproven/);
  const exec = vi.fn();
  expect(resumeOpen(entry, { exec, readContext: () => { throw new Error('missing run'); }, readSettings: () => only(['12']) }).refused).toBe(true);
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
    const report = await withRuntimeAdmission(() => only([]), async () => effects.recordPrepareFailure(input));
    expect(report.prevention.status).toBe('queued');
    expect(file).toHaveBeenCalledTimes(1);
    expect(file.mock.calls[0][0].num).toBeUndefined();
    await effects.recordPrepareFailure(input);
    expect(file).toHaveBeenCalledTimes(1);
  } finally { file.mockRestore(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});

it('direct delivery ports refuse an empty allowlist before providers, agents or lane acquisition', async () => {
  const effect = vi.fn();
  await withRuntimeAdmission(() => only([]), async () => {
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
  const result = await withRuntimeAdmission(() => only(['12', '13']), async () =>
    cliRetryInfraBlocked({ exec, readEntries: () => entries }));
  expect(result.failed).toEqual([{ num: '12', refused: true, reason: 'unproven infra recovery identity',
    detail: 'Entry retained; repair its original dispatch context before retrying.' }]);
  expect(result.retried).toEqual(['13']);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec.mock.calls[0][1].slice(-2)).toEqual(['retry', '--num=13']);
  expect(entries).toEqual(before);
});
