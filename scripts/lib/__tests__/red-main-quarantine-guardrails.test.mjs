// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QUARANTINE_SAFETY_NET_DEFAULTS, planSafetyNet, addEntries, validateQuarantineList, QUARANTINE_MAX_TTL_MS } from '../red-main-quarantine.mjs';
import { resolveQuarantineSettings, QUARANTINE_SETTINGS_ENV, runSafetyNet, readFailedJobs, SAFETY_NET_SHADOW_LOG, SAFETY_NET_LEDGER } from '../red-main-quarantine-io.mjs';
import smell from '../../conveyor/health-smells/red-main-quarantined-test.mjs';
import { validateSmellShape } from '../../conveyor/health-smells-shape.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/red-main-quarantine-62da75ed3.json', import.meta.url), 'utf8'));
const now = Date.parse(fixture.now);
const file = 'scripts/conveyor/__tests__/sim-scenario-self-sync-sibling.test.mjs';
const failure = { files: [file], tests: [{ file, name: 'A3' }], complete: true };
const proof = { kind: 'rerun-passed', runId: 7, attempt: 2 };
const rerunJobs = [{ name: 'integration', conclusion: 'failure', run_attempt: 1 }, { name: 'integration', conclusion: 'success', run_attempt: 2 }];
const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'quarantine-guards-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const plan = (o = {}) => planSafetyNet({ status: 'red', firstRedSha: '62da75ed3', failedJobs: ['integration', 'test'], jobFailures: { integration: failure }, flakeProof: { integration: proof }, now, ...o });
const entry = (o = {}) => addEntries(null, { tests: [file], job: 'integration', proof, brokenSha: '62da75ed3', owner: 'operator', reason: 'flake', actor: 'operator', now, ...o }).list.entries[0];

function net(o = {}) {
  const mainCiRuns = structuredClone(fixture.mainCiRuns);
  // Positive guardrail cases use a hypothetical earlier run of the failing sha whose re-run passed; the episode had none.
  mainCiRuns.runs.push({ ...mainCiRuns.runs[0], databaseId: proof.runId, createdAt: '2026-10-14T06:08:00Z', updatedAt: '2026-10-14T06:15:00Z', attempt: 2 });
  return runSafetyNet({ dir: temp(), now, mainCiRuns, live: false,
    mode: { value: 'stop', source: 'tool' }, settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS }, sources: {} },
    readJobs: (id, opts) => (opts?.filter === 'all' ? { jobs: id === proof.runId ? rerunJobs : [] } : { failed: fixture.failedJobs }), readLog: () => failure,
    readList: () => ({ ok: true, list: { version: 1, entries: [] } }), log: () => {}, ...o });
}

describe('settings source cascade', () => {
  it.each(['requireProvenFlake', 'fileCardPerEntry'])('%s is a boolean at each layer and accepts on/off env', (key) => {
    const dir = temp();
    const path = join(dir, 'settings.json');
    const base = { env: {}, file: path, platform: null };
    expect(resolveQuarantineSettings(base)).toMatchObject({ value: { [key]: true }, sources: { [key]: 'standard' } });
    expect(resolveQuarantineSettings({ ...base, platform: { [key]: false } })).toMatchObject({ value: { [key]: false }, sources: { [key]: 'platform' } });
    writeFileSync(path, JSON.stringify({ redMainQuarantine: { [key]: false } }));
    expect(resolveQuarantineSettings({ ...base, platform: { [key]: true } })).toMatchObject({ value: { [key]: false }, sources: { [key]: 'tool' } });
    expect(resolveQuarantineSettings({ ...base, env: { [QUARANTINE_SETTINGS_ENV[key]]: 'on' } })).toMatchObject({ value: { [key]: true }, sources: { [key]: 'env' } });
    expect(resolveQuarantineSettings({ ...base, env: { [QUARANTINE_SETTINGS_ENV[key]]: 'off' } })).toMatchObject({ value: { [key]: false }, sources: { [key]: 'env' } });
    const invalid = resolveQuarantineSettings({ ...base, env: { [QUARANTINE_SETTINGS_ENV[key]]: 'yes' } });
    expect(invalid.sources[key]).toBe('tool');
    expect(invalid.invalid.join(' ')).toContain(key);
    writeFileSync(path, JSON.stringify({ redMainQuarantine: { [key]: 'on' } }));
    expect(resolveQuarantineSettings({ ...base, platform: { [key]: false } }).sources[key]).toBe('platform');
  });
  it('reports sources for job coverage overrides and keeps the mode stop', () => {
    const file = join(temp(), 'settings.json');
    writeFileSync(file, JSON.stringify({ redMainQuarantine: { derivedJobs: ['custom'], unitJobPattern: '^custom$' } }));
    expect(resolveQuarantineSettings({ file, env: {}, platform: null })).toMatchObject({ value: { derivedJobs: ['custom'], unitJobPattern: '^custom$' }, sources: { derivedJobs: 'tool', unitJobPattern: 'tool' } });
    expect(resolveQuarantineSettings({ file, platform: null, env: { WE_RED_MAIN_QUARANTINE_DERIVED_JOBS: 'test, daemon-soak', WE_RED_MAIN_QUARANTINE_UNIT_JOB_PATTERN: '^integration$' } })).toMatchObject({ sources: { derivedJobs: 'env', unitJobPattern: 'env' } });
    expect(JSON.parse(readFileSync(new URL('../../settings/red-main-hold.json', import.meta.url), 'utf8')).redMainMode).toBe('stop');
  });
});

