/**
 * Regression contract for persistent UNKNOWN recovery in merge-ai-prs.mjs:
 * - revalidateWithUnknownRetry accepts repo?, num?, onPersistentUnknown and nudge.
 *   Exhausted transient UNKNOWN calls each hook once with {repo,num,verdict};
 *   neither hook's return value authorizes a merge. Other outcomes call neither.
 * - markStuckUnknown(marks,{repo,num,now}) returns a NEW Map keyed by `${repo}#${num}`,
 *   containing {repo,num,since,resolved?}; repeated UNKNOWN preserves continuous age.
 * - pruneStuckUnknown returns a NEW Map; complete listedRepos can prove departure.
 *   retainPriority keeps resolved rows until merge/close/departure and silences alerts.
 *   Incomplete/unreadable evidence retains state. orderStuckUnknownFirst(prs,marks)
 *   stably advances marked rows inside each enforced delivery class.
 * - repollUnknownListings gains marks: marked listed PRs are read immediately,
 *   before retry sleeps/context/cascade, even if the listing says MERGEABLE.
 * - nudgeMergeability({repo,num,read}) calls read({repo,num,fields:['mergeable']})
 *   exactly once and returns that read's result; it performs no merge/write.
 * - decideStuckUnknownAlert(marks,{now,afterMinutes=30}) returns an array of
 *   {kind:'stuck-unknown-mergeability',repo,num,...} only strictly AFTER the bound.
 * Unit IO/time is injected; CLI cases use hermetic Git/GitHub shims and temporary coordination state.
 */
import { describe, it, expect, vi } from 'vitest';
import * as drain from '../merge-ai-prs.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonAppEnv } from './fixtures/daemon-app-env.mjs';
import { openPrPageFixture } from './fixtures/open-pr-page-fixture.mjs';
import { prioritizeMainFix } from '../lib/merge-queue-hook.mjs';

const REPO = 'example/web';
const HEAD = 'a'.repeat(40);
const MINUTE = 60_000;
const opts = { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD };
const cliScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs');
const pr = (extra = {}) => ({
  number: 42, title: 'Approved change', body: 'A concrete change summary.',
  headRefName: 'lane/approved', headRefOid: HEAD, baseRefName: 'main', state: 'OPEN',
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  commits: [{ authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }],
    messageBody: 'Co-Authored-By: Claude <noreply@anthropic.com>' }],
  ...extra,
});
const unknown = () => pr({ mergeable: 'UNKNOWN' });
const key = (repo, num) => `${repo}#${num}`;
const marksAt = (since = 0) => new Map([[key(REPO, 42), { repo: REPO, num: 42, since }]]);

async function retry(reads, extra = {}) {
  let index = 0;
  const read = vi.fn(async () => reads[Math.min(index++, reads.length - 1)]);
  const sleep = vi.fn(async () => {});
  const onPersistentUnknown = vi.fn();
  const nudge = vi.fn(async () => ({ mergeable: 'MERGEABLE' }));
  const verdict = await drain.revalidateWithUnknownRetry({
    repo: REPO, num: 42, read, opts, sleep, setting: { retries: 3, delayMs: 20_000 },
    onPersistentUnknown, nudge, ...extra,
  });
  return { verdict, read, sleep, onPersistentUnknown, nudge };
}

