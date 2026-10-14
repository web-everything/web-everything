/**
 * @file dispatch-provider-registry.test.mjs — the per-kind mechanical DISPATCH PROVIDER TABLE (#3906).
 *
 * Adapted from the prototype branch (`origin/lane/mechanical-dispatcher`), whose OWN table default is
 * `mechanical` for every row. Main's table (`dispatch-provider-registry.mjs`) is LANDED OFF: every row's
 * `defaultMode` is `'agent'`, because each mechanical provider starts a `*-run.mjs` script that graduates
 * with its own card, and a row whose script is not yet on disk has nothing to run
 * ({@link ../dispatch-lane-io.mjs#routeDispatchProvider} refuses it before any process exists). So this file
 * asserts the OPPOSITE default from the prototype's own suite, and drops every prototype assertion about
 * things main does not have: `buildDispatchModeFromEnv`/`BUILD_DISPATCH_MODE_ENV` (no io-shell back-compat
 * re-export exists on main — the registry is the only place `WE_BUILD_DISPATCH_MODE` is read) and
 * `isDispatchHandleLive` (not part of this registry's surface here).
 *
 * WHAT THIS FILE PROVES:
 *
 *   1. **THE TABLE ONLY NAMES KINDS THE OPERATION WILL DISPATCH**, checked at module load.
 *   2. **EVERY ROW DEFAULTS TO `agent` ON MAIN**, and `dispatchModesFromEnv({})` is all-agent — the landed-off
 *      state #3906 shipped, unlike the prototype's all-mechanical default.
 *   3. **ONE KIND'S OPT-IN ENV VAR FLIPS ONLY THAT KIND** to `mechanical` — `WE_BUILD_DISPATCH_MODE=mechanical`
 *      moves `build` alone.
 *   4. **A TYPO'D MODE STILL THROWS**, for any registered kind's var.
 *   5. **EACH ROW'S `runScript` IS THE PROVIDER MODULE'S OWN EXPORTED `RUN_SCRIPT` CONSTANT** — the registry
 *      names the same script the provider file itself starts, not a second, driftable copy.
 *   6. **`routeDispatchProvider` SENDS AN AGENT-MODE OR UNREGISTERED KIND TO `agent`**, REFUSES (an error with
 *      `.notApplied` truthy) a `mechanical` row whose `scriptExists` says the wrapper is missing — WITHOUT
 *      calling the provider — and calls the row's provider once `scriptExists` says it is there.
 *
 * NOTHING HERE SPAWNS A PROCESS: the registry's own `provider` seam is a plain injected function in every
 * `routeDispatchProvider` case, and the one live-registry case fakes its provider too.
 */

import { describe, it, expect } from 'vitest';

describe('group member launch capability contract', () => {
  it.each(LAUNCH_KINDS)('%s direct agent provider refuses group members', launchKind => {
    expect(() => defaultClaudeProvider({ launchKind, groupMembers: ['124'] }, {
      spawnAgent: () => { throw new Error('must not spawn'); },
    })).toThrow(/group/i);
  });
  it.each(LAUNCH_KINDS.flatMap(kind => ['agent', 'mechanical', 'probation'].map(route => [kind, route])))('%s via %s delivers members or refuses before launch', (launchKind, route) => {
    const request = { launchKind, groupMembers: ['124', '125'], num: '123', lane: 1, sessionSlug: 'group',
      ...(route === 'probation' ? { probationWorker: { id: 'codex', provider: 'codex', model: 'model', taskType: launchKind === 'prepare-item' ? 'prepare' : launchKind === 'ci-heal' ? 'ci-heal' : 'doc-fix' } } : {}),
    };
    const launched = [];
    const deliver = r => { launched.push(r); return 'started'; };
    const io = { agent: deliver, probation: deliver, probationLaunch: route === 'probation' ? 'on' : 'off',
      modes: { [launchKind]: route === 'mechanical' ? 'mechanical' : 'agent' }, scriptExists: () => true,
      registry: { [launchKind]: { provider: deliver } },
    };
    const capable = (launchKind === 'prepare-item' && route === 'probation') || (launchKind === 'build' && route === 'mechanical');
    if (capable) {
      expect(routeDispatchProvider(request, io)).toBe('started');
      expect(launched[0].groupMembers).toEqual(['124', '125']);
    } else {
      expect(() => routeDispatchProvider(request, io)).toThrow(/group/i);
      expect(launched).toEqual([]);
    }
  });
});

