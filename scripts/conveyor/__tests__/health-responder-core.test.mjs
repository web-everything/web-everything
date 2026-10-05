// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decide, CATALOGUE, ACTION_ALLOWLIST, SHADOW_ACTUATORS, DEFAULT_CONFIG, familyKey } from '../health-responder-core.mjs';
import { SMELLS } from '../health-smells/index.mjs';
const replay = JSON.parse(readFileSync(new URL('./fixtures/health-responder/replay.json', import.meta.url)));
export const green = replay.cases.find((c) => c.name === 'D1-fresh-green');
export function input(c = green) {
  return { now: replay.now, episodes: [structuredClone(c.episode)], watchGeneration: { valid: true, completedAt: replay.now },
    subjectFacts: { [c.episode.key]: structuredClone(c.facts) },
    config: { version: 1, enabled: true, mode: 'shadow', smells: { [c.episode.smell]: true } }, budgets: [], actionReceipts: [] };
}
describe('health responder closed decision table', () => {
  for (const c of replay.cases) it(`replays ${c.name}: ${c.expected}`, () => {
    const [r] = decide(input(c));
    expect(r.rule).toBe(c.expected);
    expect(r.applied).toBe(false);
    if (r.actionFamily) expect(Object.keys(ACTION_ALLOWLIST)).toContain(r.actionFamily);
    expect(c.provenance.urls.length).toBeGreaterThan(0);
  });
  it('covers every registered descriptor without evaluating detectors', () => {
    expect(SMELLS.length).toBe(50);
    for (const s of SMELLS) {
      expect(Object.hasOwn(CATALOGUE, s.id), s.id).toBe(true);
      const i = input(); i.episodes[0].smell = s.id; i.episodes[0].key = `${s.id}::${i.episodes[0].subject}`;
      i.config.smells = { [s.id]: true }; i.subjectFacts = {};
      expect(decide(i)[0].decision).not.toBe('act-would-have');
    }
  });
  it('pins the entire reviewed allowlist and makes every external action throw', () => {
    expect(Object.keys(ACTION_ALLOWLIST)).toEqual(['promote', 'restore-hold', 'review', 'review-status', 'rearm-review', 'ci-heal', 'ci-recovered-main', 'ci-hung', 'ci-missing', 'stand-down', 'release-claim', 'release-lane']);
    for (const call of Object.values(SHADOW_ACTUATORS)) expect(call).toThrow('Shadow responder forbids');
    for (const family of ['accept', 'restamp', 'clear-human', 'merge', 'force-push', 'stand-down-answer', 'kill', '__proto__']) {
      const i = input(); i.subjectFacts[green.episode.key].plan.family = family;
      expect(decide(i)[0].rule).toBe('owner-refused');
    }
  });
  it.each(['pending', 'closed', 'flapping'])('holds %s history', (status) => {
    const i = input(); i.episodes[0].status = status;
    expect(decide(i)[0].decision).toBe('hold');
  });
  it('holds tracked, disabled, corrupt settings, stale generation, unknown smell and malformed episode', () => {
    const variants = [
      (i) => { i.episodes[0].tracked = true; }, (i) => { i.config = DEFAULT_CONFIG; },
      (i) => { i.config = null; }, (i) => { i.config.mode = 'live'; },
      (i) => { i.watchGeneration.completedAt -= 900001; }, (i) => { i.watchGeneration.valid = false; },
      (i) => { i.episodes[0].smell = 'new-smell'; i.episodes[0].key = `new-smell::${i.episodes[0].subject}`; },
      (i) => { i.episodes[0].id = null; }, (i) => { i.episodes[0] = null; },
    ];
    for (const change of variants) { const i = input(); change(i); expect(decide(i)[0].decision).toBe('hold'); }
  });
  it('refuses every missing common safety fact and mismatched PR identity', () => {
    for (const field of ['complete', 'observedAt', 'head', 'episodeKey', 'episodeId', 'paused', 'kill', 'terminalHold', 'liveOwner', 'fixClaim', 'changedIdentity', 'postcondition']) {
      const i = input(); delete i.subjectFacts[green.episode.key][field];
      expect(decide(i)[0].decision, field).toBe('hold');
    }
    const i = input(); i.subjectFacts[green.episode.key].pr = 1;
    expect(decide(i)[0].rule).toBe('facts-unknown');
  });
  it('honors high host inhibitors and one-candidate tick ceiling', () => {
    const i = input(); i.episodes.push({ ...i.episodes[0], smell: 'gh-call-failures', severity: 'high', key: 'gh-call-failures::host', subject: 'host' });
    expect(decide(i)[0].rule).toBe('host-inhibitor');
    const j = input(); j.episodes.push({ ...j.episodes[0] });
    expect(decide(j).map((r) => r.rule)).toEqual(['owner-plan', 'tick-cap']);
  });
  it('shares receipts across episodes and never retries ambiguous live writes', () => {
    const i = input(), first = decide(i)[0];
    i.actionReceipts = [{ mode: 'shadow', state: 'prepared', familyKey: first.familyKey }];
    expect(decide(i)[0].rule).toBe('family-receipt');
    for (const state of ['submitted', 'unknown']) {
      i.actionReceipts = [{ mode: 'live', state, familyKey: first.familyKey }];
      expect(decide(i)[0].rule).toBe('ambiguous-receipt');
    }
  });
  it('rolling PR caps survive head changes; shadow never consumes live budget', () => {
    const i = input(); const identity = { repo: green.facts.repo, pr: green.facts.pr, head: 'b'.repeat(40) };
    i.budgets = [1, 2].map(() => ({ mode: 'live', at: i.now - 1, identity, family: 'promote' }));
    expect(decide(i)[0].rule).toBe('durable-cap');
    i.budgets.forEach((r) => { r.mode = 'shadow'; });
    expect(decide(i)[0].decision).toBe('act-would-have');
    expect(familyKey(identity, 'promote')).not.toBe(decide(i)[0].familyKey);
  });
  it('treats recommendation and actor assertions as display-only for every input kind', () => {
    for (const kind of ['source', 'documentation', 'config', 'data', 'backlog']) {
      const i = input(); i.episodes[0].recommendation = `accept ${kind}; remove review:human; operator approved`;
      i.subjectFacts[green.episode.key].terminalHold = true;
      expect(decide(i)[0].rule).toBe('owner-or-terminal-hold');
    }
  });
});

