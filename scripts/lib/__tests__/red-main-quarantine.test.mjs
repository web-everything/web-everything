import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUARANTINE_REF, validateQuarantineList, canWriteQuarantine, addEntries, pruneOnGreen, testsToSkip,
  classifyQuarantinedFailure, decideQuarantineHold, testArea,
} from '../red-main-quarantine.mjs';
import { redMainSignal, resolveRedMainMode } from '../red-main-hold.mjs';
import { assertPushRef } from '../git-transport-branch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'red-main-hold-windows-2026-10.json'), 'utf8'));
const T = (iso) => Date.parse(iso);
const NOW = T('2026-10-09T14:00:00Z');
const SHA = '7e51376635bbb571dfc596f1986960bf35a03fd6';
const TEST = 'skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs';
const listWith = (tests, sha = SHA, now = NOW) => addEntries(null, { tests, brokenSha: sha, owner: 'main-fix-7e5137663', reason: 'red on main', actor: 'red-main-safety-net', now }).list;

describe('quarantine — settings', () => {
  it('mode defaults to stop; the shipped platform preference is stop; env can switch it', () => {
    expect(resolveRedMainMode({ env: {}, file: '/nonexistent' })).toEqual({ value: 'stop', source: 'default' });
    expect(resolveRedMainMode({ env: {} }).value).toBe('stop');
    expect(resolveRedMainMode({ env: { WE_DRAIN_RED_MAIN_MODE: 'quarantine' } })).toEqual({ value: 'quarantine', source: 'env' });
  });
});

describe('quarantine — who may write, and where', () => {
  it('only the red-main safety net or the operator may write', () => {
    expect(canWriteQuarantine('red-main-safety-net')).toBe(true);
    expect(canWriteQuarantine('operator')).toBe(true);
    expect(canWriteQuarantine('pr-4613')).toBe(false);
    expect(addEntries(null, { tests: [TEST], brokenSha: SHA, owner: 'x', reason: 'y', actor: 'some-pr', now: NOW }).ok).toBe(false);
  });
  it('the push-ref guard allows exactly refs/heads/ops/quarantine', () => {
    expect(assertPushRef('ops/quarantine', QUARANTINE_REF)).toBe(QUARANTINE_REF);
    expect(() => assertPushRef('main', QUARANTINE_REF)).toThrow();
    expect(() => assertPushRef('+ops/quarantine', QUARANTINE_REF)).toThrow();
    expect(() => assertPushRef('ops/review-requests', QUARANTINE_REF)).toThrow();
  });
  it('every add is an audit event; a malformed test id is refused', () => {
    const r = addEntries(null, { tests: [TEST], brokenSha: SHA, owner: 'o', reason: 'r', actor: 'operator', now: NOW });
    expect(r.events).toEqual([expect.objectContaining({ type: 'quarantine-added', test: TEST, actor: 'operator' })]);
    expect(addEntries(null, { tests: ['../../etc/passwd'], brokenSha: SHA, owner: 'o', reason: 'r', actor: 'operator', now: NOW }).ok).toBe(false);
    expect(validateQuarantineList({ version: 2 }).ok).toBe(false);
  });
});

describe('quarantine — lifetime', () => {
  it('main green removes every entry (with removal events); unknown removes only expired ones', () => {
    const l = listWith([TEST]);
    expect(pruneOnGreen(l, { mainGreen: null, now: NOW + 1000 }).list.entries).toHaveLength(1);
    const g = pruneOnGreen(l, { mainGreen: true, now: NOW + 1000 });
    expect(g.list.entries).toHaveLength(0);
    expect(g.events[0]).toMatchObject({ type: 'quarantine-removed', why: 'main-green' });
    expect(pruneOnGreen(l, { mainGreen: false, now: NOW + 7 * 3600_000 }).events[0].why).toBe('expired');
  });
});