import {
  DISPATCH_PROVIDER_REGISTRY,
  dispatchModeFor,
  dispatchModesFromEnv,
  dispatchProviderEntry,
} from '../dispatch-provider-registry.mjs';
import { DELIVER_ITEM_RUN_SCRIPT, deliverItemDetachedProvider } from '../dispatch-providers/build.mjs';
import { FIX_RUN_SCRIPT, fixDetachedProvider } from '../dispatch-providers/fix.mjs';
import { CI_HEAL_RUN_SCRIPT, ciHealDetachedProvider } from '../dispatch-providers/ci-heal.mjs';
import { PREPARE_SCOPE_RUN_SCRIPT, prepareScopeDetachedProvider } from '../dispatch-providers/prepare.mjs';
import { PREPARE_DECISION_RUN_SCRIPT, prepareDecisionDetachedProvider } from '../dispatch-providers/prepare-decision.mjs';
import { routeDispatchProvider, defaultClaudeProvider } from '../dispatch-lane-io.mjs';
import { LAUNCH_KINDS } from '../dispatch-lane.mjs';

/** The launch kinds with no registry row at all (each one's brief-driven agent dispatches its own
 *  lease/verify/PR) — `prepare-item` (#4504) joins `investigate` here for the same reason. */
const UNREGISTERED_KINDS = ['prepare-item', 'investigate'];

/** The provider module each registered kind's row wraps, and its own exported RUN_SCRIPT constant — read off
 *  the provider FILE, never restated as a literal, so a script rename has exactly one place to change and
 *  this test catches a registry entry that drifted from it. */
const PROVIDER_MODULES = {
  build: { provider: deliverItemDetachedProvider, runScript: DELIVER_ITEM_RUN_SCRIPT },
  fix: { provider: fixDetachedProvider, runScript: FIX_RUN_SCRIPT },
  'ci-heal': { provider: ciHealDetachedProvider, runScript: CI_HEAL_RUN_SCRIPT },
  prepare: { provider: prepareScopeDetachedProvider, runScript: PREPARE_SCOPE_RUN_SCRIPT },
  'prepare-decision': { provider: prepareDecisionDetachedProvider, runScript: PREPARE_DECISION_RUN_SCRIPT },
};

/** Every registered kind's mode with NOTHING set in the environment — derived from the table rather than
 *  written out, so a landing sibling lane edits the table and nothing else. */
const defaultModes = () => Object.fromEntries(
  Object.entries(DISPATCH_PROVIDER_REGISTRY).map(([kind, entry]) => [kind, entry.defaultMode]),
);