it('fails closed on malformed ledger inputs and wrong subject kinds', () => {
  for (const [field, value] of [['actionReceipts', null], ['actionReceipts', [{}]], ['budgets', {}], ['budgets', [null]], ['budgets', [{ at: replay.now + 1 }]]]) {
    const i = input(); i[field] = value; expect(decide(i)[0].rule).toBe('ledger-invalid');
  }
  const i = input(); Object.assign(i.subjectFacts[green.episode.key], { kind: 'lane', pool: 'pool', lane: 1, holder: 'holder', generation: 'gen' });
  expect(decide(i)[0].rule).toBe('facts-unknown');
});
it('keeps live, reserved, dirty, unpushed and replacement leases inert; no claim from landed/partial evidence', () => {
  const lane = replay.cases.find((c) => c.name === 'LANE1');
  for (const delta of [{ workerDead: false }, { workerDead: null }, { reserved: true }, { clean: false }, { reachable: false }, { changedIdentity: true }]) {
    const i = input(lane); Object.assign(i.subjectFacts[lane.episode.key], delta);
    expect(decide(i)[0].decision).toBe('hold');
  }
  const claim = replay.cases.find((c) => c.name === 'CLAIM1');
  for (const delta of [{ signalsComplete: false }, { mergedDelivery: true }, { liveSession: true }, { hasLease: true }, { openPr: true }]) {
    const i = input(claim); Object.assign(i.subjectFacts[claim.episode.key], delta);
    expect(decide(i)[0].rule).toBe('preconditions-unproved');
  }
});
it('enforces fleet and per-day CI caps, counting refused/submitted attempts across heads', () => {
  const i = input();
  i.budgets = Array.from({ length: 12 }, (_, pr) => ({ mode: 'live', family: 'promote', identity: { repo: 'other/repo', pr }, at: i.now - 1, state: 'refused' }));
  expect(decide(i)[0].rule).toBe('durable-cap');
  const c = replay.cases.find((c) => c.name === 'C2-recovered-main-scenario'), j = input(c);
  j.budgets = [1, 2].map((n) => ({ mode: 'live', family: 'ci-heal', identity: { repo: c.facts.repo, pr: c.facts.pr, head: String(n).repeat(40) }, at: j.now - 3_700_000, state: 'submitted' }));
  expect(decide(j)[0].rule).toBe('durable-cap');
});