describe('persistent UNKNOWN recovery stays fail closed', () => {
  it('exhausts exactly 3 retries, marks and nudges once, returning the same UNKNOWN refusal', async () => {
    const result = await retry([unknown()]);
    expect(result.verdict).toEqual(drain.revalidateForMerge(unknown(), opts));
    expect(result.verdict.decision).toBe('skip');
    expect(drain.isTransientUnknownMergeability(result.verdict)).toBe(true);
    expect(result.read).toHaveBeenCalledTimes(4);
    expect(result.sleep.mock.calls).toEqual([[20_000], [20_000], [20_000]]);
    const payload = { repo: REPO, num: 42, verdict: result.verdict };
    expect(result.onPersistentUnknown.mock.calls).toEqual([[payload]]);
    expect(result.nudge.mock.calls).toEqual([[payload]]);
  });

  it('zero retries still escalates a persistent UNKNOWN once without sleeping', async () => {
    const result = await retry([unknown()], { setting: { retries: 0, delayMs: 20_000 } });
    expect(result.verdict.decision).toBe('skip');
    expect(result.read).toHaveBeenCalledTimes(1);
    expect(result.sleep).not.toHaveBeenCalled();
    expect(result.onPersistentUnknown).toHaveBeenCalledTimes(1);
    expect(result.nudge).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['red required check', pr({ statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] })],
    ['head moved', pr({ headRefOid: 'b'.repeat(40) })],
    ['conflict', pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })],
    ['unreadable PR', null],
  ])('%s after UNKNOWN stops retries without marking or nudging', async (_name, fresh) => {
    const result = await retry([unknown(), fresh, pr()]);
    expect(result.verdict).toEqual(drain.revalidateForMerge(fresh, opts));
    expect(result.verdict.decision).toBe('skip');
    expect(result.read).toHaveBeenCalledTimes(2);
    expect(result.onPersistentUnknown).not.toHaveBeenCalled();
    expect(result.nudge).not.toHaveBeenCalled();
  });

  it.each([[pr()], [unknown(), pr()]])('resolved MERGEABLE never marks or nudges (%j)', async (...reads) => {
    const result = await retry(reads);
    expect(result.verdict.decision).toBe('merge');
    expect(result.onPersistentUnknown).not.toHaveBeenCalled();
    expect(result.nudge).not.toHaveBeenCalled();
  });

  it('keeps both hooks optional for existing callers', async () => {
    const result = await retry([unknown()], { onPersistentUnknown: undefined, nudge: undefined });
    expect(result.verdict).toEqual(drain.revalidateForMerge(unknown(), opts));
  });
});

