import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isQuiet, breaksThrough, decideDelivery, sweepSkip, planDigest, mergeSettings, inWindow, toggleActive, DEFAULT_QUIET_SETTINGS,
} from '../quiet-hours.mjs';
import { gateAlert, flushDigest, SETTINGS_PATH, STALE_STAGED_MS } from '../quiet-hours-io.mjs';
import { spawnSync } from 'node:child_process';

// A pid that is certain to be dead: a child that has already exited (a hard-coded pid could belong to a live process).
const DEAD = spawnSync(process.execPath, ['-e', '0']).pid;

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
    // The real health title for a red main is `Health: pre-existing-red-on-main — main:<sha>`: the word order is
    // "red ... main", which the title fallback must also read (it is the safety net for any caller that does not tag).
    expect(breaksThrough({ title: 'Health: pre-existing-red-on-main — main:efd88abcc' }, S).breaks).toBe(true);
    expect(breaksThrough({ title: 'Tests failing on main @ efd88abcc' }, S).breaks).toBe(true);
    expect(breaksThrough({ title: 'Health: red-pr-unattended — PR #4461' }, S).breaks).toBe(false); // red, but not main
    expect(breaksThrough({ title: 'Health: clone-behind-main — lane-3' }, S).breaks).toBe(false); // main, but not red
    // ...and the shipped settings file (which overrides the default) must say the same thing.
    const shipped = mergeSettings(JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')));
    expect(breaksThrough({ title: 'Health: pre-existing-red-on-main — main:efd88abcc' }, shipped).breaks).toBe(true);
    expect(breaksThrough({ title: 'Health: red-pr-unattended — PR #4461' }, shipped).breaks).toBe(false);
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

// The queue is one file per held alert under `<digestDir>/queue/`; a flusher claims it as `claim-<pid>-<ms>-<seq>/`.
const queued = (digest) => {
  try { return readdirSync(join(digest, 'queue')).map((f) => JSON.parse(readFileSync(join(digest, 'queue', f), 'utf8'))); } catch { return []; }
};
const claimsIn = (digest) => readdirSync(digest).filter((f) => f.startsWith('claim-'));
const leftovers = (digest) => readdirSync(digest).filter((f) => /^(claim-|sent-)/.test(f))
  .concat(existsSync(join(digest, 'tmp')) ? readdirSync(join(digest, 'tmp')).map((f) => `tmp/${f}`) : []);

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
    expect(readFileSync(join(dir, 'digest', 'latest-digest.md'), 'utf8')).toMatch(/routine 1[\s\S]*routine 2/); // in arrival order
    expect(leftovers(join(dir, 'digest'))).toEqual([]);

    // A daytime alert is delivered directly.
    expect(gateAlert({ title: 'day' }, { send, env, now: ET('12:00') })).toEqual({ ok: true });
  });

  // Variants of "the queue was claimed, then something went wrong before delivery was confirmed".
  const heldFixture = (n = 2) => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ digestDir: join(dir, 'digest'), toggleFile: join(dir, 'none.json') }));
    const env = { WE_QUIET_HOURS_SETTINGS: settingsPath };
    for (let i = 1; i <= n; i += 1) gateAlert({ title: `r${i}` }, { send: () => ({ ok: true }), env, now: ET('01:00') });
    return { dir, env, digest: join(dir, 'digest') };
  };

  it('IO: a failed digest send keeps the entries for the next flush', () => {
    const { env, digest } = heldFixture(1);
    expect(flushDigest({ send: () => ({ ok: false }), env, now: ET('08:00') }).flushed).toBe(false);
    expect(queued(digest).map((e) => e.title)).toEqual(['r1']);
    expect(claimsIn(digest)).toEqual([]);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(1);
  });

  it('IO: a throwing sender restores claimed entries for retry', () => {
    const { env, digest } = heldFixture();
    const r = flushDigest({ send: () => { throw new Error('boom'); }, env, now: ET('08:00') });
    expect(r.flushed).toBe(false);
    expect(claimsIn(digest)).toEqual([]);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(2);
  });

  it('IO: a digest file write failure restores claimed entries for retry', () => {
    const { env, digest } = heldFixture();
    mkdirSync(join(digest, 'latest-digest.md')); // writeFileSync onto a directory throws EISDIR after the md write
    const send = vi.fn(() => ({ ok: true }));
    expect(flushDigest({ send, env, now: ET('08:00') }).flushed).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(claimsIn(digest)).toEqual([]);
    rmSync(join(digest, 'latest-digest.md'), { recursive: true });
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(2);
  });

  it('IO: an exception after the claim whose restore ALSO fails leaves a claim the next flushes recover (never stranded)', () => {
    const { env, digest } = heldFixture();
    // The sender throws, and the queue path is blocked by a stray file, so putting the entries back fails twice.
    const r = flushDigest({ send: () => { writeFileSync(join(digest, 'queue'), 'blocker'); throw new Error('boom'); }, env, now: ET('08:00') });
    expect(r).toMatchObject({ flushed: false, reason: expect.stringMatching(/boom/) });
    expect(claimsIn(digest)).toHaveLength(1); // the entries are still on disk, in our claim
    rmSync(join(digest, 'queue')); // the fault clears
    const ok = vi.fn(() => ({ ok: true }));
    expect(flushDigest({ send: ok, env, now: ET('08:05') }).flushed).toBe(false); // young: maybe still a live flusher
    expect(flushDigest({ send: ok, env, now: ET('08:15') }).count).toBe(2); // our own orphan, past the stale window
    expect(ok).toHaveBeenCalledTimes(1);
    expect(leftovers(digest)).toEqual([]);
    // ...and the same orphan in a process that has since exited is recovered by any other process.
    const f = heldFixture(1);
    renameSync(join(f.digest, 'queue'), join(f.digest, `claim-${DEAD}-${ET('08:00')}-1`));
    expect(flushDigest({ send: ok, env: f.env, now: ET('08:15') }).count).toBe(1);
  });

  it('IO: a stale claim left by a crashed flusher is recovered by the next flush', () => {
    const { env, digest } = heldFixture();
    renameSync(join(digest, 'queue'), join(digest, `claim-${DEAD}-${ET('08:00')}-1`)); // crash right after the claim
    expect(queued(digest)).toEqual([]);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:05') }).flushed).toBe(false); // claim is young — maybe a live flusher
    expect(claimsIn(digest).some((f) => f.startsWith(`claim-${DEAD}-`))).toBe(true);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('09:00') }).count).toBe(2); // an hour old — recovered and sent
    expect(claimsIn(digest)).toEqual([]);
  });

  it('IO: a stale claim merges with entries held since (nothing lost, one digest)', () => {
    const { env, digest } = heldFixture(1);
    renameSync(join(digest, 'queue'), join(digest, `claim-${DEAD}-${ET('07:00')}-1`));
    gateAlert({ title: 'later' }, { send: () => ({ ok: true }), env, now: ET('22:30', '2026-10-09') }); // held again, next night
    const sent = [];
    expect(flushDigest({ send: (n) => { sent.push(n); return { ok: true }; }, env, now: ET('08:00', '2026-10-10') }).count).toBe(2);
    expect(sent).toHaveLength(1);
  });

  it('IO: a file in the queue that is not an alert does not swallow the others', () => {
    const { env, digest } = heldFixture(1);
    writeFileSync(join(digest, 'queue', 'garbage.json'), '{"at":"2026-10-09T02:00:00Z","title":"torn'); // not JSON
    gateAlert({ title: 'after' }, { send: () => ({ ok: true }), env, now: ET('03:00') });
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:00') }).count).toBe(2); // r1 + after
  });

  it('IO: a writer that died after staging leaves nothing in the queue, and its staged file is cleared after a day', () => {
    const { env, digest } = heldFixture(1);
    mkdirSync(join(digest, 'tmp'), { recursive: true });
    const staged = `${String(ET('01:00')).padStart(15, '0')}-${DEAD}-1-dead.json`;
    writeFileSync(join(digest, 'tmp', staged), JSON.stringify({ title: 'never committed' }));
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:00') }).count).toBe(1); // only r1: staged is not queued
    expect(existsSync(join(digest, 'tmp', staged))).toBe(true); // young: its writer may still commit it
    expect(ET('08:00', '2026-10-10') - ET('01:00')).toBeGreaterThan(STALE_STAGED_MS);
    flushDigest({ send: () => ({ ok: true }), env, now: ET('08:00', '2026-10-10') }); // the next morning (not quiet)
    expect(existsSync(join(digest, 'tmp', staged))).toBe(false);
  });

  it('IO: a claim stamped in the future is swept too, and a failed send re-queues the entries', () => {
    const { env, digest } = heldFixture(1);
    renameSync(join(digest, 'queue'), join(digest, `claim-${DEAD}-${ET('08:00') + 24 * 3600_000}-1`));
    expect(flushDigest({ send: () => ({ ok: false }), env, now: ET('08:00') }).flushed).toBe(false);
    expect(claimsIn(digest)).toEqual([]);
    expect(queued(digest).map((e) => e.title)).toEqual(['r1']);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(1);
  });

  it('IO: digest.enabled=false delivers new alerts and still drains what was already held (never deletes it unsent)', () => {
    const { dir, env, digest } = heldFixture(2);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ digestDir: digest, toggleFile: join(dir, 'none.json'), digest: { enabled: false } }));
    const sent = [];
    const send = (n) => { sent.push(n); return { ok: true }; };
    expect(gateAlert({ title: 'night' }, { send, env, now: ET('01:00') })).toEqual({ ok: true });
    expect(sent.map((n) => n.title)).toEqual(['night']); // nothing would ever send a held alert, so it is delivered
    const r = flushDigest({ send, env, now: ET('08:00') });
    expect(r).toMatchObject({ flushed: true, count: 2 }); // the two held before the switch are not lost
    expect(sent.at(-1).title).toBe('Quiet-hours digest: 2 alert(s) held');
    expect(queued(digest)).toEqual([]);
  });

  it.each([[undefined], [null], [{}], [{ ok: 'yes' }], [{ ok: false }]])('IO: a sender returning %j is not a confirmation — the digest stays queued', (ret) => {
    const { env, digest } = heldFixture(1);
    expect(flushDigest({ send: () => ret, env, now: ET('08:00') }).flushed).toBe(false);
    expect(queued(digest).map((e) => e.title)).toEqual(['r1']);
    expect(flushDigest({ send: () => ({ ok: true }), env, now: ET('08:30') }).count).toBe(1);
  });

  it('IO: gateAlert flushes the digest only through an explicit sendDigest, and an unconfirmed digest stays held', () => {
    const { env, digest } = heldFixture(1);
    const sent = [];
    const send = (n) => { sent.push(n); return { ok: true }; }; // fire-and-forget: acknowledges before delivery is known
    gateAlert({ title: 'day 1' }, { send, env, now: ET('12:00') });
    expect(queued(digest)).toHaveLength(1); // an unchecked sender must never be allowed to empty the queue
    expect(sent.map((n) => n.title)).toEqual(['day 1']);
    gateAlert({ title: 'day 2' }, { send, env, now: ET('12:05'), sendDigest: () => ({ ok: false }) });
    expect(queued(digest).map((e) => e.title)).toEqual(['r1']);
    const digests = [];
    gateAlert({ title: 'day 3' }, { send, env, now: ET('12:10'), sendDigest: (n) => { digests.push(n); return { ok: true }; } });
    expect(digests).toHaveLength(1);
    expect(queued(digest)).toEqual([]);
  });

  it('IO: a claim owned by a LIVE other process is left alone until the hard limit; our own orphan and a dead sweeper are swept', () => {
    const live = process.ppid; // alive, and not us
    const claim = (digest, pid) => join(digest, `claim-${pid}-${ET('08:00')}-1`);
    const ok = () => ({ ok: true });
    {
      const { env, digest } = heldFixture(1);
      renameSync(join(digest, 'queue'), claim(digest, live));
      expect(flushDigest({ send: ok, env, now: ET('08:30') }).flushed).toBe(false); // 30 min old but its owner is alive: do not steal it
      expect(existsSync(claim(digest, live))).toBe(true);
      expect(flushDigest({ send: ok, env, now: ET('08:00') + 3 * 3600_000 }).count).toBe(1); // 3 h: hung or the pid was reused
    }
    {
      const { env, digest } = heldFixture(1);
      renameSync(join(digest, 'queue'), claim(digest, process.pid)); // a failed restore in THIS (long-lived) process
      expect(flushDigest({ send: ok, env, now: ET('08:30') }).count).toBe(1);
    }
    {
      const { env, digest } = heldFixture(1);
      renameSync(join(digest, 'queue'), claim(digest, DEAD)); // a sweeper that took it, then died (a swept claim carries the SWEEPER's pid)
      expect(flushDigest({ send: ok, env, now: ET('08:30') }).count).toBe(1);
    }
  });

  // A writer can be descheduled between staging its alert and committing it, for any length of time. Whatever the
  // flushers do meanwhile — claim, send, fail, clean up, many times — its alert must reach a later digest.
  const pausedWriterSurvives = (name, setup, send) => it(`IO: a writer paused mid-commit is not lost when the flush ends ${name}`, () => {
    const { env, digest } = setup();
    const r = gateAlert({ title: 'late', body: '' }, {
      send: () => { throw new Error('the alert was held, not delivered'); }, env, now: ET('06:59'),
      beforeCommit: () => {
        flushDigest({ send, env, now: ET('08:00') });
        flushDigest({ send, env, now: ET('08:00') + 3 * 60_000 });
        flushDigest({ send, env, now: ET('08:00') + 3 * 3600_000 });
      },
    });
    expect(r).toMatchObject({ suppressed: true });
    const seen = [];
    flushDigest({ send: (n) => { seen.push(n.body); return { ok: true }; }, env, now: ET('12:00') });
    expect(seen.join(' | ')).toMatch(/late/);
    expect(leftovers(digest)).toEqual([]);
  });
  pausedWriterSurvives('after a confirmed send', () => heldFixture(1), () => ({ ok: true }));
  pausedWriterSurvives('after a failed send (entries restored)', () => heldFixture(1), () => ({ ok: false }));
  pausedWriterSurvives('on a queue with no alert in it', () => {
    const f = heldFixture(0);
    mkdirSync(join(f.digest, 'queue'), { recursive: true });
    writeFileSync(join(f.digest, 'queue', 'junk.json'), 'not json at all\n');
    return f;
  }, () => ({ ok: true }));

  it('IO: a paused writer whose queue is claimed between its mkdir and its rename still commits (the queue is made again)', () => {
    const { env, digest } = heldFixture(0);
    let claimed = false;
    const r = gateAlert({ title: 'raced' }, {
      send: () => { throw new Error('held, not delivered'); }, env, now: ET('02:00'),
      beforeCommit: () => { mkdirSync(join(digest, 'queue'), { recursive: true }); renameSync(join(digest, 'queue'), join(digest, 'elsewhere')); claimed = true; },
    });
    expect(claimed).toBe(true);
    expect(r).toMatchObject({ suppressed: true });
    expect(queued(digest).map((e) => e.title)).toEqual(['raced']);
  });

  it('IO: a multibyte title round-trips intact', () => {
    const { env } = heldFixture(0);
    gateAlert({ title: 'héllo ✓ 日本語', body: '' }, { send: () => ({ ok: true }), env, now: ET('02:00') });
    const seen = [];
    flushDigest({ send: (n) => { seen.push(n.body); return { ok: true }; }, env, now: ET('08:00') });
    expect(seen).toEqual(['héllo ✓ 日本語']);
  });

  it('IO: a flusher whose claim a sweeper took while it was hung does not send the entries again', () => {
    const { env } = heldFixture(1);
    const send = vi.fn(() => ({ ok: true }));
    const r = flushDigest({
      send, env, now: ET('08:00'),
      beforeSend: (claim) => renameSync(claim, `${claim}.taken`), // a sweeper restored this claim while the flusher was stuck
    });
    expect(r).toMatchObject({ flushed: false, reason: expect.stringMatching(/taken/) });
    expect(send).not.toHaveBeenCalled();
  });

  it('IO: a claim a sweeper just took is young again, so a second sweeper cannot take it mid-restore (no double delivery)', () => {
    const { env, digest } = heldFixture(1);
    const ok = vi.fn(() => ({ ok: true }));
    // A flusher died 7 h ago, right after claiming the queue.
    renameSync(join(digest, 'queue'), join(digest, `claim-${DEAD}-${ET('01:00')}-1`));
    // Sweeper S takes that claim, but its restore fails (a stray file blocks the queue path), so the claim stays on
    // disk, owned by S.
    writeFileSync(join(digest, 'queue'), 'blocker');
    expect(flushDigest({ send: ok, env, now: ET('08:00') }).flushed).toBe(false);
    const left = claimsIn(digest);
    expect(left).toHaveLength(1);
    expect(left[0]).not.toMatch(new RegExp(`^claim-${DEAD}-`));
    // The claim's ORIGINAL age is 7 h, but S took it a moment ago. A second sweeper a minute later must see a young
    // claim and leave it alone; recovering it now would restore and send the same alerts S is about to restore.
    rmSync(join(digest, 'queue'));
    expect(flushDigest({ send: ok, env, now: ET('08:01') }).flushed).toBe(false);
    expect(ok).not.toHaveBeenCalled();
    expect(claimsIn(digest)).toEqual(left);
    // Once it has gone quiet for the normal stale window it is recovered, and sent exactly once.
    expect(flushDigest({ send: ok, env, now: ET('08:30') }).count).toBe(1);
    expect(flushDigest({ send: ok, env, now: ET('09:30') }).flushed).toBe(false);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(leftovers(digest)).toEqual([]);
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

  it('IO: a hold that cannot be written during quiet hours delivers the alert at once, exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    writeFileSync(join(dir, 'd'), 'a file where the digest dir should be'); // every write under it fails
    const send = vi.fn(() => ({ ok: true }));
    const env = { WE_QUIET_DIGEST_DIR: join(dir, 'd'), WE_QUIET_MODE_FILE: join(dir, 'none'), WE_QUIET_HOURS_SETTINGS: join(dir, 'none.json') };
    expect(gateAlert({ title: 'x' }, { send, env, now: ET('02:00') })).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ title: 'x' });
  });
});

