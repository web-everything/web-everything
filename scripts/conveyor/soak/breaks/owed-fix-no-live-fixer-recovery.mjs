/** Replay bounded owed-fix recovery against the supplied checkout, never source markers. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

export function probe(checkout, scenario = 'all') {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { deepStrictEqual, strictEqual, ok } from 'node:assert';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [checkout, scenario] = process.argv.slice(1);
    const recovery = await import(pathToFileURL(join(checkout, 'scripts/conveyor/owed-fix-recovery.mjs')));
    const { recoverOwedFixes } = recovery;
    const reconcilePass = await import(pathToFileURL(join(checkout, 'scripts/conveyor/reconcile-pass.mjs')));
    const minute = 60_000;
    const head = 'a'.repeat(40);
    function fixture(overrides = {}) {
      const now = Date.parse('2026-11-01T12:00:00Z');
      const repo = 'we';
      const row = { kind: 'fix', prNumber: 2345, headRefOid: head };
      const claim = { owner: 'stale-owner', heartbeatAt: new Date(now - 31 * minute).toISOString(),
        meta: { repo, pr: 2345, kind: 'fixing', headSha: head, who: 'missing-fixer',
          claimedAt: new Date(now - 31 * minute).toISOString() } };
      const input = { repo, now, agents: [], prs: [{ number: 2345, state: 'OPEN',
        headRefOid: head, labels: [{ name: 'review:changes' }], fixClaim: claim, ...overrides }] };
      let claims = [claim];
      const state = new Map();
      const released = [], published = [], updates = [];
      const deps = {
        plan: value => ({ dispatch: value.prs[0].fixClaim ? [] : [{ ...row }],
          refusals: value.prs[0].fixClaim ? [{ kind: 'fix-claimed', prNumber: 2345 }] : [], notes: [] }),
        readLive: () => ({ headRefOid: head, state: 'OPEN', isDraft: false, labels: [{ name: 'review:changes' }] }),
        readClaims: () => structuredClone(claims),
        transact: (key, fn) => fn(structuredClone(state.get(key) ?? {}),
          next => state.set(key, structuredClone(next))),
        releaseClaim: value => {
          deepStrictEqual(value, { repo, pr: 2345, kind: 'fixing', owner: claim.owner, expected: claim });
          released.push(value); claims = []; return { released: true };
        },
        publish: value => { published.push(value); return true; },
        appendUpdate: value => { updates.push(value); return true; },
        authGate: () => ({ paused: false }),
        awaitingVerifyFor: () => ({ awaiting: false }),
        runnerDead: () => true,
      };
      return { input, deps, row, released, published, updates, state,
        tick: () => recoverOwedFixes(input, deps) };
    }
    const cases = {
      // Live PR #7336 red team: the daemon reconciles through its pass plan cache, which serves STRUCTURED CLONES
      // (and the routed CI-heal lambda wraps that again). Recovery must still run on such a plan.
      cachedPlan() {
        const { rememberOwedFixRecoveryInput, owedFixRecoveryInput } = reconcilePass;
        const f = fixture();
        const plan = { ...f.deps.plan(f.input), owedFixRecovery: rememberOwedFixRecoveryInput(f.input) };
        const served = structuredClone(plan);
        recovery.applyOwedFixRecovery(served, { kinds: ['fix'], input: owedFixRecoveryInput(served), io: f.deps,
          log: () => {} });
        deepStrictEqual(served.dispatch, [f.row], 'a cached plan clone must still restore the stale-claim repair');
        strictEqual(f.released.length, 1);
      },
      // Live PR #7336 red team: capacity refused the launch at minutes 0 and 30. The allowance must survive, so
      // the repair launches when capacity frees (minute 31) and nothing escalates.
      capacityDeferral() {
        const f = fixture({ fixClaim: null });
        f.deps.readClaims = () => [];
        const tick = launch => {
          const ledger = recovery.createOwedFixRecoveryLedger({ transact: f.deps.transact, log: () => {} });
          const out = recoverOwedFixes(f.input, { ...f.deps, ledger });
          if (launch && out.dispatch.length) ledger.attempting(2345);
          ledger.settle();
          return out.dispatch.length;
        };
        const offered = [];
        offered.push(tick(false));
        f.input.now += 30 * minute; offered.push(tick(false));
        f.input.now += minute; offered.push(tick(true));
        f.input.now += 29 * minute; offered.push(tick(true));
        deepStrictEqual(offered, [1, 1, 1, 0], 'deferred launches must keep the allowance; the real launch then waits');
        strictEqual(f.published.length, 0, 'a never-launched repair must not escalate');
        strictEqual(f.updates.length, 0);
      },
      recovery() {
        const f = fixture();
        deepStrictEqual(f.tick().dispatch, [f.row], 'stale claim must restore the exact repair row');
        strictEqual(f.released.length, 1, 'stale claim must be released');
        f.input.prs[0].fixClaim = null;
        for (let i = 0; i < 2; i++) deepStrictEqual(f.tick().dispatch, [], 'same head must dispatch only once');
        strictEqual(f.released.length, 1, 'same claim must be released only once');
        strictEqual(f.published.length, 0, 'do not escalate before the second window');
        strictEqual(f.updates.length, 0);
      },
      escalation() {
        const f = fixture();
        deepStrictEqual(f.tick().dispatch, [f.row]);
        strictEqual(f.released.length, 1);
        f.input.prs[0].fixClaim = null;
        f.input.now += 31 * minute;
        for (let i = 0; i < 3; i++) {
          deepStrictEqual(f.tick().dispatch, [], 'second miss must never dispatch again');
          f.input.now += 31 * minute;
        }
        strictEqual(f.published.length, 1, 'publish escalation exactly once');
        strictEqual(f.updates.length, 1, 'append escalation exactly once');
        strictEqual(f.released.length, 1);
        strictEqual(f.published[0].pr, 2345);
        strictEqual(f.published[0].head, head);
        strictEqual(f.published[0].kind, 'needs-you');
        strictEqual(f.updates[0].head, head);
      },
      parked() {
        for (const override of [{ isDraft: true }, { referralHold: { kind: 'operator' } }]) {
          const f = fixture(override);
          for (let i = 0; i < 2; i++) {
            deepStrictEqual(f.tick().dispatch, [], 'operator park/draft must block dispatch');
            f.input.now += 31 * minute;
          }
          deepStrictEqual(f.released, [], 'operator park/draft must preserve claims');
          deepStrictEqual(f.published, []);
          deepStrictEqual(f.updates, []);
        }
      },
      unreadable() {
        for (const agents of [null, undefined, {}]) {
          const f = fixture();
          f.input.agents = agents;
          const result = f.tick();
          deepStrictEqual(result.dispatch, [], 'unknown liveness must refuse dispatch');
          ok(result.refusals.length > 0, 'unknown liveness must report refusal');
          deepStrictEqual(f.released, [], 'unknown liveness must preserve claims');
          deepStrictEqual(f.published, []);
          deepStrictEqual(f.updates, []);
        }
      },
    };
    if (scenario === 'all') Object.values(cases).forEach(run => run());
    else { ok(Object.hasOwn(cases, scenario)); cases[scenario](); }
  `, checkout, scenario], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  return { violations: child.status === 0 ? [] : [
    `owed-fix recovery replay failed: ${child.error?.message || child.stderr || child.signal || child.status}`,
  ] };
}

export default {
  id: 'owed-fix-no-live-fixer-recovery',
  title: 'owed fixes recover once without a live fixer (through cached plans), keep the allowance on a capacity deferral, then escalate once',
  card: 'owed-fix recovery soak precheck',
  fixedBy: { sha: 'HEAD', where: 'main', paths: ['scripts/conveyor/owed-fix-recovery.mjs'] },
  fixPresent: checkout => probe(checkout).violations.length === 0,
  run: () => probe(root),
  judge: report => report.violations,
};
