/** Hermetic IO fixtures: report-only, no actions, no GitHub writes. */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runTick, DEFAULT_CLAIM_TTL_MIN } from '../assistant-babysit-pass.mjs';

const nowMs = Date.parse('2026-01-01T12:00:00Z');
const old = '2026-01-01T10:00:00Z';
const missing = () => Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
function fixture() {
  const files = new Map();
  const calls = [];
  const pr = { number: 1, labels: [{ name: 'review:changes' }], isDraft: false, mergeable: 'MERGEABLE',
    headRefOid: 'abc', updatedAt: old, statusCheckRollup: [] };
  const world = { files, calls, prs: [pr], events: [], commitDate: old, why: { verdict: { owner: 'fix operator', waitingFor: 'capacity', sections: [{ name: 'daemons', lines: ['review: idle', 'fix: waiting | capacity'] }] } }, claims: [] };
  world.io = {
    mkdirSync() {},
    existsSync: (path) => path === 'why.mjs',
    readdirSync: () => world.claims.map((_, index) => String(index)),
    readFileSync(path) {
      if (files.has(path)) return files.get(path);
      const index = /fix-dispatch-claims[/\\](\d+)[/\\]lock.json$/.exec(path)?.[1];
      if (index !== undefined) return JSON.stringify(world.claims[Number(index)]);
      throw missing();
    },
    writeFileSync: (path, data) => files.set(path, data),
    appendFileSync: (path, data) => files.set(path, (files.get(path) ?? '') + data),
  };
  world.exec = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'node') {
      if (world.why instanceof Error) throw world.why;
      return JSON.stringify(world.why);
    }
    if (args[0] === 'pr') return JSON.stringify(world.prs);
    if (args[1].includes('/events?')) {
      if (world.eventError) throw world.eventError;
      expect(args).toContain('--paginate');
      expect(args).toContain('--slurp');
      return JSON.stringify(world.eventPages ?? [world.events]);
    }
    if (args[1].includes('/commits/')) return world.commitDate;
    throw new Error('Unexpected command');
  };
  world.tick = (overrides = {}) => runTick({ repos: ['web-everything/web-everything'], outDir: 'output', nowMs, exec: world.exec, io: world.io, coordDir: 'coord', whyCli: 'why.mjs', env: { FIXTURE: 'yes' }, ...overrides });
  world.log = () => files.get(join('output', 'reports.jsonl')).trim().split('\n').map(JSON.parse);
  return world;
}

