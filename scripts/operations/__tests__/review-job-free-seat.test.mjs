import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { backgroundExtraSeatsEnabled, createReviewJobIo, EXTRA_SEATS_BACKGROUND_ENV } from '../review-job.mjs';
import { finishBackgroundSeats } from '../review-extra-seats.mjs';
import { countLiveReviewRounds } from '../../../skills-src/conveyor/review-daemon.mjs';

const input = { pr: 7, repo: 'o/r', lanePath: '/lane', loopPayload: { findings: {} }, slug: 'review-7', runId: 'run-1' };

describe('free the live-review seat at the verdict: extra seats run detached', () => {
  it('is on by default and off only for an explicit 0/off/false/no', () => {
    expect(backgroundExtraSeatsEnabled({})).toBe(true);
    for (const v of ['0', 'off', 'false', 'no']) expect(backgroundExtraSeatsEnabled({ [EXTRA_SEATS_BACKGROUND_ENV]: v })).toBe(false);
    expect(backgroundExtraSeatsEnabled({ [EXTRA_SEATS_BACKGROUND_ENV]: '1' })).toBe(true);
  });

  it('runExtraSeats launches a detached process and returns at once, leaving the loop file for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-seat-'));
    try {
      const spawnBackground = vi.fn(() => 4242);
      const io = createReviewJobIo({ root: dir, dir, env: {}, spawnBackground });
      const r = io.runExtraSeats(input);
      expect(r).toMatchObject({ status: 'background', pid: 4242 });
      const call = spawnBackground.mock.calls[0][0];
      expect(call.argv.slice(0, 2)).toEqual(['scripts/operations/review-extra-seats.mjs', 'run']);
      expect(call.argv).toEqual(expect.arrayContaining(['--background', '--run-id=run-1', '--pr=7', '--repo=o/r', '--lane=/lane']));
      expect(call.logPath).toBe(join(dir, 'review-7.extra-seats.log'));
      const loopArg = call.argv.find((a) => a.startsWith('--loop-json='));
      expect(loopArg).toMatch(/review-7\.loop\.[0-9a-f-]{36}\.json$/);
      expect(existsSync(loopArg.slice('--loop-json='.length))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a failed launch is only an error status and leaves no loop file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-seat-'));
    try {
      const io = createReviewJobIo({ root: dir, dir, env: {}, spawnBackground: () => { throw new Error('EMFILE'); } });
      expect(io.runExtraSeats(input)).toMatchObject({ status: 'error' });
      expect(readdirSync(dir).filter((f) => f.includes('.loop.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('kill switch off keeps the inline path (no detached launch)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-seat-'));
    try {
      const spawnBackground = vi.fn();
      const io = createReviewJobIo({ root: dir, dir, env: { [EXTRA_SEATS_BACKGROUND_ENV]: '0' }, spawnBackground });
      try { io.runExtraSeats(input); } catch { /* inline path spawns the real runner under root; only the choice matters */ }
      expect(spawnBackground).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});

describe('finishBackgroundSeats', () => {
  it('records the same seat timing rows the inline job did, then removes the loop file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-seat-'));
    const loop = join(dir, 'x.loop.json');
    try {
      writeFileSync(loop, '{}');
      let saved = null;
      const io = { update: (_id, fn) => { saved = fn({ id: 'run-1' }); } };
      finishBackgroundSeats({
        result: { seats: [{ seat: 's1', lens: 'correctness', provider: 'codex', startedAt: '2026-10-21T12:00:00Z', finishedAt: '2026-10-21T12:03:00Z', seatVerdict: 'ok', findingsCount: 2 }, { seat: 's2' }] },
        runId: 'run-1', loopFile: loop, io,
      });
      expect(saved.seatTimings).toEqual([expect.objectContaining({ seat: 's1', verdict: 'ok', findingsCount: 2, provider: 'codex' })]);
      expect(existsSync(loop)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a store crash is contained and the loop file is still removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'free-seat-'));
    const loop = join(dir, 'x.loop.json');
    try {
      writeFileSync(loop, '{}');
      const io = { update: () => { throw new Error('disk'); } };
      expect(() => finishBackgroundSeats({ result: { seats: [{ seat: 's', startedAt: 't' }] }, runId: 'r', loopFile: loop, io })).not.toThrow();
      expect(existsSync(loop)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the live-round cap and a verdict-done job', () => {
  const NODE = '/usr/bin/node';
  it('a job past its verdict (only the detached seat process left) holds no review seat', () => {
    const lines = [
      `500 1 ${NODE} /r/scripts/operations/review-extra-seats.mjs run --pr=7 --repo=o/r --lane=/lane --loop-json=/j/review-7.loop.json --background --run-id=run-1`,
      `501 500 ${NODE} /r/scripts/codex-direct-task.mjs`,
    ];
    expect(countLiveReviewRounds(lines)).toBe(0);
  });
  it('a job still in its loop still counts, beside a verdict-done one that does not', () => {
    const lines = [
      `10 1 ${NODE} /r/scripts/operations/review-job.mjs run --pr=8 --repo=o/r`,
      `11 10 ${NODE} /r/scripts/operations/review-loop-cli.mjs --pr=8`,
      `500 1 ${NODE} /r/scripts/operations/review-extra-seats.mjs run --pr=7 --repo=o/r --lane=/lane --loop-json=/j/x.json --background`,
    ];
    expect(countLiveReviewRounds(lines)).toBe(1);
  });
});