describe('the dispatch provider registry — the table', () => {
  it('names ONLY launch kinds, and each entry agrees with its own key', () => {
    for (const [key, entry] of Object.entries(DISPATCH_PROVIDER_REGISTRY)) {
      expect(LAUNCH_KINDS).toContain(key);
      expect(entry.kind).toBe(key);
      expect(typeof entry.provider).toBe('function');
      expect(entry.defaultMode === 'mechanical' || entry.defaultMode === 'agent').toBe(true);
      expect(entry.modeEnv === null || (typeof entry.modeEnv === 'string' && entry.modeEnv.length > 0)).toBe(true);
      expect(typeof entry.runScript).toBe('string');
      expect(entry.runScript.length).toBeGreaterThan(0);
    }
  });

  it('is FROZEN — a consumer cannot register a kind by mutating the table it was handed', () => {
    expect(Object.isFrozen(DISPATCH_PROVIDER_REGISTRY)).toBe(true);
    expect(Object.isFrozen(DISPATCH_PROVIDER_REGISTRY.build)).toBe(true);
  });

  // #3906 — LANDED OFF: every row's own default is `agent`, not the prototype's `mechanical`.
  it('EVERY ROW DEFAULTS TO `agent` — the landed-off state main shipped, not the prototype\'s', () => {
    for (const entry of Object.values(DISPATCH_PROVIDER_REGISTRY)) {
      expect(entry.defaultMode).toBe('agent');
    }
    expect(Object.values(DISPATCH_PROVIDER_REGISTRY).every((e) => e.defaultMode === 'agent')).toBe(true);
  });

  it('holds `build`, wired to the deliver-item wrapper behind `WE_BUILD_DISPATCH_MODE`, `agent` by default', () => {
    expect(dispatchProviderEntry('build')).toEqual({
      kind: 'build',
      provider: deliverItemDetachedProvider,
      modeEnv: 'WE_BUILD_DISPATCH_MODE',
      defaultMode: 'agent',
      runScript: DELIVER_ITEM_RUN_SCRIPT,
    });
  });

  it('holds `fix`, wired to the fix wrapper behind `WE_FIX_DISPATCH_MODE`, `agent` by default (#3640)', () => {
    expect(dispatchProviderEntry('fix')).toEqual({
      kind: 'fix',
      provider: fixDetachedProvider,
      modeEnv: 'WE_FIX_DISPATCH_MODE',
      defaultMode: 'agent',
      runScript: FIX_RUN_SCRIPT,
    });
  });

  it('holds `ci-heal`, wired to the ci-heal wrapper behind `WE_CI_HEAL_DISPATCH_MODE`, `agent` by default (#3642)', () => {
    expect(dispatchProviderEntry('ci-heal')).toEqual({
      kind: 'ci-heal',
      provider: ciHealDetachedProvider,
      modeEnv: 'WE_CI_HEAL_DISPATCH_MODE',
      defaultMode: 'agent',
      runScript: CI_HEAL_RUN_SCRIPT,
    });
  });

  it('holds `prepare`, wired behind `WE_PREPARE_DISPATCH_MODE`, `agent` by default (#3641)', () => {
    expect(dispatchProviderEntry('prepare')).toEqual({
      kind: 'prepare',
      provider: prepareScopeDetachedProvider,
      modeEnv: 'WE_PREPARE_DISPATCH_MODE',
      defaultMode: 'agent',
      runScript: PREPARE_SCOPE_RUN_SCRIPT,
    });
  });

  it('holds `prepare-decision`, wired behind `WE_PREPARE_DECISION_DISPATCH_MODE`, `agent` by default (#3644)', () => {
    expect(dispatchProviderEntry('prepare-decision')).toEqual({
      kind: 'prepare-decision',
      provider: prepareDecisionDetachedProvider,
      modeEnv: 'WE_PREPARE_DECISION_DISPATCH_MODE',
      defaultMode: 'agent',
      runScript: PREPARE_DECISION_RUN_SCRIPT,
    });
  });

  // #3906 — each row's `runScript` is the PROVIDER's own exported constant, not a second copy of the path.
  it('each row\'s `runScript` equals its provider module\'s own exported RUN_SCRIPT constant', () => {
    for (const [kind, { provider, runScript }] of Object.entries(PROVIDER_MODULES)) {
      const entry = dispatchProviderEntry(kind);
      expect(entry.provider).toBe(provider);
      expect(entry.runScript).toBe(runScript);
    }
  });
});

describe('dispatchProviderEntry — FAIL CLOSED', () => {
  it('returns null for every kind with no mechanical provider at all — `investigate`', () => {
    expect(LAUNCH_KINDS.filter((k) => !Object.hasOwn(DISPATCH_PROVIDER_REGISTRY, k))).toEqual(UNREGISTERED_KINDS);
    for (const kind of UNREGISTERED_KINDS) expect(dispatchProviderEntry(kind)).toBeNull();
  });

  it('returns null — never a default entry — for an unknown, empty or inherited key', () => {
    expect(dispatchProviderEntry('not-a-kind')).toBeNull();
    expect(dispatchProviderEntry('')).toBeNull();
    expect(dispatchProviderEntry(undefined)).toBeNull();
    expect(dispatchProviderEntry('toString')).toBeNull();
    expect(dispatchProviderEntry('constructor')).toBeNull();
  });

  it('looks up in the registry it is HANDED, so a test never has to mutate the frozen one', () => {
    const fake = Object.freeze({ 'ci-heal': { kind: 'ci-heal', provider: () => 'x', modeEnv: null, defaultMode: 'mechanical', runScript: '/x' } });
    expect(dispatchProviderEntry('ci-heal', fake).kind).toBe('ci-heal');
    expect(dispatchProviderEntry('build', fake)).toBeNull();
  });
});

