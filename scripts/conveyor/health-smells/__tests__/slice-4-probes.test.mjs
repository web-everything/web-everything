/**
 * @file scripts/conveyor/health-smells/__tests__/slice-4-probes.test.mjs
 * @description #4066 — the IO probes behind the queue and host smells (`health-watch.mjs`): the widened `probePrs`
 *   record, `probePrLimit`, `probeAppToken` (expiry only, never the token), `probeRestBudget`; and a whole fixture
 *   `tick()` that feeds the App-token and REST-budget fixtures through the real registry and opens the episode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probePrs, probePrLimit, probeLanePools, probeAppToken, probeRestBudget, tick, healthDir } from '../../health-watch.mjs';
import { emptyLimitState, setGlobalOff } from '../../../lib/pr-limit.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hw-slice4-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('probePrs — the fields the queue smells read', () => {
  it('asks gh for mergeable + comments and keeps only body/createdAt/author.login/viewerDidAuthor of each comment', () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push(args);
      return JSON.stringify([{
        number: 7, title: 'x', headRefName: 'lane/x', labels: [{ name: 'review:pending', color: 'x' }], statusCheckRollup: [], updatedAt: 't', mergeable: 'MERGEABLE',
        comments: [{ body: 'hi', createdAt: 'c', author: { login: 'chalbert', id: 1 }, viewerDidAuthor: false, url: 'u', reactionGroups: [] }],
      }]);
    };
    const out = probePrs({ exec });
    expect(calls[0].at(-1)).toContain('mergeable,comments');
    expect(out[0].mergeable).toBe('MERGEABLE');
    expect(out[0].comments).toEqual([{ body: 'hi', createdAt: 'c', author: { login: 'chalbert' }, viewerDidAuthor: false }]);
    expect(calls.map((args) => args[args.indexOf('--repo') + 1])).toEqual([
      'web-everything/web-everything', 'frontier-ui/frontierui', 'plateauapp/plateau-app',
    ]);
  });
});

describe('probeLanePools', () => {
  it('ignores stale logs for a capabilityless repo while reading capable pool health', () => {
    for (const key of ['we', 'frontierui', 'plateau-app', 'longshore']) {
      writeFileSync(join(dir, `lane-pool-health-watch-${key}.log`), '{"checked":true,"health":{"free":2}}\n');
    }
    expect(probeLanePools(dir).map((row) => row.repo)).toEqual(['we', 'frontierui', 'plateau-app']);
  });
});

describe('probePrLimit', () => {
  it('reads each repo cap through pr-limit (env override respected) and the global-off state', () => {
    expect(probePrLimit({ env: {}, readState: emptyLimitState })).toEqual({ limits: { we: 15, frontierui: 5, 'plateau-app': 5 }, globalOff: false });
    expect(probePrLimit({ env: { WE_PR_LIMIT_WE: '40' }, readState: emptyLimitState }).limits.we).toBe(40);
    const off = setGlobalOff(emptyLimitState(), { reason: 'r', untilMs: 3_600_000 }, Date.parse('2026-09-29T11:30:00Z'));
    expect(probePrLimit({ env: {}, readState: () => off, nowMs: Date.parse('2026-09-29T12:00:00Z') }).globalOff).toBe(true);
    // an expired off auto-re-arms
    expect(probePrLimit({ env: {}, readState: () => off, nowMs: Date.parse('2026-09-29T13:00:00Z') }).globalOff).toBe(false);
    expect(probePrLimit({ env: { WE_PR_LIMIT_OFF: '1' }, readState: emptyLimitState }).globalOff).toBe(true);
  });
});

describe('probeAppToken', () => {
  it('returns only the expiry — the token never leaves the file', () => {
    const p = join(dir, 'cache.json');
    writeFileSync(p, JSON.stringify({ v: 2, token: 'ghs_SECRETSECRETSECRET', expiresAt: '2026-09-29T12:05:37Z' }));
    const out = probeAppToken({ path: p });
    expect(out).toEqual({ present: true, expiresAt: '2026-09-29T12:05:37Z' });
    expect(JSON.stringify(out)).not.toContain('ghs_');
  });

  it('no cache = App not configured; a torn cache reads as present with no expiry', () => {
    expect(probeAppToken({ path: join(dir, 'missing.json') })).toEqual({ present: false });
    const p = join(dir, 'torn.json');
    writeFileSync(p, '{"v":2,"tok');
    expect(probeAppToken({ path: p })).toEqual({ present: true, expiresAt: null });
  });
});

describe('probeRestBudget', () => {
  it('shells `gh api rate_limit --jq .resources.core` and keeps limit/used/remaining/reset', () => {
    const calls = [];
    const out = probeRestBudget({ exec: (cmd, args) => { calls.push([cmd, ...args]); return '{"limit":5000,"used":4700,"remaining":300,"reset":1790000000}'; } });
    expect(calls[0]).toEqual(['gh', 'api', 'rate_limit', '--jq', '.resources.core']);
    expect(out).toEqual({ limit: 5000, used: 4700, remaining: 300, reset: 1790000000 });
  });
});

describe('tick() — the App-token / REST fixtures reach github-app-token through the real registry', () => {
  function base(n) {
    for (const d of ['logs', 'locks', 'sync']) mkdirSync(join(dir, `${d}-${n}`), { recursive: true });
    return { 'logs-dir': join(dir, `logs-${n}`), 'lock-root': join(dir, `locks-${n}`), 'self-sync-dir': join(dir, `sync-${n}`), 'state-root': join(dir, `state-${n}`), 'no-gh': true, 'no-diagnose': true, 'no-investigate': true, 'no-file': true };
  }

  it('an expired cache and a drained REST bucket open both subjects in one fixture tick', async () => {
    const cache = join(dir, 'cache.json');
    writeFileSync(cache, JSON.stringify({ v: 2, token: 'ghs_x', expiresAt: '2026-09-29T11:00:00Z' }));
    const rest = join(dir, 'rest.json');
    writeFileSync(rest, JSON.stringify({ limit: 5000, used: 4900, remaining: 100, reset: 1790000000 }));
    const summary = await tick({ ...base(1), now: '2026-09-29T12:00:00Z', 'app-token-cache': cache, 'rest-budget-fixture': rest });
    const opened = summary.transitions.filter((t) => t.key.startsWith('github-app-token::')).map((t) => t.key).sort();
    expect(opened).toEqual(['github-app-token::app-token', 'github-app-token::rest-core']);
    const state = readFileSync(join(healthDir(join(dir, 'state-1')), 'state.json'), 'utf8');
    expect(state).not.toContain('ghs_x');
  });

  it('a fixture tick with no --app-token-cache never reads the host cache (no token subject at all)', async () => {
    const summary = await tick({ ...base(2), now: '2026-09-29T12:00:00Z' });
    expect(summary.transitions.filter((t) => t.key.startsWith('github-app-token::'))).toEqual([]);
  });
});
