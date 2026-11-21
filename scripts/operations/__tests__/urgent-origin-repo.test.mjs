import { describe, it, expect, vi } from 'vitest';
import { resolveOriginRepo } from '../urgent-verify-marker.mjs';

describe('resolveOriginRepo', () => {
  it('resolves renamed HTTPS and SSH origins once per owner/name', () => {
    const gh = vi.fn(() => ({ code: 0, stdout: 'web-everything/web-everything\n' }));
    const cache = new Map();
    for (const origin of ['https://github.com/chalbert/web-everything.git', 'git@github.com:chalbert/web-everything.git', 'ssh://git@github.com/chalbert/web-everything.git']) {
      expect(resolveOriginRepo(origin, { gh, cache })).toBe('web-everything/web-everything');
    }
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0][0]).toEqual(['api', 'repos/chalbert/web-everything', '-q', '.full_name']);
    const options = gh.mock.calls[0][1];
    expect(options).toMatchObject({ timeout: 30000, maxBuffer: 1024 * 1024 });
    expect(options.env).not.toHaveProperty('GH_REPO');
    expect(options.env).not.toHaveProperty('GH_HOST');
  });
  it('returns a foreign resolved slug for the caller to reject', () => {
    expect(resolveOriginRepo('https://github.com/other/repo', { gh: () => 'evil/fork', cache: new Map() })).toBe('evil/fork');
  });
  it.each([
    ['throw', () => { throw Error('API failed'); }],
    ['nonzero', () => ({ code: 1, stdout: 'web-everything/web-everything' })],
    ['empty', () => ''], ['invalid', () => 'not a slug'],
    ['multiple lines', () => 'owner/repo\nevil/fork'], ['missing output', () => undefined],
  ])('throws on %s and does not cache failed evidence', (_, gh) => {
    const cache = new Map();
    expect(() => resolveOriginRepo('https://github.com/owner/repo', { gh, cache })).toThrow();
    expect(cache.size).toBe(0);
  });
  it.each(['https://evil.example/owner/repo', 'owner/repo', 'https://github.com/owner/repo/extra'])('refuses invalid GitHub origin %s without an API call', origin => {
    const gh = vi.fn();
    expect(() => resolveOriginRepo(origin, { gh, cache: new Map() })).toThrow();
    expect(gh).not.toHaveBeenCalled();
  });
});