describe('dispatchModeFor — a typo must never pick a path', () => {
  const entry = dispatchProviderEntry('build');

  it('defaults to `agent` when the var is unset or empty, and accepts both legal values', () => {
    expect(dispatchModeFor(entry, {})).toBe('agent');
    expect(dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: '' })).toBe('agent');
    expect(dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: '   ' })).toBe('agent');
    expect(dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: 'mechanical' })).toBe('mechanical');
    expect(dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: ' MECHANICAL ' })).toBe('mechanical');
    expect(dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: 'agent' })).toBe('agent');
  });

  it('THROWS on anything else, naming the env var and both legal values', () => {
    expect(() => dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: 'mechnical' })).toThrow(TypeError);
    expect(() => dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: 'mechnical' }))
      .toThrow(/WE_BUILD_DISPATCH_MODE must be .*mechanical.*agent/s);
    expect(() => dispatchModeFor(entry, { WE_BUILD_DISPATCH_MODE: 'mechnical' })).toThrow(/mechnical/);
  });

  it('`modeEnv: null` means no opt-out at all — the default, with nothing read and nothing to typo', () => {
    const noOptOut = { kind: 'ci-heal', provider: () => 'x', modeEnv: null, defaultMode: 'agent', runScript: '/x' };
    expect(dispatchModeFor(noOptOut, { WE_BUILD_DISPATCH_MODE: 'mechanical' })).toBe('agent');
    expect(dispatchModeFor(noOptOut, { FIX: 'nonsense' })).toBe('agent');
  });
});

describe('dispatchModesFromEnv — ALL-AGENT with nothing set, one kind\'s var flips only that kind', () => {
  it('`dispatchModesFromEnv({})` is all-agent — main\'s landed-off state', () => {
    const modes = dispatchModesFromEnv({});
    expect(modes).toEqual(defaultModes());
    expect(Object.values(modes).every((m) => m === 'agent')).toBe(true);
    expect(Object.keys(modes)).toEqual(Object.keys(DISPATCH_PROVIDER_REGISTRY));
  });

  it('`WE_BUILD_DISPATCH_MODE=mechanical` flips ONLY `build`, every other kind stays `agent`', () => {
    const modes = dispatchModesFromEnv({ WE_BUILD_DISPATCH_MODE: 'mechanical' });
    expect(modes).toEqual({ ...defaultModes(), build: 'mechanical' });
    expect(modes.fix).toBe('agent');
    expect(modes['ci-heal']).toBe('agent');
    expect(modes.prepare).toBe('agent');
    expect(modes['prepare-decision']).toBe('agent');
  });

  it('a typo in ANY one kind\'s var throws HERE, before a single dispatch', () => {
    expect(() => dispatchModesFromEnv({ WE_BUILD_DISPATCH_MODE: 'mechnical' })).toThrow(/must be/);
    expect(() => dispatchModesFromEnv({ WE_FIX_DISPATCH_MODE: 'mechnical' })).toThrow(/must be/);
  });

  it('walks the registry it is handed, not the real one', () => {
    const fake = Object.freeze({
      'ci-heal': { kind: 'ci-heal', provider: () => 'x', modeEnv: 'WE_CI_HEAL_DISPATCH_MODE', defaultMode: 'agent', runScript: '/x' },
    });
    expect(dispatchModesFromEnv({ WE_CI_HEAL_DISPATCH_MODE: 'mechanical' }, fake)).toEqual({ 'ci-heal': 'mechanical' });
    expect(dispatchModesFromEnv({}, fake)).toEqual({ 'ci-heal': 'agent' });
  });
});