describe('plan guards', () => {
  it.each(['test-shard (2)', 'integration', 'soak-shard (1)'])('covers %s with its own proof', (job) => {
    expect(plan({ failedJobs: [job, 'daemon-soak'], jobFailures: { [job]: failure }, flakeProof: { [job]: proof } })).toMatchObject({ action: 'add', entries: [{ test: file, job, proof }] });
  });
  it('requires proof for every failing job, rejecting invalid proofs', () => {
    // A green merge group tested its queued PR's changes, not the failing commit: never proof (PR #5283).
    for (const bad of [null, {}, { ...proof, kind: 'guessed' }, { ...proof, runId: {} }, { kind: 'rerun-passed', runId: 9, attempt: 1 }, { kind: 'merge-group-green-on-tip', runId: 38520623968 }]) expect(plan({ flakeProof: { integration: bad } }).why).toContain('not a proven flake: integration');
    expect(plan({ failedJobs: ['integration', 'soak-shard (1)'], jobFailures: { integration: failure, 'soak-shard (1)': failure } }).why).toContain('not a proven flake: soak-shard (1)');
  });
  it('off restores unproven additions; cards can be switched off separately', () => {
    expect(plan({ flakeProof: {}, settings: { requireProvenFlake: false, fileCardPerEntry: false } })).toMatchObject({ action: 'add', cards: [] });
  });
  it('caps files across live entries and ignores expired entries', () => {
    const list = { version: 1, entries: [entry({ tests: ['scripts/other.test.mjs'] })] };
    expect(plan({ list, settings: { maxTests: 1 } }).why).toBe('quarantine cap 1 reached');
    list.entries[0].expiresAt = now;
    expect(plan({ list, settings: { maxTests: 1 } }).action).toBe('add');
    expect(plan({ list: { version: 1, entries: [entry()] }, settings: { maxTests: 1 } }).why).toContain('already quarantined');
  });
  it('caps card expiry at a day, consistent with the entry TTL', () => {
    const p = plan({ settings: { ttlMin: 99999 } });
    expect(p.cards[0].expiresAt).toBe(now + QUARANTINE_MAX_TTL_MS);
    expect(p.cards[0].expiresAt).toBe(entry({ ttlMs: 99999 * 60000 }).expiresAt);
    expect(p.cards[0].title).toContain('10-15, 05:26 ET');
  });
  it('validates optional job and preserves legacy entries', () => {
    expect(validateQuarantineList({ version: 1, entries: [entry()] }).ok).toBe(true);
    expect(validateQuarantineList({ version: 1, entries: [{ ...entry(), job: 42 }] }).ok).toBe(false);
    expect(entry({ job: undefined }).job).toBeUndefined();
  });
});

