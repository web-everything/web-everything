import { describe, it, expect, vi } from 'vitest';
import { resolveProviderCap, resolveRoutingProviderCap, redTeamRouteByBuilder, readReviewSeatPolicy } from '../review-seat-caps.mjs';

const reader = (tool = {}, platform = {}) => () => ({ tool, platform });

describe('R1077 live review seat policy', () => {
  it('keeps the Codex fallback at 80 and enables 600 only through explicit tool settings with provenance', () => {
    expect(resolveProviderCap('codex', {}, reader())).toBe(80);
    const log = vi.fn();
    const read = options => readReviewSeatPolicy({ ...options, platform: {}, log });
    expect(resolveProviderCap('codex', {}, read)).toBe(600);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/codex=600.*tool/));
  });

  it.each([-1, 'invalid', null, { nested: 3 }, Number.MAX_SAFE_INTEGER + 1])(
    'ignores an invalid tool cap %j without widening platform zero or discarding sibling caps', invalid => {
      const log = vi.fn();
      const read = () => ({ platform: { seatDailyCaps: { codex: 0, 'agy-claude': 2 } },
        tool: { seatDailyCaps: { codex: invalid, 'agy-claude': 3 } }, log });
      expect(resolveProviderCap('codex', {}, read)).toBe(0);
      expect(resolveProviderCap('agy-claude', {}, read)).toBe(3);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/codex=0.*platform/));
    });

  it.each([null, [], 'invalid'])(
    'ignores a malformed tool cap block %j without widening platform zero', seatDailyCaps => {
      expect(resolveProviderCap('codex', {}, reader({ seatDailyCaps }, { seatDailyCaps: { codex: 0 } }))).toBe(0);
    });

  it('ignores malformed platform entries without overwriting valid restrictive tool entries', () => {
    expect(resolveProviderCap('codex', {}, reader({ seatDailyCaps: { codex: 0 } },
      { seatDailyCaps: { codex: 'invalid' } }))).toBe(0);
  });

  it.each(['unreadable', 'malformed JSON', 'scalar'])(
    'treats a %s tool layer as absent and preserves platform zero', failure => {
      const log = vi.fn();
      const read = options => readReviewSeatPolicy({ ...options, platform: { seatDailyCaps: { codex: 0 } }, log,
        readFile: () => {
          if (failure === 'unreadable') throw new Error('tool denied');
          return failure === 'malformed JSON' ? '{' : 'null';
        } });
      expect(resolveProviderCap('codex', {}, read)).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/codex=0.*platform/));
    });

  it.each(['unreadable', 'malformed'])(
    'treats a %s platform layer as absent and preserves tool zero', failure => {
      const read = options => readReviewSeatPolicy({ ...options, log: vi.fn(), readFile: path => {
        if (String(path).endsWith('review.json')) return JSON.stringify({ seatDailyCaps: { codex: 0 } });
        if (failure === 'unreadable') throw new Error('platform denied');
        return JSON.stringify({ review: null });
      } });
      expect(resolveProviderCap('codex', {}, read)).toBe(0);
    });

  it('preserves valid platform preferences when another platform file is unreadable', () => {
    const read = options => readReviewSeatPolicy({ ...options, log: vi.fn(), readFile: path => {
      if (String(path).endsWith('review.json')) return '{}';
      if (String(path).endsWith('delivery-priority-settings.json')) return JSON.stringify({ review: { seatDailyCaps: { codex: 0 } } });
      throw new Error('other platform file denied');
    } });
    expect(resolveProviderCap('codex', {}, read)).toBe(0);
  });

  it('uses the restrictive default when every settings layer is unreadable', () => {
    const log = vi.fn();
    const read = options => readReviewSeatPolicy({ ...options, log, readFile: () => { throw new Error('denied'); } });
    expect(resolveProviderCap('codex', {}, read)).toBe(80);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/codex=80.*standard/));
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] }, read)).toBe(0);
  });

  it('retains an explicit valid Gemini platform cap when the tool layer is unreadable', () => {
    const read = options => readReviewSeatPolicy({ ...options, platform: { seatDailyCaps: { 'agy-gemini': 30 } },
      log: vi.fn(), readFile: () => { throw new Error('tool denied'); } });
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] }, read)).toBe(30);
  });

  it('resolves standard, platform, tool, own env and legacy env in order', () => {
    expect(resolveProviderCap('codex', {}, reader())).toBe(80);
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

  it('warns and skips malformed leaves while retaining valid platform limits', () => {
    const read = reader({ seatDailyCaps: { codex: -1, 'agy-claude': Number.MAX_SAFE_INTEGER + 1 } },
      { seatDailyCaps: { codex: 17, 'agy-claude': 'invalid' } });
    expect(resolveProviderCap('codex', { WE_REVIEW_SEAT_CAP_CODEX: 'invalid' }, read)).toBe(17);
    expect(resolveProviderCap('agy-claude', {}, read)).toBe(10);
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
    expect(resolveProviderCap('codex', {}, unreadable)).toBe(80);
    expect(resolveProviderCap('codex', { WE_REVIEW_SEAT_CAP_CODEX: '8' }, unreadable)).toBe(8);
    expect(resolveProviderCap('codex', {}, reader({ seatDailyCaps: { codex: { nested: 3 } } }))).toBe(80);
    expect(redTeamRouteByBuilder({}, reader({ redTeam: { routeByBuilder: { nested: false } } }))).toBe(true);
  });

  it('retains routing enable/disable and explicit env zero semantics', () => {
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] }, reader())).toBe(300);
    expect(resolveRoutingProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '0' }, { enabledProviders: ['agy-gemini'] }, reader())).toBe(0);
    expect(resolveRoutingProviderCap('codex', {}, { disabledProviders: ['codex'] }, reader())).toBe(0);
  });

  it('resolves Gemini routing caps live without re-enabling an explicit settings zero', () => {
    const platform = { seatDailyCaps: { 'agy-gemini': 30 } };
    const tool = { seatDailyCaps: {} };
    const read = reader(tool, platform);
    const entry = { enabledProviders: ['agy-gemini'] };
    expect(resolveRoutingProviderCap('agy-gemini', {}, entry, reader())).toBe(300);
    expect(resolveRoutingProviderCap('agy-gemini', {}, entry, read)).toBe(30);
    tool.seatDailyCaps['agy-gemini'] = 0;
    expect(resolveRoutingProviderCap('agy-gemini', {}, entry, read)).toBe(0);
    expect(resolveRoutingProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '7' }, entry, read)).toBe(7);
    delete tool.seatDailyCaps['agy-gemini'];
    platform.seatDailyCaps['agy-gemini'] = 40;
    expect(resolveRoutingProviderCap('agy-gemini', {}, entry, read)).toBe(40);
  });

  it.each(['unreadable', 'malformed JSON', 'scalar', 'malformed leaf', 'malformed block', 'unreadable platform', 'malformed platform'])(
    'warns loudly and never enables default-disabled Gemini with %s settings', failure => {
      const log = vi.fn();
      const readFile = path => {
        if (String(path).endsWith('review.json')) {
          if (failure === 'unreadable') throw new Error('unreadable');
          if (failure === 'malformed JSON') return '{';
          if (failure === 'scalar') return 'null';
          if (failure === 'malformed block') return JSON.stringify({ seatDailyCaps: null });
          if (failure === 'malformed leaf') return JSON.stringify({ seatDailyCaps: { 'agy-gemini': 'invalid' } });
          return '{}';
        }
        if (failure === 'malformed platform') return JSON.stringify({ review: null });
        if (failure === 'unreadable platform') throw new Error('platform denied');
        return JSON.stringify({ review: { seatDailyCaps: { 'agy-gemini': 0 } } });
      };
      const read = options => readReviewSeatPolicy({ ...options, readFile, log });
      expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] }, read)).toBe(0);
      expect(log.mock.calls.some(([line]) => /WARNING.*repo default/.test(line))).toBe(true);
    });

  it('an explicit platform zero also defeats enabledProviders', () => {
    expect(resolveRoutingProviderCap('agy-gemini', {}, { enabledProviders: ['agy-gemini'] },
      reader({}, { seatDailyCaps: { 'agy-gemini': 0 } }))).toBe(0);
  });

  it('defaults builder routing on and accepts platform/tool false with provenance', () => {
    const lines = [];
    expect(redTeamRouteByBuilder({}, reader())).toBe(true);
    expect(redTeamRouteByBuilder({}, reader({}, { redTeam: { routeByBuilder: false } }))).toBe(false);
    expect(redTeamRouteByBuilder({}, () => ({ tool: { redTeam: { routeByBuilder: false } }, platform: {}, log: line => lines.push(line) }))).toBe(false);
    expect(lines[0]).toMatch(/routeByBuilder=false.*tool/);
  });
});
