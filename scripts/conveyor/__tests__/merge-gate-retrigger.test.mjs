import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let decideRequiredContextRetrigger;
let retriggerRequiredContext;
let RETRIGGER_LABEL;
beforeAll(async () => {
  ({ decideRequiredContextRetrigger, retriggerRequiredContext, RETRIGGER_LABEL } =
    await import('../merge-gate-retrigger.mjs'));
});

const REPO = 'web-everything/web-everything';
const HEAD = 'a'.repeat(40);
const run = (overrides = {}) => ({
  name: 'Merge gate', event: 'pull_request_target', conclusion: 'startup_failure',
  status: 'completed', created_at: '2026-10-13T11:00:00Z', id: 101, ...overrides,
});
const facts = (overrides = {}) => ({
  requiredContexts: ['merge-gate'], rollup: [], workflowRuns: [run()],
  alreadyRetriggered: false, ...overrides,
});

function claimLedger() {
  const claimed = new Set();
  return { claim: vi.fn((...key) => {
    const serialized = JSON.stringify(key);
    if (claimed.has(serialized)) return false;
    claimed.add(serialized);
    return true;
  }) };
}

function effects(overrides = {}) {
  return {
    readHead: vi.fn(() => HEAD), readLabels: vi.fn(() => []), addLabel: vi.fn(() => ({ ok: true })),
    removeLabel: vi.fn(() => ({ ok: true })), ...overrides,
  };
}

function assertSkip(input) {
  const result = decideRequiredContextRetrigger(input);
  expect(result.action).toBe('skip');
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
}

