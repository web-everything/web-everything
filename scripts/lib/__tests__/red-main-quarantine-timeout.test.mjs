// @vitest-environment node
import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSafetyNet, readJobFailures, SAFETY_NET_LEDGER, SAFETY_NET_SHADOW_LOG } from '../red-main-quarantine-io.mjs';
import { QUARANTINE_SAFETY_NET_DEFAULTS, testsToSkip } from '../red-main-quarantine.mjs';
import { resolveLimits, durationMs } from '../test-timeout-policy.mjs';

const policy = JSON.parse(readFileSync(new URL('../../settings/test-timeout-policy.json', import.meta.url), 'utf8'));
const file = 'scripts/conveyor/soak/daemon-soak.soak.test.mjs', job = 'soak-shard (1)';
const limits = resolveLimits(policy, { file, job });
const dirs = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'soft-quarantine-')); dirs.push(dir);
  let list = { version: 1, entries: [] };
  const write = vi.fn(({ change }) => {
    const r = change(list); if (!r.ok) throw Error(r.error);
    list = r.list; return r;
  });
  const log = vi.fn();
  const readJobs = vi.fn(() => ({ failed: [{ id: 1, name: job }] }));
  function tick({ soft = limits.softMs, mixed = false, timeoutPolicy = policy, shadow = false, incomplete = false, run = 45080540441, now = Date.parse('2026-11-22T23:30:00Z'), extra = {} } = {}) {
    const head = run.toString(16).padStart(40, '0');
    const text = `2026-11-22T23:25:07Z \x1b[31m FAIL \x1b[0m ${file} > 50 real daemon ticks: every invariant holds after every tick\nError: Test timed out in ${soft}ms.\n${mixed ? `FAIL ${file} > ordinary failure\nError: expected true\n` : ''}${incomplete ? '' : ' Test Files 1 failed | 2 passed'}`;
    return runSafetyNet({ dir, now, mode: { value: 'quarantine', source: 'test' }, live: !shadow, timeoutPolicy,
      settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS }, sources: {} },
      mainCiRuns: { runs: [{ databaseId: run, headSha: head, status: 'completed', conclusion: 'failure', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempt: 1 }], failing: { runId: run, jobs: [job, 'daemon-soak'] }, priority: { prs: [99] } },
      readJobs, readLog: () => readJobFailures(1, { exec: () => text, repoSlug: 'o/r' }),
      readList: () => ({ ok: true, list }), write, log, ...extra });
  }
  return { tick, write, log, readJobs, list: () => list, ledger: () => JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')),
    lines: () => readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim().split('\n').map(JSON.parse),
    clear: () => { list = { version: 1, entries: [] }; } };
}

