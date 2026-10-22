/**
 * @file scripts/__tests__/guard-bash-lane-occupant.test.mjs
 * @description lane-lease-occupant (2026-10-22). Live incident ~05:52 ET: a subagent ran
 *   `cd …/lane-21 && … ; cd ../lane-7 && … ; LANE_SESSION=<its OLD lane-7 slug> git reset --hard …`. Its lane-7 lease
 *   had gone TTL-stale and conveyor session fix-5775 had taken lane-7 over (fresh slug). The guard judged the whole
 *   command against lane-21 (the FIRST `cd`) and the reset ran on fix-5775's tree. These tests replay that sequence
 *   and pin the three rules: (1) a destructive git op in a lane needs the CURRENT holder's slug on a LIVE lease,
 *   (2) the occupant's use renews its lease and a stale lease is never revived, (3) a lapsed holder is told
 *   "lease lost — re-acquire".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, destructiveLaneTargets, laneOccupantReason } from '../guard-bash.mjs';
import { laneDestructiveOpVerdict, leaseRenewalOnUse } from '../lib/lane-lease.mjs';
import { readLaneLeaseSettings, renewLeaseOnUse } from '../lib/lane-lease-renew.mjs';

const GUARD = resolve(process.cwd(), 'scripts/guard-bash.mjs');
const NOW = Date.parse('2026-10-22T09:52:39Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// The two leases exactly as they stood at 09:52:39Z (shapes copied from the live markers).
const AGENT_SESSION = 'bd616854-1f67-4f80-8be5-40fe1456e3bf';
const FIX_SESSION = 'f8790505-dcd7-48b0-b11d-e31db4336124';
const OLD_LANE7_SLUG = 'grad-ledger-outbox-lane-7-1d6614dd';
const lane7Fix = () => ({
  session: 'fix-5775', purpose: 'conveyor-fix', acquiredAt: '2026-10-22T08:40:47.148Z', ttlMinutes: 240,
  host: 'Mac', pid: 30524, ownerSession: FIX_SESSION, workflowLane: false, holder: 'conveyor-fix-lane-7-0ef63229',
  workerSession: FIX_SESSION,
});
const lane21Stale = () => ({
  session: 'Mac:1', purpose: 'grad-redteam', acquiredAt: iso(NOW - 300 * MIN), ttlMinutes: 240, host: 'Mac', pid: 1,
  ownerSession: AGENT_SESSION, workflowLane: false, holder: 'grad-redteam-lane-21-8360d1e2', workerSession: AGENT_SESSION,
});
const ownLive = (over = {}) => ({
  session: 'Mac:2', purpose: 'mine', acquiredAt: iso(NOW - 30 * MIN), ttlMinutes: 240, host: 'Mac', pid: 2,
  ownerSession: AGENT_SESSION, workflowLane: false, holder: 'mine-lane-15-aaaaaaaa', workerSession: AGENT_SESSION, ...over,
});

const LANES = '/ws/.lanes/web-everything';
// The incident command, verbatim except for the workspace prefix.
const INCIDENT = `cd ${LANES}/lane-21 && git push -q origin HEAD:refs/heads/lane/grad-redteam-stack f26b12f79:refs/heads/lane/grad-redteam-a 2>&1 | grep -v "^remote:"; LANE_SESSION=grad-redteam-lane-21-8360d1e2 git reset --hard f26b12f79 -q && git log --oneline -1 | cat; cd ../lane-7 && L2=$(git log --format=%h --grep="ledger outbox 2/6" -1) && git push -q origin $L2:refs/heads/lane/grad-ledger-2 2>&1 | grep -v "^remote:"; LANE_SESSION=${OLD_LANE7_SLUG} git reset --hard $L2 -q && git log --oneline -1 | cat`;

const factsFor = (byRoot) => ({ laneLeaseFacts: { byRoot, nowMs: NOW }, reportedCwd: '/ws/webeverything' });

describe('destructiveLaneTargets — every cd counts, not just the first', () => {
  it('places the incident\'s second reset in lane-7, not lane-21', () => {
    const t = destructiveLaneTargets(INCIDENT, '/ws/webeverything');
    const resets = t.filter((x) => /reset --hard/.test(x.segment));
    expect(resets).toHaveLength(2);
    expect(resets[0].dirs).toEqual([`${LANES}/lane-21`]);
    expect(resets[1].dirs).toEqual([`${LANES}/lane-7`]);
  });
  it('follows git -C and literal variables; an unreadable target is null', () => {
    expect(destructiveLaneTargets(`git -C ${LANES}/lane-3 reset --hard`, '/ws')[0].dirs).toEqual([`${LANES}/lane-3`]);
    expect(destructiveLaneTargets(`L=${LANES}/lane-4; cd "$L" && git clean -fd`, '/ws')[0].dirs).toEqual([`${LANES}/lane-4`]);
    expect(destructiveLaneTargets('cd "$(pick-lane)" && git reset --hard', '/ws')[0].dirs).toEqual([null]);
  });
  it('a cd inside a subshell adds a candidate instead of replacing one', () => {
    const t = destructiveLaneTargets(`cd ${LANES}/lane-1 && (cd ../lane-2 && true) && git reset --hard`, '/ws');
    expect(t[0].dirs.sort()).toEqual([`${LANES}/lane-1`, `${LANES}/lane-2`]);
  });
});

describe('replay of 2026-10-22 ~05:52 ET — refused', () => {
  it('the whole incident command is denied before anything runs', () => {
    const r = decide(INCIDENT, factsFor({ [`${LANES}/lane-21`]: lane21Stale(), [`${LANES}/lane-7`]: lane7Fix() }));
    expect(r).toMatch(/lane-op-proof/);
    // the FIRST refusal is lane-21: its own lease had also lapsed — the holder is told to re-acquire
    expect(r).toMatch(/lease lost — re-acquire/);
  });
  it('even with lane-21 fine, the stale lane-7 slug is refused against fix-5775\'s live lease', () => {
    const r = decide(INCIDENT, factsFor({ [`${LANES}/lane-21`]: { ...lane21Stale(), acquiredAt: iso(NOW - 5 * MIN) }, [`${LANES}/lane-7`]: lane7Fix() }));
    expect(r).toMatch(/LANE_SESSION=grad-ledger-outbox-lane-7-1d6614dd is not web-everything\/lane-7's CURRENT holder/);
    expect(r).not.toMatch(/conveyor-fix-lane-7-0ef63229/); // the deny never leaks the real holder's slug
  });
  it('LANE_CLOBBER_OK does not pass a live lease held by someone else', () => {
    const r = decide(`cd ${LANES}/lane-7 && LANE_CLOBBER_OK=1 git reset --hard HEAD`, factsFor({ [`${LANES}/lane-7`]: lane7Fix() }));
    expect(r).toMatch(/lane-op-proof/);
  });
  it('no slug at all on a live lease is refused', () => {
    expect(decide(`cd ${LANES}/lane-7 && git reset --hard`, factsFor({ [`${LANES}/lane-7`]: lane7Fix() }))).toMatch(/No slug was asserted/);
  });
  it('an unreadable cd target into lane territory is refused', () => {
    expect(decide(`L=$(ls -d ${LANES}/lane-*); cd $L && git reset --hard`, factsFor({}))).toMatch(/cannot read statically/);
  });
});

describe('own live lease — allowed', () => {
  it('the current holder\'s slug on a live lease passes', () => {
    const root = `${LANES}/lane-15`;
    expect(decide(`cd ${root} && LANE_SESSION=mine-lane-15-aaaaaaaa git reset --hard origin/main`, factsFor({ [root]: ownLive() }))).toBeNull();
  });
  it('a workflow-lane lease proves itself with its marked slug', () => {
    const root = `${LANES}/lane-15`;
    const lease = ownLive({ workflowLane: true, session: 'batch-x-lane-15' });
    expect(decide(`cd ${root} && LANE_SESSION=batch-x-lane-15 git clean -fd`, factsFor({ [root]: lease }))).toBeNull();
  });
  it('commands that are not destructive git are untouched', () => {
    expect(laneOccupantReason(`cd ${LANES}/lane-7 && git status && git log -1`, factsFor({ [`${LANES}/lane-7`]: lane7Fix() }))).toBeNull();
  });
});

describe('expired own lease — refused with the re-acquire message', () => {
  it('the old holder asserting its own slug is told "lease lost — re-acquire"', () => {
    const root = `${LANES}/lane-15`;
    const stale = ownLive({ acquiredAt: iso(NOW - 241 * MIN) });
    const r = decide(`cd ${root} && LANE_SESSION=mine-lane-15-aaaaaaaa git reset --hard origin/main`, factsFor({ [root]: stale }));
    expect(r).toMatch(/lease lost — re-acquire/);
    // …and LANE_CLOBBER_OK cannot paper over a lapsed holder re-using its slug
    expect(decide(`cd ${root} && LANE_CLOBBER_OK=1 LANE_SESSION=mine-lane-15-aaaaaaaa git reset --hard`, factsFor({ [root]: stale }))).toMatch(/lease lost/);
  });
  it('a renewal keeps it live: renewedAt inside the TTL is a live lease', () => {
    const root = `${LANES}/lane-15`;
    const renewed = ownLive({ acquiredAt: iso(NOW - 300 * MIN), renewedAt: iso(NOW - 2 * MIN) });
    expect(decide(`cd ${root} && LANE_SESSION=mine-lane-15-aaaaaaaa git reset --hard`, factsFor({ [root]: renewed }))).toBeNull();
  });
});

describe('laneDestructiveOpVerdict — the pure table', () => {
  const v = (lease, assertedSlug, clobberOk = false) => laneDestructiveOpVerdict({ lease, assertedSlug, clobberOk, nowMs: NOW });
  it('codes', () => {
    expect(v(null, null).code).toBe('no-lease');
    expect(v(null, null, true).allowed).toBe(true);
    expect(v(lane7Fix(), null).code).toBe('slug-absent');
    expect(v(lane7Fix(), OLD_LANE7_SLUG).code).toBe('not-holder');
    expect(v(lane7Fix(), OLD_LANE7_SLUG, true).allowed).toBe(false);
    expect(v(lane7Fix(), 'conveyor-fix-lane-7-0ef63229').allowed).toBe(true);
    expect(v(lane21Stale(), 'grad-redteam-lane-21-8360d1e2').code).toBe('lease-lost');
    expect(v(lane21Stale(), null).code).toBe('lease-expired');
    expect(v(lane21Stale(), null, true).allowed).toBe(true);
    expect(v({ ...lane7Fix(), holder: undefined }, 'x').code).toBe('unprovable');
  });
});

describe('leaseRenewalOnUse — liveness follows the occupant', () => {
  it('renews for the declared occupant or the matching slug, after the throttle window', () => {
    const lease = ownLive({ acquiredAt: iso(NOW - 10 * MIN) });
    expect(leaseRenewalOnUse({ lease, mySessionId: AGENT_SESSION, nowMs: NOW, throttleMs: 5 * MIN })).toMatchObject({ renewedAt: iso(NOW), renewedBy: 'occupant' });
    expect(leaseRenewalOnUse({ lease, mySessionId: 'other', assertedSlug: 'mine-lane-15-aaaaaaaa', nowMs: NOW, throttleMs: 5 * MIN })).toMatchObject({ renewedBy: 'holder-slug' });
  });
  it('never for someone else, never inside the throttle window, never a stale or reserved lease', () => {
    expect(leaseRenewalOnUse({ lease: lane7Fix(), mySessionId: AGENT_SESSION, assertedSlug: OLD_LANE7_SLUG, nowMs: NOW })).toBeNull();
    expect(leaseRenewalOnUse({ lease: ownLive({ acquiredAt: iso(NOW - 2 * MIN) }), mySessionId: AGENT_SESSION, nowMs: NOW, throttleMs: 5 * MIN })).toBeNull();
    expect(leaseRenewalOnUse({ lease: lane21Stale(), mySessionId: AGENT_SESSION, nowMs: NOW })).toBeNull();
    expect(leaseRenewalOnUse({ lease: ownLive({ reserved: true }), mySessionId: AGENT_SESSION, nowMs: NOW })).toBeNull();
  });
  it('settings resolve through the cascade with their source; an invalid env value never wins', () => {
    expect(readLaneLeaseSettings({ env: {}, read: () => ({}), platform: null })).toMatchObject({ value: { renewOnUseMinutes: 5 }, sources: { renewOnUseMinutes: 'standard' } });
    expect(readLaneLeaseSettings({ env: {}, read: () => ({ laneLease: { renewOnUseMinutes: 7 } }), platform: null }).sources.renewOnUseMinutes).toBe('tool');
    expect(readLaneLeaseSettings({ env: { WE_LANE_LEASE_RENEW_MINUTES: '9' }, read: () => ({}), platform: null }).value.renewOnUseMinutes).toBe(9);
    expect(readLaneLeaseSettings({ env: { WE_LANE_LEASE_RENEW_MINUTES: '0' }, read: () => ({}), platform: null }).value.renewOnUseMinutes).toBe(5);
  });
});

describe('the hook itself, on a real lane layout (CLI)', () => {
  let root, lanes;
  const write = (lane, lease) => {
    mkdirSync(join(lanes, lane, '.git'), { recursive: true });
    if (lease) writeFileSync(join(lanes, lane, '.git', '.lane-lease'), JSON.stringify(lease, null, 2));
  };
  const lease = (lane) => JSON.parse(readFileSync(join(lanes, lane, '.git', '.lane-lease'), 'utf8'));
  const runHook = (command, cwd, session = AGENT_SESSION) => {
    const out = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_input: { command }, cwd }),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, WE_DISPATCH_KIND: '', WE_POLICY_CASCADE_LOG: '0' },
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out ? JSON.parse(out.split('\n')[0]) : null;
  };
  const denied = (o) => o?.hookSpecificOutput?.permissionDecision === 'deny';
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-occupant-')));
    lanes = join(root, '.lanes', 'web-everything');
    const now = Date.now();
    write('lane-21', { ...lane21Stale(), acquiredAt: iso(now - 300 * MIN) });
    write('lane-7', { ...lane7Fix(), acquiredAt: iso(now - 70 * MIN) });
    write('lane-15', ownLive({ acquiredAt: iso(now - 30 * MIN) }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('BEFORE this fix the incident shape slipped through on the first cd; now the hook denies it', () => {
    const cmd = `cd ${lanes}/lane-21 && true; cd ../lane-7 && LANE_SESSION=${OLD_LANE7_SLUG} git reset --hard HEAD -q`;
    expect(denied(runHook(cmd, root))).toBe(true);
    // lane-7's lease is untouched — the old holder's call never renews someone else's lease
    expect(lease('lane-7').renewedAt).toBeUndefined();
  });
  it('the holder\'s own slug in its own live lane is allowed and renews the lease (heartbeat)', () => {
    const before = lease('lane-15');
    const out = runHook(`cd ${lanes}/lane-15 && LANE_SESSION=mine-lane-15-aaaaaaaa git reset --hard origin/main`, root);
    expect(denied(out)).toBe(false);
    const after = lease('lane-15');
    expect(after.renewedAt).toBeTruthy();
    expect(after.holder).toBe(before.holder);
    expect(after.acquiredAt).toBe(before.acquiredAt);
  });
  it('any allowed call by the declared occupant renews; a stale lease is never revived', () => {
    runHook('git status', join(lanes, 'lane-15'));
    expect(lease('lane-15').renewedBy).toBe('occupant');
    runHook('git status', join(lanes, 'lane-21'));
    expect(lease('lane-21').renewedAt).toBeUndefined();
  });
  it('renewLeaseOnUse writes once, then throttles', () => {
    const laneRoot = join(lanes, 'lane-15');
    const r = renewLeaseOnUse({ laneRoot, mySessionId: AGENT_SESSION, settings: { renewOnUseMinutes: 1 } });
    expect(r?.renewedAt).toBeTruthy();
    expect(renewLeaseOnUse({ laneRoot, mySessionId: AGENT_SESSION, settings: { renewOnUseMinutes: 1 } })).toBeNull(); // throttled
  });
  it('after an occupancy hand-off to B, A's use never renews or rewrites the lease (codex audit r1)', () => {
    const laneRoot = join(lanes, 'lane-15');
    const file = join(laneRoot, '.git', '.lane-lease');
    const orig = readFileSync(file, 'utf8');
    const adopted = { ...JSON.parse(orig), workerSession: 'B' };
    writeFileSync(file, JSON.stringify(adopted));
    expect(renewLeaseOnUse({ laneRoot, mySessionId: AGENT_SESSION, settings: { renewOnUseMinutes: 1 } })).toBeNull();
    expect(lease('lane-15').workerSession).toBe('B');
  });
});
