import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSpawnAgent } from '../../operations/dispatch-lane-io.mjs';
import { defaultAwaitVerifyIo } from '../await-verify-pass.mjs';
import { saveLaunchEvidence, readLaunchEvidence } from '../../operations/launch-evidence.mjs';
import { launchGuardFor } from '../conflict-rebase-launch-gate.mjs';

const dirs = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'launch-evidence-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const sid = '12345678-1234-4234-8234-123456789abc';
const head = 'a'.repeat(40);
const descriptor = { mode: 'conflict-rebase', launchGuard: launchGuardFor({ mode: 'conflict-rebase',
  pr: 7, headRefOid: head, conflictRebase: { oldHead: head, defaultBranch: 'main', mainSha: 'f'.repeat(40),
        receipt: `accepted-conflict-rebase:${head}@${'f'.repeat(40)}` } }, { repo: 'o/r' }) };
const live = () => ({ headRefOid: head, state: 'OPEN', isDraft: false, baseRefName: 'main',
  mergeable: 'CONFLICTING', labels: ['review:pending'] });

async function harness({ evidence = descriptor, state = live(), savedDir = temporary() } = {}) {
  if (evidence) saveLaunchEvidence(sid, evidence, { dir: savedDir });
  const events = [];
  const exec = vi.fn(() => { events.push('exec'); return `backgrounded · ${sid}`; });
  const stop = vi.fn();
  const io = await defaultAwaitVerifyIo({
    readSavedLaunch: id => readLaunchEvidence(id, { dir: savedDir }),
    sleep: () => {}, stopSessionFn: stop,
    dispatchIo: {
      buildAgentArgv: () => ['--bg', '--resume', sid],
      defaultSpawnAgent: (argv, opts) => defaultSpawnAgent(argv, { ...opts,
        launchGateOptions: { readLive: () => { events.push('gate'); return state; } },
      }, { exec, saveEvidence: (id, saved) => saveLaunchEvidence(id, saved, { dir: savedDir }) }),
      parseBackgroundedId: () => sid, resumeSucceeded: () => ({ resumed: true }), defaultListAgents: () => [],
    },
  });
  return { exec, events, stop, run: (session = {}) => io.resume({ session: { sessionId: sid, cwd: '/lane', state: 'stopped', ...session }, prompt: 'continue' }) };
}

describe('await-verify-pass original launch evidence', () => {
  it.each(['hold', 'moved head'])('saved conflict evidence refuses a live %s with zero launches', async change => {
    const state = change === 'hold' ? { ...live(), labels: ['review:pending', 'review:held-mechanical'] }
      : { ...live(), headRefOid: 'b'.repeat(40) };
    const h = await harness({ state });
    expect(h.run()).toMatchObject({ resumed: false, reason: expect.stringContaining('launch refused') });
    expect(h.events).toEqual(['gate']);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('missing saved evidence refuses with a logged recovery instruction and zero launches', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await harness({ evidence: null });
    expect(h.run()).toMatchObject({ resumed: false, reason: expect.stringContaining('missing or unreadable saved launch evidence') });
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restore original launch evidence'));
  });

  it('valid saved conflict evidence launches exactly once after fresh execution admission', async () => {
    const h = await harness();
    expect(h.run()).toEqual({ resumed: true, reason: null });
    expect(h.events).toEqual(['gate', 'gate', 'exec']);
    expect(h.exec).toHaveBeenCalledOnce();
  });

  it('original background launch saves the exact descriptor under the CLI-assigned id for resume', () => {
    const dir = temporary();
    const readLive = vi.fn(live);
    const exec = vi.fn(() => `backgrounded · ${sid}`);
    defaultSpawnAgent(['--bg', '-n', 'fix-7', 'brief'], { ...descriptor, launchGateOptions: { readLive } }, {
      exec, saveEvidence: (id, saved) => saveLaunchEvidence(id, saved, { dir }),
    });
    expect(readLaunchEvidence(sid, { dir })).toMatchObject({ sessionId: sid, ...descriptor });
    expect(exec).toHaveBeenCalledOnce();
    expect(readLive).toHaveBeenCalledTimes(2);
  });

  it.each(['null', 'torn', 'foreign', 'missing mode', 'unknown mode', 'missing guard'])('refuses %s saved evidence', async kind => {
    const dir = temporary();
    const record = { v: 1, sessionId: sid, ...descriptor };
    if (kind === 'foreign') record.sessionId = 'foreign';
    if (kind === 'missing mode') delete record.mode;
    if (kind === 'unknown mode') record.mode = 'future';
    if (kind === 'missing guard') delete record.launchGuard;
    writeFileSync(join(dir, `${sid}.json`), kind === 'null' ? 'null' : kind === 'torn' ? '{' : JSON.stringify(record));
    const h = await harness({ savedDir: dir, evidence: null });
    expect(h.run().resumed).toBe(false);
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('reads evidence by the CLI job handle when the listing also carries a different full session UUID', async () => {
    const dir = temporary();
    saveLaunchEvidence('job12345', descriptor, { dir });
    const h = await harness({ evidence: null, savedDir: dir });
    expect(h.run({ id: 'job12345' })).toEqual({ resumed: true, reason: null });
    expect(h.exec).toHaveBeenCalledOnce();
  });

  it('oversized session ids refuse with an operator recovery instruction before reading any path', () => {
    expect(() => readLaunchEvidence('x'.repeat(129), { dir: temporary() }))
      .toThrow(/restore original launch evidence/);
  });
});
