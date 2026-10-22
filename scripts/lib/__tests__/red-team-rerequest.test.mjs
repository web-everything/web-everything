// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestRedTeamRerun, listRedTeamRequests, resolveRedTeamRerequestPolicy } from '../red-team-rerequest.mjs';

const HEAD = 'a'.repeat(40);
const REPO = 'web-everything/web-everything';
const payload = (rev = HEAD) => ({ verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev } } } });
const policy = (o = {}) => ({ value: { enabled: true, maxRequestsPerHead: 1, ...o }, sources: { enabled: 'tool', maxRequestsPerHead: 'tool' } });

describe('requestRedTeamRerun', () => {
  let dir, spawned;
  const spawnJob = o => { spawned.push(o); return 1234; };
  const call = (input = {}, opts = {}) => requestRedTeamRerun({ repo: REPO, pr: 5283, head: HEAD, loopPayload: payload(), ...input },
    { env: {}, policy: policy(), dir, spawnJob, log: () => {}, ...opts });
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt-rereq-')); spawned = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('posts one exclusive request for the exact head and starts one detached red-team-only job', () => {
    expect(call()).toMatchObject({ requested: true, attempt: 1, jobPid: 1234 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv.slice(1)).toEqual(['red-team', '--pr=5283', `--repo=${REPO}`, `--head=${HEAD}`, `--request=${listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })[0].path}`]);
    const req = JSON.parse(readFileSync(listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })[0].path, 'utf8'));
    expect(req).toMatchObject({ repo: REPO, pr: 5283, head: HEAD, attempt: 1, requestedBy: 'drain' });
  });

  it('is idempotent per head: a second call (or a restarted drain) starts nothing', () => {
    call();
    expect(call()).toMatchObject({ requested: false, reason: expect.stringContaining('maxRequestsPerHead=1') });
    expect(spawned).toHaveLength(1);
  });

  it('maxRequestsPerHead allows exactly that many attempts; 0 allows none', () => {
    expect(call({}, { policy: policy({ maxRequestsPerHead: 2 }) }).attempt).toBe(1);
    expect(call({}, { policy: policy({ maxRequestsPerHead: 2 }) }).attempt).toBe(2);
    expect(call({}, { policy: policy({ maxRequestsPerHead: 2 }) }).requested).toBe(false);
    expect(call({ pr: 7 , loopPayload: payload() }, { policy: policy({ maxRequestsPerHead: 0 }) }).requested).toBe(false);
    expect(spawned).toHaveLength(2);
  });

  it('a concurrent reservation already holding the attempt file wins; this caller starts nothing', () => {
    mkdirSync(dir, { recursive: true });
    const list0 = () => listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir });
    // simulate the race: the other caller created attempt 1 between our listing and our reserve
    const path = join(dir, `${encodeURIComponent(REPO)}-5283-${HEAD}-1.json`);
    writeFileSync(path, '{}', { flag: 'wx' });
    expect(list0()).toHaveLength(1);
    expect(call()).toMatchObject({ requested: false });
    expect(spawned).toHaveLength(0);
  });

  it('kill switches: redTeam.rerequest.enabled=false and the red-team kill switch post nothing', () => {
    expect(call({}, { policy: policy({ enabled: false }) })).toMatchObject({ requested: false, reason: expect.stringContaining('enabled=false') });
    expect(call({}, { env: { WE_REVIEW_RED_TEAM: 'off' } })).toMatchObject({ requested: false, reason: expect.stringContaining('kill switch') });
    expect(spawned).toHaveLength(0);
    expect(listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })).toHaveLength(0);
  });

  it('refuses a head the recorded review never read, and lowercases the identity', () => {
    expect(call({ loopPayload: payload('c'.repeat(40)) })).toMatchObject({ requested: false });
    expect(call({ head: HEAD.toUpperCase() })).toMatchObject({ requested: true });
    expect(listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })).toHaveLength(1);
  });

  it('a spawn failure releases only its own reservation, so the next call retries', () => {
    expect(call({}, { spawnJob: () => { throw new Error('EAGAIN'); } })).toMatchObject({ requested: false, reason: expect.stringContaining('EAGAIN') });
    expect(listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })).toHaveLength(0);
    expect(call()).toMatchObject({ requested: true, attempt: 1 });
  });

  it('an asynchronous spawn error releases the reservation', () => {
    let onError;
    expect(call({}, { spawnJob: o => { onError = o.onError; return 77; } })).toMatchObject({ requested: true });
    onError(new Error('ENOENT'));
    expect(listRedTeamRequests({ repo: REPO, pr: 5283, head: HEAD, dir })).toHaveLength(0);
  });

  it('different repos, PRs and heads do not share a reservation', () => {
    call();
    expect(call({ pr: 5284 })).toMatchObject({ requested: true });
    expect(call({ repo: 'web-everything/plateau-app' })).toMatchObject({ requested: true });
    expect(call({ head: 'd'.repeat(40), loopPayload: payload('d'.repeat(40)) })).toMatchObject({ requested: true });
    expect(spawned).toHaveLength(4);
  });
});

describe('redTeam.rerequest policy cascade', () => {
  it('standard on with one request per head; env kill switch and cap override, invalid values ignored', () => {
    expect(resolveRedTeamRerequestPolicy({}).value).toEqual({ enabled: true, maxRequestsPerHead: 1 });
    const off = resolveRedTeamRerequestPolicy({ file: { redTeam: { rerequest: { maxRequestsPerHead: 2 } } }, env: { WE_RED_TEAM_REREQUEST: 'off' } });
    expect(off.value).toEqual({ enabled: false, maxRequestsPerHead: 2 });
    expect(off.sources).toMatchObject({ enabled: 'env', maxRequestsPerHead: 'tool' });
    const bad = resolveRedTeamRerequestPolicy({ env: { WE_RED_TEAM_REREQUEST_MAX_PER_HEAD: '99' } });
    expect(bad.value.maxRequestsPerHead).toBe(1);
    expect(bad.invalid.join(' ')).toContain('99');
  });
});