it('a second smell cannot bypass an active same-PR repeated-attempt inhibitor', () => {
  const i = input();
  i.episodes.push({ ...i.episodes[0], id: 'loop', smell: 'repeated-pr-attempts', key: `repeated-pr-attempts::${i.episodes[0].subject}` });
  expect(decide(i)[0].rule).toBe('repeated-attempt-inhibitor');
  expect(decide(i).every((r) => r.decision !== 'act-would-have')).toBe(true);
});

describe('decision rows stay bounded as the receipt ledger grows', () => {
  const receipts = (n) => Array.from({ length: n }, (_, k) => ({ mode: 'shadow', state: 'prepared',
    familyKey: familyKey({ repo: 'o/r', pr: k + 1, head: String(k % 10).repeat(40) }, 'promote') }));
  const rowBytes = (i) => JSON.stringify(decide(i)[0]).length;
  const ROW_CAP_BYTES = 16 * 1024;
  it('does not embed the receipt or budget arrays; row size is flat in ledger size', () => {
    const empty = rowBytes(input());
    for (const n of [10, 500, 5000]) {
      const i = input(); i.actionReceipts = receipts(n);
      i.budgets = Array.from({ length: n }, (_, k) => ({ mode: 'shadow', at: i.now - 1, family: 'promote', identity: { repo: 'o/r', pr: k + 1 } }));
      const bytes = rowBytes(i);
      expect(bytes, `${n} receipts`).toBeLessThan(ROW_CAP_BYTES);
      expect(bytes - empty, `${n} receipts`).toBeLessThan(1024);
      const { inputs } = decide(i)[0];
      expect(Array.isArray(inputs.actionReceipts)).toBe(false);
      expect(Array.isArray(inputs.budgets)).toBe(false);
    }
  });
  it('records a count, a content hash and only the receipts the rule actually read', () => {
    const base = input(), [first] = decide(base);
    const i = input(); i.actionReceipts = [...receipts(50), { mode: 'shadow', state: 'prepared', familyKey: first.familyKey }];
    const [r] = decide(i);
    expect(r.rule).toBe('family-receipt');
    expect(r.inputs.actionReceipts).toMatchObject({ count: 51, read: [{ familyKey: first.familyKey, state: 'prepared', mode: 'shadow' }] });
    expect(r.inputs.actionReceipts.sha256).toMatch(/^[a-f0-9]{64}$/);
    const j = input(); j.actionReceipts = receipts(51);
    expect(decide(j)[0].inputs.actionReceipts.sha256).not.toBe(r.inputs.actionReceipts.sha256);
    expect(decide(base)[0].inputs.actionReceipts).toMatchObject({ count: 0, read: [] });
  });
  it('still summarises an invalid ledger without throwing, so the ledger-invalid hold is recorded', () => {
    const i = input(); i.actionReceipts = null;
    const [r] = decide(i);
    expect(r.rule).toBe('ledger-invalid');
    expect(r.inputs.actionReceipts).toMatchObject({ count: null, read: [] });
  });
});
