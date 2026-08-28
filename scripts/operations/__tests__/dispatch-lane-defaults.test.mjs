/**
 * @file dispatch-lane-defaults.test.mjs — the DEFAULT spawners, which nothing used to execute (#3037).
 *
 * WHY THIS FILE EXISTS. `dispatch-lane-io.mjs` injects every subprocess call, and every other test overrides
 * every one of them — which is exactly right for testing the logic and exactly wrong for testing the DEFAULTS.
 * PR #1211's review made the point with mutations: all three timeouts (F5) and the observer's deliberate
 * absence of `--all` (F6) could be deleted with the whole suite green, because the code carrying them ran in no
 * test at all. Those are among the most emphatic claims the module makes — the `--all` docblock calls passing it
 * *"the one mistake that makes an observer worse than none"* — and a claim asserted by nothing is a claim the
 * next refactor removes for free.
 *
 * NO PROCESS IS STARTED HERE. The three default functions take an `execFileSync`-shaped call for exactly this
 * reason; each test hands them a spy and asserts the argv and the option bag they build.
 */

import { describe, it, expect } from 'vitest';

import {
  BRIEF_PLACEHOLDERS,
  BRIEF_TOKEN_RE,
  DISPATCH_EFFECT,
  DISPATCH_LISTING_GRACE_MINUTES,
  fillBrief,
} from '../dispatch-lane.mjs';
import {
  LIST_TIMEOUT_ENV,
  LIST_TIMEOUT_MS,
  LISTING_GRACE_MS,
  PR_LIST_JSON_FIELDS,
  PR_LIST_LIMIT,
  PR_LIST_TIMEOUT_ENV,
  PR_LIST_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
  TICK_TIMEOUT_MS,
  createDispatchObservers,
  createDispatchSinks,
  defaultListAgents,
  defaultListPrs,
  defaultRunNode,
  defaultSpawnAgent,
  listTimeoutMs,
  prListTimeoutMs,
  readTick,
} from '../dispatch-lane-io.mjs';

/** An `execFileSync`-shaped spy that records its call and answers with `out`. */
function spyExec(out = '[]') {
  const calls = [];
  const exec = (file, argv, opts) => { calls.push({ file, argv, opts }); return out; };
  return { exec, calls };
}

