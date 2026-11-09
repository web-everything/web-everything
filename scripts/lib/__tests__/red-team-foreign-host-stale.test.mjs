// @vitest-environment node
import { expect, it } from 'vitest';
import { foreignHostDead, foreignHostStaleMs } from '../red-team-foreign-host-stale.mjs';

const now = 10_000_000, st = { host: 'old' };
it('foreign + stale is dead', () => expect(foreignHostDead(st, { host: 'new', statusAt: now - 1_800_001, now })).toBe(true));
it('foreign + fresh is live', () => expect(foreignHostDead(st, { host: 'new', statusAt: now - 60_000, now })).toBe(false));
it('same host is never judged here', () => expect(foreignHostDead(st, { host: 'old', statusAt: 1, now })).toBe(false));
it('unreadable timestamp holds', () => {
  for (const statusAt of [0, NaN, undefined]) expect(foreignHostDead(st, { host: 'new', statusAt, now })).toBe(false);
});
it('setting parses, bad value falls back to 30 min', () => {
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '900000' })).toBe(900000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '0' })).toBe(600000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: 'x' })).toBe(1_800_000);
  expect(foreignHostStaleMs({})).toBe(1_800_000);
});
it('any value below the 10 minute floor is raised to it', () => {
  for (const v of ['1', '60000', '599999']) expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: v })).toBe(600_000);
  expect(foreignHostStaleMs({ WE_RED_TEAM_FOREIGN_HOST_STALE_MS: '600001' })).toBe(600_001);
});
