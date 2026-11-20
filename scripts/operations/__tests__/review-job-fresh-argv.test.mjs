import { describe, expect, it, vi } from 'vitest';
import { createReviewJobIo } from '../review-job.mjs';

describe('review-job CLI argv producer', () => {
  it.each([false, true])('forwards explicit fresh authority=%s as argv with its expected head', flagged => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '{}', stderr: '' }));
    const io = createReviewJobIo({ spawnNode: spawn, env: {}, root: '/fixture' });
    const head = 'a'.repeat(40);
    io.runLoop({ repo: 'web-everything/web-everything', pr: 7116, lanePath: '/fixture/lane',
      ...(flagged ? { freshAfterDead: 'custom-dead', expectedHead: head } : {}) });
    expect(spawn).toHaveBeenCalledTimes(1);
    const argv = spawn.mock.calls[0][1];
    if (flagged) {
      expect(argv).toContain('--fresh-after-dead=custom-dead');
      expect(argv).toContain(`--expected-head=${head}`);
    } else {
      expect(argv.some(arg => arg.startsWith('--fresh-after-dead=') || arg.startsWith('--expected-head='))).toBe(false);
    }
  });
});
