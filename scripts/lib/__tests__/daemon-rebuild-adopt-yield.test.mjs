/** S1 contract: synchronous probe, injectable readReady(root, env) and now().
 * bootAt + swapMinIntervalMs are optional spacing inputs; the latch belongs to
 * this probe's lifetime, keyed by ready.adopt.finalSha AND ready.passedAt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAdoptYieldProbe } from '../daemon-rebuild/adopt-yield.mjs';
import { readyCandidatePath } from '../daemon-rebuild/state.mjs';

const BOOT = 'a'.repeat(40);
const ready = (over = {}) => ({ prevHead: BOOT, passedAt: '2026-11-14T20:00:00.000Z',
  adopt: { finalSha: 'b'.repeat(40) }, ...over });
const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(extra = {}) {
  let time = 0;
  const readReady = vi.fn(() => ready());
  const probe = createAdoptYieldProbe({ root: '/clone', bootHead: BOOT, readReady,
    now: () => time, env: {}, ...extra });
  return { probe, readReady, at: value => { time = value; } };
}

describe('createAdoptYieldProbe — S1 fail-closed safe-point signal', () => {
  it('yields for a candidate built on boot HEAD and forwards root/env to the reader', () => {
    const env = { WE_DAEMON_STATE_DIR: 'injected-state' };
    const f = fixture({ env });
    expect(f.probe()).toBe(true);
    expect(f.readReady).toHaveBeenCalledWith('/clone', env);
  });

  it.each([
    ['missing', null], ['foreign prevHead', ready({ prevHead: 'c'.repeat(40) })],
    ['missing prevHead', ready({ prevHead: undefined })], ['missing finalSha', ready({ adopt: {} })],
    ['missing passedAt', ready({ passedAt: undefined })], ['invalid passedAt', ready({ passedAt: 'invalid' })],
    ['incomplete record', {}], ['array', []],
  ])('does not yield for %s evidence', (_name, candidate) => {
    expect(fixture({ readReady: () => candidate }).probe()).toBe(false);
  });

  it('does not yield when the ready reader throws', () => {
    const f = fixture({ readReady: () => { throw new Error('unreadable'); } });
    expect(f.probe()).toBe(false);
  });

  it.each(['missing', 'corrupt'])('default reader fails closed on a %s ready.json', kind => {
    const dir = mkdtempSync(join(tmpdir(), 'adopt-yield-'));
    temps.push(dir);
    const env = { WE_DAEMON_STATE_DIR: join(dir, 'state') };
    const root = join(dir, 'clone');
    const file = readyCandidatePath(root, env);
    if (kind === 'corrupt') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{broken');
    }
    expect(createAdoptYieldProbe({ root, bootHead: BOOT, env, now: () => 0 })()).toBe(false);
  });

  it('reads at most once per default 5000ms, including repeated missing evidence', () => {
    const f = fixture({});
    f.readReady.mockReturnValue(null);
    expect(f.probe()).toBe(false);
    f.readReady.mockReturnValue(ready());
    f.at(4999);
    expect(f.probe()).toBe(false);
    expect(f.readReady).toHaveBeenCalledTimes(1);
    f.at(5000);
    expect(f.probe()).toBe(true);
    expect(f.readReady).toHaveBeenCalledTimes(2);
  });

  it('throttles failed reads too, then recovers on the next eligible read', () => {
    const f = fixture();
    f.readReady.mockImplementationOnce(() => { throw new Error('IO'); });
    expect(f.probe()).toBe(false);
    f.at(4999);
    expect(f.probe()).toBe(false);
    expect(f.readReady).toHaveBeenCalledTimes(1);
    f.at(5000);
    expect(f.probe()).toBe(true);
  });

  it('supports an injected throttle interval', () => {
    const f = fixture({ throttleMs: 100 });
    f.readReady.mockReturnValueOnce(null);
    expect(f.probe()).toBe(false);
    f.at(99);
    expect(f.probe()).toBe(false);
    f.at(100);
    expect(f.probe()).toBe(true);
  });

  it('latches each identity even after another identity or a missing record intervenes', () => {
    const f = fixture();
    expect(f.probe()).toBe(true);
    f.at(5000);
    expect(f.probe()).toBe(false);
    f.readReady.mockReturnValue(ready({ passedAt: '2026-11-14T20:01:00.000Z' }));
    f.at(10000);
    expect(f.probe()).toBe(true); // same sha, different pass
    f.readReady.mockReturnValue(ready({ adopt: { finalSha: 'c'.repeat(40) } }));
    f.at(15000);
    expect(f.probe()).toBe(true); // same pass, different sha
    f.readReady.mockReturnValue(null);
    f.at(20000);
    expect(f.probe()).toBe(false);
    f.readReady.mockReturnValue(ready());
    f.at(25000);
    expect(f.probe()).toBe(false); // original identity never re-arms
  });

  it('does not yield before swap spacing, and does not consume the identity while held', () => {
    const f = fixture({ bootAt: 0, swapMinIntervalMs: 600000 });
    f.at(599999);
    expect(f.probe()).toBe(false);
    f.at(605000);
    expect(f.probe()).toBe(true);
    f.at(610000);
    expect(f.probe()).toBe(false);
  });
});
