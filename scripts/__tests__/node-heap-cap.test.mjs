// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heapCapArgs } from '../lib/node-heap-cap.mjs';
import { defaultSpawnJob } from '../operations/review-job.mjs';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

describe('review child heap caps', () => {
  it('declares the measured caps and keeps every cap at or above the floor', () => {
    const settings = JSON.parse(readFileSync(new URL('../settings/node-heap-cap.json', import.meta.url), 'utf8'));
    expect(settings.description).toEqual(expect.any(String));
    expect(settings.floorMb).toBe(1024);
    expect(settings.caps).toEqual({ 'review-job': 2400, 'review-set-label': 1024, 'review-extra-seats': 1536 });
    for (const cap of Object.values(settings.caps)) expect(cap).toBeGreaterThanOrEqual(settings.floorMb);
  });

  it.each([['review-job', 2400], ['review-set-label', 1024], ['review-extra-seats', 1536]])(
    'loads the configured flag for %s', (name, cap) => {
      expect(heapCapArgs(name)).toEqual([`--max-old-space-size=${cap}`]);
    },
  );

  it('uses injected settings and raises a smaller cap to the configured floor', () => {
    expect(heapCapArgs('child', { settings: { floorMb: 1200, caps: { child: 600 } } }))
      .toEqual(['--max-old-space-size=1200']);
    expect(heapCapArgs('child', { settings: { floorMb: 1200, caps: { child: 3000 } } }))
      .toEqual(['--max-old-space-size=3000']);
  });

  it('leaves unknown names, including inherited object names, uncapped', () => {
    expect(heapCapArgs('unknown')).toEqual([]);
    expect(heapCapArgs('toString')).toEqual([]);
  });

  it('leaves children uncapped when the settings file is unreadable or invalid JSON', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw new Error('unreadable'); });
    syncBuiltinESMExports();
    expect(heapCapArgs('review-job')).toEqual([]);
    read.mockReturnValueOnce('{');
    expect(heapCapArgs('review-job')).toEqual([]);
  });

  it.each([null, {}, { floorMb: 1024 }, { floorMb: 1024, caps: { child: -1 } },
    { floorMb: 1024, caps: { child: '2400' } }, { floorMb: 0, caps: { child: 2400 } }])(
    'does not emit invalid Node flags for incomplete or invalid settings %j', (settings) => {
      expect(heapCapArgs('child', { settings })).toEqual([]);
    },
  );

  it('prepends the cap to the default review-job spawn argv and preserves launch options', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-heap-cap-'));
    try {
      const unref = vi.fn();
      const spawn = vi.fn(() => ({ pid: 123, unref }));
      const argv = ['scripts/operations/review-job.mjs', 'run', '--pr=42'];
      const env = { TASK_TEST: 'yes' };
      expect(defaultSpawnJob({ argv, cwd: dir, env, logPath: join(dir, 'job.log') }, { spawnChild: spawn })).toBe(123);
      expect(spawn).toHaveBeenCalledWith(process.execPath,
        ['--max-old-space-size=2400', ...argv],
        { cwd: dir, env, detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] });
      expect(unref).toHaveBeenCalledOnce();
      expect(argv[0]).toBe('scripts/operations/review-job.mjs');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
