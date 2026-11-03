/** @file pr-stall-digest.test.mjs
 * @description Slice 3: the stall sweep's operator digest on the needs-you feed — kind `stalled`, dedupe per
 *   repo#pr@head:state and against what the feed already published, self-clearing, quiet hours through gateAlert, a
 *   retried failed alert, and never suppressed on a failed read.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync, symlinkSync, linkSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { publishStalledDigest, pasteReady, feedItem } from '../pr-stall-digest.mjs';
import { replay, unacknowledged, sidecarsOf, acknowledge, runOnce } from '../../operations/needs-you-feed.mjs';
import { gateAlert } from '../../lib/quiet-hours-io.mjs';
import * as atomicJson from '../../lib/atomic-json-file.mjs';
import * as needsFeed from '../../operations/needs-you-feed.mjs';
import { Worker } from 'node:worker_threads';

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
  it('disabling clears published unacknowledged stalls and preserves other feed kinds', async () => {
    const ctx = setup(); const { notify } = sent();
    const settings = { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: ctx.feedPath }, allowPrimary: { value: true } };
    await runOnce({ settings, env: {}, now: NOW, liveGate: false, log: () => {},
      exec: () => JSON.stringify({ ready: [{ repo: REPO, number: 9, head: H }] }) });
    run(ctx, [op(1)], { notify });
    expect(unacknowledged({ path: ctx.feedPath }).map(e => e.pr)).toEqual([9, 1]);
    const disabled = run(ctx, [], { enabled: false, notify, now: NOW + 1 });
    expect(disabled.errors).toEqual([]);
    expect(disabled.lines).toHaveLength(1);
    expect(replay({ path: ctx.feedPath }).at(-1)).toMatchObject({ kind: 'cleared', was: 'stalled', pr: 1, at: new Date(NOW + 1).toISOString() });
    expect(unacknowledged({ path: ctx.feedPath }).map(e => e.pr)).toEqual([9]);
    expect(run(ctx, [], { enabled: false, notify }).lines).toEqual([]);
  });
  it('evidence has control and bidi characters stripped in persisted and replayed events', () => {
    const ctx = setup();
    run(ctx, [op(1, undefined, { evidence: ['before\u001b[31m\u202eafter\r\n\u2028\u200b'] })], { notify: () => ({ ok: true }) });
    const line = readFileSync(ctx.feedPath, 'utf8').trim();
    const event = JSON.parse(line.slice(line.lastIndexOf(' {"at":') + 1));
    expect(event.evidence).toEqual(['before [31m after    ']);
    expect(replay({ path: ctx.feedPath })[0].evidence).toEqual(event.evidence);
  });
  it.each(['append', 'state save'])('a failed disable-time %s keeps suppression keys until clearing can be retried', boundary => {
    const ctx = setup(); const { notify } = sent();
    run(ctx, [op(1)], { notify });
    const sidecar = sidecarsOf(ctx.feedPath).state;
    const before = readFileSync(sidecar, 'utf8');
    const fault = boundary === 'append'
      ? vi.spyOn(needsFeed, 'appendLines').mockImplementation(() => { throw new Error('injected clear append failure'); })
      : vi.spyOn(atomicJson, 'writeJsonAtomic').mockImplementation(() => { throw new Error('injected clear state save failure'); });
    const failed = run(ctx, [], { enabled: false, notify });
    expect(failed.errors.join(' ')).toMatch(/injected clear/);
    expect(readFileSync(sidecar, 'utf8')).toBe(before);
    expect(unacknowledged({ path: ctx.feedPath })).toHaveLength(boundary === 'append' ? 1 : 0);
    fault.mockRestore();
    expect(run(ctx, [], { enabled: false, notify }).errors).toEqual([]);
    expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
    expect(JSON.parse(readFileSync(sidecar, 'utf8')).openKeys).toEqual([]);
  });
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
  it.each(['DIGEST-STATE.JSON', 'Digest.Lock', 'Nested/events.jsonl'])('refuses a case variant of digest state (%s)', name => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const mine = join(ctx.stateDir, 'digest-state.json'), before = '{"published":[],"unnotified":[]}\n';
    writeFileSync(mine, before);
    const path = join(ctx.stateDir.replace(/pr-stall-sweep$/, 'PR-Stall-Sweep'), name);
    const r = run(ctx, [op(1)], { feedPath: path, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(readFileSync(mine, 'utf8')).toBe(before);
  });
  it('refuses a hard link to the digest state file', () => {
    const ctx = setup(); mkdirSync(ctx.stateDir, { recursive: true });
    const mine = join(ctx.stateDir, 'digest-state.json'), before = '{"published":[],"unnotified":[]}\n';
    writeFileSync(mine, before);
    const link = join(ctx.stateDir, '..', 'linked.jsonl');
    linkSync(mine, link);
    const r = run(ctx, [op(1)], { feedPath: link, notify: () => ({ ok: true }) });
    expect(r.errors.join(' ')).toMatch(/reserved/); expect(r.lines).toEqual([]);
    expect(readFileSync(mine, 'utf8')).toBe(before);
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
  it('overlapping successful passes deliver an owed alert once', async () => {
    const ctx = setup();
    run(ctx, [op(1)], { notify: () => ({ ok: false }) });
    const barrier = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
    const signals = new Int32Array(barrier);
    const source = `
      const { parentPort, workerData: d } = require('node:worker_threads');
      const fs = require('node:fs');
      (async () => {
        const { publishStalledDigest } = await import(d.module);
        const signals = new Int32Array(d.barrier);
        const open = fs.openSync;
        fs.openSync = function(path, ...args) {
          try { return open.call(this, path, ...args); }
          catch (error) {
            if (d.index === 1 && path === d.ctx.stateDir + '/digest.lock' && error.code === 'EEXIST') parentPort.postMessage({ phase: 'contended' });
            throw error;
          }
        };
        parentPort.postMessage({ phase: 'ready' });
        if (Atomics.wait(signals, d.index, 0, 10000) === 'timed-out') throw new Error('start barrier timed out');
        let notifications = 0;
        const result = publishStalledDigest({ items: [d.item], incomplete: false }, {
          ...d.ctx, env: {}, now: d.now, notify: () => {
            notifications++;
            if (d.index === 0) {
              parentPort.postMessage({ phase: 'notifying' });
              if (Atomics.wait(signals, 2, 0, 10000) === 'timed-out') throw new Error('notification barrier timed out');
            }
            return { ok: true };
          }
        });
        parentPort.postMessage({ phase: 'done', result, notifications });
      })().catch(error => { throw error; });
    `;
    const workers = [0, 1].map(index => new Worker(source, { eval: true, workerData: {
      index, barrier, ctx, item: op(1), now: NOW, module: pathToFileURL(resolve('scripts/conveyor/pr-stall-digest.mjs')).href,
    } }));
    const phase = (worker, name) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`worker did not reach ${name}`)); }, 15000);
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); };
      const message = value => { if (value.phase === name) { cleanup(); resolve(value); } };
      const error = value => { cleanup(); reject(value); };
      worker.on('message', message); worker.on('error', error);
    });
    const start = index => { Atomics.store(signals, index, 1); Atomics.notify(signals, index); };
    try {
      await Promise.all(workers.map(worker => phase(worker, 'ready')));
      const notifying = phase(workers[0], 'notifying');
      start(0); await notifying;
      const contended = phase(workers[1], 'contended');
      start(1); await contended; // the second worker actually tried the held delivery lock
      const done = Promise.all(workers.map(worker => phase(worker, 'done')));
      start(2);
      const results = await done;
      expect(results.map(r => r.result.errors)).toEqual([[], []]);
      expect(results.map(r => r.notifications)).toEqual([1, 0]);
      expect(JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8')).unnotified).toEqual([]);
      expect(replay({ path: ctx.feedPath })).toHaveLength(1);
    } finally {
      for (let index = 0; index < 3; index++) start(index);
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  }, 30000);
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

it('R437 repeats with configured backoff without duplicating feed events and resets on labels', () => {
  const ctx = setup(), { notify, out } = sent();
  const options = { notify, alertBackoffMinutes: [30,60,120,240] };
  for (const minute of [0,30,90,210,450,690]) {
    expect(run(ctx, [op(1, undefined, { labels: ['review:pending'] })], { ...options, now: NOW + minute * 60000 }).notified).toBe(true);
    expect(run(ctx, [op(1, undefined, { labels: ['review:pending'] })], { ...options, now: NOW + (minute + 1) * 60000 }).notified).toBe(false);
  }
  expect(out).toHaveLength(6);
  expect(replay({ path: ctx.feedPath })).toHaveLength(1);
  expect(run(ctx, [op(1, undefined, { labels: ['review:changes'] })], { ...options, now: NOW + 692 * 60000 }).notified).toBe(true);
});

it('R437 migrates legacy digest state and retries failed repeat delivery immediately', () => {
  const ctx = setup(), { notify } = sent();
  run(ctx, [op(1)], { notify }); // old once-per-head state has no repeat clock
  const options = { notify, alertBackoffMinutes: [30,60,120,240] };
  expect(run(ctx, [op(1)], options).notified).toBe(false);
  expect(run(ctx, [op(1)], { ...options, now: NOW + 30 * 60000, notify: () => ({ ok: false }) }).notified).toBe(false);
  expect(run(ctx, [op(1)], { ...options, now: NOW + 31 * 60000 }).notified).toBe(true);
  expect(run(ctx, [op(1, 'new-state')], { ...options, now: NOW + 32 * 60000 }).notified).toBe(true);
  expect(run(ctx, [op(1)], { ...options, now: NOW + 33 * 60000 }).notified).toBe(true);
  expect(run(ctx, [op(1)], { ...options, now: NOW + 63 * 60000 }).notified).toBe(true);
});

it('R437 keeps dependency annotations visible before the feed reason truncation', () => {
  const ctx = setup(), { notify } = sent();
  const item = op(6244, 'deadline-passed', { unblocks: [6193], reason: 'x'.repeat(200) });
  expect(feedItem(item).reason).toMatch(/^unblocks #6193/);
  run(ctx, [item], { notify });
  expect(replay({ path: ctx.feedPath })[0].reason).toContain('unblocks #6193');
});

it('R437 a failed first delivery starts the 30-minute clock only when delivery succeeds', () => {
  const ctx = setup(), { notify } = sent();
  const options = { alertBackoffMinutes: [30,60,120,240] };
  expect(run(ctx, [op(1)], { ...options, notify: () => ({ ok: false }) }).notified).toBe(false);
  expect(run(ctx, [op(1)], { ...options, notify, now: NOW + 60000 }).notified).toBe(true);
  expect(run(ctx, [op(1)], { ...options, notify, now: NOW + 30 * 60000 }).notified).toBe(false);
  expect(run(ctx, [op(1)], { ...options, notify, now: NOW + 31 * 60000 }).notified).toBe(true);
});

it('R437 owner-signal read failure preserves a published invariant feed item while other reads succeed', async () => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  let previous = {}, failOwner = false;
  let prs = [{ number: 6254, title: 'no labels', headRefOid: H, labels: [], changedFiles: 1, updatedAt: new Date(NOW).toISOString() }];
  const readPrs = vi.fn(() => prs);
  const detector = vi.fn(async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }));
  const passes = [];
  const tick = async minutes => {
    const report = await runPrSweep({ now: NOW + minutes * 60000, env: {}, config: {},
      settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
      readPrs, readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => previous,
      readSignals: () => { if (failOwner) throw new Error('injected owner read failure'); return {}; },
      detector, notify, flush: () => {}, persist: () => {}, append: () => {},
      stallSweep: async () => ({ mode: 'shadow', dir: ctx.stateDir, digest: true, items: [], incomplete: false }),
      stallDigest: (pass, options) => {
        passes.push(pass);
        return publishStalledDigest(pass, { ...options, feedPath: ctx.feedPath });
      } });
    previous = report.nextState;
    return report;
  };
  expect((await tick(0)).errors).toEqual([]);
  const opened = unacknowledged({ path: ctx.feedPath });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ pr: 6254, state: 'no-labels', kind: 'stalled' });
  failOwner = true;
  const failed = await tick(1);
  expect(failed.errors).toContain('owner signals: injected owner read failure');
  expect(readPrs).toHaveBeenCalledTimes(2);
  expect(detector).toHaveBeenCalledTimes(2);
  expect(passes[1].items).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(opened);
  expect(replay({ path: ctx.feedPath }).filter(event => event.kind === 'cleared')).toEqual([]);
  expect(passes[1].incomplete).toBe(true);
  failOwner = false;
  expect((await tick(2)).errors).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(opened);
  prs = [];
  expect((await tick(3)).errors).toEqual([]);
  expect(passes[3].incomplete).toBe(false);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
});

it('R437 legacy feed items keep their exact shape without invariant metadata', () => {
  const item = { lane: 'operator', repo: REPO, pr: 1, head: H, state: 'legacy', reason: 'readable reason',
    title: 'legacy title', command: 'inspect locally', evidence: ['proof'] };
  expect(feedItem(item)).toStrictEqual({ pr: 1, repo: REPO, head: H, kind: 'stalled', state: 'legacy',
    reason: 'legacy: readable reason', title: 'legacy title', command: 'inspect locally', evidence: ['proof'] });
});

// Exercise the completeness contract through the production sweep and real feed publisher.
async function ownerFailureWithObsoleteDetectorItem(producer) {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  const seeded = run(ctx, [op(5759, 'stalled-same-head', { action: 'stalled-detector' })], { notify });
  expect(seeded.errors).toEqual([]);
  const before = unacknowledged({ path: ctx.feedPath });
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({ pr: 5759, kind: 'stalled', state: 'stalled-same-head' });
  const readPrs = vi.fn(() => [{ number: 5759, title: 'detector resolved', headRefOid: H, labels: ['review:accepted'],
    changedFiles: 1, updatedAt: new Date(NOW).toISOString() }]);
  const detector = vi.fn(async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }));
  const published = [];
  const report = await runPrSweep({ now: NOW + 60000, env: {}, config: {},
    settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
    readPrs, detector, readQueue: () => ({ ready: [], rulingNeeded: [] }), readPrevious: () => ({}),
    readSignals: () => { throw new Error('injected owner read failure'); },
    notify, flush: () => {}, persist: () => {}, append: () => {},
    stallSweep: async () => ({ ...producer, dir: ctx.stateDir, items: [], incomplete: false }),
    stallDigest: (pass, options) => {
      published.push({ pass, options });
      return publishStalledDigest(pass, { ...options, feedPath: ctx.feedPath });
    } });
  expect(report.errors).toEqual(['owner signals: injected owner read failure']);
  expect(readPrs).toHaveBeenCalledTimes(1);
  expect(detector).toHaveBeenCalledTimes(1);
  expect(report.stallDetector).toMatchObject({ enabled: true, stalled: 0 });
  expect(published).toHaveLength(1);
  expect(published[0].options.enabled).toBe(true); // Detector stays enabled; this is not disable-time clearing.
  expect(published[0].pass).toMatchObject({ ...producer, items: [] });
  return { pass: published[0].pass, before, after: unacknowledged({ path: ctx.feedPath }),
    cleared: replay({ path: ctx.feedPath }).filter(event => event.kind === 'cleared') };
}

it('R437 mode=off preserves detector completeness and clears stale detector items despite owner-read failure', async () => {
  const result = await ownerFailureWithObsoleteDetectorItem({ mode: 'off', digest: true });
  expect(result.pass.incomplete).toBe(false);
  expect(result.after).toEqual([]);
  expect(result.cleared).toMatchObject([{ pr: 5759, kind: 'cleared', was: 'stalled' }]);
  expect(result.cleared).toHaveLength(1);
});
it('R437 digest=false preserves detector completeness and clears stale detector items despite owner-read failure', async () => {
  const result = await ownerFailureWithObsoleteDetectorItem({ mode: 'shadow', digest: false });
  expect(result.pass.incomplete).toBe(false);
  expect(result.after).toEqual([]);
  expect(result.cleared).toMatchObject([{ pr: 5759, kind: 'cleared', was: 'stalled' }]);
  expect(result.cleared).toHaveLength(1);
});
it('R437 enabled invariant producer marks owner-read failure incomplete and preserves the existing feed item', async () => {
  const result = await ownerFailureWithObsoleteDetectorItem({ mode: 'shadow', digest: true });
  expect(result.pass.incomplete).toBe(true);
  expect(result.after).toEqual(result.before);
  expect(result.cleared).toEqual([]);
});

it('persists merged invariant violation metadata alongside the original finding evidence and command', () => {
  const ctx = setup();
  const finding = op(12, 'stalled-head', { reason: 'specific failure', evidence: ['original evidence'], command: 'repair-command', owner: 'daemon:review-daemon', nextAction: 'await-review', deadline: '2026-10-21T17:00:00Z', violation: 'deadline-passed', blockedBy: [13] });
  expect(run(ctx, [finding], { notify: () => ({ ok: true }) }).errors).toEqual([]);
  expect(replay({ path: ctx.feedPath })[0]).toMatchObject({ violation: 'deadline-passed', owner: finding.owner, nextAction: finding.nextAction, deadline: finding.deadline, command: 'repair-command', evidence: ['original evidence'], state: 'stalled-head', blockedBy: [13] });
  expect(replay({ path: ctx.feedPath })[0].reason).toContain('specific failure');
});

it.each([
  ['violation', { violation: 'deadline-passed' }],
  ['nextAction', { nextAction: 'fix' }],
  ['blockedBy', { blockedBy: [2] }],
  ['unblocks', { unblocks: [3] }],
  ['deadline bucket', { deadline: new Date(NOW - 1).toISOString() }],
])('republishes and alerts on a changed %s on the same state before repeat backoff', (_name, change) => {
  const ctx = setup(), { notify, out } = sent();
  const options = { notify, alertBackoffMinutes: [30, 60] };
  const initial = op(1, undefined, { violation: null, nextAction: 'await-review', blockedBy: [], unblocks: [], deadline: new Date(NOW + 60000).toISOString() });
  expect(run(ctx, [initial], options).notified).toBe(true);
  const updated = { ...initial, ...change };
  const result = run(ctx, [updated], { ...options, now: NOW + 1 });
  expect(result.errors).toEqual([]);
  expect(result.lines).toHaveLength(1);
  expect(result.notified).toBe(true);
  expect(replay({ path: ctx.feedPath }).at(-1)).toMatchObject(change);
  expect(run(ctx, [updated], { ...options, now: NOW + 2 }).notified).toBe(false);
  expect(out).toHaveLength(2);
});
it('deadline identity crosses its bucket without timestamp churn and legacy state stays one-shot', () => {
  const ctx = setup(), { notify } = sent();
  const options = { notify, alertBackoffMinutes: [30, 60] };
  const item = op(1, undefined, { deadline: new Date(NOW + 1000).toISOString() });
  run(ctx, [item], options);
  expect(run(ctx, [{ ...item, deadline: new Date(NOW + 2000).toISOString() }], { ...options, now: NOW + 1 }).lines).toEqual([]);
  expect(run(ctx, [item], { ...options, now: NOW + 1001 }).notified).toBe(true);
  const legacy = setup();
  run(legacy, [op(1, 'A')], { notify });
  run(legacy, [op(1, 'B')], { notify });
  expect(run(legacy, [op(1, 'A')], { notify }).notified).toBe(false);
});


it.each([
  ['missing diff count', { changedFiles: undefined }], ['null diff count', { changedFiles: null }],
  ['fractional diff count', { changedFiles: 0.5 }], ['negative diff count', { changedFiles: -1 }],
  ['string diff count', { changedFiles: '0' }], ['unsafe diff count', { changedFiles: Number.MAX_SAFE_INTEGER + 1 }],
  ['missing labels', { labels: undefined }], ['null labels', { labels: null }],
  ['malformed labels', { labels: [{}] }], ['empty label name', { labels: [''] }],
  ['missing head', { headRefOid: undefined }], ['null head', { headRefOid: null }],
  ['empty head', { headRefOid: '' }], ['blank head', { headRefOid: '   ' }],
  ['missing update time', { updatedAt: undefined }], ['null update time', { updatedAt: null }],
  ['invalid update time', { updatedAt: 'invalid' }],
])('preserves persisted empty-diff feed on %s until same-head positive diff proof', async (_name, patch) => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  const base = { number: 6254, title: 'diff recovery', headRefOid: H, labels: ['review:accepted'],
    changedFiles: 0, updatedAt: new Date(NOW).toISOString() };
  let previous = {}, rows = [base];
  const passes = [];
  const tick = async minutes => {
    const report = await runPrSweep({ now: NOW + minutes * 60000, env: {}, config: {},
      settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
      readPrs: () => rows, readPrevious: () => previous, readQueue: () => ({ ready: [], rulingNeeded: [] }),
      readSignals: () => ({}), detector: async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }),
      notify, flush: () => {}, persist: () => {}, append: () => {},
      stallSweep: () => ({ mode: 'shadow', dir: ctx.stateDir, items: [], incomplete: false }),
      stallDigest: (pass, options) => { passes.push(pass); return publishStalledDigest(pass, { ...options, feedPath: ctx.feedPath }); } });
    previous = report.nextState;
    return report;
  };
  expect((await tick(0)).errors).toEqual([]);
  expect(passes[0].incomplete).toBe(false);
  expect(unacknowledged({ path: ctx.feedPath })).toMatchObject([{ pr: 6254, head: H, state: 'empty-diff' }]);
  rows = [{ ...base, changedFiles: 1, ...patch }];
  await tick(1);
  expect(passes[1].incomplete).toBe(true);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath }).some(e => e.pr === 6254 && e.head === H)).toBe(true);
  if (Object.hasOwn(patch, 'changedFiles')) {
    expect(passes[1].items).toEqual([]);
    expect(unacknowledged({ path: ctx.feedPath })).toMatchObject([{ pr: 6254, head: H, state: 'empty-diff' }]);
  }
  rows = [{ ...base, changedFiles: 1 }];
  expect((await tick(2)).errors).toEqual([]);
  expect(passes[2]).toMatchObject({ incomplete: false, items: [] });
  expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toMatchObject([{ pr: 6254, head: H }]);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toHaveLength(1);
});


it.each([
  ['mode=off / unknown diff', { mode: 'off', digest: true }, { changedFiles: null }],
  ['digest=false / unknown diff', { mode: 'shadow', digest: false }, { changedFiles: null }],
  ['mode=off / unknown labels', { mode: 'off', digest: true }, { labels: null }],
  ['digest=false / unknown labels', { mode: 'shadow', digest: false }, { labels: null }],
])('incomplete listings preserve persisted detector findings with invariant producer disabled: %s', async (_name, producer, patch) => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  const base = { number: 5759, title: 'detector evidence', headRefOid: H, labels: [],
    changedFiles: 1, updatedAt: new Date(NOW).toISOString() };
  const finding = op(base.number, Object.hasOwn(patch, 'changedFiles') ? 'empty-diff' : 'stalled-same-head', { action: 'stalled-detector' });
  let previous = {}, rows = [base], detectorItems = [finding];
  const passes = [];
  const tick = async minutes => {
    const report = await runPrSweep({ now: NOW + minutes * 60000, env: {}, config: {},
      settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
      readPrs: () => rows, readPrevious: () => previous, readQueue: () => ({ ready: [], rulingNeeded: [] }),
      readSignals: () => ({}), detector: async () => ({ enabled: true, items: detectorItems, errors: [], nextSeen: {} }),
      notify, flush: () => {}, persist: () => {}, append: () => {},
      stallSweep: () => ({ ...producer, dir: ctx.stateDir, items: [], incomplete: false }),
      stallDigest: (pass, options) => {
        passes.push({ pass, enabled: options.enabled });
        return publishStalledDigest(pass, { ...options, feedPath: ctx.feedPath });
      } });
    previous = report.nextState;
    expect(report.errors).toEqual([]);
    return report;
  };
  // The invariant would publish no-labels if enabled; only the detector reaches the feed.
  expect((await tick(0)).decisions[0].violation).toBe('no-labels');
  expect(passes[0]).toMatchObject({ enabled: true, pass: { ...producer, incomplete: false, items: [finding] } });
  const opened = unacknowledged({ path: ctx.feedPath });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ pr: base.number, head: H, state: finding.state });
  detectorItems = [];
  rows = [{ ...base, ...patch }];
  await tick(1);
  expect(passes[1]).toMatchObject({ enabled: true, pass: { ...producer, incomplete: true, items: [] } });
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(opened);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toEqual([]);
  rows = [base];
  await tick(2);
  expect(passes[2]).toMatchObject({ enabled: true, pass: { ...producer, incomplete: false, items: [] } });
  expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toHaveLength(1);
});


it('incomplete passes retain same-head findings and their saved identity while admitting new heads', () => {
  const ctx = setup(), { notify } = sent();
  const original = op(6254, 'empty-diff', { violation: 'empty-diff', nextAction: 'close into card' });
  run(ctx, [original], { notify });
  const before = unacknowledged({ path: ctx.feedPath });
  const saved = JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8'));
  const replacement = op(6254, 'owner-stale', { violation: 'owner-stale', nextAction: 'inspect unreadable labels' });
  const result = run(ctx, [replacement, op(6255)], { notify, pass: { incomplete: true }, now: NOW + 60000 });
  expect(result.errors).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath }).find(e => e.pr === 6254)).toEqual(before[0]);
  expect(unacknowledged({ path: ctx.feedPath }).some(e => e.pr === 6255)).toBe(true);
  expect(replay({ path: ctx.feedPath }).filter(e => e.pr === 6254)).toEqual(before);
  expect(JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8')).current)
    .toMatchObject(saved.current);
  expect(result.fresh.map(e => e.pr)).toEqual([6255]);
});

it.each(['no prior item', 'other head', 'other repo'])('legacy missing diff count stays complete with %s', async scenario => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  if (scenario !== 'no prior item') run(ctx, [op(6254, 'empty-diff', {
    head: scenario === 'other head' ? 'b'.repeat(40) : H,
    repo: scenario === 'other repo' ? 'plateauapp/plateau-app' : REPO,
  })], { notify });
  let pass;
  const report = await runPrSweep({ now: NOW, env: {}, config: {},
    settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
    readPrs: () => [{ number: 6254, title: 'legacy', headRefOid: H, labels: ['review:accepted'], updatedAt: new Date(NOW).toISOString() }],
    readPrevious: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}),
    detector: async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }),
    notify, flush: () => {}, persist: () => {}, append: () => {},
    stallSweep: () => ({ mode: 'off', dir: ctx.stateDir, items: [], incomplete: false }),
    stallDigest: (input, options) => { pass = input; return publishStalledDigest(input, { ...options, feedPath: ctx.feedPath }); } });
  expect(report.errors).toEqual([]);
  expect(pass.incomplete).toBe(false);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
});

it('unknown diff and null labels cannot overwrite a persisted same-head empty-diff finding', async () => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  const seeded = run(ctx, [op(6254, 'empty-diff', { violation: 'empty-diff', nextAction: 'close into card' })], { notify });
  expect(seeded.errors).toEqual([]);
  const before = unacknowledged({ path: ctx.feedPath });
  await runPrSweep({ now: NOW, env: {}, config: {},
    settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
    readPrs: () => [{ number: 6254, title: 'unknown diff', headRefOid: H, labels: null, changedFiles: null, updatedAt: new Date(NOW).toISOString() }],
    readPrevious: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}),
    detector: async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }),
    notify, flush: () => {}, persist: () => {}, append: () => {},
    stallSweep: () => ({ mode: 'shadow', dir: ctx.stateDir, items: [], incomplete: false }),
    stallDigest: (pass, options) => publishStalledDigest(pass, { ...options, feedPath: ctx.feedPath }) });
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  expect(replay({ path: ctx.feedPath })).toEqual(before);
});


it.each(['current', 'legacy'])('publisher rechecks %s persisted empty-diff proof under the feed lock', shape => {
  const ctx = setup(), { notify } = sent();
  run(ctx, [op(6254, 'empty-diff', { violation: 'empty-diff', nextAction: 'close into card' })], { notify });
  const before = unacknowledged({ path: ctx.feedPath });
  if (shape === 'legacy') {
    const path = join(ctx.stateDir, 'digest-state.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    delete saved.current;
    writeFileSync(path, JSON.stringify(saved));
  }
  const result = run(ctx, [], { notify, pass: { incomplete: false, unknownDiffs: [{ repo: REPO, pr: 6254, head: H }] } });
  expect(result.errors).toEqual([]);
  expect(result.lines).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toEqual([]);
});

it('unreadable persisted diff identity fails closed with an operator-visible error and preserves the feed', async () => {
  const { runPrSweep } = await import('../pr-sweep.mjs');
  const ctx = setup(), { notify } = sent();
  run(ctx, [op(6254, 'empty-diff')], { notify });
  const before = unacknowledged({ path: ctx.feedPath });
  const path = join(ctx.stateDir, 'digest-state.json');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.current[`${REPO}#6254@${H}:stalled`] = '[invalid identity';
  writeFileSync(path, JSON.stringify(saved));
  let pass;
  const report = await runPrSweep({ now: NOW, env: {}, config: {},
    settings: { value: { repos: [REPO], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
    readPrs: () => [{ number: 6254, title: 'unknown diff', headRefOid: H, labels: ['review:accepted'], changedFiles: null, updatedAt: new Date(NOW).toISOString() }],
    readPrevious: () => ({}), readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}),
    detector: async () => ({ enabled: true, items: [], errors: [], nextSeen: {} }),
    notify, flush: () => {}, persist: () => {}, append: () => {},
    stallSweep: () => ({ mode: 'shadow', dir: ctx.stateDir, items: [], incomplete: false }),
    stallDigest: (input, options) => { pass = input; return publishStalledDigest(input, { ...options, feedPath: ctx.feedPath }); } });
  expect(report.errors.join(' ')).toContain('persisted diff evidence:');
  expect(pass.incomplete).toBe(true);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toEqual([]);
});


it.each([
  ['state', 'empty-diff', 'owner-stale'],
  ['merged violation', 'stalled-same-head', 'empty-diff'],
])('unknown same-head diff evidence retains a persisted empty-diff %s', async (_slot, state, violation) => {
  const { readDiffEvidenceIncomplete } = await import('../pr-stall-digest.mjs');
  const ctx = setup(), { notify } = sent();
  const finding = op(6254, state, { violation, nextAction: 'close into card' });
  expect(run(ctx, [finding], { notify }).errors).toEqual([]);
  const saved = JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8'));
  expect(JSON.parse(saved.current[`${REPO}#6254@${H}:stalled`]).slice(0, 2)).toEqual([state, violation]);
  const before = unacknowledged({ path: ctx.feedPath });
  const unknownDiffs = [{ repo: REPO, pr: 6254, head: H }];
  const result = run(ctx, [], { notify, now: NOW + 60000, pass: { incomplete: false, unknownDiffs } });
  expect(result.errors).toEqual([]);
  expect(result.lines).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toEqual([]);
  expect(readDiffEvidenceIncomplete(ctx.stateDir, unknownDiffs)).toBe(true);
});

it('empty-diff text in other identity fields does not count as an empty-diff state or violation', async () => {
  const { readDiffEvidenceIncomplete } = await import('../pr-stall-digest.mjs');
  const ctx = setup(), { notify } = sent();
  expect(run(ctx, [op(6254, 'stalled-same-head', { violation: 'owner-stale', nextAction: 'empty-diff' })], { notify }).errors).toEqual([]);
  const unknownDiffs = [{ repo: REPO, pr: 6254, head: H }];
  expect(readDiffEvidenceIncomplete(ctx.stateDir, unknownDiffs)).toBe(false);
  const result = run(ctx, [], { notify, now: NOW + 60000, pass: { incomplete: false, unknownDiffs } });
  expect(result.errors).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual([]);
  expect(replay({ path: ctx.feedPath }).filter(e => e.kind === 'cleared')).toHaveLength(1);
});


it.each(['deadline crossing', 'changed state', 'omitted head'])('incomplete %s retries an owed retained alert without overwriting the feed', scenario => {
  const ctx = setup();
  const original = op(6254, 'stalled-head', { deadline: new Date(NOW + 1000).toISOString(), nextAction: 'await-review' });
  const first = run(ctx, [original], { notify: () => ({ ok: false, error: 'first delivery failed' }) });
  expect(first.errors.join(' ')).toContain('first delivery failed');
  const before = unacknowledged({ path: ctx.feedPath });
  const items = scenario === 'omitted head' ? [] : scenario === 'changed state'
    ? [{ ...original, state: 'owner-stale', violation: 'owner-stale' }] : [original];
  const retry = vi.fn(() => ({ ok: false, error: 'retry delivery failed' }));
  const failed = run(ctx, items, { notify: retry, now: NOW + 1001, pass: { incomplete: true } });
  expect(retry).toHaveBeenCalledTimes(1);
  expect(failed.errors.join(' ')).toContain('retry delivery failed');
  expect(failed.fresh.map(f => f.state)).toEqual([original.state]);
  expect(failed.lines).toEqual([]);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  const alertId = `${REPO}#6254@${H}:${original.state}`;
  expect(JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8')).unnotified).toEqual([alertId]);
  const delivered = vi.fn(() => ({ ok: true }));
  const result = run(ctx, items, { notify: delivered, now: NOW + 1002, pass: { incomplete: true } });
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(result.errors).toEqual([]);
  expect(result.notified).toBe(true);
  expect(JSON.parse(readFileSync(join(ctx.stateDir, 'digest-state.json'), 'utf8')).unnotified).toEqual([]);
  expect(replay({ path: ctx.feedPath })).toEqual(before);
});

it.each(['deadline crossing', 'changed state', 'omitted head'])('incomplete %s schedules retained backoff reminders without replacing their evidence', scenario => {
  const ctx = setup(), { notify, out } = sent();
  const original = op(6254, 'stalled-head', { deadline: new Date(NOW + 60000).toISOString(), nextAction: 'await-review' });
  const options = { notify, alertBackoffMinutes: [30, 60] };
  expect(run(ctx, [original], options).notified).toBe(true);
  const before = unacknowledged({ path: ctx.feedPath });
  const items = scenario === 'omitted head' ? [] : scenario === 'changed state'
    ? [{ ...original, state: 'owner-stale', violation: 'owner-stale' }] : [original];
  const due = run(ctx, items, { ...options, now: NOW + 31 * 60000, pass: { incomplete: true } });
  expect(due.errors).toEqual([]);
  expect(due.notified).toBe(true);
  expect(due.fresh.map(f => f.state)).toEqual([original.state]);
  expect(due.lines).toEqual([]);
  expect(run(ctx, items, { ...options, now: NOW + 32 * 60000, pass: { incomplete: true } }).notified).toBe(false);
  expect(run(ctx, items, { ...options, now: NOW + 91 * 60000, pass: { incomplete: true } }).notified).toBe(true);
  expect(out).toHaveLength(3);
  expect(unacknowledged({ path: ctx.feedPath })).toEqual(before);
  expect(replay({ path: ctx.feedPath })).toEqual(before);
});