describe('routeDispatchProvider — the registry is the only per-kind knowledge, and a missing script refuses BEFORE any process', () => {
  const agentSpy = (seen) => (r) => { seen.push(['agent', r.launchKind]); return 'abc'; };

  it('sends an AGENT-MODE registered kind to the agent path, never the row\'s provider', () => {
    const seen = [];
    const registry = Object.freeze({
      build: { kind: 'build', provider: () => { seen.push(['entry', 'build']); return 'pid:1'; }, modeEnv: 'X', defaultMode: 'agent', runScript: '/x' },
    });
    const handle = routeDispatchProvider({ launchKind: 'build' }, {
      registry, modes: { build: 'agent' }, agent: agentSpy(seen),
    });
    expect(handle).toBe('abc');
    expect(seen).toEqual([['agent', 'build']]);
  });

  it('sends an UNREGISTERED kind to the agent path regardless of what `modes` says', () => {
    const seen = [];
    for (const kind of UNREGISTERED_KINDS) {
      routeDispatchProvider({ launchKind: kind, num: '1', lane: 1, sessionSlug: 's' }, {
        modes: Object.fromEntries(LAUNCH_KINDS.map((k) => [k, 'mechanical'])),
        agent: agentSpy(seen),
      });
    }
    expect(seen.map(([, k]) => k)).toEqual(UNREGISTERED_KINDS);
  });

  it('refuses a MECHANICAL row whose wrapper script is missing — `.notApplied` is truthy, and the provider is NEVER called', () => {
    const seen = [];
    const registry = Object.freeze({
      build: {
        kind: 'build',
        provider: () => { seen.push('provider-called'); return 'pid:1'; },
        modeEnv: 'WE_BUILD_DISPATCH_MODE', defaultMode: 'agent', runScript: '/nonexistent/deliver-item-run.mjs',
      },
    });
    let caught = null;
    try {
      routeDispatchProvider({ launchKind: 'build' }, {
        registry, modes: { build: 'mechanical' }, agent: agentSpy(seen), scriptExists: () => false,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.notApplied).toBeTruthy();
    expect(String(caught.message)).toContain('/nonexistent/deliver-item-run.mjs');
    // NEITHER path ran — not the provider, not the agent fallback.
    expect(seen).toEqual([]);
  });

  it('calls the row\'s provider once `scriptExists` says the wrapper IS there — no process starts (fake registry)', () => {
    const seen = [];
    const registry = Object.freeze({
      build: {
        kind: 'build',
        provider: (r) => { seen.push(['entry', r.launchKind]); return 'pid:42'; },
        modeEnv: 'WE_BUILD_DISPATCH_MODE', defaultMode: 'agent', runScript: '/fake/deliver-item-run.mjs',
      },
    });
    const handle = routeDispatchProvider({ launchKind: 'build' }, {
      registry, modes: { build: 'mechanical' }, agent: agentSpy(seen), scriptExists: () => true,
    });
    expect(handle).toBe('pid:42');
    expect(seen).toEqual([['entry', 'build']]);
  });

  it('a missing `launchKind` is treated as `build` for the LOOKUP, exactly as before the registry', () => {
    const seen = [];
    // A `mechanical` mode for `build` proves the lookup resolved `build` from the absent `launchKind` — an
    // unregistered/miss-keyed lookup would fall to `agent` regardless of `modes`, which would not distinguish
    // this from a lookup that resolved nothing at all.
    const registry = Object.freeze({
      build: { kind: 'build', provider: (r) => { seen.push(['entry', r]); return 'pid:1'; }, modeEnv: 'X', defaultMode: 'agent', runScript: '/x' },
    });
    expect(routeDispatchProvider({}, {
      registry, modes: { build: 'mechanical' }, agent: agentSpy(seen), scriptExists: () => true,
    })).toBe('pid:1');
    expect(seen).toEqual([['entry', {}]]);
  });
});

describe('THE DEFAULT PATH — an empty environment is all-agent, so the sink\'s default provider never reaches a wrapper', () => {
  it('an EMPTY env means `agent` for every registered kind — nothing has to be set to keep today\'s behaviour', () => {
    expect(dispatchModesFromEnv({})).toEqual(defaultModes());
    expect(Object.values(dispatchModesFromEnv({})).every((m) => m === 'agent')).toBe(true);
    expect(Object.keys(dispatchModesFromEnv({})).length).toBeGreaterThan(0);
  });

  it('routeDispatchProvider with the REAL registry and REAL default modes sends `build` to the agent path', () => {
    const seen = [];
    const handle = routeDispatchProvider({ launchKind: 'build' }, {
      modes: dispatchModesFromEnv({}),
      agent: (r) => { seen.push(r.launchKind); return 'abc'; },
    });
    expect(handle).toBe('abc');
    expect(seen).toEqual(['build']);
  });
});

describe('grouped mechanical build argv', () => {
  it('passes members to the detached delivery process', async () => {
    const calls = [];
    await deliverItemDetachedProvider({ num: '1', lane: '2', sessionSlug: 'conveyor-1', groupMembers: ['2', 'xabc123'] }, {
      spawnDetached: (argv) => { calls.push(argv); return { pid: 123 }; },
      logPathFor: () => '/tmp/group-provider.log', readDeliveryAgentMarker: () => null,
    });
    expect(calls[0]).toContain('--group-members=2,xabc123');
  });
});
