/** @file pr-stall-digest.test.mjs
 * @description Slice 3: the stall sweep's operator digest on the needs-you feed — kind `stalled`, dedupe per
 *   repo#pr@head:state and against what the feed already published, self-clearing, quiet hours through gateAlert, a
 *   retried failed alert, and never suppressed on a failed read.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishStalledDigest, pasteReady, feedItem } from '../pr-stall-digest.mjs';
import { replay, unacknowledged, sidecarsOf, acknowledge, runOnce } from '../../operations/needs-you-feed.mjs';
import { gateAlert } from '../../lib/quiet-hours-io.mjs';
import * as atomicJson from '../../lib/atomic-json-file.mjs';

const REPO = 'web-everything/web-everything';
const H = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T18:00:00Z');
const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'stall-digest-')); roots.push(root);
  return { feedPath: join(root, 'needs-you-events.jsonl'), stateDir: join(root, 'pr-stall-sweep') };
}
const op = (pr, state = 'ruling-needed:dispute', o = {}) => ({ lane: 'operator', repo: REPO, pr, head: H, state, action: state, reason: 'the fixer and the reviewer disagree',
  evidence: ['needs-your-decision note', 'e2', 'e3', 'e4'], command: `node scripts/operations/run.mjs record-referral-ruling --pr=${pr} --actor=<your login> --channel=<where you ruled>`, title: 't', ...o });
const sent = () => { const out = []; const notify = (n) => { out.push(n); return { ok: true }; }; return { out, notify }; };
const run = (ctx, items, o = {}) => publishStalledDigest({ items, incomplete: false, ...o.pass }, { now: NOW, env: {}, ...ctx, ...o });

describe('the stalled feed kind', () => {
  it('releases stalled suppression when disabled so an acknowledged head can enter the queue feed', async () => {
    const ctx = setup(); const { notify } = sent();
    run(ctx, [op(1)], { notify });
    acknowledge({ path: ctx.feedPath });
    const sidecar = sidecarsOf(ctx.feedPath).state;
    const prev = JSON.parse(readFileSync(sidecar, 'utf8'));
    const other = `${REPO}#9@${H}:needs-you`;
    writeFileSync(sidecar, JSON.stringify({ ...prev, openKeys: [...prev.openKeys, other], marker: 'preserve' }));
    const disabled = run(ctx, [], { enabled: false, notify });
    expect(disabled.errors).toEqual([]);
    expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toMatchObject({ openKeys: [other], marker: 'preserve' });
    const settings = { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: ctx.feedPath }, allowPrimary: { value: true } };
    const result = await runOnce({ settings, env: { WE_PR_STALL_SWEEP_MODE: 'shadow', WE_PR_STALL_SWEEP_DIGEST: 'false' },
      now: NOW + 1, liveGate: false, log: () => {}, exec: () => JSON.stringify({ ready: [{ repo: REPO, number: 1, head: H }] }) });
    expect(result.lines.some(line => line.startsWith(`NEEDS-YOU ${REPO}#1 needs-you:`))).toBe(true);
    expect(unacknowledged({ path: ctx.feedPath }).map(event => event.pr)).toEqual([1]);
  });
  it.each(['digest-state.json', 'digest.lock', 'other.json', 'nested/events.jsonl'])('refuses a feed inside digest state (%s) without touching existing bytes', name => {
    const ctx = setup();
    mkdirSync(ctx.stateDir, { recursive: true });
    const mine = join(ctx.stateDir, 'digest-state.json');
    const before = '{"published":[],"current":{},"unnotified":[],"marker":"untouched"}\n';
    writeFileSync(mine, before);
    const path = join(ctx.stateDir, name);
    const r = run({ stateDir: ctx.stateDir }, [op(1)], { env: { WE_NEEDS_YOU_FEED: path }, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/stalled feed:.*reserved/);
    expect(r.lines).toEqual([]);
    expect(readFileSync(mine, 'utf8')).toBe(before);
    if (path !== mine) expect(existsSync(path)).toBe(false);
  });
  it.each(['file', 'directory'])('refuses a %s symlink alias into digest state', type => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const mine = join(ctx.stateDir, 'digest-state.json'), before = '{"published":[],"unnotified":[]}\n';
    writeFileSync(mine, before);
    const alias = join(ctx.stateDir, '..', 'alias');
    symlinkSync(type === 'file' ? mine : ctx.stateDir, alias);
    const path = type === 'file' ? alias : join(alias, 'new', 'events.jsonl');
    const r = run(ctx, [op(1)], { feedPath: path, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(readFileSync(mine, 'utf8')).toBe(before);
  });
  it('allows a sibling directory whose name starts with the state directory name', () => {
    const ctx = setup(); const path = join(`${ctx.stateDir}-feed`, 'events.jsonl');
    const r = run(ctx, [op(1)], { feedPath: path, notify: () => ({ ok: true }) });
    expect(r.errors).toEqual([]); expect(replay({ path })).toHaveLength(1);
  });
  it('refuses the external target of a symlinked digest-state file', () => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const target = join(ctx.stateDir, '..', 'saved-state.json'), before = '{"published":[],"unnotified":[]}\n';
    writeFileSync(target, before);
    symlinkSync(target, join(ctx.stateDir, 'digest-state.json'));
    const r = run(ctx, [op(1)], { feedPath: target, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
  it.each(['digest-state.json', 'nested/events.jsonl'])('refuses a dangling symlink into new digest state: %s', name => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const alias = join(ctx.stateDir, '..', 'events.jsonl');
    symlinkSync(join(ctx.stateDir, name), alias);
    const r = run(ctx, [op(1)], { feedPath: alias, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(existsSync(join(ctx.stateDir, name))).toBe(false);
    expect(existsSync(join(ctx.stateDir, 'digest-state.json'))).toBe(false);
  });
  it('rejects a stale digest.lock feed before lock recovery can delete its events', () => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const path = join(ctx.stateDir, 'digest.lock'), before = 'NEEDS-YOU existing events\n';
    writeFileSync(path, before);
    const stale = new Date(Date.now() - 60_000); utimesSync(path, stale, stale);
    const r = run(ctx, [op(1)], { feedPath: path, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(join(ctx.stateDir, 'digest-state.json'))).toBe(false);
  });
  it('publishes each operator item once, with reason, 1-3 evidence lines and one paste-ready command', () => {
    const ctx = setup(); const { out, notify } = sent();
    const r = run(ctx, [op(1), { ...op(2), lane: 'system' }], { notify });
    const ev = replay({ path: ctx.feedPath });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'stalled', pr: 1, head: H, state: 'ruling-needed:dispute' });
    expect(ev[0].reason).toMatch(/^ruling-needed:dispute: /);
    expect(ev[0].evidence).toEqual(['needs-your-decision note', 'e2', 'e3']);
    expect(ev[0].command).not.toMatch(/<your login>|<where you ruled>/);
    expect(out).toHaveLength(1); expect(out[0].title).toMatch(/1 need you/);
    expect(r.notified).toBe(true);
  });
  it('does not repeat the same PR head and state, but re-publishes a new state on the same head', () => {
    const ctx = setup(); const { out, notify } = sent();
    run(ctx, [op(1)], { notify }); run(ctx, [op(1)], { notify, now: NOW + 900_000 });
    expect(replay({ path: ctx.feedPath })).toHaveLength(1); expect(out).toHaveLength(1);
    run(ctx, [op(1, 'needs-decision:note')], { notify, now: NOW + 1_800_000 });
    expect(replay({ path: ctx.feedPath }).filter((e) => e.kind === 'stalled').map((e) => e.state)).toEqual(['ruling-needed:dispute', 'needs-decision:note']);
    expect(out).toHaveLength(2);
  });
  it('a new head is a new item', () => {
    const ctx = setup(); const { notify } = sent();
    run(ctx, [op(1)], { notify }); run(ctx, [op(1, undefined, { head: 'b'.repeat(40) })], { notify });
    expect(replay({ path: ctx.feedPath }).filter((e) => e.kind === 'stalled')).toHaveLength(2);
  });
  it('is not published again when the feed already carries that PR head under another kind', () => {
    const ctx = setup(); const { out, notify } = sent();
    const sidecar = sidecarsOf(ctx.feedPath).state;
    run(ctx, [], { notify }); // creates the dirs
    writeFileSync(sidecar, JSON.stringify({ openKeys: [`${REPO}#1@${H}:ruling-needed`] }));
    run(ctx, [op(1)], { notify });
    expect(replay({ path: ctx.feedPath })).toEqual([]); expect(out).toEqual([]);
  });
  it('an event-only key for the same head does not suppress it', () => {
    const ctx = setup(); const { out, notify } = sent(); run(ctx, [], { notify });
    writeFileSync(sidecarsOf(ctx.feedPath).state, JSON.stringify({ openKeys: [`${REPO}#1@${H}:review-no-verdict`] }));
    run(ctx, [op(1)], { notify });
    expect(out).toHaveLength(1);
  });
  it('clears itself once the condition is gone, but never on an incomplete pass', () => {
    const ctx = setup(); const { notify } = sent();
    run(ctx, [op(1)], { notify });
    run(ctx, [], { notify, pass: { incomplete: true } });
    expect(unacknowledged({ path: ctx.feedPath })).toHaveLength(1);
    run(ctx, [], { notify });
    expect(replay({ path: ctx.feedPath }).at(-1)).toMatchObject({ kind: 'cleared', was: 'stalled', pr: 1 });
    expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
  });
  it('leaves the other feed kinds alone', () => {
    const ctx = setup(); const { notify } = sent(); run(ctx, [], { notify });
    const sidecar = sidecarsOf(ctx.feedPath).state;
    writeFileSync(sidecar, JSON.stringify({ openKeys: [`${REPO}#9@${H}:needs-you`] }));
    run(ctx, [], { notify });
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).openKeys).toEqual([`${REPO}#9@${H}:needs-you`]);
  });
});

describe('never suppressed', () => {
  it('a feed state that cannot be read still alerts every item', () => {
    const ctx = setup(); const { out, notify } = sent(); run(ctx, [], { notify });
    writeFileSync(sidecarsOf(ctx.feedPath).state, '{torn');
    const r = run(ctx, [op(1), op(2)], { notify });
    expect(out).toHaveLength(1); expect(out[0].title).toMatch(/2 need you/);
    expect(r.errors.join(' ')).toMatch(/stalled feed/);
  });
  it('a delivery lock held elsewhere still alerts (a repeat, never a drop)', () => {
    const ctx = setup(); const { out, notify } = sent(); run(ctx, [], { notify });
    writeFileSync(join(ctx.stateDir, 'digest.lock'), `${process.pid}\n`);
    const r = run(ctx, [op(1)], { notify });
    expect(out).toHaveLength(1); expect(r.errors.join(' ')).toMatch(/digest lock/);
  }, 30_000);
  it('a failed alert survives an incomplete pass and is sent when the item returns', () => {
    const ctx = setup(); const out = [];
    run(ctx, [op(1)], { notify: () => ({ ok: false, error: 'osascript' }) });
    run(ctx, [], { notify: (n) => { out.push(n); return { ok: true }; }, pass: { incomplete: true } });
    run(ctx, [op(1)], { notify: (n) => { out.push(n); return { ok: true }; } });
    expect(out).toHaveLength(1);
  });
  it('A -> B -> A on one head alerts each state once', () => {
    const ctx = setup(); const { out, notify } = sent();
    for (const st of ['ruling-needed:dispute', 'needs-decision:note', 'ruling-needed:dispute']) run(ctx, [op(1, st)], { notify });
    expect(out).toHaveLength(2);
    // ...while the feed always shows the head's CURRENT state
    expect(unacknowledged({ path: ctx.feedPath }).map((e) => e.state)).toEqual(['ruling-needed:dispute']);
  });
  it('a command that still holds a choice becomes the inspection command, keeping the template', () => {
    const f = feedItem(op(1, undefined, { command: 'node x --ruling=<block|not-real> --actor=<your login>' }));
    expect(f.command).toBe(`gh pr view 1 --repo ${REPO} --comments`); expect(f.template).toMatch(/<block\|not-real>/);
  });
  it('an item with no evidence gets one factual line', () => expect(feedItem(op(1, undefined, { evidence: [] })).evidence).toHaveLength(1));
  it('an undelivered alert remains owed until notification succeeds', () => {
    const ctx = setup(); const out = [];
    run(ctx, [op(1)], { notify: () => ({ ok: false }) });
    const own = JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8'));
    expect(own.unnotified).toEqual([`${REPO}#1@${H}:ruling-needed:dispute`]);
    run(ctx, [op(1)], { notify: (n) => { out.push(n); return { ok: true }; } });
    expect(out).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8')).unnotified).toEqual([]);
  });
  it.each([
    { boundary: 'before feed publication', failAt: 1 },
    { boundary: 'after feed publication', failAt: 2 },
    { boundary: 'after successful notification', failAt: 3 },
  ])('a digest-state write that fails $boundary cannot drop an alert', ({ failAt }) => {
    const ctx = setup(); const mine = join(ctx.stateDir, 'digest-state.json');
    const alertId = `${REPO}#1@${H}:ruling-needed:dispute`;
    const key = `${REPO}#1@${H}:stalled`;
    const realWrite = atomicJson.writeJsonAtomic;
    let writes = 0; let failures = 0;
    const write = vi.spyOn(atomicJson, 'writeJsonAtomic').mockImplementation((path, data, options) => {
      if (path === mine && ++writes === failAt) {
        failures++;
        throw new Error('injected digest-state write failure');
      }
      return realWrite(path, data, options);
    });
    // Before confirmation, also leave delivery unsuccessful so recovery must use the durable owed record.
    // At confirmation, delivery succeeded: a failed save may repeat that alert, but must never lose it.
    const firstNotify = vi.fn(() => ({ ok: failAt === 3 }));
    const failed = run(ctx, [op(1)], { notify: firstNotify });
    expect(failures).toBe(1);
    expect(writes).toBe(failAt);
    expect(failed.errors.join(' ')).toContain('injected digest-state write failure');
    expect(firstNotify).toHaveBeenCalledOnce();
    expect(failed.notified).toBe(failAt === 3);
    if (failAt === 1) {
      // Write-ahead guarantee: a failed owed-record save must prevent BOTH feed writes.
      expect(existsSync(ctx.feedPath)).toBe(false);
      expect(existsSync(sidecarsOf(ctx.feedPath).state)).toBe(false);
      expect(existsSync(mine)).toBe(false);
    } else {
      expect(replay({ path: ctx.feedPath })).toHaveLength(1);
      expect(JSON.parse(readFileSync(sidecarsOf(ctx.feedPath).state, 'utf8')).openKeys).toEqual([key]);
      expect(JSON.parse(readFileSync(mine, 'utf8')).unnotified).toEqual([alertId]);
    }
    write.mockRestore();
    // A new invocation recovers using only the persisted files, including an already-open feed item.
    const { out, notify } = sent();
    const recovered = run(ctx, [op(1)], { notify });
    expect(recovered.errors).toEqual([]);
    expect(recovered.notified).toBe(true);
    expect(out).toHaveLength(1);
    expect(JSON.parse(readFileSync(mine, 'utf8')).unnotified).toEqual([]);
    run(ctx, [op(1)], { notify });
    expect(out).toHaveLength(1);
  });
  it('a feed append that fails is published on a later pass', () => {
    const ctx = setup(); const { out, notify } = sent();
    run(ctx, [op(1)], { notify });
    chmodSync(ctx.feedPath, 0o444);
    run(ctx, [op(1, 'needs-decision:note')], { notify });
    chmodSync(ctx.feedPath, 0o644);
    run(ctx, [op(1, 'needs-decision:note')], { notify });
    expect(replay({ path: ctx.feedPath }).filter((e) => e.kind === 'stalled').map((e) => e.state)).toEqual(['ruling-needed:dispute', 'needs-decision:note']);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
  it('a resolved stall that comes back on the same head and state is published again', () => {
    const ctx = setup(); const { out, notify } = sent();
    run(ctx, [op(1)], { notify }); run(ctx, [], { notify }); run(ctx, [op(1)], { notify });
    expect(out).toHaveLength(2);
  });
  it('a failed alert is retried next pass', () => {
    const ctx = setup(); const out = [];
    run(ctx, [op(1)], { notify: () => ({ ok: false, error: 'osascript' }) });
    run(ctx, [op(1)], { notify: (n) => { out.push(n); return { ok: true }; } });
    expect(out).toHaveLength(1);
    run(ctx, [op(1)], { notify: (n) => { out.push(n); return { ok: true }; } });
    expect(out).toHaveLength(1);
  });
  it('quiet hours hold the alert for the 07:00 digest instead of dropping it', () => {
    const ctx = setup(); const root = mkdtempSync(join(tmpdir(), 'quiet-')); roots.push(root);
    const settingsPath = join(root, 'quiet.json');
    writeFileSync(settingsPath, JSON.stringify({ enabled: true, start: '22:00', end: '07:00', timeZone: 'America/New_York' }));
    const env = { WE_QUIET_HOURS: 'on', WE_QUIET_HOURS_SETTINGS: settingsPath, WE_QUIET_DIGEST_DIR: join(root, 'digest'), WE_QUIET_MODE_FILE: join(root, 'toggle.json') };
    const delivered = [];
    const at2am = Date.parse('2026-10-22T06:00:00Z'); // 02:00 ET
    const notify = (n) => gateAlert(n, { send: (x) => { delivered.push(x); return { ok: true }; }, env, now: at2am });
    const r = run(ctx, [op(1)], { notify, now: at2am });
    expect(r.notified).toBe(true); // held = accepted by the gate, so it is not retried as a failure
    expect(delivered).toEqual([]);
    const digestDir = join(root, 'digest');
    expect(readdirSync(digestDir).length).toBeGreaterThan(0); // the held alert is queued for the 07:00 flush
  });
  it('digest off publishes nothing', () => {
    const ctx = setup(); const { out, notify } = sent();
    expect(run(ctx, [op(1)], { notify, enabled: false }).skipped).toBe('digest off');
    expect(out).toEqual([]); expect(existsSync(ctx.feedPath)).toBe(false);
  });
  it('under test it never touches the real feed', () => {
    expect(publishStalledDigest({ items: [op(1)] }, { env: { VITEST: 'true' }, stateDir: '/nonexistent' }).skipped).toBe('under-test');
  });
});

describe('paste-ready', () => {
  it('fills the operator login and channel; a missing command becomes the PR view', () => {
    expect(pasteReady({ command: 'x --actor=<your login> --channel=<where>' })).not.toMatch(/</);
    expect(pasteReady({ repo: REPO, pr: 4, command: null })).toBe(`gh pr view 4 --repo ${REPO} --comments`);
    expect(feedItem(op(3)).evidence).toHaveLength(3);
  });
});