describe('rerun proof IO', () => {
  const probe = (jobs, { attempt = 2, earlier = false, sameHead = true, settings = {} } = {}) => {
    const mainCiRuns = structuredClone(fixture.mainCiRuns);
    delete mainCiRuns.failing.groupEvidence;
    const run = mainCiRuns.runs[0];
    if (earlier) mainCiRuns.runs.push({ ...run, databaseId: 7, createdAt: '2026-10-14T06:08:00Z', headSha: sameHead ? run.headSha : 'abcdef1', attempt });
    else if (attempt === undefined) delete run.attempt;
    else run.attempt = attempt;
    const readJobs = vi.fn((id, options) => {
      if (options?.filter === 'all') { if (jobs instanceof Error) throw jobs; return { jobs }; }
      return { failed: fixture.failedJobs };
    });
    return { out: net({ mainCiRuns, readJobs, settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, ...settings }, sources: {} } }), readJobs };
  };
  const passed = [{ name: 'integration', conclusion: 'failure', run_attempt: 1 }, { name: 'integration', conclusion: 'success', run_attempt: 2 }];
  it('uses only the highest run_attempt, independent of order', () => {
    const { out, readJobs } = probe([...passed].reverse());
    expect(out.plan.entries[0].proof).toEqual({ kind: 'rerun-passed', runId: 38517676708, attempt: 2 });
    expect(readJobs).toHaveBeenCalledWith(38517676708, { filter: 'all' });
    expect(probe([...passed, { name: 'integration', conclusion: 'failure', run_attempt: 3 }]).out.plan.action).toBe('none');
    expect(probe([{ name: 'integration', conclusion: 'success', run_attempt: 1 }]).out.plan.action).toBe('none');
  });
  it('derives attempt from jobs when gh run list omits it', () => {
    const mainCiRuns = structuredClone(fixture.mainCiRuns);
    delete mainCiRuns.runs[0].attempt;
    delete mainCiRuns.failing.groupEvidence;
    expect(net({ mainCiRuns, readJobs: (_, opts) => opts?.filter === 'all' ? { jobs: passed } : { failed: fixture.failedJobs } }).plan.action).toBe('add');
  });
  it('accepts an earlier run of the same head, but no other head', () => {
    expect(probe(passed, { earlier: true }).out.plan.entries[0].proof.runId).toBe(7);
    expect(probe(passed, { earlier: true, sameHead: false }).out.plan.action).toBe('none');
  });
  it('unreadable jobs and absent evidence never prove a flake', () => {
    expect(probe(new Error('unreadable')).out.plan.action).toBe('none');
    expect(probe(undefined).out.plan.action).toBe('none');
  });
  it.each([
    ['missing update', (run) => { delete run.updatedAt; }],
    ['invalid update', (run) => { run.updatedAt = 'unknown'; }],
    ['future update', (run) => { run.updatedAt = '2099-01-01T00:00:00Z'; }],
    ['update before creation', (run) => { run.updatedAt = '2026-10-14T06:00:00Z'; }],
  ])('rejects rerun proof with %s', (_, mutate) => {
    const mainCiRuns = structuredClone(fixture.mainCiRuns);
    delete mainCiRuns.failing.groupEvidence;
    mainCiRuns.runs[0].attempt = 2;
    mutate(mainCiRuns.runs[0]);
    expect(net({ mainCiRuns, readJobs: (_, opts) => opts?.filter === 'all' ? { jobs: passed } : { failed: fixture.failedJobs } }).plan.action).toBe('none');
  });
  it('does not read all attempts when off or main is green', () => {
    const { readJobs } = probe(passed, { settings: { requireProvenFlake: false } });
    expect(readJobs.mock.calls.some(([, opts]) => opts?.filter === 'all')).toBe(false);
    const read = vi.fn();
    net({ mainCiRuns: { runs: [{ ...fixture.mainCiRuns.runs[0], conclusion: 'success', attempt: 2 }] }, readJobs: read });
    expect(read).not.toHaveBeenCalled();
  });
  it('reads every page with filter=all', () => {
    const exec = vi.fn((_, args) => JSON.stringify({ jobs: args[1].endsWith('page=1') ? Array.from({ length: 100 }, () => passed[0]) : [passed[1]] }));
    const result = readFailedJobs(7, { exec, repoSlug: 'owner/repo', filter: 'all' });
    expect(result.jobs).toHaveLength(101);
    expect(exec.mock.calls.map(([, args]) => args[1])).toEqual(['repos/owner/repo/actions/runs/7/jobs?per_page=100&filter=all&page=1', 'repos/owner/repo/actions/runs/7/jobs?per_page=100&filter=all&page=2']);
  });
});

