import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nodeFs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as adoption from '../adopt.mjs';
import { prepareRebuild, readOverlayEventLog } from '../prepare.mjs';
import { writeReadyCandidate, writeRebuildState } from '../state.mjs';
import * as planner from '../plan.mjs';
import * as edgeFetch from '../edge-fetch.mjs';
import * as localState from '../local-state.mjs';
import * as lease from '../lease.mjs';
import * as repair from '../../lane-repair.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath, readOverlays, removeOverlay } from '../../daemon-overlays.mjs';
import { removeRegistration, retireRegistration } from '../../../daemon-overlay.mjs';
import { createPrototypeLoader } from '../../../operations/prototype-load-io.mjs';
import { OPERATOR_LOGINS } from '../../marker-authorship.mjs';

const ref = 'lane/overlay-fix';
const sha = 'a'.repeat(40);
const added = { kind: 'added', ref, at: '2026-11-14T10:00:00Z' };
const actor = OPERATOR_LOGINS[0];
const removed = { kind: 'auto-retired', ref, tip: sha, by: 'operator', actor, reason: 'retire fix', at: '2026-11-14T11:00:00Z' };
// The last appended add is older than retirement; the earlier appended add is newer.
const outOfOrderAdds = [{ ...added, at: '2026-11-14T12:00:00Z' }, added, removed];

