import { it, expect } from 'vitest';
import { dispatchProviderAvailable } from '../dispatch-provider-availability.mjs';
import { vi } from 'vitest';

const scorecardIO = vi.hoisted(() => ({ read: undefined }));
vi.mock('../../conveyor/run-scorecard-store.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readStore: (options) => actual.readStore({ ...options, read: scorecardIO.read }),
  };
});
it('checks the selected binary and refuses a known quota hold before launch', () => {
  const now = Date.parse('2026-09-30T20:00:00Z');
  const options = { env: { PATH: '/bin' }, now, access: () => {}, records: [] };
  expect(dispatchProviderAvailable('codex', options)).toBe(true);
  expect(dispatchProviderAvailable('codex', { ...options, access: () => { throw new Error('missing'); } })).toBe(false);
  expect(dispatchProviderAvailable('codex', { ...options, records: [{ provider: 'codex', status: 'quota-exhausted', scoredAt: '2026-09-30T19:59:00Z', quotaResetsAt: '2026-09-30T21:00:00Z' }] })).toBe(false);
  expect(dispatchProviderAvailable('agy-gemini', { ...options, access: path => { expect(path).toBe('/bin/agy'); } })).toBe(true);
});

const row = {
  provider: 'codex', status: 'quota-exhausted',
  scoredAt: '2026-09-30T19:59:00Z', quotaResetsAt: '2026-09-30T21:00:00Z',
};
it.each([
  ['ok', { version: 1, records: [] }, true],
  ['ENOENT', null, true],
  ['malformed JSON', '{', false],
  ['invalid store shape', { records: null }, false],
  ['EACCES', null, false],
  ['quota exhausted', { records: [row] }, false],
  ['quota gauge full', { records: [{ ...row, status: 'ok', quotaUsedPercent: 99 }] }, false],
  ['expired quota', { records: [{ ...row, quotaResetsAt: '2026-09-30T19:59:59Z' }] }, true],
  ['later clean row', { records: [row, { ...row, status: 'ok', scoredAt: '2026-09-30T20:00:00Z' }] }, true],
])('default records: %s preserves holds or refuses unreadable evidence', (state, store, expected) => {
  scorecardIO.read = vi.fn(() => {
    if (state === 'ENOENT' || state === 'EACCES') throw Object.assign(new Error(state), { code: state });
    return typeof store === 'string' ? store : JSON.stringify(store);
  });
  const access = vi.fn();
  try {
    expect(dispatchProviderAvailable('codex', {
      env: { PATH: '/bin' }, now: Date.parse('2026-09-30T20:00:00Z'), access,
    })).toBe(expected);
    expect(scorecardIO.read).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledTimes(expected ? 1 : 0);
  } finally {
    scorecardIO.read = undefined;
  }
});

it('keeps injected records independent of an unreadable default store', () => {
  scorecardIO.read = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  try {
    expect(dispatchProviderAvailable('codex', { records: [], env: { PATH: '/bin' }, access: () => {} })).toBe(true);
    expect(scorecardIO.read).not.toHaveBeenCalled();
  } finally {
    scorecardIO.read = undefined;
  }
});
