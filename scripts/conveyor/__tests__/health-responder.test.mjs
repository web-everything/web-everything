// @vitest-environment node
import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shadowTick } from '../health-responder.mjs';
import { responderDir, readJournal } from '../health-responder-state.mjs';
import { healthDir } from '../health-watch-section.mjs';
import { ACTION_ALLOWLIST } from '../health-responder-core.mjs';
const replay = JSON.parse(readFileSync(new URL('./fixtures/health-responder/replay.json', import.meta.url)));
const green = replay.cases.find((c) => c.name === 'D1-fresh-green');
const roots = [];
afterEach(() => { vi.useRealTimers(); roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })); });
function setup(c = green) {
  const root = mkdtempSync(join(tmpdir(), 'health-shadow-')); roots.push(root);
  const watch = healthDir(root), store = responderDir(root);
  mkdirSync(join(watch, 'episodes'), { recursive: true }); mkdirSync(store);
  const tick = { completedAt: replay.now };
  writeFileSync(join(watch, 'last-tick.json'), JSON.stringify(tick));
  writeFileSync(join(watch, 'state.json'), JSON.stringify({ lastTick: tick, episodes: { [c.episode.key]: c.episode } }));
  writeFileSync(join(watch, 'episodes', `${c.episode.id}.json`), JSON.stringify(c.episode));
  writeFileSync(join(store, 'config.json'), JSON.stringify({ version: 1, enabled: true, mode: 'shadow', smells: { [c.episode.smell]: true } }));
  return { root, watch, store, options: { stateRoot: root, now: replay.now, clock: () => replay.now, readFacts: async () => ({ [c.episode.key]: c.facts }) } };
}
it('replays the corpus through real disk IO with every external sink wired to throw', async () => {
  const calls = [];
  const forbidden = (name) => () => { calls.push(name); throw new Error(`external write ${name}`); };
  const actuators = Object.fromEntries([...Object.keys(ACTION_ALLOWLIST), 'github', 'worker', 'action-job', 'lane', 'claim', 'desktop', 'host-config'].map((s) => [s, forbidden(s)]));
  for (const c of replay.cases) {
    const { options, watch, store } = setup(c);
    const before = readFileSync(join(watch, 'state.json'), 'utf8');
    const first = await shadowTick({ ...options, actuators });
    expect(first[0].rule, c.name).toBe(c.expected);
    const second = await shadowTick({ ...options, actuators });
    expect(second[0].rule, c.name).toBe(first[0].decision === 'act-would-have' ? 'family-receipt' : c.expected);
    expect(readJournal(store)).toHaveLength(2);
    expect(readFileSync(join(watch, 'state.json'), 'utf8')).toBe(before);
    expect(readdirSync(store).sort()).toEqual(['config.json', 'decisions.jsonl', 'last-tick.json', 'receipts.json']);
  }
  expect(calls).toEqual([]);
});
it('rechecks disabled switch after read, and holds on lease loss or tick deadline', async () => {
  const { options, store } = setup();
  const readFacts = async () => {
    writeFileSync(join(store, 'config.json'), JSON.stringify({ version: 2, enabled: false, mode: 'shadow', smells: {} }));
    return { [green.episode.key]: green.facts };
  };
  expect((await shadowTick({ ...options, readFacts }))[0].rule).toBe('disabled');
  expect((await shadowTick({ ...options, leaseAlive: () => false }))[0].rule).toBe('watch-invalid');
  let n = 0;
  expect((await shadowTick({ ...options, clock: () => replay.now + n++ * 31_000 }))[0].rule).toBe('watch-invalid');
});
it('bounds foreground facts at ten seconds and cancels the reader', async () => {
  vi.useFakeTimers(); const { options } = setup(); let signal;
  const task = shadowTick({ ...options, readFacts: (_, o) => { signal = o.signal; return new Promise(() => {}); } });
  await vi.advanceTimersByTimeAsync(10_001);
  expect((await task)[0].rule).toBe('watch-invalid'); expect(signal.aborted).toBe(true);
});
it('a journal past the old 32 MiB limit rotates into a segment; the next tick still runs, records and keeps its receipts', async () => {
  const { options, store } = setup();
  const first = await shadowTick(options);
  expect(first[0].decision).toBe('act-would-have');
  const file = join(store, 'decisions.jsonl');
  const pad = JSON.stringify({ ...first[0], decision: 'noop', rule: 'pad', pad: 'x'.repeat(60_000) }) + '\n';
  appendFileSync(file, pad.repeat(560));
  const big = readFileSync(file);
  expect(big.length).toBeGreaterThan(32 * 1024 * 1024);
  const second = await shadowTick(options);
  expect(second[0].rule).toBe('family-receipt'); // the receipt from before the rotation still holds
  const segments = readdirSync(store).filter((n) => /^decisions\..+\.jsonl$/.test(n));
  expect(segments).toHaveLength(1);
  expect(readFileSync(join(store, segments[0])).equals(big)).toBe(true); // complete, byte-identical
  expect(readJournal(store)).toHaveLength(1); // the active segment restarts small
  expect((await shadowTick(options))[0].rule).toBe('family-receipt');
  expect(readJournal(store)).toHaveLength(2);
}, 30_000);
it('default production reader cannot invent a current-head owner plan', async () => {
  const { options } = setup(); delete options.readFacts;
  expect((await shadowTick(options))[0].rule).toBe('facts-unknown');
});
it('contains no production detector evaluation or external actuator import', () => {
  for (const name of ['health-responder.mjs', 'health-responder-core.mjs', 'health-responder-state.mjs']) {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/\.evaluate\s*\(/);
    expect(text).not.toMatch(/from ['"][^'"]*(?:ci-heal-pr-dispatch|review-set-label|lease-reaper|orphan-claim-release|review-job|notify-desktop)/);
    if (name !== 'health-responder.mjs') expect(text).not.toMatch(/(?:exec|spawn)(?:Sync|File|FileSync)?\s*\(/);
    else expect(text).toContain("timeout: CHILD_READ_CEILING_MS");
  }
});

it('resident process uses manifest cadence, publishes real lease ownership and reloads between ticks after five minutes', async () => {
  const { runResponderDaemon, shouldReload } = await import('../health-responder.mjs');
  const { runnerLeaseStatus } = await import('../../../skills-src/conveyor/runner-lock.mjs');
  const { options, root } = setup();
  const lockRoot = join(root, 'locks'); let time = replay.now, calls = 0;
  const a = { revision: 'old', inputsKey: 'inputs-a' }, b = { revision: 'new', inputsKey: 'inputs-b' };
  expect(shouldReload(a, b, 299_999)).toBe(false);
  expect(shouldReload(a, b, 300_000)).toBe(true);
  expect(shouldReload(a, { ...b, inputsKey: a.inputsKey }, 300_000)).toBe(false);
  const result = await runResponderDaemon({ root, lockRoot, env: { CONVEYOR_STATE_ROOT: root }, clock: () => time,
    readInputs: () => calls ? b : a, sleep: async (ms) => { expect(ms).toBe(60_000); time += 60_000; },
    runPass: async (entry, context) => {
      expect(entry.args).toEqual(['tick']);
      expect(runnerLeaseStatus(lockRoot, { key: '<conveyor:pass-daemon:health-responder-lease>' }).owner).toBe(context.env.HEALTH_RESPONDER_LEASE_OWNER);
      expect(context.env.HEALTH_RESPONDER_BOOT_REVISION).toBe('old'); calls++;
      await shadowTick({ ...options, env: context.env }); return { code: 0 };
    }, maxRuns: 8 });
  expect(calls).toBe(5); expect(result.runs).toBe(6);
  expect(runnerLeaseStatus(lockRoot, { key: '<conveyor:pass-daemon:health-responder-lease>' }).held).toBe(false);
});