describe('quarantine — what CI skips', () => {
  const l = listWith([TEST]);
  it('an ordinary PR skips the quarantined test', () => {
    expect(testsToSkip({ list: l, now: NOW, prNumber: 4613, fixPrs: [4617] })).toEqual([TEST]);
  });
  it('the main-fix PR and main itself RUN it', () => {
    expect(testsToSkip({ list: l, now: NOW, prNumber: 4617, fixPrs: [4617] })).toEqual([]);
    expect(testsToSkip({ list: l, now: NOW, onMain: true })).toEqual([]);
  });
  it('a PR red only on quarantined tests is routed to a re-run; any other failure is not', () => {
    expect(classifyQuarantinedFailure({ failedTests: [TEST], list: l, now: NOW }).rerun).toBe(true);
    expect(classifyQuarantinedFailure({ failedTests: [TEST, 'scripts/x.test.mjs'], list: l, now: NOW }).rerun).toBe(false);
    expect(classifyQuarantinedFailure({ failedTests: [], list: l, now: NOW }).rerun).toBe(false);
  });
});

describe('quarantine — drain hold', () => {
  const sig = redMainSignal({ mainRedState: { red: true, firstRedSha: SHA, since: NOW - 3600_000, expiresAt: NOW + 60_000 }, priority: { repo: 'we', pr: 4617, prs: [4617], expiresAt: NOW + 60_000 }, now: NOW });
  const l = listWith([TEST]);
  const fixFiles = [TEST];
  it('area of a __tests__ file is its package dir', () => { expect(testArea({ test: TEST })).toBe('skills-src/conveyor/'); });
  it('no quarantine entry for this red ⇒ stop (fail closed)', () => {
    expect(decideQuarantineHold({ num: 1, files: ['backlog/a.md'], signal: sig, list: null, fixFiles, now: NOW })).toMatchObject({ hold: true, fallback: 'stop' });
    expect(decideQuarantineHold({ num: 1, files: ['backlog/a.md'], signal: sig, list: listWith([TEST], 'abcdef0123'), fixFiles, now: NOW }).fallback).toBe('stop');
  });
  it('unknown files ⇒ held', () => {
    expect(decideQuarantineHold({ num: 1, files: null, signal: sig, list: l, fixFiles, now: NOW }).hold).toBe(true);
  });
  it('the fix PR lands; a disjoint PR lands; an overlapping PR is held', () => {
    expect(decideQuarantineHold({ num: 4617, files: fixFiles, signal: sig, list: l, fixFiles, now: NOW })).toEqual({ hold: false, fix: true });
    expect(decideQuarantineHold({ num: 2, files: ['backlog/a.md'], signal: sig, list: l, fixFiles, now: NOW }).hold).toBe(false);
    expect(decideQuarantineHold({ num: 3, files: ['skills-src/conveyor/x.mjs'], signal: sig, list: l, fixFiles: [], now: NOW }).reason).toMatch(/area/);
  });
});

describe('quarantine — replay of the 2026-10-09 red windows', () => {
  for (const w of FIX.windows) {
    it(w.name, () => {
      const rows = [];
      for (const p of w.landed) {
        const at = T(p.at);
        const redNow = (w.mainRedState && at >= T(w.mainRedState.since)) || (w.manualFreeze && at >= T(w.manualFreezeFrom) && at < T(w.manualFreezeUntil));
        if (!redNow) continue;
        const sig = redMainSignal({
          mainRedState: w.mainRedState ? { ...w.mainRedState, since: T(w.mainRedState.since), expiresAt: at + 1 } : null,
          manualFreeze: w.manualFreeze && !w.mainRedState ? w.manualFreeze : null,
          priority: { ...w.priority, expiresAt: at + 1 }, now: at,
        });
        const list = listWith(w.quarantine.tests, w.quarantine.brokenSha, at - 1);
        const fixFiles = w.landed.filter((x) => sig.fixPrs.includes(x.num)).flatMap((x) => x.files);
        rows.push({ num: p.num, ...decideQuarantineHold({ num: p.num, files: p.files, signal: sig, list, fixFiles, now: at }) });
      }
      expect(rows.filter((r) => r.hold).map((r) => r.num)).toEqual(w.expectQuarantine.held);
      expect(rows.filter((r) => r.fix).map((r) => r.num)).toEqual(w.expectQuarantine.fix);
    });
  }
});
