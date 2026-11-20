import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRetryInfraBlocked } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { resumeOpen, infraRecoveryCard, parseInfraStore, recordInfraBlock } from '../../conveyor/infra-blocked.mjs';
import { decideRuntimeAdmission, assertRuntimeAdmitted, withRuntimeAdmission, setRuntimeAdmissionCards, withRuntimeAdmissionTick } from '../runtime-admission.mjs';
import { readBuildPrioritySettings } from '../build-queue.mjs';
import * as runtime from '../runtime-admission.mjs';

const admission = { assertRuntimeAdmitted, withRuntimeAdmission };
const only = ids => ({ mode: 'only', only: true, ids });
it('production recovery payloads resolve lead and member aliases in parent and child admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-alias-'));
  mkdirSync(join(root, 'backlog'));
  writeFileSync(join(root, 'backlog/012-lead.md'), '---\nbornAs: xabcdef0\n---\n');
  writeFileSync(join(root, 'backlog/013-member.md'), '---\nbornAs: xabcdef1\n---\n');
  const readIdentity = card => runtime.readRuntimeRecoveryIdentity(card, { root });
  const entry = { num: '12', builderContext: 'dispatch', ref: 'lane/12', sha: 'a'.repeat(40) };
  const readContext = () => ({ entry: { payload: {
    num: '12', groupMembers: ['13'], itemSpecPath: 'backlog/012-lead.md',
  } } });
  const readSettings = () => only(['xabcdef0', 'xabcdef1']);
  const exec = vi.fn(command => command === 'git' ? entry.sha : '{"pr":77}');
  try {
    expect(resumeOpen(entry, { admission, exec, readSettings, readContext, readIdentity }))
      .toMatchObject({ ok: true, prNumber: 77 });
    const parentExec = vi.fn(() => JSON.stringify({ retried: ['12'] }));
    const report = await withRuntimeAdmissionTick(readSettings, () => cliRetryInfraBlocked({
      exec: parentExec, readEntries: () => [entry], readContext, readIdentity,
    }));
    expect(report.retried).toEqual(['12']);
    expect(parentExec).toHaveBeenCalledTimes(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.each(['missing', 'wrong-card', 'malformed', 'ambiguous', 'symlink', 'oversized'])('recovery does not borrow an unproven alias: %s', scenario => {
  const root = mkdtempSync(join(tmpdir(), 'infra-alias-invalid-'));
  mkdirSync(join(root, 'backlog'));
  const path = join(root, 'backlog/012-lead.md');
  const text = '---\nbornAs: xabcdef0\n---\n';
  if (scenario === 'wrong-card') writeFileSync(join(root, 'backlog/013-other.md'), text);
  if (scenario === 'malformed') writeFileSync(path, '---\nbornAs: 13\n---\n');
  if (scenario === 'ambiguous') {
    writeFileSync(path, text);
    writeFileSync(join(root, 'backlog/12-duplicate.md'), text);
  }
  if (scenario === 'symlink') {
    writeFileSync(join(root, 'other.md'), text);
    symlinkSync(join(root, 'other.md'), path);
  }
  if (scenario === 'oversized') writeFileSync(path, text + 'x'.repeat(1024 * 1024));
  const exec = vi.fn();
  try {
    const result = resumeOpen({ num: '12', groupMembers: [], ref: 'lane/12',
      bornAs: 'xabcdef0', id: 'xabcdef0-forged', itemSpecPath: 'backlog/013-other.md' }, {
      admission, exec, readSettings: () => only(['xabcdef0']),
      readIdentity: card => runtime.readRuntimeRecoveryIdentity(card, { root }),
    });
    expect(result).toMatchObject({ refused: true, admission: true,
      reason: ['missing', 'wrong-card'].includes(scenario) ? 'runtime-only' : 'runtime-malformed' });
    expect(exec).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('recovery revalidates aliases before publish and refuses a newly unreadable group member', () => {
  const root = mkdtempSync(join(tmpdir(), 'infra-alias-recheck-'));
  mkdirSync(join(root, 'backlog'));
  writeFileSync(join(root, 'backlog/012-lead.md'), '---\nbornAs: xabcdef0\n---\n');
  const memberPath = join(root, 'backlog/013-member.md');
  writeFileSync(memberPath, '---\nbornAs: xabcdef1\n---\n');
  const sha = 'a'.repeat(40);
  const exec = vi.fn(() => { writeFileSync(memberPath, '---\nbornAs: invalid\n---\n'); return sha; });
  try {
    const result = resumeOpen({ num: '12', groupMembers: ['13'], ref: 'lane/12', sha }, {
      admission, exec, readSettings: () => only(['xabcdef0', 'xabcdef1']),
      readIdentity: card => runtime.readRuntimeRecoveryIdentity(card, { root }),
    });
    expect(result).toMatchObject({ refused: true, admission: true, reason: 'runtime-malformed' });
    expect(exec.mock.calls.map(([command]) => command)).toEqual(['git', 'git']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('an unreadable recovery alias holds only that entry and the next admitted card retries', async () => {
  const entries = [{ num: '12', groupMembers: [] }, { num: '13', groupMembers: [] }];
  const before = structuredClone(entries);
  const exec = vi.fn(() => '{"retried":["13"]}');
  const report = await withRuntimeAdmissionTick(() => only(['xabcdef1']), () => cliRetryInfraBlocked({
    exec, readEntries: () => entries,
    readIdentity: card => {
      if (card.num === '12') throw new Error('unreadable');
      return { ...card, bornAs: 'xabcdef1' };
    },
  }));
  expect(report.failed).toEqual([{ num: '12', refused: true, reason: 'runtime-malformed' }]);
  expect(report.retried).toEqual(['13']);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(entries).toEqual(before);
});
it('infra context cannot shrink stored group membership or admit only the lead', () => {
  const entry = { num: '12', groupMembers: ['13'], builderContext: 'historical' };
  const readContext = () => ({ entry: { payload: { num: '12', groupMembers: [] } } });
  expect(infraRecoveryCard(entry, { readContext }).groupMembers).toEqual(['13']);
  const exec = vi.fn();
  expect(resumeOpen(entry, { admission, exec, readContext, readSettings: () => only(['12']) }))
    .toMatchObject({ ok: false, refused: true, admission: true });
  expect(exec).not.toHaveBeenCalled();
  expect(infraRecoveryCard(entry, { readContext: () => ({ entry: { payload: { num: '12', groupMembers: ['14', '13'] } } }) }).groupMembers)
    .toEqual(['13', '14']);
});
it('context-less historical membership is unknown until explicitly recorded', () => {
  const exec = vi.fn();
  const entry = { num: '12', ref: 'lane/12' };
  expect(resumeOpen(entry, { admission, exec, readSettings: () => ({ mode: 'lift' }) }))
    .toMatchObject({ ok: false, refused: true, admission: true, reason: 'unproven infra recovery identity' });
  expect(exec).not.toHaveBeenCalled();
  for (const groupMembers of [[], ['13']]) {
    const stored = recordInfraBlock([], { ...entry, groupMembers });
    const restored = parseInfraStore(JSON.stringify(stored))[0];
    expect(infraRecoveryCard(restored).groupMembers).toEqual(groupMembers);
  }
});
it('re-recording a rebuilt infra entry preserves the union of known members', () => {
  const entry = { num: '12', ref: 'lane/12', sha: 'old', groupMembers: ['13'] };
  const stored = recordInfraBlock([entry], { ...entry, sha: 'new', groupMembers: ['14'] });
  expect(parseInfraStore(JSON.stringify(stored))[0].groupMembers).toEqual(['13', '14']);
});
it.each([null, { held: true }, { only: true }])('empty batches freshly check settings and refuse %j', settings => {
  const effect = vi.fn();
  const readSettings = vi.fn(() => settings);
  expect(withRuntimeAdmission([], 'route', effect, { readSettings }))
    .toMatchObject({ outcome: 'runtime-refused', reason: 'runtime-malformed' });
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(effect).not.toHaveBeenCalled();
  expect(withRuntimeAdmission([], 'route', effect, { readSettings: () => ({ mode: 'lift' }) })).toBeUndefined();
  expect(effect).toHaveBeenCalledTimes(1);
});
it('an empty batch under a valid only-list has no identities to refuse', () => {
  const effect = vi.fn(() => 'launched');
  expect(withRuntimeAdmission([], 'route', effect, { readSettings: () => only([]) })).toBe('launched');
  expect(effect).toHaveBeenCalledTimes(1);
});
it.each(['', '{}', 'not json', 'null', '{"pr":false}', '{"pr":0}', '{"pr":"bad"}'])('successful subprocess output %j without a PR is an infra failure', output => {
  const sha = 'a'.repeat(40);
  const exec = vi.fn(command => command === 'git' ? sha : output);
  expect(resumeOpen({ num: '12', ref: 'lane/12', sha, groupMembers: [] }, { admission, exec, readSettings: () => ({ mode: 'lift' }) }))
    .toEqual({ ok: false, detail: 'pr-land returned no PR number; entry retained for retry' });
  expect(exec.mock.calls.at(-1)[0]).toBe('node');
});
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
  const stored = [{ num: '12', groupMembers: [], ref: 'lane/12' }];
  const report = await withRuntimeAdmissionTick(() => settings, async () => cliRetryInfraBlocked({ exec, readEntries: () => stored }));
  expect(exec).not.toHaveBeenCalled();
  expect(report.failed).toEqual([{ num: '12', refused: true, reason: settings.held ? 'runtime-malformed' : 'runtime-only' }]);
  expect(report.runtimeRefused).toHaveLength(1);
  expect(stored).toEqual([{ num: '12', groupMembers: [], ref: 'lane/12' }]);
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
it('a damaged historical infra identity is retained and a healthy following entry still executes', async () => {
  const entries = [{ num: '12', builderContext: '{' }, { num: '13', groupMembers: [] }];
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


it.each([null, {}, '13', [null], [undefined], ['12\n'], Array(1)].map(members => [members]))(
  'malformed infra group %j refuses only its card and continues the retry pass', async groupMembers => {
    const entries = [{ num: '12', groupMembers }, { num: '13', groupMembers: [] }];
    const before = structuredClone(entries);
    const exec = vi.fn(() => JSON.stringify({ retried: ['13'] }));
    const report = await withRuntimeAdmissionTick(() => ({ mode: 'lift' }), async () =>
      cliRetryInfraBlocked({ exec, readEntries: () => entries }));
    expect(report.failed).toEqual([{ num: '12', refused: true, reason: 'runtime-malformed',
      detail: 'Entry retained; repair groupMembers before retrying.' }]);
    expect(report.retried).toEqual(['13']);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1].at(-1)).toBe('--num=13');
    expect(entries).toEqual(before);
  });
