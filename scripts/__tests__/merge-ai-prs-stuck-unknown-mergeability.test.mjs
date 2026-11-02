/**
 * RED contract for merge-ai-prs.mjs (no production changes in this task):
 * - revalidateWithUnknownRetry accepts repo?, num?, onPersistentUnknown and nudge.
 *   Exhausted transient UNKNOWN calls each hook once with {repo,num,verdict};
 *   neither hook's return value authorizes a merge. Other outcomes call neither.
 * - markStuckUnknown(marks,{repo,num,now}) returns a NEW Map keyed by `${repo}#${num}`,
 *   containing {repo,num,since}; repeated marks preserve the first timestamp.
 * - pruneStuckUnknown(marks,{prs}) returns a NEW Map. prs are fresh observations
 *   {repo,num,mergeable,state}; known mergeability resolves the alert, retaining
 *   starvation priority until CLOSED/MERGED or absent from a complete listing.
 *   Absent/unreadable evidence otherwise retains it. orderStuckUnknownFirst(prs,marks)
 *   returns a stable, non-mutating partition of {repo,num,...} rows.
 * - repollUnknownListings gains marks: marked listed PRs are read immediately,
 *   before retry sleeps/context/cascade, even if the listing says MERGEABLE.
 * - nudgeMergeability({repo,num,read}) calls read({repo,num,fields:['mergeable']})
 *   exactly once and returns that read's result; it performs no merge/write.
 * - decideStuckUnknownAlert(marks,{now,afterMinutes=30}) returns an array of
 *   {kind:'stuck-unknown-mergeability',repo,num,...} only strictly AFTER the bound.
 * CLI coverage below uses isolated state and hermetic git/gh executables.
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

const REPO = 'example/web';
const HEAD = 'a'.repeat(40);
const MINUTE = 60_000;
const opts = { requiredCheck: 'test', defaultBranch: 'main', expectedHeadSha: HEAD };
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

  it.each(['MERGEABLE', 'CONFLICTING'])('resolves the %s alert but retains durable priority until departure', mergeable => {
    const marks = marksAt();
    const next = drain.pruneStuckUnknown(marks, { prs: [{ repo: REPO, num: 42, mergeable, state: 'OPEN' }] });
    expect(next.get(key(REPO, 42))).toEqual({ repo: REPO, num: 42, since: 0, resolved: true });
    expect(drain.decideStuckUnknownAlert(next, { now: 80 * MINUTE })).toEqual([]);
    expect(drain.orderStuckUnknownFirst([{ repo: REPO, num: 1 }, { repo: REPO, num: 42 }], next).map(p => p.num)).toEqual([42, 1]);
    expect(drain.markStuckUnknown(next, { repo: REPO, num: 42, now: 90 * MINUTE }).get(key(REPO, 42)))
      .toEqual({ repo: REPO, num: 42, since: 90 * MINUTE });
    expect(marks).toEqual(marksAt());
  });

  it('prunes absent marks only for explicitly complete, successfully fetched repos', () => {
    const marks = drain.markStuckUnknown(marksAt(), { repo: 'example/other', num: 42, now: 0 });
    expect(drain.pruneStuckUnknown(marks, { prs: [], listedRepos: [REPO] }))
      .toEqual(new Map([[key('example/other', 42), marks.get(key('example/other', 42))]]));
    expect(drain.pruneStuckUnknown(marks, { prs: [], listedRepos: [] })).toEqual(marks);
  });

  it('starts a new continuous age when a resolved priority mark becomes UNKNOWN again', () => {
    const resolved = new Map([[key(REPO, 42), { repo: REPO, num: 42, since: 0, resolved: true }]]);
    const fresh = [{ repo: REPO, num: 42, mergeable: 'UNKNOWN' }];
    const active = drain.pruneStuckUnknown(resolved, { prs: fresh, now: 90 * MINUTE });
    expect(active).toEqual(marksAt(90 * MINUTE));
    expect(drain.pruneStuckUnknown(active, { prs: fresh, now: 95 * MINUTE })).toEqual(active);
    expect(drain.decideStuckUnknownAlert(active, { now: 121 * MINUTE })).toHaveLength(1);
  });

  it.each(['ready-age', 'card-number'])('keeps %s plan readyOrder aligned while preserving enforced delivery classes', order => {
    const candidates = [1, 2, 42, 7].map(num => ({ repo: REPO, num, decision: 'merge' }));
    const plan = drain.planLabelDrain(candidates, { readyOrder: { order, priority: { mode: 'enforce' },
      stuckUnknownMarks: marksAt(), infoOf: c => ({ readyAtMs: c.num, facts: { incident: { open: true, owner: c.num === 2 } } }) } });
    expect(plan.ready.map(c => c.num)).toEqual(order === 'ready-age' ? [2, 42, 1, 7] : [42, 1, 2, 7]);
    expect(plan.readyOrder.map(c => c.num)).toEqual(plan.ready.map(c => c.num));
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

  it('uses a configured threshold below the default; only the 11-minute mark alerts', () => {
    const marks = new Map([...marksAt(), [key(REPO, 7), { repo: REPO, num: 7, since: 6 * MINUTE }]]);
    expect(drain.decideStuckUnknownAlert(marks, { now: 11 * MINUTE, afterMinutes: 10 }))
      .toEqual([expect.objectContaining({ kind: 'stuck-unknown-mergeability', num: 42 })]);
    expect(drain.decideStuckUnknownAlert(marks, { now: 11 * MINUTE })).toEqual([]);
    expect(drain.decideStuckUnknownAlert(new Map(), { now: 80 * MINUTE })).toEqual([]);
  });
});

it('nudges recomputation with one injected mergeable-only read, even when still UNKNOWN', async () => {
  const result = { mergeable: 'UNKNOWN' };
  const read = vi.fn(async () => result);
  expect(await drain.nudgeMergeability({ repo: REPO, num: 42, read })).toBe(result);
  expect(read.mock.calls).toEqual([[{ repo: REPO, num: 42, fields: ['mergeable'] }]]);
});

const cliGh = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), f = process.env.UNKNOWN_FIXTURE;
const { prs, fresh, wrongNumber, unreadable, failMerge } = JSON.parse(fs.readFileSync(f, 'utf8'));
const openPrPageFixture = ${openPrPageFixture};
const landed = n => fs.existsSync(f + '.merged-' + n);
const out = x => { fs.writeSync(1, JSON.stringify(x)); process.exit(0); };
fs.appendFileSync(f + '.calls', JSON.stringify(a) + '\\n');
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('main'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') out(prs.filter(p => !landed(p.number)));
if (a[0] === 'api' && a[1] === 'graphql') {
  const query = a.find(v => v.startsWith('query=')) || '';
  if (query.includes('comments{totalCount}')) out({ data: { repository: { pullRequest: { comments: { totalCount: 0 } } } } });
  out(openPrPageFixture(prs.filter(p => !landed(p.number)), query));
}
if (a[0] === 'pr' && a[1] === 'view') {
  const p = prs.find(p => String(p.number) === a[2]);
  if (!p || (p.number === 42 && unreadable)) process.exit(1);
  const fields = a[a.indexOf('--json') + 1] || '';
  const full = fields.includes('mergeStateStatus');
  out({ ...p, ...(p.number === 42 && (full || fields === 'mergeable') ? { mergeable: fresh } : {}),
    ...(p.number === 42 && full && wrongNumber ? { number: 999 } : {}),
    state: landed(p.number) ? 'MERGED' : 'OPEN', mergedAt: landed(p.number) ? new Date().toISOString() : null });
}
if (a[0] === 'pr' && a[1] === 'merge') {
  fs.appendFileSync(f + '.attempts', a[2] + '\\n');
  if (Number(a[2]) === failMerge) process.exit(1);
  fs.writeFileSync(f + '.merged-' + a[2], '');
}
if (a[0] === 'api') out([]);
process.exit(0);
`;
const cliGit = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') process.stdout.write('git@github.com:fixture/drain-unknown.git\\n');
if (a[0] === 'diff') process.exit(1);
process.exit(0);
`;

function withCli(test) {
  const dir = mkdtempSync(join(tmpdir(), 'drain-unknown-'));
  try {
    const bin = join(dir, 'bin'), coord = join(dir, 'coord'), fixture = join(dir, 'prs.json');
    mkdirSync(bin); mkdirSync(coord);
    for (const [name, code] of [['gh', cliGh], ['git', cliGit]]) writeFileSync(join(bin, name), code, { mode: 0o755 });
    const path = join(coord, 'stuck-unknown-mergeability.json');
    const deliverySettings = join(dir, 'delivery.json');
    writeFileSync(deliverySettings, JSON.stringify({ mergeDelivery: { strategy: 'drain-direct' },
      mergeQueue: { enabled: false }, mergeFreshness: { enabled: false } }));
    const preferences = join(dir, 'preferences.json');
    const marks = () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    const seed = rows => writeFileSync(path, JSON.stringify(rows));
    const repo = 'fixture/drain-unknown';
    const preload = 'data:text/javascript,' + encodeURIComponent("import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.UNKNOWN_HOME; syncBuiltinESMExports();");
    const run = ({ numbers = [42], fresh = 'MERGEABLE', wrongNumber = false, unreadable = false, failMerge = null, unready = false, flags = [], json = true, env = {}, mainFixPr = null, alertAfterMinutes = 30, redRequired = false } = {}) => {
      const prs = numbers.map(number => pr({ number, headRefOid: number.toString(16).padStart(40, '0'), headRefName: `lane/leaf-${number}`,
        labels: unready ? [] : [{ name: 'ready-to-merge' }], comments: [],
        ...(redRequired ? { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] } : {}),
        files: [{ path: `backlog/leaf-${number}.md`, additions: 1, deletions: 0, changeType: 'ADDED' }] }));
      writeFileSync(fixture, JSON.stringify({ prs, fresh, wrongNumber, unreadable, failMerge }));
      const mainFixFile = join(dir, 'main-fix.json');
      if (mainFixPr) writeFileSync(mainFixFile, JSON.stringify({ repo: 'drain-unknown', pr: mainFixPr, prs: [mainFixPr], setAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
      else rmSync(mainFixFile, { force: true });
      writeFileSync(preferences, JSON.stringify({ 'drain.stuckUnknownMergeability': { afterMinutes: alertAfterMinutes } }));
      for (const suffix of ['.attempts', '.calls', ...numbers.map(n => '.merged-' + n)]) rmSync(fixture + suffix, { force: true });
      const r = spawnSync(process.execPath, ['--import', preload, join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'),
        '--this-repo', '--label=ready-to-merge', '--no-reconcile-labels', '--no-drain-lease', '--no-red-main-freeze', ...(json ? ['--json'] : []), ...flags], {
        cwd: dir, encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, ...daemonAppEnv(dir), PATH: `${bin}:${process.env.PATH}`, UNKNOWN_HOME: dir, UNKNOWN_FIXTURE: fixture,
          WE_COORDINATION_ROOT: coord, WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES: '0', WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC: '0',
          WE_DRAIN_ORDER: 'card-number', WE_DRAIN_PRIORITY_MODE: 'off',
          WE_MERGE_DELIVERY_SETTINGS_FILE: deliverySettings, WE_PLATFORM_PREFERENCES_FILE: preferences,
          WE_MERGE_QUEUE_SETTINGS_FILE: deliverySettings,
          WE_MERGE_QUEUE_MAIN_FIX_FILE: mainFixFile, ...env },
      });
      expect(r.error, r.stderr).toBeUndefined();
      const readLines = suffix => existsSync(fixture + suffix) ? readFileSync(fixture + suffix, 'utf8').trim().split('\n').filter(Boolean) : [];
      return { result: json ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : null, stderr: r.stderr,
        attempts: readLines('.attempts').map(Number), calls: readLines('.calls').map(line => JSON.parse(line)) };
    };
    test({ run, marks, seed, repo });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('persistent UNKNOWN real drain wiring', () => {
  it('persists a refusal and nudge, retains resolved priority across invocations until confirmed merge', () => withCli(({ run, marks, repo }) => {
    const first = run({ fresh: 'UNKNOWN' });
    expect(first.attempts).toEqual([]);
    expect(marks()).toEqual([{ repo, num: 42, since: expect.any(Number) }]);
    expect(first.calls.filter(a => a[0] === 'pr' && a[1] === 'view' && a[a.indexOf('--json') + 1] === 'mergeable')).toHaveLength(1);
    const second = run({ numbers: [1, 42], failMerge: 42, json: false });
    expect(second.attempts).toEqual([42, 1]);
    expect(second.stderr).toMatch(/1\. #42 .*persistent UNKNOWN recovery priority/);
    expect(second.stderr).toMatch(/2\. #1 /);
    expect(marks()).toEqual([{ repo, num: 42, since: expect.any(Number), resolved: true }]);
    const third = run({ numbers: [1, 42] });
    expect(third.attempts).toEqual([42, 1]);
    expect(marks()).toEqual([]);
  }), 180_000);

  it.each([false, true])('prunes departed marks and alerts on a complete fetch (still open=%s)', unready => withCli(({ run, seed, marks, repo }) => {
    seed([{ repo, num: 42, since: Date.now() - 80 * MINUTE }, { repo: 'fixture/other', num: 42, since: Date.now() }]);
    const out = run({ numbers: unready ? [42] : [], unready });
    expect(marks()).toEqual([{ repo: 'fixture/other', num: 42, since: expect.any(Number) }]);
    expect(out.result.alerts ?? []).not.toContainEqual(expect.objectContaining({ repo, num: 42 }));
    expect(out.stderr).not.toContain('"kind":"stuck-unknown-mergeability"');
  }), 90_000);

  it('emits an aged alert after the early read, then clears it on resolved evidence', () => withCli(({ run, seed, repo }) => {
    seed([{ repo, num: 42, since: Date.now() - 80 * MINUTE }]);
    const stuck = run({ fresh: 'UNKNOWN' });
    expect(stuck.result.alerts).toContainEqual(expect.objectContaining({ kind: 'stuck-unknown-mergeability', repo, num: 42 }));
    expect(stuck.stderr.match(/"kind":"stuck-unknown-mergeability"/g)).toHaveLength(1);
    const resolved = run();
    expect(resolved.result.alerts ?? []).toEqual([]);
  }), 180_000);

  it('retains the published main-fix delivery priority ahead of recovery in the logged and actual order', () => withCli(({ run, seed, repo }) => {
    seed([{ repo, num: 42, since: Date.now() - 80 * MINUTE }]);
    const out = run({ numbers: [1, 2, 42], mainFixPr: 2, json: false,
      env: { WE_DRAIN_ORDER: 'ready-age', WE_DRAIN_PRIORITY_MODE: 'enforce' } });
    expect(out.attempts).toEqual([2, 42, 1]);
    expect(out.stderr).toMatch(/1\. #2 P0/);
    expect(out.stderr).toMatch(/2\. #42 .*persistent UNKNOWN recovery priority/);
  }), 90_000);

  it('wires a configured 10-minute alert threshold that would stay silent under the 30-minute default', () => withCli(({ run, seed, repo }) => {
    seed([{ repo, num: 42, since: Date.now() - 11 * MINUTE }]);
    const out = run({ fresh: 'UNKNOWN', alertAfterMinutes: 10 });
    expect(out.result.alerts).toContainEqual(expect.objectContaining({ num: 42 }));
    expect(out.stderr).toContain('stuckUnknownMergeability.afterMinutes=10 (platform)');
  }), 90_000);

  it('reactivates a resolved mark and later alerts even when red CI prevents premerge revalidation', () => withCli(({ run, seed, marks, repo }) => {
    const old = Date.now() - 80 * MINUTE;
    seed([{ repo, num: 42, since: old, resolved: true }]);
    const renewed = run({ fresh: 'UNKNOWN', redRequired: true });
    expect(renewed.attempts).toEqual([]);
    expect(marks()).toEqual([{ repo, num: 42, since: expect.any(Number) }]);
    expect(marks()[0].since).toBeGreaterThan(old);
    const active = { ...marks()[0], since: Date.now() - 11 * MINUTE };
    seed([active]);
    const aged = run({ fresh: 'UNKNOWN', redRequired: true, alertAfterMinutes: 10 });
    expect(aged.attempts).toEqual([]);
    expect(marks()).toEqual([active]);
    expect(aged.result.alerts).toContainEqual(expect.objectContaining({ num: 42 }));
  }), 180_000);

  it.each(['wrongNumber', 'unreadable'])('fails closed on %s without clearing the requested mark', mode => withCli(({ run, seed, marks, repo }) => {
    const mark = { repo, num: 42, since: Date.now() - 80 * MINUTE };
    seed([mark]);
    const out = run({ [mode]: true });
    expect(out.attempts).toEqual([]);
    expect(marks()).toEqual([mark]);
    expect(out.result.alerts).toContainEqual(expect.objectContaining({ repo, num: 42 }));
  }), 90_000);
});
