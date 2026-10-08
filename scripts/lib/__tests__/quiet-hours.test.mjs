import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isQuiet, breaksThrough, decideDelivery, sweepSkip, planDigest, mergeSettings, inWindow, toggleActive, DEFAULT_QUIET_SETTINGS,
} from '../quiet-hours.mjs';
import { gateAlert, flushDigest } from '../quiet-hours-io.mjs';

// 2026-10-08 is EDT (UTC-4): 23:30 ET = 03:30Z, 12:00 ET = 16:00Z, 06:59 ET = 10:59Z, 07:00 ET = 11:00Z.
const ET = (hhmm, day = '2026-10-09') => Date.parse(`${day}T${hhmm}:00-04:00`);
const S = DEFAULT_QUIET_SETTINGS;

describe('isQuiet', () => {
  it('overnight window wraps midnight', () => {
    expect(isQuiet(ET('23:30', '2026-10-08'), S).quiet).toBe(true);
    expect(isQuiet(ET('02:00'), S).quiet).toBe(true);
    expect(isQuiet(ET('06:59'), S).quiet).toBe(true);
    expect(isQuiet(ET('07:00'), S).quiet).toBe(false);
    expect(isQuiet(ET('12:00'), S).quiet).toBe(false);
    expect(isQuiet(ET('21:59', '2026-10-08'), S).quiet).toBe(false);
    expect(isQuiet(ET('22:00', '2026-10-08'), S)).toEqual({ quiet: true, reason: 'window' });
  });
  it('uses the configured time zone across DST (EST in January)', () => {
    expect(isQuiet(Date.parse('2027-01-15T03:30:00Z'), S).quiet).toBe(true); // 22:30 EST
    expect(isQuiet(Date.parse('2027-01-15T02:30:00Z'), S).quiet).toBe(false); // 21:30 EST
  });
  it('disabled / malformed window → not quiet', () => {
    expect(isQuiet(ET('02:00'), { ...S, enabled: false }).reason).toBe('disabled');
    expect(isQuiet(ET('02:00'), { ...S, start: '25:00' }).reason).toBe('bad-window');
    expect(inWindow(100, 300, 300)).toBe(false);
  });
  it('toggle forces quiet; past or garbage until = off', () => {
    const noon = ET('12:00');
    expect(isQuiet(noon, S, { on: true, until: null })).toEqual({ quiet: true, reason: 'toggle' });
    expect(isQuiet(noon, S, { on: true, until: new Date(noon + 60_000).toISOString() }).quiet).toBe(true);
    expect(isQuiet(noon, S, { on: true, until: new Date(noon - 60_000).toISOString() }).quiet).toBe(false);
    expect(isQuiet(noon, S, { on: false, until: null }).quiet).toBe(false);
    expect(toggleActive({ on: true, until: 'nope' }, noon)).toBe(false);
    expect(isQuiet(noon, S, 'garbage').quiet).toBe(false);
  });
  it('mergeSettings tolerates garbage and partial input', () => {
    expect(mergeSettings(null)).toEqual(mergeSettings(S));
    const m = mergeSettings({ start: 5, breakthrough: { daemonDownMin: 45 } });
    expect(m.start).toBe('22:00');
    expect(m.breakthrough.daemonDownMin).toBe(45);
    expect(m.breakthrough.mainRed).toBe(true);
  });
});

describe('breakthrough rule', () => {
  it('main red always breaks through', () => {
    expect(breaksThrough({ title: 'x', emergency: { kind: 'main-red' } }, S).breaks).toBe(true);
    expect(breaksThrough({ title: 'CI: main is red on abc123' }, S).breaks).toBe(true);
    expect(breaksThrough({ title: 'x', emergency: { kind: 'main-red' } }, { ...S, breakthrough: { mainRed: false } }).breaks).toBe(false);
  });
  it('daemon down breaks through only past the threshold', () => {
    expect(breaksThrough({ emergency: { kind: 'daemon-down', downForMs: 31 * 60_000 } }, S).breaks).toBe(true);
    expect(breaksThrough({ emergency: { kind: 'daemon-down', downForMs: 30 * 60_000 } }, S).breaks).toBe(true);
    expect(breaksThrough({ emergency: { kind: 'daemon-down', downForMs: 10 * 60_000 } }, S).breaks).toBe(false);
    expect(breaksThrough({ emergency: { kind: 'daemon-down', downForMs: null } }, S).breaks).toBe(true);
    expect(breaksThrough({ emergency: { kind: 'daemon-down' } }, { ...S, breakthrough: { daemonDownUnknownDuration: 'hold' } }).breaks).toBe(false);
  });
  it('routine alerts are held at night, delivered by day', () => {
    const a = { title: 'Health: red-pr-unattended — #1' };
    expect(decideDelivery(a, { now: ET('02:00'), settings: S }).deliver).toBe(false);
    expect(decideDelivery(a, { now: ET('12:00'), settings: S }).deliver).toBe(true);
    expect(decideDelivery({ ...a, emergency: { kind: 'main-red' } }, { now: ET('02:00'), settings: S }).deliver).toBe(true);
  });
  it('sweeps: coroner/opus skip overnight, pr-movement still runs', () => {
    expect(sweepSkip('coroner', { now: ET('02:00'), settings: S }).skip).toBe(true);
    expect(sweepSkip('opus', { now: ET('02:00'), settings: S }).skip).toBe(true);
    expect(sweepSkip('pr-movement', { now: ET('02:00'), settings: S }).skip).toBe(false);
    expect(sweepSkip('coroner', { now: ET('12:00'), settings: S }).skip).toBe(false);
  });
});