describe('report-only tick', () => {
  it('appends JSONL, writes digest, enriches why, and makes NO GitHub write call', () => {
    const w = fixture();
    const { summary, reports } = w.tick();
    expect(summary).toMatchObject({ open: 1, owing: 1, reports: 1, skipped: 0 });
    expect(reports[0]).toMatchObject({ rule: 'no-worker', owner: 'fix operator', waitingFor: 'capacity', fixLogLine: 'fix: waiting | capacity' });
    expect(w.log().map((line) => line.type)).toEqual(['report', 'tick']);
    expect(w.files.get(join('output', 'digest.md'))).toContain('| PR | rule | min | owner | reason | fix-log |');
    expect(w.files.get(join('output', 'digest.md'))).toContain('fix: waiting \\| capacity');
    const gh = w.calls.filter((call) => call.command === 'gh');
    expect(gh).toHaveLength(3);
    for (const { args, options } of gh) {
      expect(args[0] === 'api' || args.slice(0, 2).join(' ') === 'pr list').toBe(true);
      if (args[0] === 'api') {
        for (let index = 0; index < args.length; index++) {
          if (['-X', '--method'].includes(args[index])) expect(args[index + 1]).toBe('GET');
          if (/^(?:-X|--method)=/.test(args[index])) expect(args[index].split('=')[1]).toBe('GET');
        }
      }
      expect(options).toMatchObject({ timeout: 60000, maxBuffer: 32 * 1024 * 1024, env: { GH_CALLER: 'wev-assistant', FIXTURE: 'yes' } });
    }
    expect(gh[0].args).toEqual(['pr', 'list', '--repo', 'web-everything/web-everything', '--state', 'open', '--limit', '500', '--json', 'number,labels,isDraft,mergeable,headRefOid,updatedAt,statusCheckRollup']);
    expect(w.calls.at(-1)).toMatchObject({ command: 'node', args: ['why.mjs', 'why', '--pr=1', '--repo=web-everything/web-everything', '--json'], options: { timeout: 90000 } });
  });

  it('caches unchanged detail and dedupes reports for exactly 60 minutes while retaining digest', () => {
    const w = fixture();
    w.tick();
    w.calls.length = 0;
    w.tick({ nowMs: nowMs + 60 * 60000 - 1 });
    expect(w.calls.filter((c) => c.command === 'gh').map((c) => c.args[0])).toEqual(['pr']);
    expect(w.log().map((line) => line.type)).toEqual(['report', 'tick', 'tick']);
    expect(w.files.get(join('output', 'digest.md'))).toContain('no-worker');
    w.tick({ nowMs: nowMs + 60 * 60000 });
    expect(w.log().filter((line) => line.type === 'report')).toHaveLength(2);
    w.prs[0].updatedAt = '2026-01-01T11:00:00Z';
    w.calls.length = 0;
    w.tick();
    expect(w.calls.filter((c) => c.command === 'gh' && c.args[0] === 'api')).toHaveLength(1);
  });

  it('caps detail across repos, oldest first, and exposes skipped fallback', () => {
    const w = fixture();
    w.prs = [
      { ...w.prs[0], number: 2, updatedAt: '2026-01-01T11:00:00Z' },
      { ...w.prs[0], number: 1 },
    ];
    const { summary } = w.tick({ repos: ['org/first', 'org/second'], maxDetail: 1 });
    expect(summary).toMatchObject({ open: 4, owing: 4, skipped: 3 });
    expect(w.calls.filter((c) => c.command === 'gh').map((c) => c.args[0])).toEqual(['pr', 'pr', 'api', 'api']);
    expect(w.calls[2].args[1]).toContain('issues/1/events');
    expect(w.files.get(join('output', 'digest.md'))).toContain('Skipped PRs need operator inspection');
  });

  it.each([499, 500, 501])('flags truncation per repo and in the tick log and digest at %i open PRs', (count) => {
    const w = fixture();
    w.prs = Array.from({ length: count }, (_, index) => ({ ...w.prs[0], number: index + 1, labels: [] }));
    const exec = (command, args, options) => {
      const result = w.exec(command, args, options);
      return args[0] === 'pr' && args[3] === 'org/other' ? JSON.stringify(w.prs.slice(0, 1)) : result;
    };
    const { summary } = w.tick({ repos: ['org/many', 'org/other'], exec });
    expect(summary).toMatchObject({ open: count + 1, truncated: count >= 500, repoSummaries: [
      { repo: 'org/many', open: count, truncated: count >= 500 },
      { repo: 'org/other', open: 1, truncated: false },
    ] });
    expect(w.log().at(-1)).toEqual(summary);
    const digest = w.files.get(join('output', 'digest.md'));
    expect(digest.split('\n')[0].includes('TRUNCATED: some open PRs not seen')).toBe(count >= 500);
    if (count >= 500) expect(digest).toContain('operator inspection of the full open PR list: org/many.');
  });

  it('rotates 26 candidates with the default cap of 25 so the skipped PR is checked on tick 2', () => {
    const w = fixture();
    const repo = 'web-everything/web-everything';
    w.prs = Array.from({ length: 26 }, (_, index) => ({ ...w.prs[0], number: index + 1,
      updatedAt: new Date(Date.parse(old) + index * 1000).toISOString() }));
    expect(w.tick().summary).toMatchObject({ skipped: 1, reports: 25 });
    const firstState = JSON.parse(w.files.get(join('output', 'state.json')));
    expect(Object.keys(firstState.lastDetailAt)).toHaveLength(25);
    expect(firstState.lastDetailAt[JSON.stringify([repo, 26])]).toBeUndefined();
    w.calls.length = 0;
    expect(w.tick({ nowMs: nowMs + 60000 }).summary).toMatchObject({ skipped: 1, reports: 25 });
    const eventReads = w.calls.filter((c) => c.args[1]?.includes('/events?'));
    expect(eventReads).toHaveLength(1);
    expect(eventReads[0].args[1]).toContain('issues/26/events');
    expect(w.calls.find((c) => c.command === 'node').args).toContain('--pr=26');
    const secondState = JSON.parse(w.files.get(join('output', 'state.json')));
    expect(Object.keys(secondState.lastDetailAt)).toHaveLength(26);
    expect(secondState.lastDetailAt[JSON.stringify([repo, 26])]).toBe(nowMs + 60000);
    expect(secondState.lastDetailAt[JSON.stringify([repo, 25])]).toBe(nowMs);
  });

  it('rotates the shared detail budget across repos with the same PR number', () => {
    const w = fixture();
    const options = { repos: ['org/first', 'org/second'], maxDetail: 1 };
    w.tick(options);
    w.calls.length = 0;
    w.tick({ ...options, nowMs: nowMs + 60000 });
    expect(w.calls.find((c) => c.args[1]?.includes('/events?')).args[1]).toContain('repos/org/second/issues/1/events');
    expect(JSON.parse(w.files.get(join('output', 'state.json'))).lastDetailAt).toEqual({
      [JSON.stringify(['org/first', 1])]: nowMs,
      [JSON.stringify(['org/second', 1])]: nowMs + 60000,
    });
  });

  it('limits digest to 50 reports and defaults detail to 25', () => {
    const w = fixture();
    w.prs = Array.from({ length: 30 }, (_, index) => ({ ...w.prs[0], number: index + 1,
      labels: [{ name: 'review:changes' }, { name: 'ready-to-merge' }, { name: 'review:accepted' }] }));
    const { summary } = w.tick();
    expect(summary).toMatchObject({ skipped: 5, reports: 75 });
    expect(w.files.get(join('output', 'digest.md')).split('\n').filter((line) => line.startsWith('| web-'))).toHaveLength(50);
  });

  it.each(['we', 'web-everything', 'web-everything/web-everything'])('accepts live claim repo alias %s', (repo) => {
    const w = fixture();
    w.claims = [{ heartbeatAt: new Date(nowMs).toISOString(), meta: { repo, pr: 1, kind: 'fixing', claimedAt: '2026-01-01T11:55:00Z', headSha: 'abc', ttlMinutes: 10 } }];
    expect(w.tick().reports).toEqual([]);
    expect(w.calls.some((c) => c.command === 'node')).toBe(false);
  });

  it.each([
    ['missing', undefined], ['null', null], ['negative', -1], ['string', '10'], ['boolean', false],
    ['NaN', NaN], ['infinite', Infinity], ['object', {}],
  ])('defaults %s claim TTL to 20 minutes without aborting other PR reports', (_, ttlMinutes) => {
    const w = fixture();
    expect(DEFAULT_CLAIM_TTL_MIN).toBe(20);
    w.prs.push({ ...w.prs[0], number: 2 });
    w.claims = [{ heartbeatAt: new Date(nowMs - 20 * 60000).toISOString(), meta: {
      repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:30:00Z', headSha: 'abc', ttlMinutes,
    } }];
    expect(w.tick().reports.map((r) => [r.pr, r.rule])).toEqual([[2, 'no-worker']]);
    expect(w.log().at(-1)).toMatchObject({ type: 'tick', open: 2, reports: 1 });
    expect(w.tick({ nowMs: nowMs + 1 }).reports.map((r) => [r.pr, r.rule])).toEqual([[1, 'no-worker'], [2, 'no-worker']]);
  });

  it.each([0, 10, 30])('preserves a valid claim TTL of %i minutes', (ttlMinutes) => {
    const w = fixture();
    w.claims = [{ heartbeatAt: new Date(nowMs - ttlMinutes * 60000).toISOString(), meta: {
      repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:30:00Z', ttlMinutes,
    } }];
    expect(w.tick().reports).toEqual([]);
    expect(w.tick({ nowMs: nowMs + 1 }).reports.map((r) => r.rule)).toEqual(['no-worker']);
  });

  it.each([
    ['incomplete metadata', { meta: { kind: 'fix' } }],
    ['invalid repo', { meta: { kind: 'fix', repo: 123, pr: 1 } }],
    ['invalid PR', { meta: { kind: 'fix', repo: 'we', pr: 'bad' } }],
    ['invalid claim time', { heartbeatAt: old, meta: { kind: 'fix', repo: 'we', pr: 1, claimedAt: 'bad' } }],
    ['invalid heartbeat', { heartbeatAt: 'bad', meta: { kind: 'fix', repo: 'we', pr: 1, claimedAt: old } }],
    ['corrupt JSON', '{'],
    ['unreadable file', new Error('denied')],
  ])('skips one malformed claim (%s) while reading valid claims and reporting other PRs', (_, malformed) => {
    const w = fixture();
    w.prs.push({ ...w.prs[0], number: 2 });
    w.claims = [malformed, { heartbeatAt: new Date(nowMs).toISOString(), meta: {
      repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:55:00Z',
    } }];
    if (typeof malformed === 'string') w.files.set(join('coord', 'fix-dispatch-claims', '0', 'lock.json'), malformed);
    if (malformed instanceof Error) {
      const readFileSync = w.io.readFileSync;
      w.io.readFileSync = (path, ...args) => {
        if (path === join('coord', 'fix-dispatch-claims', '0', 'lock.json')) throw malformed;
        return readFileSync(path, ...args);
      };
    }
    expect(w.tick().reports.map((r) => [r.pr, r.rule])).toEqual([[2, 'no-worker']]);
    expect(w.log().at(-1)).toMatchObject({ type: 'tick', open: 2, reports: 1 });
    expect(w.files.get(join('output', 'digest.md'))).toContain('no-worker');
  });

  it('handles missing claims directory and absent why CLI', () => {
    const w = fixture();
    w.io.readdirSync = () => { throw missing(); };
    expect(w.tick({ whyCli: 'absent.mjs' }).reports[0].owner).toBe('fix daemon');
    expect(w.calls.some((c) => c.command === 'node')).toBe(false);
  });
  it('ignores unrelated claims and tolerates a failed why call', () => {
    const w = fixture();
    w.claims = [{ meta: { kind: 'review' } }];
    w.why = new Error('offline');
    expect(w.tick().reports[0]).toMatchObject({ owner: 'fix daemon' });
    expect(w.tick().reports[0].waitingFor).toBeUndefined();
  });
  it('uses the latest label event to defer time based reports', () => {
    const w = fixture();
    w.events = [{ event: 'labeled', created_at: old }, { event: 'unlabeled', created_at: '2026-01-01T11:59:00Z' }];
    expect(w.tick().reports).toEqual([]);
  });
  it.each(['review:changes', 'ready-to-merge'])('reads recent label changes after page one before reporting %s', (label) => {
    const w = fixture();
    w.prs[0].labels = [{ name: label }];
    w.eventPages = [
      Array.from({ length: 100 }, () => ({ event: 'labeled', created_at: old })),
      [{ event: 'unlabeled', created_at: '2026-01-01T11:59:00Z' }],
    ];
    expect(w.tick().reports).toEqual([]);
    expect(w.log().map((line) => line.type)).toEqual(['tick']);
    expect(w.calls.some((call) => call.command === 'node')).toBe(false);
  });
  it('invalidates persisted page-one label caches before classifying unchanged PRs', () => {
    const w = fixture();
    const key = JSON.stringify(['web-everything/web-everything', 1, old]);
    w.files.set(join('output', 'state.json'), JSON.stringify({ events: { [key]: Date.parse(old) }, heads: {}, lastReported: {} }));
    w.eventPages = [[], [{ event: 'labeled', created_at: '2026-01-01T11:59:00Z' }]];
    expect(w.tick().reports).toEqual([]);
    expect(w.calls.filter((call) => call.args.includes('--paginate'))).toHaveLength(1);
    expect(JSON.parse(w.files.get(join('output', 'state.json')))).toMatchObject({ labelEventsVersion: 2, lastDetailAt: {
      [JSON.stringify(['web-everything/web-everything', 1])]: nowMs,
    } });
  });
  it('reports a stale claim without owed-work or ready-to-merge labels', () => {
    const w = fixture();
    w.prs[0].labels = [];
    w.claims = [{ heartbeatAt: old, meta: { repo: 'we', pr: 1, kind: 'fix', claimedAt: old, headSha: 'abc', ttlMinutes: 10 } }];
    const { reports, summary } = w.tick();
    expect(summary.owing).toBe(0);
    expect(reports.map((report) => report.rule)).toEqual(['stale-claim']);
    expect(w.log()[0]).toMatchObject({ type: 'report', rule: 'stale-claim' });
  });
  it.each(['status:fixing', 'review-status:fixing'])('reports %s without a live claim or owed-work or ready-to-merge labels', (label) => {
    const w = fixture();
    w.prs[0].labels = [{ name: label }];
    const { reports, summary } = w.tick();
    expect(summary.owing).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ rule: 'contradiction', reason: `${label} + no live claim` });
  });
  it('reports review:human with a live fix claim without owed-work or ready-to-merge labels', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'review:human' }];
    w.claims = [{ heartbeatAt: new Date(nowMs).toISOString(), meta: { repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:55:00Z', headSha: 'abc', ttlMinutes: 10 } }];
    const { reports, summary } = w.tick();
    expect(summary.owing).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ rule: 'contradiction', reason: 'review:human + live fix claim' });
  });
  it('reports ready-stalled with only a ready-to-merge label', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'ready-to-merge' }];
    expect(w.tick().reports.map((report) => report.rule)).toEqual(['ready-stalled']);
  });
  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR'])('recognizes failing check %s', (state) => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'status:ci-red' }];
    w.prs[0].statusCheckRollup = [{ state }];
    expect(w.tick({ whyCli: null }).reports[0].owner).toBe('ci-heal');
  });
  it('does not request details or why for nonowing, nonready PRs', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'status:ci-red' }];
    expect(w.tick().reports).toEqual([]);
    expect(w.calls).toHaveLength(1);
  });

  it.each([
    ['unreadable claims', (w) => { w.io.readdirSync = () => { throw new Error('denied'); }; }],
    ['incomplete labels', (w) => { w.prs[0].labels = null; }],
    ['incomplete checks', (w) => { w.prs[0].statusCheckRollup = null; }],
    ['malformed events', (w) => { w.events = {}; }],
    ['malformed later event page', (w) => { w.eventPages = [[], {}]; }],
    ['failed paginated events', (w) => { w.eventError = new Error('page two failed'); }],
    ['oversized paginated events', (w) => { w.eventError = Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }); }],
    ['bad commit timestamp', (w) => { w.commitDate = 'unknown'; }],
    ['corrupt persisted state', (w) => { w.files.set(join('output', 'state.json'), '{'); }],
    ['invalid detail cap', () => {}, { maxDetail: -1 }],
  ])('fails closed without a clean digest: %s', (_, change, options) => {
    const w = fixture();
    change(w);
    expect(() => w.tick(options)).toThrow();
    expect(w.files.has(join('output', 'digest.md'))).toBe(false);
    expect(w.files.has(join('output', 'reports.jsonl'))).toBe(false);
  });
});