describe('required merge-gate context retrigger', () => {
  it('sentinel satisfies the merge-gate workflow label watch rule', () => {
    const skipped = RETRIGGER_LABEL !== 'ready-to-merge' && !RETRIGGER_LABEL.startsWith('review:');
    expect(skipped).toBe(false);
  });

  it('workflow text retains the review prefix label watch clause', () => {
    const workflow = readFileSync('.github/workflows/merge-gate.yml', 'utf8');
    expect(workflow).toContain("!startsWith(github.event.label.name, 'review:')");
  });

  it('missing required context plus startup_failure run gives one retrigger', async () => {
    const decision = decideRequiredContextRetrigger(facts());
    expect(decision).toEqual(expect.objectContaining({ action: 'retrigger', context: 'merge-gate', reason: expect.any(String) }));
    expect(RETRIGGER_LABEL).toBe('review:merge-gate-retrigger');
    const ledger = claimLedger();
    const io = effects();
    const result = await retriggerRequiredContext({ repo: REPO, pr: 5060, head: HEAD, context: decision.context, io, ledger });
    expect(result.ok).toBe(true);
    expect(ledger.claim).toHaveBeenCalledTimes(1);
    expect(io.readHead).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    expect(io.removeLabel).toHaveBeenCalledTimes(1);
    expect(io.removeLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    expect(ledger.claim.mock.invocationCallOrder[0]).toBeLessThan(io.readHead.mock.invocationCallOrder[0]);
    expect(io.readHead.mock.invocationCallOrder[0]).toBeLessThan(io.addLabel.mock.invocationCallOrder[0]);
    expect(io.addLabel.mock.invocationCallOrder[0]).toBeLessThan(io.removeLabel.mock.invocationCallOrder[0]);
  });

  it('missing required context with no run at all gives one retrigger', async () => {
    const decision = decideRequiredContextRetrigger(facts({ workflowRuns: [] }));
    expect(decision).toEqual(expect.objectContaining({ action: 'retrigger', context: 'merge-gate' }));
    const io = effects();
    await retriggerRequiredContext({ repo: REPO, pr: 5060, head: HEAD, context: decision.context, io, ledger: claimLedger() });
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    expect(io.removeLabel).toHaveBeenCalledTimes(1);
    expect(io.removeLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
  });

  it('a second tick on the same head is a no-op', async () => {
    const ledger = claimLedger();
    const io = effects();
    const args = { repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate', io, ledger };
    await retriggerRequiredContext(args);
    await retriggerRequiredContext(args);
    expect(ledger.claim).toHaveBeenCalledTimes(2);
    expect(io.readHead).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    expect(io.removeLabel).toHaveBeenCalledTimes(1);
    expect(io.removeLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    assertSkip(facts({ alreadyRetriggered: true }));
  });

  it('present-but-pending context gives no retrigger', () => {
    for (const status of ['QUEUED', 'IN_PROGRESS', 'PENDING']) {
      assertSkip(facts({ rollup: [{ __typename: 'CheckRun', name: 'merge-gate', status, conclusion: null }] }));
    }
  });

  it('failed context gives no retrigger', () => {
    for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT']) {
      assertSkip(facts({ rollup: [{ __typename: 'CheckRun', name: 'merge-gate', status: 'COMPLETED', conclusion }] }));
    }
  });

  it('a live queued or in_progress run gives no retrigger', () => {
    for (const status of ['queued', 'in_progress']) {
      assertSkip(facts({ workflowRuns: [run(), run({ id: 102, status, conclusion: null, created_at: '2026-10-13T12:00:00Z' })] }));
    }
  });

  it('only the latest matching workflow run determines retrigger eligibility', () => {
    const success = run({ id: 102, conclusion: 'success', created_at: '2026-10-13T12:00:00Z' });
    assertSkip(facts({ workflowRuns: [success, run()] }));
    assertSkip(facts({ workflowRuns: [run(), success] }));
    expect(decideRequiredContextRetrigger(facts({ workflowRuns: [
      run({ id: 103, name: 'CI', status: 'in_progress', conclusion: null, created_at: '2026-10-13T13:00:00Z' }), run(),
    ] })).action).toBe('retrigger');
  });

  it('moved head gives no label event', async () => {
    const ledger = claimLedger();
    const io = effects({ readHead: vi.fn(() => 'b'.repeat(40)) });
    await retriggerRequiredContext({ repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate', io, ledger });
    expect(ledger.claim).toHaveBeenCalledTimes(1);
    expect(io.readHead).toHaveBeenCalledTimes(1);
    expect(io.addLabel).not.toHaveBeenCalled();
    expect(io.removeLabel).not.toHaveBeenCalled();
  });

  it('add failure skips remove and reports failure', async () => {
    const io = effects({ addLabel: vi.fn(() => { throw new Error('label add rejected'); }) });
    const result = await retriggerRequiredContext({ repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate', io, ledger: claimLedger() });
    expect(result.ok).toBe(false);
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.removeLabel).not.toHaveBeenCalled();
  });

  it('remove failure reports ok with a warning after the label event', async () => {
    const io = effects({ removeLabel: vi.fn(() => { throw new Error('label removal rejected'); }) });
    const result = await retriggerRequiredContext({ repo: REPO, pr: 5060, head: HEAD, context: 'merge-gate', io, ledger: claimLedger() });
    expect(result.ok).toBe(true);
    expect(result.warning).toEqual(expect.any(String));
    expect(result.warning.trim()).not.toBe('');
    expect(io.addLabel).toHaveBeenCalledTimes(1);
    expect(io.addLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    expect(io.removeLabel).toHaveBeenCalledTimes(1);
    expect(io.removeLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
  });

  it('malformed input fails closed', () => {
    for (const input of [undefined, null, {}, facts({ requiredContexts: null }),
      facts({ requiredContexts: [null] }), facts({ rollup: null }), facts({ rollup: [null] }),
      facts({ workflowRuns: null }), facts({ workflowRuns: [{}] }), facts({ alreadyRetriggered: 'false' })]) {
      assertSkip(input);
    }
  });

  it('no retrigger storm: 5 PRs, 3 ticks fires exactly one label pair per (pr, head)', async () => {
    const ledger = claimLedger();
    const ios = Array.from({ length: 5 }, () => effects());
    for (let tick = 0; tick < 3; tick++) {
      for (let index = 0; index < ios.length; index++) {
        await retriggerRequiredContext({ repo: REPO, pr: 5060 + index, head: HEAD,
          context: 'merge-gate', io: ios[index], ledger });
      }
    }
    for (const io of ios) {
      expect(io.addLabel).toHaveBeenCalledTimes(1);
      expect(io.addLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
      expect(io.removeLabel).toHaveBeenCalledTimes(1);
      expect(io.removeLabel).toHaveBeenCalledWith(RETRIGGER_LABEL);
    }
  });
});
