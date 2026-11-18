/** Hermetic IO fixtures: report-only, no actions, no GitHub writes. */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runTick, DEFAULT_CLAIM_TTL_MIN } from '../assistant-babysit-pass.mjs';

const nowMs = Date.parse('2026-01-01T12:00:00Z');
const old = '2026-01-01T10:00:00Z';
const missing = () => Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
const makeClaim = (meta = {}, fields = {}) => ({ owner: 'fixer:test', heartbeatAt: new Date(nowMs).toISOString(),
  meta: { repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:55:00Z', ttlMinutes: 10, ...meta }, ...fields });
function fixture() {
  const files = new Map();
  const calls = [];
  const pr = { number: 1, isInMergeQueue: false, labels: [{ name: 'review:changes' }], isDraft: false, mergeable: 'MERGEABLE',
    headRefOid: 'abc', updatedAt: old, statusCheckRollup: [] };
  const world = { files, calls, required: ['checks', 'infra'], rules: [], prs: [pr], events: [], commitDate: old, why: { verdict: { owner: 'fix operator', waitingFor: 'capacity', sections: [{ name: 'daemons', lines: ['review: idle', 'fix: waiting | capacity'] }] } }, claims: [] };
  world.io = {
    mkdirSync() {},
    existsSync: (path) => path === 'why.mjs',
    readdirSync: () => world.claims.map((_, index) => String(index)),
    readFileSync(path) {
      if (files.has(path)) return files.get(path);
      const index = /fix-dispatch-claims[/\\](\d+)[/\\]lock.json$/.exec(path)?.[1];
      if (index !== undefined) {
        const claim = world.claims[Number(index)];
        if (claim instanceof Error) throw claim;
        return typeof claim === 'string' ? claim : JSON.stringify(claim && !('owner' in claim) ? { owner: 'fixer:test', ...claim } : claim);
      }
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
    if (args[1].includes('/protection/required_status_checks')) {
      if (world.required instanceof Error) throw world.required;
      return JSON.stringify(world.required);
    }
    if (args[1].includes('/rules/branches/main')) {
      if (world.rules instanceof Error) throw world.rules;
      return JSON.stringify(world.rules);
    }
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

describe('precision and explanation budgets', () => {
  const apiReads = (w) => w.calls.filter((c) => c.args[1]?.includes('/required_status_checks') || c.args[1]?.includes('/rules/branches/main'));
  it.each(['name', 'context'])('flags required red %s entries and ignores non-required red for reports and actions', (field) => {
    const w = fixture();
    w.prs[0].labels = [];
    w.prs[0].statusCheckRollup = [{ [field]: 'optional', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/org/repo/actions/runs/42' }];
    expect(w.tick().summary).toMatchObject({ reports: 0, wouldAct: 0 });
    w.prs[0].statusCheckRollup.push({ [field]: 'checks', conclusion: 'FAILURE' });
    expect(w.tick().reports.map((r) => r.rule)).toEqual(['gate-red-stalled']);
    expect(apiReads(w)).toHaveLength(2);
  });
  it('unions simultaneous classic and ruleset requirements so a ruleset-only red remains reportable and actionable', () => {
    const w = fixture();
    w.required = ['classic'];
    w.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ruleset' }, { context: 'classic' }] } }];
    w.prs[0].labels = [];
    w.prs[0].statusCheckRollup = [
      { name: 'classic', conclusion: 'SUCCESS' },
      { name: 'ruleset', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/org/repo/actions/runs/42' },
      { name: 'optional', conclusion: 'FAILURE' },
    ];
    const { reports, summary } = w.tick();
    expect(reports.map((report) => report.rule)).toEqual(['gate-red-stalled']);
    expect(summary.wouldAct).toBe(1);
    const decisions = w.files.get(join('output', 'actions.jsonl')).trim().split('\n').map(JSON.parse);
    expect(decisions[0]).toMatchObject({ action: 'rerun-failed', argv: ['gh', 'run', 'rerun', '42', '--failed', '--repo=web-everything/web-everything'] });
    expect(apiReads(w)).toHaveLength(2);
    expect(JSON.parse(w.files.get(join('output', 'state.json'))).requiredChecks['web-everything/web-everything'].names).toEqual(['classic', 'ruleset']);
    w.calls.length = 0;
    expect(w.tick({ nowMs: nowMs + 60000 }).reports[0].rule).toBe('gate-red-stalled');
    expect(apiReads(w)).toHaveLength(0);
  });
  it('refreshes persisted classic-only requirement caches before filtering required reds', () => {
    const w = fixture();
    w.files.set(join('output', 'state.json'), JSON.stringify({ requiredChecks: {
      'web-everything/web-everything': { at: nowMs, names: ['classic'] },
    } }));
    w.required = ['classic'];
    w.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ruleset' }] } }];
    w.prs[0].labels = [];
    w.prs[0].statusCheckRollup = [{ name: 'ruleset', conclusion: 'FAILURE' }];
    expect(w.tick().reports.map((report) => report.rule)).toEqual(['gate-red-stalled']);
    expect(apiReads(w)).toHaveLength(2);
    expect(JSON.parse(w.files.get(join('output', 'state.json'))).requiredChecks['web-everything/web-everything']).toMatchObject({ version: 2, names: ['classic', 'ruleset'] });
  });
  it.each([[], new Error('denied')])('reads rulesets after empty or failed protection evidence %j', (required) => {
    const w = fixture();
    w.required = required;
    w.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'checks' }] } }, { type: 'other' }];
    w.tick();
    expect(apiReads(w)).toHaveLength(2);
    expect(JSON.parse(w.files.get(join('output', 'state.json'))).requiredChecks['web-everything/web-everything'].names).toEqual(['checks']);
    expect(w.files.get(join('output', 'digest.md'))).not.toContain('required checks unavailable');
  });
  it.each([[], new Error('denied'), {}])('warns once per repo when required evidence is unavailable %j, including cached fallback', (value) => {
    const w = fixture();
    w.required = value;
    w.rules = value;
    w.prs[0].labels = [];
    w.prs[0].statusCheckRollup = [{ name: 'optional', conclusion: 'FAILURE' }];
    const warning = 'required checks unavailable for web-everything/web-everything; using all checks';
    expect(w.tick().reports[0].rule).toBe('gate-red-stalled');
    expect(w.files.get(join('output', 'digest.md')).split(warning)).toHaveLength(2);
    w.calls.length = 0;
    w.tick({ nowMs: nowMs + 60000 });
    expect(apiReads(w)).toHaveLength(0);
    expect(w.files.get(join('output', 'digest.md'))).toContain(warning);
  });
  it('refreshes required names at exactly 60 minutes', () => {
    const w = fixture();
    w.tick();
    w.calls.length = 0;
    w.tick({ nowMs: nowMs + 60 * 60000 - 1 });
    expect(apiReads(w)).toHaveLength(0);
    w.tick({ nowMs: nowMs + 60 * 60000 });
    expect(apiReads(w)).toHaveLength(2);
  });
  it('passes merge queue membership to rules while retaining contradictions and bad claims', () => {
    const w = fixture();
    w.prs[0].isInMergeQueue = true;
    w.prs[0].labels = [{ name: 'ready-to-merge' }, { name: 'review:changes' }];
    w.prs[0].statusCheckRollup = [{ name: 'checks', conclusion: 'FAILURE' }];
    w.claims = [makeClaim({ ttlMinutes: -1 })];
    expect(w.tick().reports.map((r) => r.rule)).toEqual(['bad-claim', 'contradiction']);
  });
  it.each([
    [{ autoMergeRequest: { enabledAt: old } }, false],
    [{ autoMergeRequest: { enabledAt: old }, mergeStateStatus: 'BLOCKED' }, false],
    [{ autoMergeRequest: { enabledAt: old }, mergeStateStatus: 'QUEUED' }, true],
    [{ autoMergeRequest: null, mergeStateStatus: 'QUEUED', labels: [{ name: 'status:ready-to-merge' }] }, true],
    [{ autoMergeRequest: null }, false],
  ])('falls back only when gh rejects the queue field: %j', (patch, queued) => {
    const w = fixture();
    Object.assign(w.prs[0], patch, { statusCheckRollup: [{ name: 'checks', conclusion: 'FAILURE' }] });
    delete w.prs[0].isInMergeQueue;
    const exec = (command, args, options) => {
      if (args[0] === 'pr' && args.at(-1).includes('isInMergeQueue')) throw new Error('Unknown JSON field: "isInMergeQueue"');
      return w.exec(command, args, options);
    };
    const result = w.tick({ exec });
    expect(result.reports.some((r) => ['no-worker', 'gate-red-stalled'].includes(r.rule))).toBe(!queued);
    expect(w.calls.find((c) => c.args[0] === 'pr').args.at(-1)).toContain('autoMergeRequest');
  });
  it('does not turn an unrelated PR-list failure into a fallback read', () => {
    const w = fixture();
    let attempts = 0;
    expect(() => w.tick({ exec: () => { attempts++; throw new Error('offline'); } })).toThrow('offline');
    expect(attempts).toBe(1);
  });
  it.each([
    ['no-worker', ['review:changes']],
    ['gate-red-stalled', []],
    ['ready-stalled', ['ready-to-merge']],
  ])('older-gh auto-merge intent without queue membership retains %s with required checks red', (rule, labels) => {
    const w = fixture();
    Object.assign(w.prs[0], { autoMergeRequest: { enabledAt: old }, mergeStateStatus: 'BLOCKED',
      labels: labels.map((name) => ({ name })), statusCheckRollup: [{ name: 'checks', conclusion: 'FAILURE' }] });
    delete w.prs[0].isInMergeQueue;
    const exec = (command, args, options) => {
      if (args[0] === 'pr' && args.at(-1).includes('isInMergeQueue')) throw new Error('Unknown JSON field: "isInMergeQueue"');
      return w.exec(command, args, options);
    };
    expect(w.tick({ exec }).reports.map((report) => report.rule)).toContain(rule);
  });
  it('reuses why on tick two, refreshes at 30 minutes, and refreshes for a new head', () => {
    const w = fixture();
    w.tick();
    w.calls.length = 0;
    expect(w.tick({ nowMs: nowMs + 30 * 60000 - 1 }).reports[0].fixLogLine).toBe('fix: waiting | capacity');
    expect(w.calls.filter((c) => c.command === 'node')).toHaveLength(0);
    w.tick({ nowMs: nowMs + 30 * 60000 });
    expect(w.calls.filter((c) => c.command === 'node')).toHaveLength(1);
    w.prs[0].headRefOid = 'def';
    w.tick({ nowMs: nowMs + 30 * 60000 + 1 });
    expect(w.calls.filter((c) => c.command === 'node')).toHaveLength(2);
  });
  it('caps fresh why calls at six, retains reports, and prioritizes missing then oldest caches across repos', () => {
    const w = fixture();
    w.prs = Array.from({ length: 8 }, (_, index) => ({ ...w.prs[0], number: index + 1 }));
    expect(w.tick({ repos: ['org/one', 'org/two'] }).summary).toMatchObject({ reports: 16, whySkipped: 10 });
    expect(w.calls.filter((c) => c.command === 'node')).toHaveLength(6);
    expect(w.files.get(join('output', 'digest.md'))).toContain('whySkipped: 10');
    w.calls.length = 0;
    w.tick({ repos: ['org/one', 'org/two'], nowMs: nowMs + 60000, maxWhy: 1 });
    expect(w.calls.filter((c) => c.command === 'node').map((c) => c.args[2])).toEqual(['--pr=4']);
    const state = JSON.parse(w.files.get(join('output', 'state.json')));
    state.whyCache = Object.fromEntries(w.prs.map((pr) => [`org/one#${pr.number}@abc`, { at: nowMs - pr.number * 60000, verdict: { owner: 'operator' } }]));
    w.files.set(join('output', 'state.json'), JSON.stringify(state));
    w.calls.length = 0;
    w.tick({ repos: ['org/one'], nowMs: nowMs + 60 * 60000, maxWhy: 1 });
    expect(w.calls.filter((c) => c.command === 'node').map((c) => c.args[2])).toEqual(['--pr=8']);
  });
  it('allows a zero why budget and counts failed calls against the cap', () => {
    const w = fixture();
    expect(w.tick({ maxWhy: 0 }).summary.whySkipped).toBe(1);
    expect(w.calls.some((c) => c.command === 'node')).toBe(false);
    w.prs.push({ ...w.prs[0], number: 2 });
    w.why = new Error('timeout');
    expect(w.tick({ maxWhy: 1 }).summary).toMatchObject({ reports: 2, whySkipped: 1 });
    expect(w.calls.filter((c) => c.command === 'node')).toHaveLength(1);
  });
});

describe('report-only tick', () => {
  it('appends JSONL, writes digest, enriches why, and makes NO GitHub write call', () => {
    const w = fixture();
    const { summary, reports } = w.tick();
    expect(summary).toMatchObject({ open: 1, owing: 1, reports: 1, badClaims: 0, skipped: 0 });
    expect(reports[0]).toMatchObject({ rule: 'no-worker', owner: 'fix operator', waitingFor: 'capacity', fixLogLine: 'fix: waiting | capacity' });
    expect(w.log().map((line) => line.type)).toEqual(['report', 'tick']);
    expect(w.files.get(join('output', 'digest.md'))).toContain('| PR | rule | min | owner | reason | fix-log |');
    expect(w.files.get(join('output', 'digest.md'))).toContain('fix: waiting \\| capacity');
    const gh = w.calls.filter((call) => call.command === 'gh');
    expect(gh).toHaveLength(5);
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
    expect(gh[0].args).toEqual(['pr', 'list', '--repo', 'web-everything/web-everything', '--state', 'open', '--limit', '500', '--json', 'number,labels,isDraft,mergeable,mergeStateStatus,headRefOid,updatedAt,statusCheckRollup,isInMergeQueue']);
    expect(w.calls.at(-1)).toMatchObject({ command: 'node', args: ['why.mjs', 'why', '--pr=1', '--repo=web-everything/web-everything', '--json'], options: { timeout: 20000 } });
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
    w.tick({ nowMs: nowMs + 60 * 60000 + 1 });
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
    expect(w.calls.filter((c) => c.command === 'gh').map((c) => c.args[0])).toEqual(['pr', 'api', 'api', 'pr', 'api', 'api', 'api', 'api']);
    expect(w.calls[6].args[1]).toContain('issues/1/events');
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
    ['missing', undefined], ['null', null],
  ])('defaults %s claim TTL to 10 minutes without aborting other PR reports', (_, ttlMinutes) => {
    const w = fixture();
    expect(DEFAULT_CLAIM_TTL_MIN).toBe(10);
    w.prs.push({ ...w.prs[0], number: 2 });
    w.claims = [{ heartbeatAt: new Date(nowMs - 5 * 60000).toISOString(), meta: {
      repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:30:00Z', headSha: 'abc', ttlMinutes,
    } }];
    expect(w.tick().reports.map((r) => [r.pr, r.rule])).toEqual([[2, 'no-worker']]);
    expect(w.log().at(-1)).toMatchObject({ type: 'tick', open: 2, reports: 1, badClaims: 0 });
    expect(w.tick({ nowMs: nowMs + 6 * 60000 }).reports.map((r) => [r.pr, r.rule])).toEqual([[1, 'no-worker'], [2, 'no-worker']]);
  });

  it.each([10, 30])('preserves a valid claim TTL of %i minutes', (ttlMinutes) => {
    const w = fixture();
    w.claims = [{ heartbeatAt: new Date(nowMs - ttlMinutes * 60000).toISOString(), meta: {
      repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:30:00Z', ttlMinutes,
    } }];
    expect(w.tick().reports).toEqual([]);
    expect(w.tick({ nowMs: nowMs + 1 }).reports.map((r) => r.rule)).toEqual(['no-worker']);
  });

  it.each([
    ['negative ttl', makeClaim({ ttlMinutes: -1 }), 'Invalid ttlMinutes', true],
    ['zero ttl', makeClaim({ ttlMinutes: 0 }), 'Invalid ttlMinutes', true],
    ['numeric string ttl', makeClaim({ ttlMinutes: '10' }), 'Invalid ttlMinutes', true],
    ['non-number string ttl', makeClaim({ ttlMinutes: 'bad' }), 'Invalid ttlMinutes', true],
    ['boolean ttl', makeClaim({ ttlMinutes: false }), 'Invalid ttlMinutes', true],
    ['object ttl', makeClaim({ ttlMinutes: {} }), 'Invalid ttlMinutes', true],
    ['infinite ttl', JSON.stringify(makeClaim()).replace('"ttlMinutes":10', '"ttlMinutes":1e400'), 'Invalid ttlMinutes', true],
    ['NaN ttl JSON', JSON.stringify(makeClaim()).replace('"ttlMinutes":10', '"ttlMinutes":NaN'), 'Invalid claim JSON', false],
    ['missing owner', makeClaim({}, { owner: undefined }), 'Missing or invalid owner', true],
    ['missing metadata', {},'Missing or invalid meta.repo', false],
    ['missing repo', makeClaim({ repo: undefined }), 'Missing or invalid meta.repo', false],
    ['invalid repo', makeClaim({ repo: 123 }), 'Missing or invalid meta.repo', false],
    ['missing PR', makeClaim({ pr: undefined }), 'Missing or invalid meta.pr', false],
    ['invalid PR', makeClaim({ pr: 'bad' }), 'Missing or invalid meta.pr', false],
    ['invalid kind', makeClaim({ kind: 7 }), 'Missing or invalid meta.kind', true],
    ['invalid claim time', makeClaim({ claimedAt: 'bad' }), 'Invalid claimedAt', true],
    ['missing claim time', makeClaim({ claimedAt: undefined }), 'Invalid claimedAt', true],
    ['invalid heartbeat', makeClaim({}, { heartbeatAt: 'bad' }), 'Invalid heartbeatAt', true],
    ['NaN heartbeat', makeClaim({}, { heartbeatAt: NaN }), 'Invalid heartbeatAt', true],
    ['missing heartbeat', makeClaim({}, { heartbeatAt: undefined }), 'Invalid heartbeatAt', true],
    ['bad JSON', '{', 'Invalid claim JSON', false],
    ['unreadable file', new Error('denied'), 'Unreadable claim: denied', false],
    ['disappeared file', missing(), 'Unreadable claim: ENOENT', false],
  ])('fails closed for an owed PR with %s: surfaces bad claim and still reports no-worker without aborting other PRs', (_, malformed, problem, attributed) => {
    const w = fixture();
    w.prs.push({ ...w.prs[0], number: 2 });
    w.claims = [malformed];
    const { summary, reports, badClaims } = w.tick();
    expect(badClaims).toHaveLength(1);
    expect(badClaims[0]).toMatchObject({ path: join('fix-dispatch-claims', '0', 'lock.json'), problem });
    if (attributed) expect(badClaims[0]).toMatchObject({ repo: 'we', pr: 1 });
    expect(reports.filter((r) => r.rule === 'bad-claim')).toEqual(attributed ? [expect.objectContaining({
      repo: 'web-everything/web-everything', pr: 1, rule: 'bad-claim', reason: problem,
    })] : []);
    expect(reports.filter((r) => r.rule === 'no-worker').map((r) => r.pr)).toEqual([1, 2]);
    expect(summary).toMatchObject({ open: 2, reports: attributed ? 3 : 2, badClaims: 1 });
    expect(w.log().at(-1)).toEqual(summary);
    const digest = w.files.get(join('output', 'digest.md'));
    expect(digest.split('| PR |')[0]).toContain('badClaims: 1');
    expect(digest.split('| PR |')[0]).toContain(problem);
    expect(digest).toContain('no-worker');
  });

  it('continues reading valid claims after a malformed claim without counting it as a worker', () => {
    const w = fixture();
    w.prs.push({ ...w.prs[0], number: 2 });
    w.claims = [makeClaim({ ttlMinutes: -1 }), makeClaim({ ttlMinutes: undefined })];
    const { reports, summary } = w.tick();
    expect(summary.badClaims).toBe(1);
    expect(reports.map((r) => [r.pr, r.rule])).toEqual([[1, 'bad-claim'], [2, 'no-worker']]);
  });

  it.each(['we', 'web-everything', 'web-everything/web-everything'])('dedupes bad-claim reports for repo alias %s once per PR per tick and for 60 minutes in JSONL', (repo) => {
    const w = fixture();
    w.claims = [makeClaim({ repo, ttlMinutes: -1 }), makeClaim({ repo, claimedAt: 'bad' })];
    const { reports, summary } = w.tick();
    expect(summary.badClaims).toBe(2);
    expect(reports.filter((r) => r.rule === 'bad-claim')).toHaveLength(1);
    expect(reports.filter((r) => r.rule === 'no-worker')).toHaveLength(1);
    expect(w.tick({ nowMs: nowMs + 60 * 60000 - 1 }).reports.filter((r) => r.rule === 'bad-claim')).toHaveLength(1);
    expect(w.log().filter((r) => r.rule === 'bad-claim')).toHaveLength(1);
    expect(w.files.get(join('output', 'digest.md'))).toContain('bad-claim');
    w.tick({ nowMs: nowMs + 60 * 60000 });
    expect(w.log().filter((r) => r.rule === 'bad-claim')).toHaveLength(2);
  });

  it('bounds digest problems to 10 and exposes the full count and operator fallback', () => {
    const w = fixture();
    w.claims = Array.from({ length: 12 }, () => '{');
    const { summary, badClaims } = w.tick();
    expect(summary.badClaims).toBe(12);
    expect(badClaims).toHaveLength(12);
    expect(w.log().at(-1).badClaims).toBe(12);
    const header = w.files.get(join('output', 'digest.md')).split('| PR |')[0];
    expect(header).toContain('badClaims: 12');
    expect(header).toContain('inspect claim files');
    expect(header.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(10);
    expect(header).not.toContain(join('fix-dispatch-claims', '10', 'lock.json'));
  });

  it('reports named bad claims despite exhausted detail budget or absence from the PR list', () => {
    const w = fixture();
    w.claims = [makeClaim({ ttlMinutes: -1 }), makeClaim({ pr: 99, ttlMinutes: 0 }),
      makeClaim({ repo: 'org/other', ttlMinutes: -1 })];
    const { summary, reports } = w.tick({ maxDetail: 0 });
    expect(summary).toMatchObject({ badClaims: 3, reports: 3, skipped: 1 });
    expect(reports.map((r) => [r.repo, r.pr, r.rule])).toEqual([
      ['web-everything/web-everything', 1, 'bad-claim'], ['web-everything/web-everything', 99, 'bad-claim'], ['org/other', 1, 'bad-claim'],
    ]);
    expect(w.calls.map((c) => c.args.slice(0, 2))).toEqual([['pr', 'list'], ['api', 'repos/web-everything/web-everything/branches/main/protection/required_status_checks'], ['api', 'repos/web-everything/web-everything/rules/branches/main']]);
  });

  it('handles missing claims directory and absent why CLI', () => {
    const w = fixture();
    w.io.readdirSync = () => { throw missing(); };
    expect(w.tick({ whyCli: 'absent.mjs' }).reports[0].owner).toBe('fix daemon');
    expect(w.calls.some((c) => c.command === 'node')).toBe(false);
  });
  it('ignores unrelated claims and tolerates a failed why call', () => {
    const w = fixture();
    w.claims = [makeClaim({ kind: 'review' })];
    w.why = new Error('offline');
    expect(w.tick().reports[0]).toMatchObject({ owner: 'fix daemon' });
    expect(w.tick().reports[0].waitingFor).toBeUndefined();
    expect(w.log().at(-1).badClaims).toBe(0);
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
  it('does not report review:human with a live fix claim (normal state)', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'review:human' }];
    w.claims = [{ heartbeatAt: new Date(nowMs).toISOString(), meta: { repo: 'we', pr: 1, kind: 'fix', claimedAt: '2026-01-01T11:55:00Z', headSha: 'abc', ttlMinutes: 10 } }];
    const { reports, summary } = w.tick();
    expect(summary.owing).toBe(0);
    expect(reports).toHaveLength(0);
  });
  it('reports ready-stalled with only a ready-to-merge label', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'ready-to-merge' }];
    expect(w.tick().reports.map((report) => report.rule)).toEqual(['ready-stalled']);
  });
  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR'])('recognizes failing check %s', (state) => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'status:ci-red' }];
    w.prs[0].statusCheckRollup = [{ context: 'checks', state }];
    expect(w.tick({ whyCli: null }).reports[0].owner).toBe('ci-heal');
  });
  it('does not request details or why for nonowing, nonready PRs', () => {
    const w = fixture();
    w.prs[0].labels = [{ name: 'status:ci-red' }];
    expect(w.tick().reports).toEqual([]);
    expect(w.calls).toHaveLength(3);
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
    ['invalid why cap', () => {}, { maxWhy: -1 }],
    ['missing queue evidence', (w) => { delete w.prs[0].isInMergeQueue; }],
  ])('fails closed without a clean digest: %s', (_, change, options) => {
    const w = fixture();
    change(w);
    expect(() => w.tick(options)).toThrow();
    expect(w.files.has(join('output', 'digest.md'))).toBe(false);
    expect(w.files.has(join('output', 'reports.jsonl'))).toBe(false);
  });
});