describe('the default subprocess calls are BOUNDED — every one of them', () => {
  it('the tick read is bounded, and it is the only network-bound call in the module', () => {
    // `tick-core` shells `conveyor-state`, `dispatch-plan`, the free-lane picker and one `gh pr view` per
    // bounced PR, and it runs synchronously inside the CLI. A wedged `gh` must not hang a caller forever.
    const { exec, calls } = spyExec('{}');
    defaultRunNode(['/repo/scripts/conveyor/tick-core.mjs'], { cwd: '/repo', input: '{}' }, { exec });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].opts).toMatchObject({ timeout: TICK_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' });
    // The caller's own opts still ride, and still cannot be silently dropped by the default.
    expect(calls[0].opts).toMatchObject({ cwd: '/repo', input: '{}' });
  });

  it('the agent spawn is bounded — `claude --bg` returns immediately, so a hang here is a hang in the executor', () => {
    const { exec, calls } = spyExec('');
    defaultSpawnAgent(['--bg', '--session-id', 'sess-x', '-n', 'conveyor-3037', 'go'], { cwd: '/repo' }, { exec });
    expect(calls[0].file).toBe('claude');
    expect(calls[0].opts).toMatchObject({ timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' });
    expect(calls[0].opts.cwd).toBe('/repo');
  });

  it('the agent listing is bounded — it sits inside a waker pass that promises to be fail-soft per run', () => {
    const { exec, calls } = spyExec('[]');
    defaultListAgents({ exec, env: {} });
    // THE LITERAL, not only the constant: fifteen seconds is the claim, and a test written as
    // `timeout: LIST_TIMEOUT_MS` alone stays true for any value the constant is changed to.
    expect(LIST_TIMEOUT_MS).toBe(15 * 1000);
    expect(calls[0].opts).toMatchObject({ timeout: LIST_TIMEOUT_MS, killSignal: 'SIGKILL' });
  });

  // ── PR #1211 round 2, G3 — the bound is REACHABLE, which is what de-flakes the waker CLI test ──────────────

  it('the listing bound is overridable from the environment, and `0` means UNBOUNDED', () => {
    // `wake-cli.test.mjs` drives the real CLI in a child process; under the gate's fork storm its stub
    // `claude` could not always complete inside 15 seconds, `execFileSync` SIGKILLed it, and one assertion
    // failed roughly one run in five. The child now sets this to `0` — Node reads that as no timeout at all —
    // so the assertion races no wall clock, rather than racing a longer one.
    expect(listTimeoutMs({})).toBe(LIST_TIMEOUT_MS);
    expect(listTimeoutMs({ [LIST_TIMEOUT_ENV]: '0' })).toBe(0);
    expect(listTimeoutMs({ [LIST_TIMEOUT_ENV]: '90000' })).toBe(90000);
    const { exec, calls } = spyExec('[]');
    defaultListAgents({ exec, env: { [LIST_TIMEOUT_ENV]: '0' } });
    expect(calls[0].opts.timeout).toBe(0);
  });

  it('refuses a malformed listing bound rather than silently using the default', () => {
    // Same rule as `WE_DISPATCH_AGENT_ARGS`: an operator who set a bound that never applied is worse off than
    // one who was told their value was junk.
    expect(() => listTimeoutMs({ [LIST_TIMEOUT_ENV]: 'soon' })).toThrow(new RegExp(LIST_TIMEOUT_ENV));
    expect(() => listTimeoutMs({ [LIST_TIMEOUT_ENV]: '-1' })).toThrow(/non-negative/);
  });
});

describe('the observer reads LIVE sessions only', () => {
  it('does NOT pass `--all` — with it, every finished build would read `running` forever', () => {
    // The module's most emphatic negative claim, and it was protected by nothing: `--all` also lists COMPLETED
    // sessions, so the observer's "absent means gone" branch would never be reached again.
    const { exec, calls } = spyExec('[]');
    defaultListAgents({ exec });
    expect(calls[0].file).toBe('claude');
    expect(calls[0].argv).toEqual(['agents', '--json']);
    expect(calls[0].argv).not.toContain('--all');
  });

  it('parses the listing, and an empty answer is an empty array rather than a throw', () => {
    expect(defaultListAgents({ exec: () => '[{"sessionId":"s1"}]' })).toEqual([{ sessionId: 's1' }]);
    expect(defaultListAgents({ exec: () => '' })).toEqual([]);
  });
});

// ── #x9ylkp7 — THE DISCOVERY QUERY, pinned. Every other test of this feature passes on injected fixtures ─────
//
// The failure mode of a wrong discovery query is SILENCE, not an error: an empty listing is BY DESIGN
// indistinguishable from "no PR yet", so a query that matches nothing looks exactly like a fleet with no PRs
// open. Nothing reddens, the waker keeps escalating at 6h, and the item reads as delivered. That is why the
// argv is asserted here and not merely exercised through a fixture — the same defect class as F5/F6 in the PR
// #1211 review, where a tested default reached by nothing was the whole problem.

describe('the PR discovery query — the one thing fixtures cannot prove', () => {
  it('asks for `--state all`; without it every MERGED PR is hidden and the axis resolves NOTHING', () => {
    const { exec, calls } = spyExec('[]');
    defaultListPrs({ exec, env: {} });
    expect(calls[0].file).toBe('gh');
    // THE FLAG, and the PAIR — `gh pr list --state all`. Bare `gh pr list` defaults to OPEN only, and `merged`
    // is the single classification this observer ever resolves on.
    const stateAt = calls[0].argv.indexOf('--state');
    expect(stateAt).toBeGreaterThan(-1);
    expect(calls[0].argv[stateAt + 1]).toBe('all');
  });

  it('asks for `headRefName` in `--json`; without it no PR can be matched to any item', () => {
    const { exec, calls } = spyExec('[]');
    defaultListPrs({ exec, env: {} });
    const jsonAt = calls[0].argv.indexOf('--json');
    expect(jsonAt).toBeGreaterThan(-1);
    const fields = String(calls[0].argv[jsonAt + 1]).split(',');
    // `headRefName` is the match key; `state`/`mergedAt`/`labels` are what `classifyPr` itself reads; `number`
    // is the evidence recorded on the resolved entry.
    expect(fields).toEqual(expect.arrayContaining(['headRefName', 'state', 'mergedAt', 'labels', 'number']));
    expect(PR_LIST_JSON_FIELDS.split(',')).toEqual(fields);
  });

  it('the whole argv, in one assertion — a rename or a dropped flag reddens exactly here', () => {
    const { exec, calls } = spyExec('[]');
    defaultListPrs({ exec, env: {} });
    expect(calls[0].argv).toEqual(['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS]);
    expect(PR_LIST_LIMIT).toBe(400); // the LITERAL, not only the constant — same page the lease reaper reads
  });

  it('is BOUNDED — it is a network read sitting inside a fail-soft waker pass', () => {
    const { exec, calls } = spyExec('[]');
    defaultListPrs({ exec, env: {} });
    expect(PR_LIST_TIMEOUT_MS).toBe(30 * 1000);
    expect(calls[0].opts).toMatchObject({ timeout: PR_LIST_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' });
  });

  it('the bound is its OWN knob, and a malformed one is refused rather than ignored', () => {
    // A separate var from the agent listing's: the two reads have different costs (a local daemon versus a
    // network round-trip), and lengthening one must not silently lengthen the other.
    expect(prListTimeoutMs({})).toBe(PR_LIST_TIMEOUT_MS);
    expect(prListTimeoutMs({ [PR_LIST_TIMEOUT_ENV]: '0' })).toBe(0);
    expect(prListTimeoutMs({ [LIST_TIMEOUT_ENV]: '1' })).toBe(PR_LIST_TIMEOUT_MS); // the OTHER knob is not this one
    expect(listTimeoutMs({ [PR_LIST_TIMEOUT_ENV]: '1' })).toBe(LIST_TIMEOUT_MS);
    expect(() => prListTimeoutMs({ [PR_LIST_TIMEOUT_ENV]: 'soon' })).toThrow(new RegExp(PR_LIST_TIMEOUT_ENV));
    expect(() => prListTimeoutMs({ [PR_LIST_TIMEOUT_ENV]: '-1' })).toThrow(/non-negative/);
  });

  it('parses the page, and an empty answer is an empty array rather than a throw', () => {
    expect(defaultListPrs({ exec: () => '[{"number":7}]', env: {} })).toEqual([{ number: 7 }]);
    expect(defaultListPrs({ exec: () => '', env: {} })).toEqual([]);
  });
});

// ── PR #1211 round-3 review, H3 — the "one source of truth" derivation, asserted by nothing until now ─────────

describe('LISTING_GRACE_MS is DERIVED, not a second literal that can drift from DISPATCH_LISTING_GRACE_MINUTES', () => {
  it('stays the minutes constant times 60_000 — reddens if either side is ever re-literalised', () => {
    // The docblock on `LISTING_GRACE_MS` (dispatch-lane-io.mjs) says this derivation exists so the OBSERVER's
    // two constants cannot drift apart. That claim was asserted by nothing: mutating `LISTING_GRACE_MS` back to
    // a bare `2 * 60 * 1000` literal left every test in this directory green. This is the identical defect
    // class as round 2's G5 (`DISPATCH_HOLD_GRACE_MINUTES`), pinned the same way — with the LITERAL, not only
    // the constant.
    //
    // WHAT THIS NO LONGER SPANS, corrected by #3353. The sentence above used to say the derivation kept the
    // PURE GUARD's copy of the window from drifting — `dispatchStillHolds`'s default. It does not any more:
    // hardening 5 gave the guard its own, larger `DISPATCH_GUARD_LISTING_GRACE_MINUTES`, on the grounds that
    // the observer's wrong answer writes nothing while the guard's starts a second agent in an occupied lane.
    // Nothing here reddened when that changed, because this assertion only ever bound the observer's two
    // constants. The guard's side is pinned in `dispatch-liveness-hardening.test.mjs` instead.
    expect(DISPATCH_LISTING_GRACE_MINUTES).toBe(2);
    expect(LISTING_GRACE_MS).toBe(DISPATCH_LISTING_GRACE_MINUTES * 60_000);
  });
});

// ── PR #1211 round-3 review, H5 (advisory) — a placeholder broken by a BRACE or NEWLINE fills verbatim ────────
//
// `BRIEF_TOKEN_RE`'s docblock (dispatch-lane.mjs) already names this limit honestly: a token carrying an
// interior brace or newline is the one spelling outside its class, so it never matches at all. That means it
// never reaches `fillBrief`'s substitute-or-refuse-or-report branches either — it just survives the `.replace`
// untouched, filled into the dispatched agent's prompt VERBATIM, with `unknownTokens` staying `[]` because
// nothing ever saw it as a token. This pins that CURRENT behavior so a future change to `BRIEF_TOKEN_RE` cannot
// silently alter it without a test noticing. Widening the regex to also catch these two spellings is welcome
// but not required — the bar here is lower than H3/H4 because the gap is already documented, not misdocumented.

describe('fillBrief: a token broken by an interior brace or newline is filled verbatim and unreported', () => {
  const BRIEF = 'build #{{ITEM_NUM}} at {{ITEM_SPEC_PATH}} in lane {{LANE}} as {{SESSION_SLUG}} scoped {{SCOPE}}';
  const VALUES = { ITEM_NUM: '3037', ITEM_SPEC_PATH: 'backlog/3037-x.md', LANE: 8, SESSION_SLUG: 'conveyor-3037', SCOPE: 'we:a,we:b' };

  it('neither spelling matches BRIEF_TOKEN_RE at all — confirming why fillBrief cannot see it', () => {
    expect([...'{{ITEM_\nNUM}}'.matchAll(BRIEF_TOKEN_RE)]).toEqual([]);
    expect([...'{{ITEM{NUM}}'.matchAll(BRIEF_TOKEN_RE)]).toEqual([]);
  });

  it('an interior NEWLINE: {{ITEM_\\nNUM}} survives fillBrief verbatim, with an empty unknownTokens', () => {
    const { prompt, unknownTokens } = fillBrief(`${BRIEF}\nbroken: {{ITEM_\nNUM}}`, VALUES);
    expect(prompt).toContain('{{ITEM_\nNUM}}');
    expect(unknownTokens).toEqual([]);
  });

  it('an interior BRACE: {{ITEM{NUM}} survives fillBrief verbatim, with an empty unknownTokens', () => {
    const { prompt, unknownTokens } = fillBrief(`${BRIEF}\nbroken: {{ITEM{NUM}}`, VALUES);
    expect(prompt).toContain('{{ITEM{NUM}}');
    expect(unknownTokens).toEqual([]);
  });

  it('the five real placeholders still fill normally alongside the broken one', () => {
    const { prompt } = fillBrief(`${BRIEF}\nbroken: {{ITEM{NUM}}`, VALUES);
    for (const name of BRIEF_PLACEHOLDERS) expect(prompt).not.toContain(`{{${name}}}`);
  });
});

describe('the PRODUCTION callers reach those defaults — a tested default nothing uses is the same defect', () => {
  // THE SECOND HALF OF F5, found by mutating this fix rather than the original code: asserting
  // `defaultRunNode` builds a timeout proves nothing if `readTick`'s own default quietly stopped being it.
  // Each of these drives the real factory with NOTHING overridden except the process boundary itself.

  it('the tick reader goes through `defaultRunNode`, timeout and all', () => {
    const { exec, calls } = spyExec('{"decisions":{},"nextState":{}}');
    readTick({
      num: '3037',
      exec,
      readText: () => 'brief {{ITEM_NUM}}',
      loadItems: () => [],
      listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ timeout: TICK_TIMEOUT_MS, killSignal: 'SIGKILL' });
  });

  it('the guard\'s LIVENESS read goes through `defaultListAgents` too — same argv, same bound, still no `--all`', () => {
    // The third wiring seam, and the one G1's fix adds: a `stampLiveness` that reached a different reader — or
    // no reader — would put every hold silently back on the clock, which is the defect round 2 found. Nothing
    // is overridden here but the process boundary itself.
    const { exec, calls } = spyExec('[]');
    readTick({
      num: '3037',
      exec,
      runNode: () => '{"decisions":{},"nextState":{}}',
      readText: () => 'brief {{ITEM_NUM}}',
      loadItems: () => [],
      listInFlightDispatches: () => ({ runs: [{ runId: 'a', handle: 'sess-1' }], unreadable: 0 }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('claude');
    expect(calls[0].argv).toEqual(['agents', '--json']);
    expect(calls[0].opts).toMatchObject({ killSignal: 'SIGKILL' });
  });

  it('the sink goes through `defaultSpawnAgent`, timeout and all', async () => {
    const { exec, calls } = spyExec('');
    const sinks = createDispatchSinks({ root: '/primary/webeverything', exec, mintSessionId: () => 'sess-z9' });
    await sinks[DISPATCH_EFFECT]({ num: '3037', sessionSlug: 'conveyor-3037', prompt: '# go', expectedWithinMinutes: 90 });
    expect(calls[0].file).toBe('claude');
    expect(calls[0].argv.slice(0, 3)).toEqual(['--bg', '--session-id', 'sess-z9']);
    expect(calls[0].opts).toMatchObject({ timeout: SPAWN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  });

  it('the observer goes through `defaultListAgents` — same argv, still no `--all`', async () => {
    const { exec, calls } = spyExec('[]');
    const observers = createDispatchObservers({ exec, now: () => new Date('2026-08-13T12:00:00.000Z') });
    // NO `payload.num`, so the PR axis is skipped entirely and `claude` is the only thing shelled — which is
    // itself the assertion that an entry the PR axis cannot use costs no subprocess.
    await observers[DISPATCH_EFFECT]({ handle: 'sess-gone', startedAt: '2026-08-13T10:00:00.000Z' }, { handle: 'sess-gone' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('claude');
    expect(calls[0].argv).toEqual(['agents', '--json']);
    expect(calls[0].opts).toMatchObject({ timeout: LIST_TIMEOUT_MS, killSignal: 'SIGKILL' });
  });

  it('the observer\'s PR axis goes through `defaultListPrs` too — the seam #x9ylkp7 adds, reached by production', async () => {
    // Same shape of proof as the three above, and the same reason: a pinned default that the real factory does
    // not reach is a pinned default that resolves nothing in production.
    const { exec, calls } = spyExec('[]');
    const observers = createDispatchObservers({ exec, now: () => new Date('2026-08-13T12:00:00.000Z') });
    await observers[DISPATCH_EFFECT](
      { handle: 'sess-gone', startedAt: '2026-08-13T10:00:00.000Z', payload: { num: '3095' } },
      { handle: 'sess-gone' },
    );
    const gh = calls.find((c) => c.file === 'gh');
    expect(gh, 'the observer must reach the real `gh pr list` reader').toBeTruthy();
    expect(gh.argv).toEqual(['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS]);
    expect(gh.opts).toMatchObject({ timeout: PR_LIST_TIMEOUT_MS, killSignal: 'SIGKILL' });
    // …and the PR axis running first does not cost the liveness axis: an empty page is no verdict, so the
    // agent listing is still read.
    expect(calls.some((c) => c.file === 'claude')).toBe(true);
  });
});

describe('#3383 — readTick resolves LANE_REF for a fix/ci-heal launch, and pays no `gh` call for anything else', () => {
  const baseIo = {
    root: '/repo',
    readText: () => 'brief {{ITEM_NUM}} {{PR_NUM}} {{LANE_REF}} {{LANE}} {{SESSION_SLUG}} {{SCOPE}}',
    loadItems: () => [{ num: '3037', slug: 'x', specPath: 'backlog/3037-x.md', scope: ['we:scripts/'] }],
    listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
    listAgents: () => [],
  };

  it('a `fix` launch: prHeadRef comes off listPrs(), matched on launch.pr — never a second gh call per dispatch', () => {
    let listPrsCalls = 0;
    const v = readTick({
      num: '3037',
      ...baseIo,
      runNode: () => JSON.stringify({ decisions: { spawnFixes: [{ num: '3037', lane: 8, pr: 701 }] }, nextState: { fixGuards: [{ num: '3037', pr: 701, lane: 8, spawnedTick: 0 }] } }),
      listPrs: () => { listPrsCalls += 1; return [{ number: 701, headRefName: 'lane/3037-x' }, { number: 999, headRefName: 'lane/other' }]; },
    });
    expect(v.launchKind).toBe('fix');
    expect(v.prHeadRef).toBe('lane/3037-x');
    expect(listPrsCalls).toBe(1);
  });

  it('a `build` launch never calls listPrs at all — a build dispatch has no PR yet to look up', () => {
    let listPrsCalls = 0;
    const v = readTick({
      num: '3037',
      ...baseIo,
      runNode: () => JSON.stringify({ decisions: { spawnBuilds: [{ num: '3037', lane: 8 }] }, nextState: { buildGuards: [{ num: '3037', lane: 8, spawnedTick: 0 }] } }),
      listPrs: () => { listPrsCalls += 1; return []; },
    });
    expect(v.launchKind).toBe('build');
    expect(v.prHeadRef).toBeNull();
    expect(listPrsCalls).toBe(0);
  });

  it('a `ci-heal` launch resolves against nextState.ciHealGuards, not buildGuards/prepareGuards/fixGuards', () => {
    const v = readTick({
      num: '3037',
      ...baseIo,
      runNode: () => JSON.stringify({
        decisions: { spawnCiHeals: [{ num: '3037', lane: 8, pr: 701, reason: 'red-ci' }] },
        nextState: {
          buildGuards: [{ num: '3037', lane: 9, spawnedTick: 0 }], // a decoy under the SAME num, wrong list
          ciHealGuards: [{ num: '3037', pr: 701, lane: 8, spawnedTick: 0 }],
        },
      }),
      listPrs: () => [{ number: 701, headRefName: 'lane/3037-x' }],
    });
    expect(v.launchKind).toBe('ci-heal');
    expect(v.dispatchedGuard).toEqual({ num: '3037', pr: 701, lane: 8, spawnedTick: 0 });
  });

  it('a listPrs() that throws degrades to a null prHeadRef rather than crashing the read — shapeDispatchRead then refuses the dispatch, loudly, not this reader silently', () => {
    const v = readTick({
      num: '3037',
      ...baseIo,
      runNode: () => JSON.stringify({ decisions: { spawnFixes: [{ num: '3037', lane: 8, pr: 701 }] }, nextState: { fixGuards: [] } }),
      listPrs: () => { throw new Error('gh is down'); },
    });
    expect(v.prHeadRef).toBeNull();
  });
});