describe('operator retirement of a live overlay', () => {
  let root, env;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'overlay-retirement-'));
    env = { ...process.env, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays') };
    addOverlay(root, { ref }, { env });
    appendOverlayEvent(root, added, { env });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function match(events = readOverlayEventLog(root, env), extra = {}) {
    return adoption.matchReadyCandidate({
      ready: { kind: 'candidate', prevHead: 'live', passedAt: '2026-11-15T10:00:00Z',
        tree: 'candidate-tree', adopt: { finalSha: 'candidate', applied: [] } },
      plan: { finalSha: 'newer-plan' }, prevHead: 'live', treeOf: () => 'plan-tree',
      stillWanted: () => true, verifyBuilt: () => true,
      nowMs: Date.parse('2026-11-15T10:01:00Z'), maxAgeMs: 3_600_000,
      liveApplied: [{ ref, sha }],
      retiredByOperator: (a) => adoption.overlayRetiredByOperator?.({ ...a, events,
        registered: (r) => readOverlays(root, { env }).some((o) => o.ref === r) }) ?? false,
      ...extra,
    });
  }

  function refused(result = match()) {
    expect(result).toMatchObject({ adopt: null, reason: `superseded-omits-live-overlay: ${ref}`, omitted: [ref] });
  }

  function loader(identity = () => ({ login: actor.toUpperCase(), type: 'User' })) {
    return createPrototypeLoader({ fs: nodeFs, env: { ...env, HOME: root }, now: () => 0,
      sleep: () => { throw new Error('unexpected sleep'); }, resolveOperatorIdentity: identity,
      settings: { workspaceRoot: root, daemons: { control: { clone: root } }, loaderCli: 'scripts/daemon-overlay.mjs', recordPath: join(root, 'records.jsonl') },
      exec: (command, args) => {
        if (command === 'node' && args[1] === 'list') return JSON.stringify({ list: readOverlays(root, { env }) });
        if (command === 'git' && args[0] === 'fetch') return '';
        if (command === 'git' && args[0] === 'rev-parse') return sha;
        if (command === 'git' && args[0] === 'ls-remote') return `${sha}\trefs/heads/${ref}`;
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      } });
  }

  it('real prototype-load --remove verifies the actor and produces adoptable auto-retired evidence', async () => {
    expect(await loader()({ daemon: 'control', remove: ref, actor: actor.toUpperCase(), reason: 'withdraw live fix' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).toMatchObject({ kind: 'auto-retired', ref, actor,
      operatorReason: true, by: env.USER || 'prototype-load', reason: 'withdraw live fix', tip: sha });
    expect(match()).toMatchObject({ adopt: { finalSha: 'candidate' }, retired: [ref] });
  });

  it.each([
    ['non-operator', 'outsider', () => ({ login: 'outsider', type: 'User' })],
    ['mismatched actor', 'outsider', () => ({ login: actor, type: 'User' })],
    ['bot identity', actor, () => ({ login: actor, type: 'Bot' })],
    ['unreadable identity', actor, () => { throw new Error('identity unavailable'); }],
  ])('prototype-load refuses %s --actor without removing anything', async (_name, declared, identity) => {
    const before = readOverlays(root, { env });
    expect(await loader(identity)({ daemon: 'control', remove: ref, actor: declared, reason: 'withdraw' }))
      .toMatchObject({ ok: false, stopReason: 'operator-identity-refused', removed: [] });
    expect(readOverlays(root, { env })).toEqual(before);
    expect(readOverlayEventLog(root, env)).toEqual([added]);
  });

  it('automatic retireRegistration supplies no operator proof', async () => {
    expect(await retireRegistration({ root, ref, expectedTip: sha, env, by: 'prototype-load', deps: {
      prove: () => ({ action: 'retire', tip: sha, reason: 'in-main' }), tip: () => sha,
    } })).toMatchObject({ retired: true });
    const event = readOverlayEventLog(root, env).at(-1);
    expect(event).toMatchObject({ kind: 'auto-retired', reason: 'in-main', tip: sha });
    expect(event).not.toHaveProperty('actor');
    expect(event).not.toHaveProperty('operatorReason');
    refused();
  });

  it('prototype-load without an actor removes but cannot authorize omission of a live overlay', async () => {
    expect(await loader(() => { throw new Error('must not resolve absent actor'); })({ daemon: 'control', remove: ref, reason: 'withdraw' }))
      .toMatchObject({ ok: true, removed: [ref] });
    expect(readOverlayEventLog(root, env).at(-1)).not.toHaveProperty('actor');
    refused();
  });

  it('refuses a removed event even with an allowlisted actor, matching tip and reason', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, { ...removed, kind: 'removed' }]));
    refused(match([added, removed, { ...removed, kind: 'removed' }]));
  });

  it('auto-retired requires operator evidence and accepts it case-insensitively', () => {
    removeOverlay(root, ref, { env });
    expect(match([added, { ...removed, actor: actor.toUpperCase() }])).toMatchObject({
      adopt: { finalSha: 'candidate' }, retired: [ref],
    });
    for (const invalid of [{ actor: undefined }, { actor: 'outsider' }, { reason: ' ' }, { tip: 'b'.repeat(40) }]) {
      refused(match([added, { ...removed, ...invalid }]));
    }
    refused(match([added, removed, { ...removed, kind: 'auto-retired', actor: undefined }]));
  });

  it('still discards a candidate after hand removal without a record', () => {
    removeOverlay(root, ref, { env });
    refused();
  });

  it.each([
    'operator-retired', 'hand-removed', 're-registered', 'removed-by-plan',
    'unreadable-events', 'retirement-recorded-during-plan',
  ])(
    'prepareRebuild wires live registration and event evidence for %s', async (removal) => {
      // The real prepare phase reads both registry snapshots and the on-disk audit trail.
      // Git, planning and move/build effects are stubbed; no checkout or network is touched.
      env = { ...env, WE_DAEMON_STATE_DIR: join(root, 'state'),
        WE_DAEMON_EVENTS: join(root, 'daemon-events.jsonl'), WE_DAEMON_AUTO_REBASE: '0' };
      const liveHead = 'b'.repeat(40);
      const mainSha = 'c'.repeat(40);
      const candidate = 'd'.repeat(40);
      const plan = { ok: true, finalSha: 'e'.repeat(40), mainSha,
        inputsKey: 'new-plan', applied: [], decisions: [], alerts: [] };
      writeRebuildState(root, { adopted: { head: liveHead, mainSha, applied: [{ ref, sha }] } }, env);
      writeReadyCandidate(root, { kind: 'candidate', prevHead: liveHead,
        passedAt: '2026-11-15T10:00:00Z', tree: 'candidate-tree',
        adopt: { finalSha: candidate, mainSha, inputsKey: 'ready-plan', applied: [] } }, env);
      if (removal === 'removed-by-plan') {
        appendOverlayEvent(root, removed, { env });
        plan.decisions.push({ ref, action: 'remove', reason: 'pr-closed' });
      } else if (removal === 'hand-removed' || removal === 'retirement-recorded-during-plan') removeOverlay(root, ref, { env });
      else {
        expect(await loader()({ daemon: 'control', remove: ref, actor, reason: 'withdraw live fix' }))
          .toMatchObject({ ok: true, removed: [ref] });
        if (removal === 're-registered') addOverlay(root, { ref }, { env });
        if (removal === 'unreadable-events') {
          const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
          writeFileSync(file, `${readFileSync(file, 'utf8')}unreadable\n`);
        }
      }
      vi.spyOn(localState, 'ensureSafeToMove').mockReturnValue({ safe: true, untracked: [] });
      vi.spyOn(repair, 'repairCloneRefs').mockReturnValue({ ok: true, pruned: [], reportedNew: [] });
      vi.spyOn(edgeFetch, 'fetchMainAndOverlays').mockReturnValue({ ok: true, goneRefs: [] });
      vi.spyOn(planner, 'planRebuild').mockImplementation(async () => {
        if (removal === 'retirement-recorded-during-plan') appendOverlayEvent(root, removed, { env });
        return plan;
      });
      vi.spyOn(adoption, 'readyBuildVerified').mockReturnValue(true);
      vi.spyOn(lease, 'claimBuildLease').mockReturnValue(null);
      const matching = vi.spyOn(adoption, 'matchReadyCandidate');
      const retirement = vi.spyOn(adoption, 'overlayRetiredByOperator');
      const finalize = vi.spyOn(adoption, 'finalizeRebuild').mockResolvedValue({ moved: true, head: candidate });
      const run = (args) => {
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (args[0] === 'symbolic-ref') return ok('main');
        if (args[0] === 'rev-parse') {
          const rev = args.at(-1);
          if (rev === 'HEAD') return ok(liveHead);
          if (rev === 'origin/main^{commit}') return ok(mainSha);
          if (rev === `${plan.finalSha}^{tree}`) return ok('plan-tree');
        }
        if (args[0] === 'ls-files' || args[0] === 'log') return ok();
        if (['merge-base', 'merge-tree', 'config'].includes(args[0])) return { status: 1, stdout: '', stderr: '' };
        throw new Error(`unexpected Git: ${args.join(' ')}`);
      };
      await prepareRebuild({ root, env, run, now: () => Date.parse('2026-11-15T10:01:00Z'),
        mainOnly: false, adoptOnly: true, prBaseChain: () => [] });
      expect(matching).toHaveBeenCalledOnce();
      expect(matching.mock.calls[0][0].liveApplied).toEqual([{ ref, sha }]);
      expect(retirement).toHaveBeenCalledOnce();
      // A same-tick drop clears registeredRefs but must retain overlaysBefore's veto.
      expect(retirement.mock.calls[0][0].registered(ref))
        .toBe(removal === 're-registered' || removal === 'removed-by-plan');
      const result = matching.mock.results[0].value;
      if (removal === 'operator-retired' || removal === 'retirement-recorded-during-plan') {
        expect(result).toMatchObject({ adopt: { finalSha: candidate }, retired: [ref] });
        expect(finalize).toHaveBeenCalledOnce();
      } else if (removal === 're-registered') {
        // Adopt the build that passed, then add: the overlay is registered again, so the next rebuild carries it.
        expect(result).toMatchObject({ adopt: { finalSha: candidate }, rebuildAfter: [ref] });
        expect(finalize).toHaveBeenCalledOnce();
      } else {
        refused(result);
        expect(finalize).not.toHaveBeenCalled();
      }
    },
  );

  it('removeRegistration records tip/by/reason but drops a caller-supplied actor and refuses adoption', () => {
    expect(removeRegistration({ root, ref, by: 'operator', actor, reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    const events = readOverlayEventLog(root, env);
    expect(events.at(-1)).toMatchObject({ kind: 'removed', ref, tip: sha, by: 'operator', reason: 'retire fix' });
    expect(events.at(-1)).not.toHaveProperty('actor');
    expect(Number.isFinite(Date.parse(events.at(-1).at))).toBe(true);
    refused(match(events));
  });

  it.each([
    ['no actor (legacy record)', { ...removed, actor: undefined }],
    ['non-operator actor', { ...removed, actor: 'unregistered[bot]' }],
    ['non-string actor', { ...removed, actor: [actor] }],
    ['wrong sha', { ...removed, tip: 'b'.repeat(40) }],
    ['missing sha', { ...removed, tip: undefined }],
    ['empty reason', { ...removed, reason: '  ' }],
    ['missing time', { ...removed, at: undefined }],
    ['invalid time', { ...removed, at: 'invalid' }],
    ['older than added', { ...removed, at: '2026-11-14T09:00:00Z' }],
    ['same time as added', { ...removed, at: added.at }],
    ['different ref', { ...removed, ref: 'lane/other' }],
  ])('refuses retirement evidence with %s', (_name, record) => {
    removeOverlay(root, ref, { env });
    refused(match([added, record]));
  });

  it('accepts a registered operator actor case-insensitively with a reason', () => {
    removeOverlay(root, ref, { env });
    expect(match([added, { ...removed, actor: actor.toUpperCase() }])).toMatchObject({
      adopt: { finalSha: 'candidate' }, retired: [ref],
    });
  });

  it('removal without an actor still removes but supplies no retirement proof', () => {
    expect(removeRegistration({ root, ref, reason: 'retire fix', env,
      deps: { tip: () => sha } }).removed).toBe(true);
    expect(readOverlayEventLog(root, env).at(-1)).not.toHaveProperty('actor');
    refused();
  });

  it('refuses a stale record after a later re-add even when removed again by hand', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed, { ...added, at: '2026-11-14T12:00:00Z' }]));
  });

  function refusesRetirementOlderThanAnyPrecedingAdd(predicate = adoption.overlayRetiredByOperator) {
    removeOverlay(root, ref, { env });
    // Append order is deliberately different from timestamp order: only the LAST
    // appended add is older than retirement. Checking just that add, or any add, is unsafe.
    const events = outOfOrderAdds;
    refused(match(events, { retiredByOperator: (a) => predicate({ ...a, events,
      registered: (r) => readOverlays(root, { env }).some((o) => o.ref === r) }) }));
  }

  it('refuses retirement older than any preceding add despite an older final appended add', () => {
    refusesRetirementOlderThanAnyPrecedingAdd();
  });

  it.each(['added.slice(-1).every(', 'added.some('])(
    'multi-add regression detects the %s chronology mutation', (replacement) => {
      // Mutate an isolated function in memory; never remove a guard from the working tree.
      // Read native source so Vitest's rewritten import bindings cannot mask the mutation.
      // Resolve a Node path so Vite cannot rewrite the read as a browser asset URL.
      const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../adopt.mjs'), 'utf8')
        .match(/export (function overlayRetiredByOperator\([\s\S]*?\n\})/)[1];
      expect(source).toContain('added.every(');
      const mutant = new Function('OPERATOR_LOGINS', `return (${source.replace('added.every(', replacement)});`)(OPERATOR_LOGINS);
      expect(mutant({ ref, sha, events: outOfOrderAdds, registered: () => false })).toBe(true);
      expect(() => refusesRetirementOlderThanAnyPrecedingAdd(mutant)).toThrow();
    },
  );

  it('refuses a still-registered ref', () => refused(match([added, removed])));

  it('refuses when an unknown lifecycle event follows the removal', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed, { kind: 'mystery', ref, at: '2026-11-14T12:00:00Z' }]));
  });

  it('refuses unknown add chronology', () => {
    removeOverlay(root, ref, { env });
    refused(match([{ ...added, at: undefined }, removed]));
  });

  it('refuses unreadable events instead of using a valid prefix', () => {
    removeOverlay(root, ref, { env });
    appendOverlayEvent(root, removed, { env });
    const file = overlayFilePath(root, env).replace(/\.json$/, '.events.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}unreadable\n`);
    refused();
    rmSync(file);
    refused();
  });

  it('removal without a non-empty reason supplies no retirement proof', () => {
    removeRegistration({ root, ref, actor, reason: ' ', env, deps: { tip: () => sha } });
    refused();
  });

  it('an unreadable removed tip supplies no retirement proof', () => {
    removeRegistration({ root, ref, actor, reason: 'retire fix', env, deps: { tip: () => undefined } });
    refused();
  });

  it('refuses by default when no retirement predicate is injected', () => {
    removeOverlay(root, ref, { env });
    refused(match([added, removed], { retiredByOperator: undefined }));
  });
});
