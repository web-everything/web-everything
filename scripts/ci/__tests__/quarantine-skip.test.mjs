// @vitest-environment node
/**
 * Card xx7ckd6 N1 — CI's red-main quarantine skip step (we:scripts/ci/quarantine-skip.mjs). Replays today's red main
 * (first red 2cb94418d; failing `scripts/operations/__tests__/record-referral-ruling.test.mjs`): an ordinary PR skips
 * only that file, the main-fix PR runs it, main runs it, and `redMainMode: stop` (the shipped setting) skips nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

import { quarantineSkip } from '../quarantine-skip.mjs';
import { decideCiSkip, ciJobContext, addEntries, setFixPrs, pruneOnGreen, validateQuarantineList } from '../../lib/red-main-quarantine.mjs';

const TEST_FILE = 'scripts/operations/__tests__/record-referral-ruling.test.mjs';
const FIRST_RED = '2cb94418d3d95e9d64ca59ce6de789a319a6718c';
const NOW = Date.parse('2026-10-10T19:05:00Z');
const FIX_PR = 4980;
const ADDED = addEntries(null, { tests: [TEST_FILE], brokenSha: FIRST_RED, owner: 'red-main-safety-net', reason: 'main CI red since 2cb94418d', actor: 'red-main-safety-net', now: Date.parse('2026-10-10T18:56:00Z') }).list;
const LIST = setFixPrs(ADDED, { fixPrs: [FIX_PR], actor: 'red-main-safety-net', now: NOW }).list;
const READ = { ok: true, list: LIST };
const Q = { value: 'quarantine', source: 'env' };
const prEvent = (n) => ({ pull_request: { number: n, base: { ref: 'main' } } });

const run = (o) => quarantineSkip({ env: {}, now: NOW, mode: Q, read: READ, changed: [], readEvent: () => o.event, flags: { event: 'pull_request', ref: `refs/pull/${o.pr}/merge`, 'event-path': '/e.json' }, ...o });

describe('quarantine-skip — 2026-10-10 replay', () => {
  it('an ordinary PR skips ONLY the quarantined test file', () => {
    const r = run({ pr: 4990, event: prEvent(4990) });
    expect(r.line).toBe(`--exclude=${TEST_FILE}`);
    expect(r.skip).toEqual([TEST_FILE]);
  });
  it('the main-fix PR skips nothing (it must prove the test passes)', () => {
    const r = run({ pr: FIX_PR, event: prEvent(FIX_PR) });
    expect(r.line).toBe('');
    expect(r.why).toMatch(/main-fix PR/);
  });
  it('redMainMode stop (shipped) skips nothing', () => {
    const r = run({ pr: 4990, event: prEvent(4990), mode: { value: 'stop', source: 'settings' } });
    expect(r.line).toBe('');
    expect(r.why).toMatch(/redMainMode is stop/);
  });
  it('main itself (push) skips nothing', () => {
    expect(run({ flags: { event: 'push', ref: 'refs/heads/main' }, event: null }).line).toBe('');
  });
  it('an unreadable list skips nothing (run everything)', () => {
    expect(run({ pr: 4990, event: prEvent(4990), read: { ok: false, error: 'no ref' } }).line).toBe('');
  });
  it('a PR that changes the quarantined test file runs it', () => {
    const r = run({ pr: 4990, event: prEvent(4990), changed: [TEST_FILE, 'scripts/x.mjs'] });
    expect(r.line).toBe('');
  });
  it('unknown changed files ⇒ run everything', () => {
    expect(run({ pr: 4990, event: prEvent(4990), changed: null }).line).toBe('');
  });
  it('an expired entry is not skipped', () => {
    expect(run({ pr: 4990, event: prEvent(4990), now: NOW + 25 * 60 * 60 * 1000 }).line).toBe('');
  });
  it('after prune on green nothing is skipped', () => {
    const pruned = pruneOnGreen(LIST, { mainGreen: true, now: NOW });
    expect(pruned.list).toEqual({ version: 1, entries: [] });
    expect(run({ pr: 4990, event: prEvent(4990), read: { ok: true, list: pruned.list } }).line).toBe('');
  });
});

describe('ciJobContext', () => {
  it('pull_request from the event payload or the ref', () => {
    expect(ciJobContext({ eventName: 'pull_request', ref: 'refs/pull/12/merge', event: null })).toEqual({ onMain: false, prNumber: 12, known: true });
    expect(ciJobContext({ eventName: 'pull_request', ref: 'x', event: prEvent(7) }).prNumber).toBe(7);
  });
  it('merge_group: the PR at the head of the group', () => {
    expect(ciJobContext({ eventName: 'merge_group', ref: 'refs/heads/gh-readonly-queue/main/pr-4980-abc123', event: null }).prNumber).toBe(4980);
  });
  it('push to main ⇒ onMain; anything else unknown', () => {
    expect(ciJobContext({ eventName: 'push', ref: 'refs/heads/main' })).toMatchObject({ onMain: true, known: true });
    expect(ciJobContext({ eventName: 'pull_request', ref: 'refs/heads/x', event: null }).known).toBe(false);
    expect(decideCiSkip({ mode: 'quarantine', read: READ, ctx: { known: false }, changedFiles: [], now: NOW }).skip).toEqual([]);
  });
});

describe('list guards', () => {
  it('only a writer may set the fix PR numbers', () => {
    expect(setFixPrs(ADDED, { fixPrs: [1], actor: 'pr-4990', now: NOW }).ok).toBe(false);
  });
  it('a malformed fixPrs makes the list unreadable', () => {
    expect(validateQuarantineList({ ...LIST, fixPrs: ['4980; rm -rf'] }).ok).toBe(false);
  });
  it('a name-qualified entry is never turned into a file exclude', () => {
    const l = addEntries(null, { tests: [`${TEST_FILE}::#4979 the sanctioned writer`], brokenSha: FIRST_RED, owner: 'o', reason: 'r', actor: 'operator', now: NOW - 1000 }).list;
    const d = decideCiSkip({ mode: 'quarantine', read: { ok: true, list: l }, ctx: { known: true, onMain: false, prNumber: 1 }, changedFiles: [], now: NOW });
    expect(d.skip).toEqual([]);
    expect(d.unsupported).toHaveLength(1);
  });
});

describe('quarantine-skip — the mode is the one the daemon published on the list (PR #4816 review)', () => {
  const stamped = (mode) => ({ ok: true, list: { ...LIST, mode } });
  const asPr = (o) => run({ pr: 4990, event: prEvent(4990), mode: undefined, ...o });
  it('daemon switched on by env/preference: the list says quarantine, the PR tree still says stop ⇒ CI skips', () => {
    const r = asPr({ read: stamped('quarantine'), env: {} });
    expect(r.line).toBe(`--exclude=${TEST_FILE}`);
  });
  it('the list says stop ⇒ nothing is skipped, whatever CI own env says', () => {
    const r = asPr({ read: stamped('stop'), env: { WE_DRAIN_RED_MAIN_MODE: 'quarantine' } });
    expect(r.line).toBe('');
    expect(r.why).toMatch(/redMainMode is stop/);
  });
  it('no stamp on the list: stop — the PR tree and the job env are never a source for the mode', () => {
    const r = asPr({ read: READ, env: { WE_DRAIN_RED_MAIN_MODE: 'quarantine' } });
    expect(r.line).toBe('');
    expect(r.why).toMatch(/redMainMode is stop/);
    expect(asPr({ read: READ, env: {} }).line).toBe('');
  });
  it('the mode never comes from the checked-out settings file', () => {
    expect(readFileSync(new URL('../quarantine-skip.mjs', import.meta.url), 'utf8')).not.toMatch(/resolveRedMainMode|red-main-hold/);
  });
  it('stop mode still reads the list once: the mode lives on the list, so there is one bounded fetch even while off', () => {
    let reads = 0;
    const r = asPr({ read: undefined, readList: () => { reads += 1; return stamped('stop'); } });
    expect(r.line).toBe('');
    expect(reads).toBe(1);
  });
  it('an unreadable list still skips nothing', () => {
    expect(asPr({ read: { ok: false, error: 'no ref' }, env: { WE_DRAIN_RED_MAIN_MODE: 'quarantine' } }).line).toBe('');
  });
});

describe('ci.yml wiring', () => {
  const steps = yaml.load(readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')).jobs['test-shard'].steps;
  it.each(['Unit suite shard', 'Unit suite no-coverage group'])('%s appends the skip args to its vitest run', (prefix) => {
    const s = steps.find((x) => String(x.name).startsWith(prefix));
    const line = s.run.split('\n').find((l) => l.includes('npm run test:'));
    expect(line).toMatch(/"\$\{files\[@\]\}" \$\(node scripts\/ci\/quarantine-skip\.mjs\)/);
  });
});
