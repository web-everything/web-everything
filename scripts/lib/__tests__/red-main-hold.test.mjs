import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RED_MAIN_HOLD_REASON, resolveRedMainHoldSetting, redMainSignal, decideRedMainHold, redMainHoldReason, replayRedMainHold,
} from '../red-main-hold.mjs';
import { classifySkipReason } from '../drain-skip-reasons.mjs';
import { resolveFreezeMarkerPath } from '../../readiness/red-main-remediation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'fixtures', 'red-main-hold-windows-2026-10.json'), 'utf8'));
const T = (iso) => Date.parse(iso);
const NOW = T('2026-10-09T14:00:00Z');
const red = { red: true, firstRedSha: '7e51376635bbb571', since: T('2026-10-09T13:06:06Z'), expiresAt: NOW + 60_000 };
const pri = { repo: 'we', pr: 4617, prs: [4617], expiresAt: NOW + 60_000 };

describe('red-main-hold — setting cascade (card x5wnfcg)', () => {
  it('built-in default is on', () => {
    expect(resolveRedMainHoldSetting({ env: {}, file: '/nonexistent.json' })).toEqual({ value: 'on', source: 'default' });
  });
  it('settings file (platform preference) beats the default; env (tool override) beats the file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'rmh-')), 's.json');
    writeFileSync(f, JSON.stringify({ redMainHold: 'off' }));
    expect(resolveRedMainHoldSetting({ env: {}, file: f })).toEqual({ value: 'off', source: 'settings' });
    expect(resolveRedMainHoldSetting({ env: { WE_DRAIN_RED_MAIN_HOLD: 'on' }, file: f })).toEqual({ value: 'on', source: 'env' });
    expect(resolveRedMainHoldSetting({ env: { WE_DRAIN_RED_MAIN_HOLD: 'bogus' }, file: f }).value).toBe('off');
  });
  it('the shipped platform preference is on', () => {
    expect(resolveRedMainHoldSetting({ env: {} }).value).toBe('on');
  });
});

describe('red-main-hold — signal', () => {
  it('green (no records) is not red', () => {
    expect(redMainSignal({ now: NOW }).red).toBe(false);
  });
  it('the published health-watch record alone is red; the fix PRs come from the priority record', () => {
    const s = redMainSignal({ mainRedState: red, priority: pri, now: NOW });
    expect(s).toMatchObject({ red: true, sources: ['published'], fixPrs: [4617] });
  });
  it('lifts automatically: an expired (or removed) record is not red', () => {
    expect(redMainSignal({ mainRedState: { ...red, expiresAt: NOW - 1 }, priority: { ...pri, expiresAt: NOW - 1 }, now: NOW }).red).toBe(false);
  });
  it('a manual freeze marker is red, and still exempts the published fix PR (held item 164)', () => {
    const s = redMainSignal({ manualFreeze: { frozen: true }, priority: pri, now: NOW });
    expect(s).toMatchObject({ red: true, fixPrs: [4617] });
    expect(s.sources).toContain('manual');
  });
  it("another repo's priority record names no WE fix PR", () => {
    expect(redMainSignal({ mainRedState: red, priority: { ...pri, repo: 'fui' }, now: NOW }).fixPrs).toEqual([]);
  });
});

describe('red-main-hold — per-PR decision', () => {
  const sig = redMainSignal({ mainRedState: red, priority: pri, now: NOW });
  it('the main-fix PR is exempt', () => {
    expect(decideRedMainHold({ num: 4617, signal: sig })).toEqual({ hold: false, fix: true });
  });
  it('every other local PR is held with a red-main-hold reason the skip taxonomy names', () => {
    const d = decideRedMainHold({ num: 4613, signal: sig });
    expect(d.hold).toBe(true);
    expect(d.reason.startsWith(`${RED_MAIN_HOLD_REASON}:`)).toBe(true);
    expect(d.reason).toContain('#4617');
    expect(classifySkipReason(d.reason)).toBe('red-main-hold');
  });
  it('the reason is stable pass to pass (no clock in it) so the hold event fires once', () => {
    expect(redMainHoldReason(sig)).toBe(redMainHoldReason(redMainSignal({ mainRedState: red, priority: pri, now: NOW + 30_000 })));
  });
  it('no fix PR published yet ⇒ every local PR is held', () => {
    const s = redMainSignal({ mainRedState: red, now: NOW });
    expect(decideRedMainHold({ num: 4617, signal: s }).hold).toBe(true);
  });
  it('other repos, setting off, and green main hold nothing', () => {
    expect(decideRedMainHold({ num: 1, isLocal: false, signal: sig }).hold).toBe(false);
    expect(decideRedMainHold({ num: 1, signal: sig, setting: 'off' }).hold).toBe(false);
    expect(decideRedMainHold({ num: 1, signal: redMainSignal({ now: NOW }) }).hold).toBe(false);
  });
});

describe('red-main-hold — replay of the 2026-10-09 red windows', () => {
  for (const w of FIX.windows) {
    it(w.name, () => {
      const signalAt = (at) => {
        const live = (iso) => iso && at >= T(iso);
        const mainRedState = w.mainRedState && live(w.mainRedState.since)
          ? { ...w.mainRedState, since: T(w.mainRedState.since), expiresAt: at + 1_800_000 } : null;
        const manualFreeze = w.manualFreeze && live(w.manualFreezeFrom) && at < T(w.manualFreezeUntil) ? w.manualFreeze : null;
        const priority = (mainRedState || manualFreeze) && w.priority ? { ...w.priority, expiresAt: at + 1_800_000 } : null;
        return redMainSignal({ mainRedState, manualFreeze, priority, now: at });
      };
      const rows = replayRedMainHold(w.landed.map((p) => ({ num: p.num, at: T(p.at) })), signalAt);
      expect(rows.filter((r) => r.hold).map((r) => r.num)).toEqual(w.expect.held);
      expect(rows.filter((r) => r.fix).map((r) => r.num)).toEqual(w.expect.fix);
      expect(rows.filter((r) => !r.hold && !r.fix).map((r) => r.num)).toEqual(w.expect.free);
    });
  }
});

describe('red-main freeze marker — ONE source (held item 166)', () => {
  it('outside a test run it lives in the coordination root, whatever clone imports it', () => {
    expect(resolveFreezeMarkerPath({ WE_COORDINATION_ROOT: '/coord' })).toBe('/coord/red-main-freeze.json');
  });
  it('WE_RED_MAIN_FREEZE still overrides', () => {
    expect(resolveFreezeMarkerPath({ WE_RED_MAIN_FREEZE: '/x.json', WE_COORDINATION_ROOT: '/coord' })).toBe('/x.json');
  });
  it('inside a test run it never points at the live coordination root', () => {
    expect(resolveFreezeMarkerPath({ VITEST: 'true', WE_COORDINATION_ROOT: '/coord' })).not.toContain('/coord');
  });
});