describe('shadow action log', () => {
  it('reads why for human-owned owed work before the report threshold', () => {
    const w = fixture();
    w.prs[0].labels.push({ name: 'review:human' });
    w.commitDate = '2026-01-01T11:59:00Z';
    expect(w.tick().reports).toEqual([]);
    expect(w.calls.some((c) => c.command === 'node')).toBe(true);
  });
  it('uses why suggestedOp for rearm without a matching log line', () => {
    const w = fixture();
    w.why.verdict.suggestedOp = 'rearm';
    expect(w.tick().summary.wouldAct).toBe(1);
  });
  const actionLog = (w) => (w.files.get(join('output', 'actions.jsonl')) ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  const rearming = () => {
    const w = fixture();
    w.why.verdict.sections[0].lines = ['fix: refused at cap'];
    return w;
  };
  it('logs would-act once per head, migrates old state, and logs again for a new head', () => {
    const w = rearming();
    expect(w.tick().summary).toMatchObject({ wouldAct: 1, escalated: 0 });
    expect(w.tick().summary).toMatchObject({ wouldAct: 0, escalated: 1 });
    expect(w.tick().summary).toMatchObject({ wouldAct: 0, escalated: 0 });
    expect(actionLog(w)).toEqual([expect.objectContaining({ type: 'would-act', mode: 'shadow', action: 'rearm', head: 'abc',
      argv: ['node', 'scripts/operations/run.mjs', 'rearm', '--pr=1', '--repo=web-everything/web-everything'] }), expect.objectContaining({ type: 'escalate', reason: 'action already recorded for this head; condition persists', logLine: 'fix: refused at cap' })]);
    w.prs[0].headRefOid = 'def';
    expect(w.tick().summary.wouldAct).toBe(1);
    expect(actionLog(w).filter((line) => line.type === 'would-act').map((line) => line.head)).toEqual(['abc', 'def']);
    expect(w.files.get(join('output', 'digest.md'))).toContain('## Would act (shadow)');
    expect(w.log().at(-1).wouldAct).toBe(1);
  });
  it.each(['off', 'unknown', null, '{'])('settings %j disable decisions while reports continue', (mode) => {
    const w = rearming();
    w.files.set(join('output', 'settings.json'), mode === '{' ? mode : JSON.stringify({ mode }));
    expect(w.tick().summary).toMatchObject({ reports: 1, wouldAct: 0, escalated: 0 });
    expect(actionLog(w)).toEqual([]);
  });
  it('unreadable settings fail closed', () => {
    const w = rearming();
    const read = w.io.readFileSync;
    w.io.readFileSync = (path, ...args) => { if (path.endsWith('settings.json')) throw new Error('denied'); return read(path, ...args); };
    expect(w.tick().summary.wouldAct).toBe(0);
  });
  it('act is shadow with one stderr line and no executed write commands', () => {
    const w = rearming();
    w.files.set(join('output', 'settings.json'), JSON.stringify({ mode: 'act' }));
    w.prs[0].mergeStateStatus = 'BEHIND';
    w.prs[0].statusCheckRollup = [{ name: 'checks', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/org/repo/actions/runs/42/job/1' }];
    const stderr = [];
    expect(w.tick({ stderr: (line) => stderr.push(line) }).summary.wouldAct).toBe(3);
    expect(stderr).toEqual(['act mode not built; shadow only\n']);
    expect(actionLog(w).every((line) => line.mode === 'shadow')).toBe(true);
    for (const { command, args } of w.calls) {
      expect(args).not.toContain('PUT');
      expect(args).not.toContain('rerun');
      expect(args).not.toContain('rearm');
      expect(args).not.toContain('merge');
      expect(command === 'node' ? args[1] === 'why' : command === 'gh' && (args[0] === 'api' || args.slice(0, 2).join(' ') === 'pr list')).toBe(true);
    }
  });
  it.each(['action', 'escalation', 'report'])('append failure leaves the %s key unrecorded and the next tick logs it', (kind) => {
    const w = kind === 'action' ? rearming() : fixture();
    if (kind === 'escalation') w.why.verdict.sections[0].lines = ['fix: waiting | operator'];
    w.prs.push({ ...w.prs[0], number: 2 });
    const append = w.io.appendFileSync;
    const stderr = [];
    let failed = false;
    w.io.appendFileSync = (path, data) => {
      const line = JSON.parse(data);
      if (!failed && line.pr === 1 && line.type === ({ action: 'would-act', escalation: 'escalate', report: 'report' })[kind]) {
        failed = true;
        throw new Error('interrupted');
      }
      append(path, data);
    };
    w.tick({ stderr: (line) => stderr.push(line) });
    const state = JSON.parse(w.files.get(join('output', 'state.json')));
    const keys = Object.keys(state[({ action: 'actions', escalation: 'escalations', report: 'lastReported' })[kind]]);
    expect(keys).toHaveLength(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('interrupted');
    w.io.appendFileSync = append;
    w.tick();
    const log = kind === 'report' ? w.log() : actionLog(w);
    expect(log.filter((line) => line.pr === 1 && line.type === ({ action: 'would-act', escalation: 'escalate', report: 'report' })[kind])).toHaveLength(1);
  });
  it('escalates with exact log, dedupes for 60 minutes, and keys by head and rule', () => {
    const w = fixture();
    w.why.verdict.sections[0].lines = ['fix: waiting | operator'];
    expect(w.tick().summary.escalated).toBe(1);
    expect(w.tick({ nowMs: nowMs + 60 * 60000 - 1 }).summary.escalated).toBe(0);
    expect(w.tick({ nowMs: nowMs + 60 * 60000 }).summary.escalated).toBe(1);
    expect(actionLog(w)[0]).toMatchObject({ type: 'escalate', rule: 'no-worker', logLine: 'fix: waiting | operator' });
    w.prs[0].headRefOid = 'def';
    expect(w.tick().summary.escalated).toBe(1);
    w.prs[0].labels = [{ name: 'review:human' }, { name: 'review:changes' }];
    expect(w.tick().summary.escalated).toBe(1);
    expect(actionLog(w).at(-1).rule).toBe('human-wait');
  });
  it.each([
    [[], true, false, 'gate-red-stalled'],
    [[{ name: 'review:human' }, { name: 'review:changes' }], false, false, 'human-wait'],
    [[{ name: 'status:stood-down' }], false, false, 'human-wait'],
    [[], true, true, 'gate-red-stalled'],
  ])('reads details and why for additional candidate %j', (labels, ciFailing, isDraft, rule) => {
    const w = fixture();
    Object.assign(w.prs[0], { labels, isDraft, statusCheckRollup: ciFailing ? [{ name: 'checks', conclusion: 'FAILURE' }] : [] });
    expect(w.tick().reports.some((r) => r.rule === rule)).toBe(true);
    expect(w.calls.filter((c) => c.args[0] === 'api')).toHaveLength(4);
    expect(w.calls.some((c) => c.command === 'node')).toBe(true);
  });
  it.each(['https://github.com/org/repo/actions/runs/42', 'https://github.com/org/repo/actions/runs/42?check=1', 'unparseable'])('parses run evidence from %s', (detailsUrl) => {
    const w = fixture();
    w.prs[0].labels = [];
    w.prs[0].statusCheckRollup = [{ name: 'infra', conclusion: 'STARTUP_FAILURE', detailsUrl }];
    w.tick();
    expect(actionLog(w)[0].type).toBe(detailsUrl === 'unparseable' ? 'escalate' : 'would-act');
  });
  it('bounds digest decisions to 30 and points to the complete log', () => {
    const w = rearming();
    w.prs = Array.from({ length: 31 }, (_, index) => ({ ...w.prs[0], number: index + 1 }));
    expect(w.tick({ maxDetail: 31, maxWhy: 31 }).summary.wouldAct).toBe(31);
    const section = w.files.get(join('output', 'digest.md')).split('## Would act (shadow)')[1];
    expect(section.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(30);
    expect(section).toContain('inspect actions.jsonl for the full log');
    expect(actionLog(w)).toHaveLength(31);
  });
});
