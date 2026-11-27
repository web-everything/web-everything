import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publishHandlingStage } from '../needs-you-feed.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'handling-')); dirs.push(root);
  const stage = { run: 'run-1', claim: 'claim-1', round: 1, stage: 'review', head: 'a'.repeat(40), sequence: 1 };
  const handler = { registered: true, handler: 'review-worker', authority: 'review', owner: 'owner-1', live: true,
    observedAt: '2026-11-26T15:00:00.000Z' };
  const activate = vi.fn();
  const options = { stage, path: join(root, 'handlers.json'), now: () => Date.parse(handler.observedAt),
    readStage: () => ({ ...stage }), readHandler: () => ({ ...handler }), activate };
  return { options, handler, activate };
}
describe('HANDLING-COMBO-A-WE handler publication', () => {
  it('handler reader cannot redirect the validated scope by mutating its argument', async () => {
    const { options, handler, activate } = fixture();
    const original = { ...options.stage };
    options.readHandler = scope => {
      // An adapter may retain and mutate its input; it must never own the internal scope.
      try { Object.assign(scope, { run: 'other', claim: 'other', round: 2, head: 'b'.repeat(40), sequence: 2 }); } catch { /* frozen input is also safe */ }
      return { ...handler };
    };
    options.readStage = () => ({ ...original });
    const evidence = await publishHandlingStage(options);
    expect(evidence).toMatchObject(original);
    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toMatchObject(original);
    expect(activate).toHaveBeenCalledWith(evidence);
  });
  it.each([2, 3])('handler evidence expiring during awaited stage read %s refuses activation', async delayedRead => {
    const { options, activate } = fixture();
    let timestamp = options.now(), reads = 0;
    options.now = () => timestamp;
    options.readStage = async () => {
      if (++reads === delayedRead) { await Promise.resolve(); timestamp += 300001; }
      return { ...options.stage };
    };
    await expect(publishHandlingStage(options)).rejects.toThrow(/handler.*operator/i);
    expect(activate).not.toHaveBeenCalled();
  });
  it.each(['run', 'claim', 'round', 'stage', 'head', 'sequence'])('a %s change only after publication refuses activation', async field => {
    const { options, activate } = fixture();
    let sawPublication = false;
    options.readStage = () => {
      sawPublication = existsSync(options.path);
      return sawPublication ? { ...options.stage, [field]: 'changed' } : { ...options.stage };
    };
    await expect(publishHandlingStage(options)).rejects.toThrow(/stage.*operator/i);
    expect(sawPublication).toBe(true);
    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toMatchObject(options.stage);
    expect(activate).not.toHaveBeenCalled();
  });
  it('a stage without published handler evidence is not activated; publication precedes activation', async () => {
    const { options, activate } = fixture();
    activate.mockImplementation(evidence => {
      expect(JSON.parse(readFileSync(options.path, 'utf8'))).toEqual(evidence);
      expect(evidence).toMatchObject({ ...options.stage, handler: 'review-worker', authority: 'review', owner: 'owner-1', live: true });
    });
    await publishHandlingStage(options);
    expect(activate).toHaveBeenCalledOnce();
  });
  it('caller stage mutation during awaited handler IO cannot move persisted or activated scope', async () => {
    const { options, handler, activate } = fixture();
    const originalScope = { ...options.stage };
    options.readStage = () => ({ ...originalScope });
    let enteredHandler, releaseHandler;
    const entered = new Promise(resolve => { enteredHandler = resolve; });
    const released = new Promise(resolve => { releaseHandler = resolve; });
    options.readHandler = async () => {
      enteredHandler();
      await released;
      return { ...handler };
    };
    const publication = publishHandlingStage(options);
    await entered;
    Object.assign(options.stage, { run: 'run-2', claim: 'claim-2', round: 2,
      stage: 'build', head: 'b'.repeat(40), sequence: 2 });
    releaseHandler();
    const evidence = await publication;
    expect(evidence).toMatchObject(originalScope);
    expect(JSON.parse(readFileSync(options.path, 'utf8'))).toEqual(evidence);
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith(evidence);
  });
  it.each([null, {}, { registered: false }, { authority: 'build' }, { live: false }, { owner: '' },
    { observedAt: 'invalid' }, { observedAt: '2026-11-26T14:00:00.000Z' }, { observedAt: '2026-11-26T16:00:00.000Z' },
    { handler: 'x'.repeat(513) }])('missing, unauthorized, stale or oversized handler refuses visibly: %j', async patch => {
    const { options, handler, activate } = fixture();
    options.readHandler = () => patch === null ? null : Object.keys(patch).length ? { ...handler, ...patch } : {};
    await expect(publishHandlingStage(options)).rejects.toThrow(/handler.*operator/i);
    expect(activate).not.toHaveBeenCalled();
    expect(existsSync(options.path)).toBe(false);
  });
  it.each(['head', 'claim', 'round', 'sequence'])('rechecks %s after publication before activation', async field => {
    const { options, activate } = fixture(); let reads = 0;
    options.readStage = () => ++reads === 1 ? options.stage : { ...options.stage, [field]: 'changed' };
    await expect(publishHandlingStage(options)).rejects.toThrow(/stage.*operator/i);
    expect(activate).not.toHaveBeenCalled();
  });
  it('unknown handler IO and failed publication never activate', async () => {
    const { options, activate } = fixture();
    options.readHandler = () => { throw new Error('unreadable'); };
    await expect(publishHandlingStage(options)).rejects.toThrow(/operator/i);
    options.readHandler = () => ({ registered: true });
    await expect(publishHandlingStage(options)).rejects.toThrow(/operator/i);
    expect(activate).not.toHaveBeenCalled();
  });
  it('publication failure retains an inactive stage with an operator recovery message', async () => {
    const { options, activate } = fixture();
    writeFileSync(options.path, 'blocked parent'); options.path = join(options.path, 'evidence.json');
    await expect(publishHandlingStage(options)).rejects.toThrow(/publication.*operator/i);
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([{ head: 'abc' }, { sequence: 0 }, { round: 0 }, { run: 'x'.repeat(513) }])('invalid or oversized stage refuses before effects: %j', async patch => {
    const { options, activate } = fixture(); options.stage = { ...options.stage, ...patch };
    await expect(publishHandlingStage(options)).rejects.toThrow(/stage.*operator/i);
    expect(existsSync(options.path)).toBe(false); expect(activate).not.toHaveBeenCalled();
  });
  it('a concurrent hold after publication blocks activation', async () => {
    const { options, activate } = fixture();
    options.readStage = () => ({ ...options.stage, held: existsSync(options.path) });
    await expect(publishHandlingStage(options)).rejects.toThrow(/stage.*operator/i);
    expect(activate).not.toHaveBeenCalled();
  });
  it('a failed effect retains published evidence and never claims success', async () => {
    const { options, activate } = fixture(); activate.mockRejectedValue(new Error('effect failed'));
    await expect(publishHandlingStage(options)).rejects.toThrow('effect failed');
    expect(JSON.parse(readFileSync(options.path, 'utf8')).stage).toBe('review');
  });
});
