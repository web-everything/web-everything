import { expect, it, vi } from 'vitest';
import { probePidAlive } from '../pid-alive.mjs';

it('reports a successful signal-zero probe as alive', () => {
  const kill = vi.fn();
  expect(probePidAlive(42, kill)).toBe(true);
  expect(kill).toHaveBeenCalledWith(42, 0);
});
it('reports death only for ESRCH', () => {
  expect(probePidAlive(42, () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); })).toBe(false);
});
it.each(['EPERM', 'EACCES', 'EIO', 'EINVAL', undefined])('treats probe error %s as unknown, never dead', code => {
  expect(probePidAlive(42, () => { throw Object.assign(Error('unreadable'), { code }); })).toBeNull();
});
it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, 2 ** 31])('does not probe an invalid or oversized PID (%s)', pid => {
  const kill = vi.fn();
  expect(probePidAlive(pid, kill)).toBeNull();
  expect(kill).not.toHaveBeenCalled();
});