// PR 4461 rung 2 ("ruling not addressed"): each test below is named for the finding it pins.
describe('quietHours: findings the operator ruled on (PR 4461)', () => {
  const fixture = (n = 1) => {
    const dir = mkdtempSync(join(tmpdir(), 'quiet-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ digestDir: join(dir, 'digest'), toggleFile: join(dir, 'none.json') }));
    const env = { WE_QUIET_HOURS_SETTINGS: settingsPath };
    for (let i = 1; i <= n; i += 1) gateAlert({ title: `r${i}` }, { send: () => ({ ok: true }), env, now: ET('01:00') });
    return { dir, env, digest: join(dir, 'digest') };
  };
  const collector = () => { const seen = []; return { seen, send: (n) => { seen.push(n); return { ok: true }; } }; };
  const GRACE = 3 * 60_000; // longer than any grace period the flusher may wait before cleaning up

  it('F1/F9: a writer paused mid-commit across a whole flush and cleanup cycle still has its alert delivered', () => {
    const { env } = fixture(1);
    const { seen, send } = collector();
    const direct = [];
    const r = gateAlert({ title: 'late', body: 'late' }, {
      send: (n) => { direct.push(n); return { ok: true }; }, env, now: ET('06:59'),
      // The writer is descheduled between choosing where to write and writing; meanwhile quiet hours end and every
      // flush and cleanup step runs to completion, more than once.
      beforeCommit: () => {
        flushDigest({ send, env, now: ET('08:00') });
        flushDigest({ send, env, now: ET('08:00') + GRACE });
        flushDigest({ send, env, now: ET('08:00') + 2 * GRACE });
      },
    });
    const later = flushDigest({ send, env, now: ET('09:00') });
    const delivered = [...direct.map((n) => n.title), ...seen.map((n) => n.body)].join(' | ');
    expect({ r, later: later.reason ?? later.count, delivered }).toMatchObject({ delivered: expect.stringMatching(/late/) });
  });

  // A writer's rename resolves `queue/` by path BEFORE it takes effect: when the flusher renames `queue/` to its claim
  // in between, the entry lands inside the claim, possibly after the flusher has listed it. The beforeSend seam plays
  // that late arrival. The writer was told "held", so the entry must reach a later digest, never be deleted unsent.
  it('F1/F9 (rung 3): an alert that lands in the claim after the flusher read it is not deleted with the claim', () => {
    const { env, digest } = fixture(1);
    const { seen, send } = collector();
    const late = { at: new Date(ET('06:59')).toISOString(), title: 'late', body: 'late' };
    const r = flushDigest({ send, env, now: ET('08:00'),
      beforeSend: (claimDir) => writeFileSync(join(claimDir, `${String(ET('06:59')).padStart(15, '0')}-1-1-late.json`), JSON.stringify(late)) });
    expect(r).toMatchObject({ flushed: true, count: 1 });
    flushDigest({ send, env, now: ET('09:00') });
    expect(seen.map((n) => n.body)).toEqual(['r1', 'late']);
    expect(leftovers(digest)).toEqual([]);
  });

  // One entry that cannot be read made every flush throw after the claim and restore the whole queue, forever: every
  // alert held with it was stranded. Now the rest are sent; the stray file is kept in the queue (never deleted), named
  // in the digest, and sent itself once it can be read.
  const STRAY = '000000000000000-1-1-stray.json';
  it.each([
    ['a directory', (p) => mkdirSync(p)],
    ['a file with no read permission', (p) => { writeFileSync(p, '{"title":"x"}'); chmodSync(p, 0o000); }],
    ['a symlink', (p, dir) => { writeFileSync(join(dir, 'outside.json'), '{"title":"outside"}'); symlinkSync(join(dir, 'outside.json'), p); }],
    ['a file that is not JSON', (p) => writeFileSync(p, '{"title":"torn')],
  ])('F2 (rung 3): %s in the queue does not strand the alerts held with it, flush after flush', (_, makeStray) => {
    const { env, digest, dir } = fixture(2);
    const stray = join(digest, 'queue', STRAY);
    makeStray(stray, dir);
    if (/permission/.test(_)) { try { readFileSync(stray); return; /* root reads anything: nothing to test */ } catch { /* unreadable, as intended */ } }
    const { seen, send } = collector();
    flushDigest({ send, env, now: ET('08:00') });
    expect(flushDigest({ send, env, now: ET('09:00') }).reason).toMatch(/1 held file\(s\) could not be read; kept in the queue/);
    expect(seen.map((n) => n.title)).toEqual(['Quiet-hours digest: 2 alert(s) held']);
    expect(seen[0].body).toMatch(/1 held file\(s\) could not be read; kept in the queue\] r1 \| r2$/);
    expect(readdirSync(join(digest, 'queue'))).toEqual([STRAY]); // kept, never deleted
    expect(leftovers(digest)).toEqual([]);
  });

  it('F2 (rung 3): an alert that could not be read for a while is sent once it can be (a passing error is not a loss)', () => {
    const { env, digest } = fixture(1);
    const stray = join(digest, 'queue', STRAY);
    writeFileSync(stray, JSON.stringify({ title: 'was unreadable', body: 'x' }));
    chmodSync(stray, 0o000);
    try { readFileSync(stray); return; /* root reads anything: nothing to test */ } catch { /* unreadable, as intended */ }
    const { seen, send } = collector();
    flushDigest({ send, env, now: ET('08:00') });
    chmodSync(stray, 0o644);
    flushDigest({ send, env, now: ET('09:00') });
    expect(seen.map((n) => n.title)).toEqual(['Quiet-hours digest: 1 alert(s) held', 'Quiet-hours digest: 1 alert(s) held']);
    expect(seen[1].body).toBe('was unreadable');
    expect(queued(digest)).toEqual([]);
  });

  it('F4: switching quiet hours off (WE_QUIET_HOURS=off) still delivers what was already held', () => {
    const { env } = fixture(2);
    const { seen, send } = collector();
    expect(flushDigest({ send, env: { ...env, WE_QUIET_HOURS: 'off' }, now: ET('02:00') })).toMatchObject({ flushed: true, count: 2 });
    expect(seen.map((n) => n.title)).toEqual(['Quiet-hours digest: 2 alert(s) held']);
    // ...and a gated alert with the switch off flushes the backlog through its checked digest sender too.
    const f = fixture(1);
    const g = collector();
    expect(gateAlert({ title: 'now' }, { send: () => ({ ok: true }), sendDigest: g.send, env: { ...f.env, WE_QUIET_HOURS: 'off' }, now: ET('02:00') })).toEqual({ ok: true });
    expect(g.seen.map((n) => n.title)).toEqual(['Quiet-hours digest: 1 alert(s) held']);
  });
});