describe('stuck UNKNOWN marks across passes', () => {
  it('exports the pure mark, prune, order, nudge and alert helpers', () => {
    for (const name of ['markStuckUnknown', 'pruneStuckUnknown', 'orderStuckUnknownFirst',
      'nudgeMergeability', 'decideStuckUnknownAlert']) expect(drain[name], name).toBeTypeOf('function');
  });

  it('preserves continuous age and distinguishes the same PR number in different repos', () => {
    const empty = new Map();
    const first = drain.markStuckUnknown(empty, { repo: REPO, num: 42, now: 0 });
    const again = drain.markStuckUnknown(first, { repo: REPO, num: 42, now: 80 * MINUTE });
    const other = drain.markStuckUnknown(again, { repo: 'example/other', num: 42, now: MINUTE });
    expect(empty.size).toBe(0);
    expect(first).not.toBe(again);
    expect(again.get(key(REPO, 42))).toEqual({ repo: REPO, num: 42, since: 0 });
    expect(other.size).toBe(2);
    expect(again.size).toBe(1);
  });

  it.each([
    { mergeable: 'MERGEABLE', state: 'OPEN' },
    { mergeable: 'CONFLICTING', state: 'OPEN' },
    { mergeable: 'UNKNOWN', state: 'CLOSED' },
    { mergeable: 'UNKNOWN', state: 'MERGED' },
  ])('clears a mark after fresh evidence %j without mutating the input', fresh => {
    const marks = marksAt();
    const next = drain.pruneStuckUnknown(marks, { prs: [{ repo: REPO, num: 42, ...fresh }] });
    expect(next.size).toBe(0);
    expect(marks.size).toBe(1);
    const renewed = drain.markStuckUnknown(next, { repo: REPO, num: 42, now: 90 * MINUTE });
    expect(renewed.get(key(REPO, 42)).since).toBe(90 * MINUTE);
  });

  it.each([
    { prs: [] },
    { prs: [{ repo: REPO, num: 42 }] },
    { prs: [{ repo: REPO, num: 42, mergeable: 'UNKNOWN', state: 'OPEN' }] },
    { prs: [{ repo: 'example/other', num: 42, mergeable: 'MERGEABLE' }] },
  ])('retains marks on absent/unreadable/UNKNOWN or unrelated evidence (%j)', ({ prs }) => {
      const marks = marksAt();
      expect(drain.pruneStuckUnknown(marks, { prs })).toEqual(marks);
    });

  it('stably puts marked repo/number pairs first in cascade order without mutating rows', () => {
    const rows = [{ repo: REPO, num: 1 }, { repo: REPO, num: 42 },
      { repo: 'example/other', num: 42 }, { repo: REPO, num: 7 }];
    const marks = drain.markStuckUnknown(marksAt(), { repo: REPO, num: 7, now: 1 });
    const original = [...rows];
    expect(drain.orderStuckUnknownFirst(rows, marks)).toEqual([rows[1], rows[3], rows[0], rows[2]]);
    expect(rows).toEqual(original);
  });

  it('prunes absent marks only for complete fetched repos, before an --only narrowing', () => {
    const marks = drain.markStuckUnknown(marksAt(), { repo: 'example/other', num: 42, now: 0 });
    expect(drain.pruneStuckUnknown(marks, { prs: [], listedRepos: [REPO], retainPriority: true }))
      .toEqual(new Map([[key('example/other', 42), marks.get(key('example/other', 42))]]));
    expect(drain.pruneStuckUnknown(marks, { prs: [], listedRepos: [] })).toEqual(marks);
  });

  it.each(['MERGEABLE', 'CONFLICTING'])('keeps durable priority after %s, clears the alert, and restarts UNKNOWN age', mergeable => {
    const resolved = drain.pruneStuckUnknown(marksAt(), {
      prs: [{ repo: REPO, num: 42, mergeable, state: 'OPEN' }], retainPriority: true,
    });
    expect(resolved.get(key(REPO, 42))).toEqual({ repo: REPO, num: 42, since: 0, resolved: true });
    expect(drain.decideStuckUnknownAlert(resolved, { now: 80 * MINUTE })).toEqual([]);
    expect(drain.markStuckUnknown(resolved, { repo: REPO, num: 42, now: 90 * MINUTE }).get(key(REPO, 42)))
      .toEqual({ repo: REPO, num: 42, since: 90 * MINUTE });
    expect(drain.pruneStuckUnknown(resolved, { prs: [{ repo: REPO, num: 42, state: 'MERGED' }], retainPriority: true }).size).toBe(0);
  });

  it.each([
    ['ready-age', 'enforce', [1, 42, 7]],
    ['ready-age', 'shadow', [42, 1, 7]],
    ['card-number', 'enforce', [42, 1, 7]],
  ])('orders marked candidates with %s/%s and keeps plan reasons aligned', (order, mode, expected) => {
    const rows = [1, 7, 42].map(num => ({ repo: REPO, num, item: num, decision: 'merge' }));
    const result = drain.planLabelDrain(rows, { readyOrder: {
      order, priority: { mode }, stuckUnknownMarks: marksAt(), now: MINUTE,
      infoOf: c => ({ readyAtMs: c.num, facts: { incident: { open: true, owner: c.num === 1 } } }),
    } });
    expect(result.ready.map(c => c.num)).toEqual(expected);
    expect(result.readyOrder.map(c => c.num)).toEqual(result.ready.map(c => c.num));
  });

  it('applies the same main-fix rule before logging the plan even with delivery priority off', () => {
    const rows = [7, 42, 1].map(num => ({ repo: REPO, num, decision: 'merge' }));
    const plan = drain.planLabelDrain(rows, { readyOrder: {
      priority: { mode: 'off' }, stuckUnknownMarks: marksAt(),
      prioritize: ordered => prioritizeMainFix(ordered, { mainFix: { repo: REPO, pr: 1 }, queueSettings: { enabled: true } }),
    } });
    expect(plan.ready.map(c => c.num)).toEqual([1, 42, 7]);
    expect(plan.readyOrder.map(c => c.num)).toEqual([1, 42, 7]);
  });

  it('re-reads marked PRs at next pass start before waits, context and cascade', async () => {
    const events = [];
    const rows = new Map([[REPO, [pr({ number: 1 }), pr()]]]);
    const read = vi.fn(async (repo, num) => { events.push(`read:${repo}#${num}`); return pr(); });
    await drain.repollThenCollectContext({
      repoll: () => drain.repollUnknownListings({ prsByRepo: rows, marks: marksAt(), read,
        setting: { retries: 3, delayMs: 20_000 }, sleep: async () => { events.push('sleep'); } }),
      collect: () => { events.push('context'); },
    });
    events.push('cascade');
    expect(events).toEqual([`read:${REPO}#42`, 'context', 'cascade']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('marks and nudges UNKNOWN listings that cannot reach merge-site revalidation', async () => {
    const onPersistentUnknown = vi.fn(), nudge = vi.fn();
    await drain.repollUnknownListings({ prsByRepo: new Map([[REPO, [unknown()]]]),
      read: async () => unknown(), sleep: async () => {}, setting: { retries: 1, delayMs: 0 }, onPersistentUnknown, nudge });
    expect(onPersistentUnknown.mock.calls).toEqual([[{ repo: REPO, num: 42 }]]);
    expect(nudge.mock.calls).toEqual(onPersistentUnknown.mock.calls);
  });
});

describe('operator fallback for a continuously stuck UNKNOWN', () => {
  it('defaults to 30 minutes, with a strict threshold and a distinct non-red-main kind', () => {
    const marks = marksAt();
    expect(drain.decideStuckUnknownAlert(marks, { now: 30 * MINUTE })).toEqual([]);
    const alerts = drain.decideStuckUnknownAlert(marks, { now: 30 * MINUTE + 1 });
    expect(alerts).toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', repo: REPO, num: 42 })]);
    expect(JSON.stringify(alerts)).not.toContain('red-main');
    expect(marks).toEqual(marksAt());
  });

  it('uses configured continuous age below the default threshold while fresh marks do not alert', () => {
    const marks = new Map([...marksAt(), [key(REPO, 7), { repo: REPO, num: 7, since: 15 * MINUTE }]]);
    expect(drain.decideStuckUnknownAlert(marks, { now: 20 * MINUTE })).toEqual([]);
    expect(drain.decideStuckUnknownAlert(marks, { now: 20 * MINUTE, afterMinutes: 10 }))
      .toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', num: 42 })]);
    expect(drain.decideStuckUnknownAlert(new Map(), { now: 80 * MINUTE })).toEqual([]);
  });
});

it('nudges recomputation with one injected mergeable-only read, even when still UNKNOWN', async () => {
  const result = { mergeable: 'UNKNOWN' };
  const read = vi.fn(async () => result);
  expect(await drain.nudgeMergeability({ repo: REPO, num: 42, read })).toBe(result);
  expect(read.mock.calls).toEqual([[{ repo: REPO, num: 42, fields: ['mergeable'] }]]);
});

// Real runCli invocations share only the temporary coordination directory. Both executables are inert
// fixtures: no real Git metadata, GitHub calls or merge writes, including during follow-up bookkeeping.
const cliGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), F = process.env.UNKNOWN_FIXTURE;
const prs = JSON.parse(fs.readFileSync(F, 'utf8'));
const landed = n => fs.existsSync(F + '.merged-' + n);
const out = x => { fs.writeSync(1, JSON.stringify(x)); process.exit(0); };
if (a[0] === 'repo') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'api' && a[1] === 'graphql') {
  const query = a.find(x => x.startsWith('query=')) || '';
  if (query.includes('comments{totalCount}')) out({ data: { repository: { pullRequest: { comments: { totalCount: 0 } } } } });
  out((${openPrPageFixture})(prs.filter(p => !landed(p.number)), query));
}
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p) process.exit(1);
  const fields = a[a.indexOf('--json') + 1] || '';
  const fresh = fields.endsWith('reviewDecision,labels,commits');
  if (fresh || fields === 'mergeable') fs.appendFileSync(F + '.reads', a[2] + ':' + fields + '\\n');
  out({ ...p, ...(fresh && process.env.UNKNOWN_NUM === a[2] ? { mergeable: 'UNKNOWN' } : {}),
    ...(fresh && process.env.WRONG_NUM === a[2] ? { number: 999, mergeable: 'MERGEABLE' } : {}),
    state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? new Date().toISOString() : null });
}
if (a[0] === 'pr' && a[1] === 'merge') {
  fs.appendFileSync(F + '.attempts', a[2] + '\\n');
  if (process.env.FAIL_NUM === a[2]) { process.stderr.write('fixture merge refused'); process.exit(1); }
  fs.writeFileSync(F + '.merged-' + a[2], ''); process.exit(0);
}
if (a[0] === 'api') {
  if (/issues\\/\\d+\\/events$/.test(a[1])) out([{ event: 'labeled', label: { name: 'priority:urgent' }, actor: { login: 'chalbert' } }]);
  if (/\\/branches\\/main$/.test(a[1])) out({ sha: 'tip' });
  if (/pulls\\/\\d+\\/files/.test(a[1])) out([[{ filename: 'backlog/leaf.md' }]]);
  out([]);
}
process.exit(0);
`;
const cliGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-unknown.git');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

function cliFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-unknown-'));
  try {
    const bin = join(dir, 'bin'), coord = join(dir, 'coord'), fixture = join(dir, 'prs.json');
    mkdirSync(bin); mkdirSync(coord);
    for (const [name, code] of [['gh', cliGh], ['git', cliGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const statePath = join(coord, 'stuck-unknown-mergeability.json');
    const preferences = join(dir, 'preferences.json');
    const mainFixFile = join(dir, 'main-fix.json'), queueFile = join(dir, 'queue.json');
    writeFileSync(preferences, JSON.stringify({ 'drain.stuckUnknownMergeability': { afterMinutes: 10 } }));
    writeFileSync(queueFile, JSON.stringify({ mergeQueue: { enabled: true }, mergeFreshness: { enabled: false } }));
    const auth = daemonAppEnv(dir);
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.HOME; syncBuiltinESMExports();");
    const rows = nums => nums.map(number => pr({ number, headRefOid: `sha-${number}`, headRefName: `lane/leaf-${number}`,
      comments: [], files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0, changeType: 'ADDED' }] }));
    const state = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [];
    const seed = (extra = {}) => writeFileSync(statePath, JSON.stringify([{ repo: 'fixture/drain-unknown', num: 42, since: Date.now() - 80 * MINUTE, ...extra }]));
    const invoke = (prs, env = {}, flags = []) => {
      writeFileSync(fixture, JSON.stringify(prs));
      for (const suffix of ['.reads', '.attempts']) if (existsSync(fixture + suffix)) rmSync(fixture + suffix);
      const child = spawnSync(process.execPath, ['--import', preload, cliScript,
        '--this-repo', '--label=ready-to-merge', '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', '--json', ...flags], {
        cwd: dir, encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, ...auth, PATH: `${bin}:${process.env.PATH}`, UNKNOWN_FIXTURE: fixture,
          WE_COORDINATION_ROOT: coord, WE_PLATFORM_PREFERENCES_FILE: preferences,
          WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '0', WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC: '0',
          WE_DRAIN_PRIORITY_MODE: 'enforce', ...env },
      });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const lines = suffix => existsSync(fixture + suffix) ? readFileSync(fixture + suffix, 'utf8').trim().split('\n').filter(Boolean) : [];
      return { result: JSON.parse(child.stdout.trim().split('\n').at(-1)), stderr: child.stderr,
        reads: lines('.reads'), attempts: lines('.attempts').map(Number) };
    };
    const mainFix = num => {
      writeFileSync(mainFixFile, JSON.stringify({ repo: 'we', pr: num, prs: [num], firstRedSha: 'red', reason: 'fixture main fix', setAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
      return { WE_MERGE_QUEUE_MAIN_FIX_FILE: mainFixFile, WE_MERGE_QUEUE_SETTINGS_FILE: queueFile };
    };
    run({ rows, state, seed, invoke, mainFix });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('persistent UNKNOWN through the daemon drain CLI', () => {
  it('marks a PR that remains UNKNOWN in the listing without attempting a merge', () => cliFixture(({ rows, state, invoke }) => {
    const prs = rows([42]); prs[0].mergeable = 'UNKNOWN';
    const out = invoke(prs, { UNKNOWN_NUM: '42' });
    expect(out.attempts).toEqual([]);
    expect(out.reads).toContain('42:mergeable');
    expect(state()).toEqual([expect.objectContaining({ num: 42 })]);
  }), 180_000);
  it('persists a bounded refusal and nudge across invocations, then emits its distinct aged alert', () => cliFixture(({ rows, state, seed, invoke }) => {
    const first = invoke(rows([42]), { UNKNOWN_NUM: '42' });
    expect(first.attempts).toEqual([]);
    expect(first.reads).toContain('42:mergeable');
    expect(state()).toEqual([{ repo: 'fixture/drain-unknown', num: 42, since: expect.any(Number) }]);
    seed({ since: Date.now() - 20 * MINUTE });
    const since = state()[0].since;
    const second = invoke(rows([42]), { UNKNOWN_NUM: '42' });
    expect(state()[0].since).toBe(since);
    expect(second.reads[0]).toMatch(/^42:number,/);
    expect(second.result.alerts).toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', num: 42 })]);
    expect(second.stderr).toContain('merge-ai-prs · alert:');
    expect(second.stderr).toContain('stuckUnknownMergeability.afterMinutes=10 (platform)');
    expect(second.attempts).toEqual([]);
  }), 180_000);

  it.each(['closed', 'unlabelled'])('prunes the durable mark and alert when the PR is %s', kind => cliFixture(({ rows, seed, state, invoke }) => {
    seed();
    const prs = rows(kind === 'closed' ? [] : [42]);
    if (prs.length) prs[0].labels = [];
    const out = invoke(prs);
    expect(state()).toEqual([]);
    expect(out.result.alerts).toEqual([]);
    expect(out.stderr).not.toContain('merge-ai-prs · alert:');
  }), 180_000);

  it('preserves resolved priority across invocations until merge, behind an urgent class', () => cliFixture(({ rows, seed, state, invoke }) => {
    seed();
    // The early read resolves #42, but a merge failure requires its priority to survive process exit.
    const first = invoke(rows([7, 42]), { FAIL_NUM: '42' });
    expect(first.attempts).toEqual([42, 7]);
    expect(first.result.alerts).toEqual([]);
    expect(state()).toEqual([expect.objectContaining({ num: 42, resolved: true })]);
    const prs = rows([1, 8, 42]);
    prs[0].labels.push({ name: 'priority:urgent' });
    const out = invoke(prs);
    expect(out.reads[0]).toMatch(/^42:number,/);
    expect(out.attempts).toEqual([1, 42, 8]);
    expect(out.result.alerts).toEqual([]);
    expect(state()).toEqual([]);
  }), 180_000);

  it('does not prune a present marked PR narrowed out by --only', () => cliFixture(({ rows, seed, state, invoke }) => {
    seed();
    invoke(rows([7, 42]), {}, ['--only=7']);
    expect(state()).toEqual([expect.objectContaining({ num: 42 })]);
  }), 180_000);

  it('keeps the published main-fix ahead of starvation priority even with delivery classes off', () => cliFixture(({ rows, seed, mainFix, invoke }) => {
    seed();
    const out = invoke(rows([1, 42]), { ...mainFix(1), WE_DRAIN_PRIORITY_MODE: 'off' });
    expect(out.attempts).toEqual([1, 42]);
  }), 180_000);

  it('rejects a wrong-number fresh read without resolving the marked PR or its alert', () => cliFixture(({ rows, seed, state, invoke }) => {
    seed();
    const out = invoke(rows([42]), { WRONG_NUM: '42' });
    expect(out.attempts).toEqual([]);
    expect(out.result.alerts).toEqual([expect.objectContaining({ num: 42 })]);
    expect(state()[0].resolved).toBeUndefined();
  }), 180_000);
});