describe('audit and shadow visibility', () => {
  it('live additions owe one card and expose proof-bearing live entries', () => {
    const result = net({ live: true, mode: { value: 'quarantine', source: 'env' }, write: ({ change }) => change({ version: 1, entries: [] }) });
    expect(result.applied).toBe(true);
    expect(result.events.filter((e) => e.type === 'card-owed')).toEqual([expect.objectContaining({ ...result.plan.cards[0] })]);
    expect(result.liveEntries).toEqual([expect.objectContaining({ test: file, job: 'integration', proof })]);
  });
  it('does not owe a card for an entry concurrently added at the transport tip', () => {
    const result = net({ live: true, mode: { value: 'quarantine', source: 'env' }, write: ({ change }) => change({ version: 1, entries: [entry()] }) });
    expect(result.events.filter((e) => e.type === 'card-owed')).toEqual([]);
  });
  it('rejects additions when the transport tip concurrently reaches maxTests, without publishing or owing a card', () => {
    const dir = temp();
    const fresh = { version: 1, mode: 'quarantine', entries: [entry({ tests: ['scripts/other.test.mjs'] })] };
    const published = [];
    const changes = [];
    const result = net({ dir, live: true, mode: { value: 'quarantine', source: 'env' },
      settings: { value: { ...QUARANTINE_SAFETY_NET_DEFAULTS, maxTests: 1 }, sources: {} },
      // Planning sees an empty list; publication sees the other writer's different live file.
      write: ({ change }) => {
        const changed = change(fresh);
        changes.push(changed);
        if (!changed.ok) throw new Error(changed.error);
        published.push(changed);
        return changed;
      } });
    expect(result.plan.action).toBe('add');
    expect(changes).toEqual([{ ok: false, error: 'quarantine cap 1 reached' }]);
    expect(result).toMatchObject({ applied: false, error: 'quarantine cap 1 reached' });
    expect(result.events ?? []).toEqual([]);
    expect(published).toEqual([]);
    expect(fresh.entries.map((e) => e.test)).toEqual(['scripts/other.test.mjs']);
    expect(JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')).reds['62da75ed3'].added).toEqual([]);
  });
  it('logs none once per changed reason in a red window and persists shadowWhy', () => {
    const dir = temp();
    const mainCiRuns = structuredClone(fixture.mainCiRuns);
    delete mainCiRuns.failing.groupEvidence;
    const r = net({ dir, mainCiRuns });
    net({ dir, mainCiRuns });
    let lines = readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, SAFETY_NET_LEDGER), 'utf8')).reds['62da75ed3'].shadowWhy).toBe(r.plan.why);
    mainCiRuns.failing.jobs = ['smoke'];
    net({ dir, mainCiRuns });
    lines = readFileSync(join(dir, SAFETY_NET_SHADOW_LOG), 'utf8').trim().split('\n').map(JSON.parse);
    expect(lines).toHaveLength(2);
    expect(lines[1].why).toContain('smoke');
  });
});

describe('quarantined test health smell', () => {
  const evaluate = (result) => smell.evaluate({ mainCiRuns: fixture.mainCiRuns }, { now, quarantineSafetyNet: () => result });
  it('has the discovered smell shape and files one sign per live entry', () => {
    expect(validateSmellShape(smell)).toBe(smell);
    expect(smell).toMatchObject({ action: 'file', severity: 'medium' });
    const signs = evaluate({ shadow: false, liveEntries: [entry(), entry({ tests: ['scripts/other.test.mjs'] })] });
    expect(signs).toHaveLength(2);
    expect(signs[0]).toMatchObject({ subject: `quarantine:${file}`, breach: true });
    for (const part of [file, 'integration', '62da75ed3', 'rerun-passed', String(proof.runId), new Date(entry().expiresAt).toISOString()]) expect(signs[0].summary).toContain(part);
  });
  it('shadow, expiry, missing result and failed reads produce no sign', () => {
    expect(evaluate({ shadow: true, liveEntries: [entry()] })).toEqual([]);
    expect(evaluate({ shadow: false, liveEntries: [entry({ now: now - 24 * 3600000 })] })).toEqual([]);
    expect(evaluate(null)).toEqual([]);
    expect(smell.evaluate({}, { now, quarantineSafetyNet: () => { throw new Error('read failed'); } })).toEqual([]);
    expect(smell.evaluate({}, { now })).toEqual([]);
  });
});