describe('digest', () => {
  it('plans one notification, grouping repeats', () => {
    const d = planDigest([{ title: 'A', body: '1' }, { title: 'A', body: '2' }, { title: 'B' }, 'junk'], S);
    expect(d.title).toBe('Quiet-hours digest: 3 alert(s) held');
    expect(d.body).toBe('A ×2 | B');
    expect(planDigest([], S)).toBe(null);
    expect(planDigest([{ title: 'A' }], { ...S, digest: { enabled: false } })).toBe(null);
  });

  it('IO: holds at night, sends ONE digest after quiet ends, emergencies pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ digestDir: join(dir, 'digest'), toggleFile: join(dir, 'toggle.json') }));
    const env = { WE_QUIET_HOURS_SETTINGS: settingsPath };
    const sent = [];
    const send = (n) => { sent.push(n); return { ok: true }; };

    expect(gateAlert({ title: 'routine 1' }, { send, env, now: ET('01:00') }).suppressed).toBe(true);
    expect(gateAlert({ title: 'routine 2' }, { send, env, now: ET('02:00') }).suppressed).toBe(true);
    expect(gateAlert({ title: 'main down', emergency: { kind: 'main-red' } }, { send, env, now: ET('03:00') }).ok).toBe(true);
    expect(sent.map((n) => n.title)).toEqual(['main down']);
    expect(flushDigest({ send, env, now: ET('06:00') }).flushed).toBe(false); // still quiet

    expect(flushDigest({ send, env, now: ET('07:05') }).count).toBe(2);
    expect(sent.at(-1).title).toBe('Quiet-hours digest: 2 alert(s) held');
    expect(flushDigest({ send, env, now: ET('07:35') }).flushed).toBe(false); // only once
    expect(existsSync(join(dir, 'digest', 'latest-digest.md'))).toBe(true);
    expect(readFileSync(join(dir, 'digest', 'latest-digest.md'), 'utf8')).toMatch(/routine 2/);

    // A daytime alert is delivered directly.
    expect(gateAlert({ title: 'day' }, { send, env, now: ET('12:00') })).toEqual({ ok: true });
  });

  it('IO: a failed digest send keeps the entries for the next flush', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ digestDir: join(dir, 'digest'), toggleFile: join(dir, 'none.json') }));
    const env = { WE_QUIET_HOURS_SETTINGS: settingsPath };
    gateAlert({ title: 'r' }, { send: () => ({ ok: true }), env, now: ET('01:00') });
    expect(flushDigest({ send: () => ({ ok: false }), env, now: ET('08:00') }).flushed).toBe(false);
    expect(readdirSync(join(dir, 'digest'))).toContain('held.jsonl');
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(1);
  });

  it('IO: the toggle file forces quiet by day; VITEST bypass and off switch deliver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(join(dir, 'toggle.json'), JSON.stringify({ on: true, until: null }));
    writeFileSync(settingsPath, JSON.stringify({ digestDir: join(dir, 'digest'), toggleFile: join(dir, 'toggle.json') }));
    const send = () => ({ ok: true });
    expect(gateAlert({ title: 'x' }, { send, env: { WE_QUIET_HOURS_SETTINGS: settingsPath }, now: ET('12:00') }).suppressed).toBe(true);
    expect(gateAlert({ title: 'x' }, { send, env: { WE_QUIET_HOURS_SETTINGS: settingsPath, WE_QUIET_HOURS: 'off' }, now: ET('12:00') })).toEqual({ ok: true });
    expect(gateAlert({ title: 'x' }, { send, env: { WE_QUIET_HOURS_SETTINGS: settingsPath, VITEST: 'true' }, now: ET('12:00') })).toEqual({ ok: true });
  });

  it('IO: a broken settings file still delivers (never loses an alert)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const p = join(dir, 's.json'); writeFileSync(p, '{torn');
    // torn settings → defaults; at noon that is not quiet → delivered.
    expect(gateAlert({ title: 'x' }, { send: () => ({ ok: true }), env: { WE_QUIET_HOURS_SETTINGS: p, WE_QUIET_DIGEST_DIR: join(dir, 'd'), WE_QUIET_MODE_FILE: join(dir, 'none') }, now: ET('12:00') })).toEqual({ ok: true });
  });
});