it.each([
  ['hard kill', { soft: limits.hardMs }],
  ['runnerKillAtHard', { timeoutPolicy: { ...policy, all: { ...policy.all, runnerKillAtHard: true } } }],
  ['mixed failures in one file', { mixed: true }],
  ['unconfigured', { timeoutPolicy: {} }],
  ['missing hard', { timeoutPolicy: { all: { soft: policy.tests[file].soft, runnerKillAtHard: false } } }],
  ['incomplete log', { incomplete: true }],
])('%s never takes the immediate path and an empty red list alerts with WHY', (_, options) => {
  const h = harness(), out = h.tick(options);
  expect(out.plan.action).toBe('none'); expect(out.applied).toBe(false); expect(h.write).not.toHaveBeenCalled();
  expect(h.lines()).toContainEqual(expect.objectContaining({ type: 'alert', why: out.plan.why }));
  expect(h.log).toHaveBeenCalledWith(expect.stringContaining(out.plan.why));
});
it('hard timeout stays on red-main even if proof would otherwise be optional', () => {
  const h = harness();
  expect(h.tick({ soft: limits.hardMs, extra: { settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, requireProvenFlake: false } } } }).plan.action).toBe('none');
});
it('live soak timeout quarantines at once without proof reads and protects the fix PR', () => {
  const h = harness(), out = h.tick();
  expect(out.applied).toBe(true); expect(h.readJobs).toHaveBeenCalledTimes(1);
  expect(h.list().entries).toHaveLength(1);
  expect(h.list().entries[0]).toMatchObject({ test: file, job, release: { passesUnderSoft: policy.all.release.passes }, note: expect.stringContaining('file-level skip quarantines every case in the file'),
    timeout: { priority: 'high', outcomes: [{ class: 'soft', conformityLoss: 'runner-kills-at-soft (G1)', measured: { runnerLimitMs: limits.softMs } }] } });
  expect(h.list().entries[0].proof).toBeUndefined();
  expect(JSON.parse(h.list().entries[0].reason)[0].limits.sources.soft.scope).toBe(`tests.${file}`);
  expect(out.events).toContainEqual(expect.objectContaining({ type: 'card-owed', priority: 'high' }));
  expect(h.lines().map(o => o.type)).toEqual(['quarantine', 'alert', 'fix-card']);
  expect(testsToSkip({ list: h.list(), now: Date.parse('2026-11-22T23:30:00Z'), prNumber: 99 })).toEqual([]);
  expect(h.ledger().tests[file].softQuarantines).toHaveLength(1);
  h.tick(); expect(h.ledger().tests[file].softQuarantines).toHaveLength(1);
});
it('shadow only logs would-be soft quarantine; no live entry or count', () => {
  const h = harness(), out = h.tick({ shadow: true });
  expect(out.applied).toBe(false); expect(h.write).not.toHaveBeenCalled(); expect(h.list().entries).toEqual([]);
  expect(h.lines()).toContainEqual(expect.objectContaining({ shadow: true, type: 'fix-card', priority: 'high' }));
  expect(h.ledger().tests[file]).toBeUndefined();
});
it('second soft quarantine within the window escalates once, with urgent card and alert', () => {
  const h = harness(); h.tick(); h.clear();
  const out = h.tick({ run: 45080540442, now: Date.parse('2026-11-22T23:31:00Z') });
  expect(out.applied).toBe(true);
  expect(out.events).toContainEqual(expect.objectContaining({ type: 'card-owed', priority: 'urgent' }));
  const escalation = h.lines().filter(o => o.type === 'escalation');
  expect(escalation).toHaveLength(1); expect(escalation[0].entries).toHaveLength(policy.all.escalation.count);
  expect(h.lines()).toContainEqual(expect.objectContaining({ type: 'alert', priority: 'urgent' }));
  expect(h.ledger().tests[file].softQuarantines).toHaveLength(2);
});
it('25 hours apart does not escalate', () => {
  const h = harness(); h.tick(); h.clear();
  h.tick({ run: 45080540442, now: Date.parse('2026-11-22T23:30:00Z') + durationMs(policy.all.escalation.window) + 3600000 });
  expect(h.lines().filter(o => o.type === 'escalation')).toEqual([]);
});
it('missing escalation escalates immediately and missing release requires approval', () => {
  const h = harness();
  h.tick({ timeoutPolicy: { ...policy, all: { ...policy.all, escalation: undefined, release: undefined } } });
  expect(h.list().entries[0].release).toEqual({ approvalRequired: true });
  expect(h.lines()).toContainEqual(expect.objectContaining({ type: 'escalation', priority: 'urgent' }));
});
it('a failed write emits no soft outputs and adds no counted quarantine', () => {
  const h = harness();
  const out = h.tick({ extra: { write: () => { throw Error('publication refused'); } } });
  expect(out.applied).toBe(false); expect(h.ledger().tests[file]).toBeUndefined();
  expect(h.lines()).toEqual([expect.objectContaining({ type: 'alert', why: 'publication refused' })]);
});
it('fileCardPerEntry disabled still emits a typed fix card through logs', () => {
  const h = harness();
  const out = h.tick({ extra: { settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, fileCardPerEntry: false } } } });
  expect(out.applied).toBe(true);
  expect(out.events.some(e => e.type === 'card-owed')).toBe(false);
  expect(h.lines()).toContainEqual(expect.objectContaining({ type: 'fix-card', priority: 'high' }));
  expect(h.ledger().tests[file].softQuarantines[0].note).toContain('structured safety-net logs');
});
it('an entry added concurrently at the fresh transport tip is not counted again', () => {
  const h = harness();
  const out = h.tick({ extra: { write: ({ change }) => {
    const first = change({ version: 1, entries: [] });
    return change(first.list);
  } } });
  expect(out.applied).toBe(true);
  expect(h.ledger().tests[file]).toBeUndefined();
});
