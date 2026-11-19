import { describe, it, expect } from 'vitest';
import { resolveProviderCap, resolveRoutingProviderCap, redTeamRouteByBuilder, readReviewSeatPolicy } from '../review-seat-caps.mjs';

const reader = (tool = {}, platform = {}) => () => ({ tool, platform });

describe('R1077 live review seat policy', () => {
  it('resolves standard, platform, tool, own env and legacy env in order', () => {
    expect(resolveProviderCap('codex', {}, reader())).toBe(600);
    const platform = { seatDailyCaps: { codex: 12, 'agy-claude': 15 } };
    expect(resolveProviderCap('codex', {}, reader({}, platform))).toBe(12);
    const read = reader({ seatDailyCaps: { codex: 20 } }, platform);
    expect(resolveProviderCap('codex', {}, read)).toBe(20);
    expect(resolveProviderCap('agy-claude', {}, read)).toBe(15);
    expect(resolveProviderCap('agy-gemini', {}, read)).toBe(0);
    expect(resolveProviderCap('codex', { WE_REVIEW_EXTRA_SEATS_DAILY_CAP: '7' }, read)).toBe(7);
    expect(resolveProviderCap('codex', { WE_REVIEW_EXTRA_SEATS_DAILY_CAP: '7', WE_REVIEW_SEAT_CAP_CODEX: '9' }, read)).toBe(9);
    expect(resolveProviderCap('codex', { WE_REVIEW_EXTRA_SEATS_DAILY_CAP: 'garbage' }, read)).toBe(40);
  });

  it('rejects invalid settings and falls through to the next valid layer', () => {
    const read = reader({ seatDailyCaps: { codex: -1, 'agy-claude': Number.MAX_SAFE_INTEGER + 1 } },
      { seatDailyCaps: { codex: 17, 'agy-claude': 'invalid' } });
    expect(resolveProviderCap('codex', { WE_REVIEW_SEAT_CAP_CODEX: 'invalid' }, read)).toBe(17);
    expect(resolveProviderCap('agy-claude', {}, read)).toBe(300);
    expect(resolveProviderCap('unknown', {}, read)).toBe(40);
  });

  it('reads changed settings without a restart, including platform preferences', () => {
    let cap = 18;
    const read = options => readReviewSeatPolicy({ ...options,
      readFile: path => JSON.stringify(String(path).endsWith('review.json') ? {} : { review: { seatDailyCaps: { codex: cap } } }),
    });
    expect(resolveProviderCap('codex', {}, read)).toBe(18);
    cap = 22;
    expect(resolveProviderCap('codex', {}, read)).toBe(22);
  });

  it('falls back on unreadable settings and rejects object-shaped scalar overrides', () => {
    const unreadable = () => { throw new Error('unreadable'); };
    expect(resolveProviderCap('codex', {}, unreadable)).toBe(600);
    expect(resolveProviderCap('codex', { WE_REVIEW_SEAT_CAP_CODEX: '8' }, unreadable)).toBe(8);
    expect(resolveProviderCap('codex', {}, reader({ seatDailyCaps: { codex: { nested: 3 } } }))).toBe(600);
    expect(redTeamRouteByBuilder({}, reader({ redTeam: { routeByBuilder: { nested: false } } }))).toBe(true);
  });

  it('retains routing enable/disable and explicit env zero semantics', () => {
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] }, reader())).toBe(300);
    expect(resolveRoutingProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' }, { enabledProviders: ['agy-gemini'] }, reader())).toBe(0);
    expect(resolveRoutingProviderCap('codex', {}, { disabledProviders: ['codex'] }, reader())).toBe(0);
  });

  it('defaults builder routing on and accepts platform/tool false with provenance', () => {
    const lines = [];
    expect(redTeamRouteByBuilder({}, reader())).toBe(true);
    expect(redTeamRouteByBuilder({}, reader({}, { redTeam: { routeByBuilder: false } }))).toBe(false);
    expect(redTeamRouteByBuilder({}, () => ({ tool: { redTeam: { routeByBuilder: false } }, platform: {}, log: line => lines.push(line) }))).toBe(false);
    expect(lines[0]).toMatch(/routeByBuilder=false.*tool/);
  });
});
