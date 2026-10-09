/**
 * @file scripts/readiness/__tests__/conveyor-state.test.mjs
 * @description Unit proof of the CONVEYOR TICK STATE-READ's PURE core (WE #2611, epic #2612). Drives every
 *   `shape*` / `derive*` / `assess*` fn and the top-level {@link assembleConveyorState} composer directly with
 *   fixtures (NO real git / gh / fs / clock — `now` is injected). Three representative end-to-end ticks pin the
 *   whole shape: a HEALTHY tick, a STALLED-LANE tick (transcript mtime past the stall threshold → verdict warn),
 *   and a DAEMON-UNAVAILABLE tick (a null report degrades to the `"unavailable"` sentinel, not a crash).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  shapeQueue,
  itemNumFromRef,
  ciRollup,
  shapePrs,
  shapeLanes,
  computeFreeSlots,
  shapeDaemon,
  lastMergeFromDaemon,
  lastQueueAddFromQueued,
  deriveIdle,
  transcriptMentionsItem,
  assessHealth,
  assembleConveyorState,
  deriveClearedNotReady,
  deriveUnshaped,
  deriveNeedsSlice,
  deriveDecisions,
  reverseLaneItemMap,
  attachLaneInfra,
  DEFAULT_STALL_MS,
} from '../conveyor-state.mjs';
// #2661 — the same-cause collapse primitive, unit-tested directly for its guards (the assessHealth tests above
// only exercise it through well-formed lane inputs).
import { clusterByCause } from '../../conveyor/infra-blocked.mjs';
import { bornAsIndexFromItems, resolveBornAsRefs } from '../../conveyor/queue-store.mjs';

describe('shapeQueue — ready/queued build-queue rows → the tick queue shape', () => {
  it('passes priorityClass through only when the build queue enforces class order', () => {
    expect(shapeQueue({ priorityMode: 'enforce', queue: [{ num: '1', priorityClass: 'P1' }] })[0].priorityClass).toBe('P1');
    expect(shapeQueue({ priorityMode: 'enforce', queue: [{ num: '1' }] })[0]).not.toHaveProperty('priorityClass');
    // shadow = log only, never reorder: the class is not handed to the prepare-ahead window
    expect(shapeQueue({ priorityMode: 'shadow', queue: [{ num: '1', priorityClass: 'P1' }] })[0]).not.toHaveProperty('priorityClass');
    expect(shapeQueue([{ num: '1', priorityClass: 'P1' }])[0]).not.toHaveProperty('priorityClass');
  });

  it('maps num/rank/buildQueued and defaults openBlockers/scope defensively', () => {
    const buildQueue = { queue: [{ num: '554', rank: null, buildQueued: false }, { num: 42, rank: 3, buildQueued: true }] };
    expect(shapeQueue(buildQueue)).toEqual([
      { num: '554', rank: null, buildQueued: false, openBlockers: [], scope: null, kind: null, epicState: null, prepared: false, preparedDate: null },
      { num: '42', rank: 3, buildQueued: true, openBlockers: [], scope: null, kind: null, epicState: null, prepared: false, preparedDate: null },
    ]);
  });
  it('reads a bare row array too', () => {
    expect(shapeQueue([{ num: '1' }])).toEqual([{ num: '1', rank: null, buildQueued: false, openBlockers: [], scope: null, kind: null, epicState: null, prepared: false, preparedDate: null }]);
  });
  it('picks up openBlockers / blockedBy / scope / kind / epicState when a producer annotates them', () => {
    expect(shapeQueue([{ num: '9', openBlockers: [7, 8], scope: ['we:src/a.ts'], kind: 'epic', epicState: 'unsliced' }])[0]).toEqual({
      num: '9', rank: null, buildQueued: false, openBlockers: ['7', '8'], scope: ['we:src/a.ts'], kind: 'epic', epicState: 'unsliced', prepared: false, preparedDate: null,
    });
    expect(shapeQueue([{ num: '9', blockedBy: ['10'] }])[0].openBlockers).toEqual(['10']);
  });
  it('tolerates null / missing queue → []', () => {
    expect(shapeQueue(null)).toEqual([]);
    expect(shapeQueue({})).toEqual([]);
  });

  it('with a sidecar clearedNums, buildQueued reflects the SESSION-LOCAL conveyor queue, not the committed flag (#2613)', () => {
    // A row committed-cleared (buildQueued:true) but NOT in the sidecar reads buildQueued:false; a row in the
    // sidecar reads buildQueued:true even with no committed flag. Padding-tolerant (sidecar "042" ≡ row 42).
    const buildQueue = { queue: [{ num: 42, buildQueued: true }, { num: '200', buildQueued: false }, { num: 300 }] };
    const shaped = shapeQueue(buildQueue, ['200', '042']);
    expect(shaped.map((r) => [r.num, r.buildQueued])).toEqual([
      ['42', true], // sidecar "042" matches → cleared, despite… (also committed, but the sidecar is the source now)
      ['200', true], // sidecar member with NO committed flag → cleared
      ['300', false], // not in the sidecar → not cleared
    ]);
  });

  it('an EMPTY sidecar clears nothing even when rows carry committed buildQueued:true', () => {
    const buildQueue = { queue: [{ num: 42, buildQueued: true }] };
    expect(shapeQueue(buildQueue, []).map((r) => r.buildQueued)).toEqual([false]);
  });

  it('clearedNums = null falls back to the committed buildQueued flag (backward-compatible)', () => {
    const buildQueue = { queue: [{ num: 42, buildQueued: true }, { num: 7, buildQueued: false }] };
    expect(shapeQueue(buildQueue, null).map((r) => r.buildQueued)).toEqual([true, false]);
  });

  it('STARVATION FIX: a JIT-numbered card only reads buildQueued:true once its stale hash clearedNum is ' +
     'resolved through bornAs BEFORE being passed in — the IO shell\'s job, proven here at the pure-fn boundary', () => {
    const buildQueue = { queue: [{ num: '4290' }, { num: '17' }] }; // ready rows, keyed by the LANDED number
    const bornAsIndex = bornAsIndexFromItems([{ num: '4290', bornAs: 'x34h6a2' }]);
    const rawClearedNums = ['x34h6a2', '17']; // the stale sidecar spelling — never matches row 4290
    expect(shapeQueue(buildQueue, rawClearedNums).map((r) => r.buildQueued)).toEqual([false, true]); // BEFORE: starved
    const resolvedClearedNums = resolveBornAsRefs(
      rawClearedNums.map((n) => ({ num: n, addedAt: null })),
      bornAsIndex,
    ).map((e) => e.num);
    expect(resolvedClearedNums).toEqual(['4290', '17']);
    expect(shapeQueue(buildQueue, resolvedClearedNums).map((r) => r.buildQueued)).toEqual([true, true]); // AFTER: fixed
  });
});

describe('deriveClearedNotReady — cleared ids with no ready build-queue row (#2613 review req 2b)', () => {
  const buildQueue = { queue: [{ num: '200' }, { num: 300 }] };

  it('returns the cleared ids absent from the ready set (blocked / resolved / typo), stored spelling kept', () => {
    expect(deriveClearedNotReady(buildQueue, ['200', '999', 'ghost'])).toEqual(['999', 'ghost']);
  });
  it('is padding/`#`-tolerant against the ready rows', () => {
    expect(deriveClearedNotReady(buildQueue, ['#300', '#42'])).toEqual(['#42']);
  });
  it('all-ready → [], and null clearedNums → []', () => {
    expect(deriveClearedNotReady(buildQueue, ['200', 300])).toEqual([]);
    expect(deriveClearedNotReady(buildQueue, null)).toEqual([]);
  });
});

describe('deriveUnshaped — armed rows with no predicted scope (the auto-prepare surface, #2613)', () => {
  it('returns ARMED rows whose scope is absent / empty / all-blank; scoped armed rows are excluded', () => {
    const buildQueue = {
      queue: [
        { num: '10', scope: ['we:src/a.ts'] }, // armed + scoped → NOT unshaped
        { num: '20', scope: [] }, // armed + empty scope → unshaped
        { num: '30' }, // armed + absent scope → unshaped
        { num: '40', scope: ['', null] }, // armed + only empty/blank entries (normScope → []) → unshaped
      ],
    };
    // Sidecar clears everything so all four are armed; only the scope-less three are unshaped.
    expect(deriveUnshaped(buildQueue, ['10', '20', '30', '40'])).toEqual([
      { num: '20', scope: [] },
      { num: '30', scope: null },
      { num: '40', scope: ['', null] },
    ]);
  });

  it('excludes UN-armed rows even when they have no scope (only CLEARED items are surfaced)', () => {
    const buildQueue = { queue: [{ num: '10' }, { num: '20' }] };
    // Only 10 is cleared this session; 20 is not armed, so it is not an unshaped surface even with no scope.
    expect(deriveUnshaped(buildQueue, ['10'])).toEqual([{ num: '10', scope: null }]);
  });

  it('with clearedNums = null, falls back to the committed buildQueued flag', () => {
    const buildQueue = { queue: [{ num: '10', buildQueued: true }, { num: '20', buildQueued: false }] };
    expect(deriveUnshaped(buildQueue, null)).toEqual([{ num: '10', scope: null }]);
  });

  it('empty / null build queue → []', () => {
    expect(deriveUnshaped(null, ['1'])).toEqual([]);
    expect(deriveUnshaped({ queue: [] }, ['1'])).toEqual([]);
  });

  it('EXCLUDES a scope-less epic — it is needs-slice, NOT unshaped (mirrors the dispatcher\'s epic-before-scope precedence, #2645)', () => {
    // A scope-less epic satisfies the empty-scope test, but an epic is held `needs-slice` before the scope gate —
    // never `unshaped-no-scope` — so it must NOT surface here (else §3b would prepare-scope a container).
    const buildQueue = { queue: [{ num: '10', kind: 'epic' }, { num: '20', kind: 'story' }] };
    expect(deriveUnshaped(buildQueue, ['10', '20'])).toEqual([{ num: '20', scope: null }]); // the story only
    expect(deriveNeedsSlice(buildQueue, ['10', '20'])).toEqual([{ num: '10', epicState: null }]); // the epic only
  });

  it('EXCLUDES a scope-less decision — it is needs-decision, NOT unshaped (mirrors the decision-before-scope precedence, #2647)', () => {
    // A decision carries no scope; without the decision guard it would satisfy the empty-scope test and surface as
    // unshaped — aiming a prepare-SCOPE agent at an item that needs no build scope. It must surface ONLY in decisions.
    const buildQueue = { queue: [{ num: '10', kind: 'decision' }, { num: '20', kind: 'story' }] };
    expect(deriveUnshaped(buildQueue, ['10', '20'])).toEqual([{ num: '20', scope: null }]); // the story only
    expect(deriveDecisions(buildQueue, ['10', '20'])).toEqual([{ num: '10', prepared: false, preparedDate: null }]); // the decision only
  });

  it('EXCLUDES a scope-less investigation — it is needs-investigation, NOT unshaped (mirrors the investigation-before-scope precedence, #3567)', () => {
    // An investigation carries no scope; without the guard it would satisfy the empty-scope test and surface as
    // unshaped, so planPrepareSpawns' shared guard set would spawn a wrong-kind prepare-SCOPE agent for it first and
    // silently skip the real investigate spawn.
    const buildQueue = { queue: [{ num: '10', kind: 'investigation' }, { num: '20', kind: 'story' }] };
    expect(deriveUnshaped(buildQueue, ['10', '20'])).toEqual([{ num: '20', scope: null }]); // the story only
  });

  it('EXCLUDES a scope-less feature — it is needs-slice, NOT unshaped, exactly like an epic (#1312 review regression, #2998)', () => {
    // Regression coverage: a scope-less `kind:feature` previously satisfied the empty-scope test and would have
    // false-surfaced here (aiming a prepare-SCOPE agent at a container) because only `kind === 'epic'` was excluded.
    // `feature` (#2691) is epic-parity by design, so it must be excluded the same way and surface ONLY via needsSlice.
    const buildQueue = { queue: [{ num: '10', kind: 'feature' }, { num: '20', kind: 'story' }] };
    expect(deriveUnshaped(buildQueue, ['10', '20'])).toEqual([{ num: '20', scope: null }]); // the story only
    expect(deriveNeedsSlice(buildQueue, ['10', '20'])).toEqual([{ num: '10', epicState: null }]); // the feature only
  });
});

describe('deriveDecisions — armed kind:decision rows (the prepare/present surface, #2647)', () => {
  it('returns ARMED decision rows with prepared/preparedDate; non-decision armed rows are excluded', () => {
    const buildQueue = {
      queue: [
        { num: '10', kind: 'decision', preparedDate: '2026-07-01', prepared: true }, // armed, prepared → present
        { num: '20', kind: 'story', scope: ['we:src/a.ts'] }, // armed story → NOT a decision
        { num: '30', kind: 'decision' }, // armed, un-prepared → prepare
      ],
    };
    expect(deriveDecisions(buildQueue, ['10', '20', '30'])).toEqual([
      { num: '10', prepared: true, preparedDate: '2026-07-01' },
      { num: '30', prepared: false, preparedDate: null },
    ]);
  });

  it('excludes UN-armed decisions even though they are decisions (only CLEARED items are surfaced)', () => {
    const buildQueue = { queue: [{ num: '10', kind: 'decision' }, { num: '20', kind: 'decision' }] };
    expect(deriveDecisions(buildQueue, ['10'])).toEqual([{ num: '10', prepared: false, preparedDate: null }]);
  });

  it('with clearedNums = null, falls back to the committed buildQueued flag', () => {
    const buildQueue = { queue: [{ num: '10', kind: 'decision', buildQueued: true }, { num: '20', kind: 'decision', buildQueued: false }] };
    expect(deriveDecisions(buildQueue, null)).toEqual([{ num: '10', prepared: false, preparedDate: null }]);
  });

  it('empty / null build queue → []', () => {
    expect(deriveDecisions(null, ['1'])).toEqual([]);
    expect(deriveDecisions({ queue: [] }, ['1'])).toEqual([]);
  });
});

describe('deriveNeedsSlice — armed kind:epic rows (the /slice surface, #2645)', () => {
  it('returns ARMED epic rows with their epicState; non-epic armed rows are excluded', () => {
    const buildQueue = {
      queue: [
        { num: '10', kind: 'epic', epicState: 'unsliced' }, // armed epic → needs-slice
        { num: '20', kind: 'story', scope: ['we:src/a.ts'] }, // armed story → NOT needs-slice
        { num: '30', kind: 'epic', epicState: 'done' }, // armed epic (done) → surfaced, skill routes to resolve
      ],
    };
    expect(deriveNeedsSlice(buildQueue, ['10', '20', '30'])).toEqual([
      { num: '10', epicState: 'unsliced' },
      { num: '30', epicState: 'done' },
    ]);
  });

  it('excludes UN-armed epics even though they are epics (only CLEARED items are surfaced)', () => {
    const buildQueue = { queue: [{ num: '10', kind: 'epic' }, { num: '20', kind: 'epic' }] };
    // Only 10 is cleared this session; 20 is an epic but not armed, so it is not a needs-slice surface.
    expect(deriveNeedsSlice(buildQueue, ['10'])).toEqual([{ num: '10', epicState: null }]);
  });

  it('with clearedNums = null, falls back to the committed buildQueued flag', () => {
    const buildQueue = { queue: [{ num: '10', kind: 'epic', buildQueued: true }, { num: '20', kind: 'epic', buildQueued: false }] };
    expect(deriveNeedsSlice(buildQueue, null)).toEqual([{ num: '10', epicState: null }]);
  });

  it('also returns ARMED kind:feature rows — epic-parity (#2998)', () => {
    const buildQueue = {
      queue: [
        { num: '10', kind: 'feature', epicState: 'unsliced' }, // armed feature → needs-slice, same as an epic
        { num: '20', kind: 'story', scope: ['we:src/a.ts'] }, // armed story → NOT needs-slice
      ],
    };
    expect(deriveNeedsSlice(buildQueue, ['10', '20'])).toEqual([
      { num: '10', epicState: 'unsliced' },
    ]);
  });

  it('empty / null build queue → []', () => {
    expect(deriveNeedsSlice(null, ['1'])).toEqual([]);
    expect(deriveNeedsSlice({ queue: [] }, ['1'])).toEqual([]);
  });
});

describe('itemNumFromRef — item id out of a lane headRef', () => {
  it('extracts a numeric id', () => expect(itemNumFromRef('lane/2611-conveyor-state')).toBe('2611'));
  it('extracts a numeric id with no slug', () => expect(itemNumFromRef('lane/2611')).toBe('2611'));
  it('extracts a JIT slug id', () => expect(itemNumFromRef('lane/xe2fmix-slug')).toBe('xe2fmix'));
  it('a word-first ref falls back to the TRAILING digits (never the leading word)', () => {
    expect(itemNumFromRef('lane/hotfix-2611')).toBe('2611'); // not 'hotfix'
  });
  it('a word-only ref (no id anywhere) → null, never a silent wrong id', () => {
    expect(itemNumFromRef('lane/hotfix')).toBe(null);
    expect(itemNumFromRef('lane/conveyor-work')).toBe(null);
  });
  it('is null for a non-lane / empty ref', () => {
    expect(itemNumFromRef('main')).toBe(null);
    expect(itemNumFromRef(null)).toBe(null);
  });
  // #xaa7r2n — a RETRY ref glues an attempt-tag letter directly onto the id (mirrors lease-reaper.mjs's
  // itemNumFromSession/laneRefItemNum grammar for the dispatcher's own retry-naming convention). Confirmed
  // live: PR #1851's headRefName is exactly this shape and used to resolve to null.
  it('a retried numeric ref (attempt-tag letter glued onto the number) still resolves to the base item', () => {
    expect(itemNumFromRef('lane/3441b-resolve-on-land-extractor')).toBe('3441');
  });
  it('a retried JIT-slug ref, base slug at the 7-char cap, resolves to the slug (not slug+retry-letter)', () => {
    // Only a MAX-LENGTH (7-char) base slug disambiguates: {5,7} cannot absorb an 8th char into the slug
    // itself, so the trailing retry letter is forced into the separate [a-z]? group. A base slug SHORTER
    // than 7 chars plus a retry letter is genuinely ambiguous with a longer valid slug of the same total
    // length (e.g. 'xe2fmixb' reads as a plain 7-char slug, not '6-char slug + b') — accepted as a known,
    // currently-unreachable limitation: JIT-slug items don't get attempt-tag retries today (#xaa7r2n).
    expect(itemNumFromRef('lane/xe2fmixyb-slug')).toBe('xe2fmixy');
  });
});

describe('ciRollup — statusCheckRollup → one CI token', () => {
  it('none for an empty rollup', () => expect(ciRollup([])).toBe('none'));
  it('pass when every check is complete & green', () => {
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass');
  });
  it('fail when any check is definitively red (wins over pending)', () => {
    expect(ciRollup([{ status: 'IN_PROGRESS' }, { conclusion: 'FAILURE' }])).toBe('fail');
  });
  it('pending when a check is still running and none failed', () => {
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])).toBe('pending');
  });
  it('SKIPPED / NEUTRAL conclusions count as complete-green (→ pass)', () => {
    expect(ciRollup([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'NEUTRAL' }])).toBe('pass');
  });
  it('a legacy commit StatusContext state:PENDING → pending', () => {
    expect(ciRollup([{ state: 'SUCCESS' }, { state: 'PENDING' }])).toBe('pending');
  });
  it('a legacy commit StatusContext state:ERROR → fail', () => {
    expect(ciRollup([{ state: 'SUCCESS' }, { state: 'ERROR' }])).toBe('fail');
  });
  it('a COMPLETED run with a null/absent conclusion → pending (not silently green)', () => {
    expect(ciRollup([{ status: 'COMPLETED' }])).toBe('pending');
    expect(ciRollup([{ status: 'COMPLETED', conclusion: null }])).toBe('pending');
  });

  // #2925 — the decisive case: a superseded CANCELLED entry beside the SUCCESS that actually finished, same
  // check name. Before the fix `ciRollup` folded EVERY entry with no per-name collapse, so this read `fail` for
  // as long as the cancelled entry sat in the rollup even though the check that finished is green.
  it('a superseded CANCELLED entry beside a later SUCCESS for the SAME name reads pass, not fail (#2925)', () => {
    expect(ciRollup([
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ])).toBe('pass');
  });

  // x3hg6h2 — review-gate is BY DESIGN red for as long as a PR is un-reviewed (we:.github/workflows/
  // review-gate.yml + we:scripts/check-review-gate.mjs); folding it into this rollup mislabels every
  // un-reviewed PR `fail` and can misdirect tick-core.mjs's isRedCi/isCiHealTarget at a PR that isn't broken.
  it('excludes review-gate — its own by-design pre-review failure does not read fail (x3hg6h2)', () => {
    expect(ciRollup([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('pass');
    // A real failing check beside review-gate's expected failure still reads fail.
    expect(ciRollup([
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('fail');
  });
});

describe('transcriptMentionsItem — ANCHORED item-id match (no #26-masks-#2611 false hit)', () => {
  it('matches the exact id followed by a non-alphanumeric', () => {
    expect(transcriptMentionsItem('working on #2611 ("conveyor")', '2611')).toBe(true);
    expect(transcriptMentionsItem('done #2611.', '2611')).toBe(true);
  });
  it('#26 does NOT match a longer #2611 / #260 (the stall-masking false hit)', () => {
    expect(transcriptMentionsItem('working on #2611', '26')).toBe(false);
    expect(transcriptMentionsItem('working on #260', '26')).toBe(false);
  });
  it('#261 does NOT match the #261x family', () => {
    expect(transcriptMentionsItem('see #2613 and #2614', '261')).toBe(false);
  });
  it('a JIT slug matches exactly, not a longer slug', () => {
    expect(transcriptMentionsItem('item #xe2fmix here', 'xe2fmix')).toBe(true);
    expect(transcriptMentionsItem('item #xe2fmixy here', 'xe2fmix')).toBe(false);
  });
  it('empty text / null num → false', () => {
    expect(transcriptMentionsItem('', '2611')).toBe(false);
    expect(transcriptMentionsItem('#2611', null)).toBe(false);
  });
});

describe('shapePrs — gh pr list → the in-flight PR shape', () => {
  it('maps num(from headRef)/prNumber/state/ci/labels/mergeStateStatus/stoodDown', () => {
    const prs = shapePrs([
      { number: 658, state: 'OPEN', headRefName: 'lane/2611-conveyor-state', statusCheckRollup: [{ conclusion: 'SUCCESS' }], labels: [{ name: 'review:human' }], mergeStateStatus: 'BEHIND' },
    ]);
    expect(prs).toEqual([{ num: '2611', prNumber: 658, state: 'OPEN', ci: 'pass', labels: ['review:human'], mergeStateStatus: 'BEHIND', stoodDown: false }]);
  });
  it('tolerates a bare-string label array and a missing rollup', () => {
    expect(shapePrs([{ number: 1, headRefName: 'lane/5-x', labels: ['a'] }])[0]).toEqual({
      num: '5', prNumber: 1, state: '', ci: 'none', labels: ['a'], mergeStateStatus: '', stoodDown: false,
    });
  });
  it('carries mergeStateStatus through raw so the CI-heal BEHIND branch can read it (#2738)', () => {
    expect(shapePrs([{ number: 9, headRefName: 'lane/3-x', mergeStateStatus: 'BEHIND' }])[0].mergeStateStatus).toBe('BEHIND');
    expect(shapePrs([{ number: 9, headRefName: 'lane/3-x' }])[0].mergeStateStatus).toBe('');
  });
  it('null list → []', () => expect(shapePrs(null)).toEqual([]));
  it('#xaa7r2n — a retried PR headRef (attempt-tag letter) still resolves num, not null', () => {
    expect(shapePrs([{ number: 1851, headRefName: 'lane/3441b-resolve-on-land-extractor', state: 'OPEN' }])[0].num).toBe('3441');
  });
  // #3296 — `stoodDown` is derived from the PR's own comments via `countStandDownComments`, the SAME durable
  // marker `reconcile-core.mjs`'s `planReconcile` reads to refuse re-dispatching a fixer at this PR.
  it('#3296 a PR whose comments carry the durable STAND_DOWN_MARKER → stoodDown: true', () => {
    const pr = shapePrs([
      { number: 2223, headRefName: 'lane/3383-x', labels: [{ name: 'review:changes' }], comments: [
        { body: 'ordinary comment' },
        // #3383 — a trusted author is now required for this to count.
        { body: '🛑 conveyor fix — stood down, human judgment needed\n\nfoo', author: { login: 'web-everything' } },
      ] },
    ])[0];
    expect(pr.stoodDown).toBe(true);
  });
  it('#3296 a PR with ordinary comments (no stand-down marker) → stoodDown: false', () => {
    expect(shapePrs([{ number: 1, headRefName: 'lane/1-x', comments: [{ body: 'lgtm' }] }])[0].stoodDown).toBe(false);
  });
  it('#3296 a PR with no comments at all → stoodDown: false (never throws)', () => {
    expect(shapePrs([{ number: 1, headRefName: 'lane/1-x' }])[0].stoodDown).toBe(false);
  });
});

// A lane-pool `status --json` row + the scope-lease-collect picture leases share the lane index.
const poolRow = (lane, { leased = true, session = `sess-${lane}`, predictedScope, exists = true, clean } = {}) => ({
  lane, path: `/pool/lane-${lane}`, exists, leased, clean,
  lease: leased ? { session, ...(predictedScope ? { predictedScope } : {}) } : null,
});
const picLease = (lane, { predicted = [], breach = [], session = `sess-${lane}` } = {}) => ({ lane, session, predicted, observed: predicted, breach, clean: breach.length === 0 });

describe('reverseLaneItemMap — lane-ports registry → { lane: num } the health scan reads (#2616)', () => {
  it('reverses each entry that carries a lane (the shape acquire --item / map writes)', () => {
    const reg = { 2616: { port: 3110, lane: 1, repo: 'web-everything' }, 2617: { lane: 2, repo: 'basetest' } };
    expect(reverseLaneItemMap(reg)).toEqual({ 1: '2616', 2: '2617' });
  });
  it('keeps a JIT x-slug key verbatim', () => {
    expect(reverseLaneItemMap({ x5etmdv: { lane: 3 } })).toEqual({ 3: 'x5etmdv' });
  });
  it('an entry with no lane, and a missing / non-object / array registry, contribute nothing (never fabricated)', () => {
    expect(reverseLaneItemMap({ 42: { port: 3100 } })).toEqual({}); // no `lane` → skipped
    expect(reverseLaneItemMap({})).toEqual({});
    expect(reverseLaneItemMap(null)).toEqual({});
    expect(reverseLaneItemMap(undefined)).toEqual({});
    expect(reverseLaneItemMap([{ lane: 1 }])).toEqual({}); // an array registry is not a valid map
  });
  it('empty registry → empty map → assessHealth stays ok (the pre-#2616 inert-but-safe degrade)', () => {
    expect(reverseLaneItemMap({})).toEqual({});
  });
});

describe('shapeLanes — pool rows × scope picture → the tick lanes shape', () => {
  it('keeps only live-leased lanes and crosses in predicted scope + breach', () => {
    const poolStatus = { lanes: [poolRow(1, { predictedScope: ['we:src/a.ts'] }), poolRow(2, { leased: false })] };
    const scopePicture = { leases: [picLease(1, { predicted: ['we:src/a.ts'], breach: ['we:src/x.ts'] })] };
    const lanes = shapeLanes({ poolStatus, scopePicture, laneItem: { 1: '2611' } });
    expect(lanes).toEqual([{ lane: 1, num: '2611', session: 'sess-1', lease: ['we:src/a.ts'], breach: ['we:src/x.ts'] }]);
  });
  it('falls back to the marker predictedScope when the picture has no lease, num null when unmapped', () => {
    const poolStatus = { lanes: [poolRow(3, { predictedScope: ['we:src/m.ts'] })] };
    const lanes = shapeLanes({ poolStatus, scopePicture: { leases: [] } });
    expect(lanes[0]).toEqual({ lane: 3, num: null, session: 'sess-3', lease: ['we:src/m.ts'], breach: [] });
  });
});

describe('computeFreeSlots — free (existing, unleased, clean) lanes', () => {
  it('counts unleased existing lanes only', () => {
    const poolStatus = { lanes: [poolRow(1), poolRow(2, { leased: false }), poolRow(3, { leased: false }), { lane: 4, exists: false, leased: false }] };
    expect(computeFreeSlots(poolStatus)).toBe(2);
  });
  it('null pool → 0', () => expect(computeFreeSlots(null)).toBe(0));
  it('excludes an unleased lane sitting DIRTY (orphaned work from a crashed/killed session)', () => {
    const poolStatus = { lanes: [poolRow(1, { leased: false, clean: true }), poolRow(2, { leased: false, clean: false })] };
    expect(computeFreeSlots(poolStatus)).toBe(1);
  });
  it('a lane with no `clean` field at all (older pool-status shape) still counts — undefined is not false', () => {
    const poolStatus = { lanes: [poolRow(1, { leased: false })] };
    expect(computeFreeSlots(poolStatus)).toBe(1);
  });
});

describe('shapeDaemon — plateau daemon status report → the daemon section (or "unavailable")', () => {
  it('distills resident / lastPass / parked from the real report shape', () => {
    const report = { launchd: { loaded: true }, lastPass: { at: '2026-07-22T14:56:07.141Z', merged: 0 }, parkedNow: [{ num: 104, repo: 'plateauapp/plateau-app' }] };
    expect(shapeDaemon(report)).toEqual({ resident: true, lastPass: report.lastPass, parked: report.parkedNow });
  });
  it('a null/absent report → the "unavailable" sentinel (graceful degrade)', () => {
    expect(shapeDaemon(null)).toBe('unavailable');
    expect(shapeDaemon(undefined)).toBe('unavailable');
  });
});

describe('idle-clock inputs — last merge / last queue-add', () => {
  it('lastMergeFromDaemon = newest `at` among passes that merged something', () => {
    const report = { lastPass: { at: '2026-07-22T15:00:00.000Z', merged: 0 }, history: [{ at: '2026-07-22T13:00:00.000Z', merged: 2 }, { at: '2026-07-22T14:00:00.000Z', merged: 1 }] };
    expect(lastMergeFromDaemon(report)).toBe('2026-07-22T14:00:00.000Z');
  });
  it('lastMergeFromDaemon null when nothing merged / daemon unavailable', () => {
    expect(lastMergeFromDaemon({ lastPass: { at: 'x', merged: 0 }, history: [] })).toBe(null);
    expect(lastMergeFromDaemon(null)).toBe(null);
  });
  it('lastQueueAddFromQueued = newest queued `at`', () => {
    expect(lastQueueAddFromQueued({ queued: [{ num: '1', at: '2026-07-22T10:00:00Z' }, { num: '2', at: '2026-07-22T12:00:00Z' }] })).toBe('2026-07-22T12:00:00Z');
    expect(lastQueueAddFromQueued({ queued: [] })).toBe(null);
  });
  it('deriveIdle passes the injected now through and never calls Date', () => {
    const idle = deriveIdle({ daemonReport: null, queuedState: { queued: [] }, now: 1234 });
    expect(idle).toEqual({ lastMerge: null, lastQueueAdd: null, now: 1234 });
  });
});

describe('assessHealth — stalled-lane detection via transcript mtimes', () => {
  const now = 1_000_000_000_000;
  it('ok when no lane is past the stall threshold', () => {
    const lanes = [{ lane: 1, num: '2611', lastActivity: now - 10_000 }];
    expect(assessHealth({ lanes, now })).toEqual({ verdict: 'ok', stalled: [], degradedInfra: [], errors: [] });
  });
  it('warn + a stalled entry when a lane is silent past stallMs', () => {
    const lanes = [{ lane: 1, num: '2611', session: 's1', lastActivity: now - (DEFAULT_STALL_MS + 60_000) }];
    const h = assessHealth({ lanes, now });
    expect(h.verdict).toBe('warn');
    expect(h.stalled).toEqual([{ lane: 1, num: '2611', session: 's1', idleS: Math.round((DEFAULT_STALL_MS + 60_000) / 1000) }]);
  });
  it('a lane with no located transcript (lastActivity null) is NEVER flagged', () => {
    expect(assessHealth({ lanes: [{ lane: 1, num: '2611', lastActivity: null }], now }).verdict).toBe('ok');
  });
  it('collector errors alone make the verdict warn', () => {
    expect(assessHealth({ lanes: [], now, errors: ['lane-pool status: boom'] })).toEqual({ verdict: 'warn', stalled: [], degradedInfra: [], errors: ['lane-pool status: boom'] });
  });
});

describe('assessHealth — widespread external-infra failure clusters into ONE degraded-infra signal (#2661)', () => {
  const now = 1_000_000_000_000;
  const infraLane = (lane, num, cause) => ({ lane, num, infra: { cause, attempt: 1, nextRetrySec: 30, capped: false } });

  it('several lanes down on ONE cause collapse to a single degraded-infra entry — NOT N stall alarms', () => {
    const lanes = [infraLane(1, '2611', 'GitHub outage'), infraLane(2, '2612', 'GitHub outage'), infraLane(3, '2613', 'GitHub outage')];
    const h = assessHealth({ lanes, now });
    expect(h.stalled).toEqual([]); // an infra lane is NEVER a stall alarm
    expect(h.degradedInfra).toEqual([
      { cause: 'GitHub outage', count: 3, members: [{ lane: 1, num: '2611' }, { lane: 2, num: '2612' }, { lane: 3, num: '2613' }] },
    ]);
    // additive — degraded-infra does NOT flip the verdict (the outage is its own distinct signal).
    expect(h.verdict).toBe('ok');
  });

  it('distinct causes stay distinct; most-affected cause is ordered first (deterministic)', () => {
    const lanes = [infraLane(1, '11', 'network'), infraLane(2, '22', 'GitHub outage'), infraLane(3, '33', 'GitHub outage')];
    const h = assessHealth({ lanes, now });
    expect(h.degradedInfra.map((g) => [g.cause, g.count])).toEqual([['GitHub outage', 2], ['network', 1]]);
  });

  it('a genuine per-lane STALL still surfaces on its own alongside an unrelated outage cluster', () => {
    const lanes = [
      infraLane(1, '2611', 'GitHub outage'),
      infraLane(2, '2612', 'GitHub outage'),
      { lane: 3, num: '2613', session: 's3', lastActivity: now - (DEFAULT_STALL_MS + 90_000) }, // a real stall
    ];
    const h = assessHealth({ lanes, now });
    expect(h.verdict).toBe('warn'); // the genuine stall makes it warn
    expect(h.stalled).toEqual([{ lane: 3, num: '2613', session: 's3', idleS: Math.round((DEFAULT_STALL_MS + 90_000) / 1000) }]);
    expect(h.degradedInfra).toEqual([{ cause: 'GitHub outage', count: 2, members: [{ lane: 1, num: '2611' }, { lane: 2, num: '2612' }] }]);
  });

  it('an injected githubStatus REFINES the cause; a live incident groups every lane under "GitHub outage"', () => {
    // Two lanes recorded with DIFFERENT raw classes; a live major incident correlates both to "GitHub outage".
    const lanes = [infraLane(1, '11', 'network'), infraLane(2, '22', 'GitHub outage')];
    const h = assessHealth({ lanes, now, githubStatus: { reachable: true, indicator: 'major' } });
    expect(h.degradedInfra).toEqual([{ cause: 'GitHub outage', count: 2, members: [{ lane: 1, num: '11' }, { lane: 2, num: '22' }] }]);
  });

  it('a null / failed githubStatus never cascades — the store cause is used as-is (no false or lost signal)', () => {
    const lanes = [infraLane(1, '11', 'GitHub outage'), infraLane(2, '22', 'GitHub outage')];
    expect(assessHealth({ lanes, now, githubStatus: null }).degradedInfra).toEqual([
      { cause: 'GitHub outage', count: 2, members: [{ lane: 1, num: '11' }, { lane: 2, num: '22' }] },
    ]);
    // an unreachable status page (our OWN connectivity is the suspect) downgrades a "GitHub outage" base to
    // "network" via correlateCause — but both lanes downgrade identically, so it stays ONE cluster (count 2).
    const unreachable = assessHealth({ lanes, now, githubStatus: { reachable: false } }).degradedInfra;
    expect(unreachable).toEqual([{ cause: 'network', count: 2, members: [{ lane: 1, num: '11' }, { lane: 2, num: '22' }] }]);
  });
});

describe('clusterByCause — the same-cause collapse primitive (#2661), direct guards', () => {
  it('null / non-array / empty input → []', () => {
    expect(clusterByCause(null)).toEqual([]);
    expect(clusterByCause(undefined)).toEqual([]);
    expect(clusterByCause('nope')).toEqual([]);
    expect(clusterByCause([])).toEqual([]);
  });
  it('non-object members are skipped; a blank / absent cause folds to "infra"', () => {
    const out = clusterByCause([null, 42, { lane: 1, num: 7 }, { lane: 2, num: 8, cause: '   ' }]);
    expect(out).toEqual([{ cause: 'infra', count: 2, members: [{ lane: 1, num: '7' }, { lane: 2, num: '8' }] }]);
  });
  it('groups by exact cause, orders most-affected first then cause name, stringifies num, null-safe lane/num', () => {
    const out = clusterByCause([
      { lane: 3, num: 30, cause: 'network' },
      { lane: 1, num: 10, cause: 'GitHub outage' },
      { lane: 2, cause: 'GitHub outage' }, // no num → null
    ]);
    expect(out).toEqual([
      { cause: 'GitHub outage', count: 2, members: [{ lane: 1, num: '10' }, { lane: 2, num: null }] },
      { cause: 'network', count: 1, members: [{ lane: 3, num: '30' }] },
    ]);
  });
});

describe('attachLaneInfra — folds infra detail onto a lane by num (#2659)', () => {
  it('attaches infra to a matching lane; leaves an unmatched lane byte-for-byte unchanged', () => {
    const lanes = [{ lane: 1, num: '2659', session: 's', lease: [], breach: [] }, { lane: 2, num: '99', session: 's', lease: [], breach: [] }];
    const by = { 2659: { cause: 'GitHub outage', attempt: 1, nextRetrySec: 30, capped: false } };
    const out = attachLaneInfra(lanes, by);
    expect(out[0].infra).toEqual(by['2659']);
    expect(out[1]).toBe(lanes[1]); // unchanged reference — no infra key added
    expect('infra' in out[1]).toBe(false);
  });
  it('padding/#-tolerant match; a null-num lane never matches; empty inputs → []', () => {
    const lanes = [{ lane: 1, num: '02659' }, { lane: 3, num: null }];
    const by = { 2659: { cause: 'x', attempt: 1, nextRetrySec: 0, capped: true } };
    const out = attachLaneInfra(lanes, by);
    expect(out[0].infra).toEqual(by['2659']);
    expect('infra' in out[1]).toBe(false);
    expect(attachLaneInfra([], {})).toEqual([]);
  });
});

// ── END-TO-END (pure) — assembleConveyorState over three representative ticks ─────────────────────────────────
describe('assembleConveyorState — the whole tick picture', () => {
  const now = 1_000_000_000_000;
  const baseInputs = () => ({
    buildQueue: { queue: [{ num: '2611', rank: 1, buildQueued: true }, { num: '2612', rank: 2, buildQueued: false }] },
    poolStatus: { lanes: [poolRow(1, { predictedScope: ['we:scripts/readiness/conveyor-state.mjs'] }), poolRow(2, { leased: false }), poolRow(3, { leased: false }) ] },
    scopePicture: { leases: [picLease(1, { predicted: ['we:scripts/readiness/conveyor-state.mjs'] })] },
    prList: [{ number: 658, state: 'OPEN', headRefName: 'lane/2611-conveyor-state', statusCheckRollup: [{ conclusion: 'SUCCESS' }], labels: [{ name: 'review:human' }] }],
    daemonReport: { launchd: { loaded: true }, lastPass: { at: '2026-07-22T15:00:00Z', merged: 0 }, history: [{ at: '2026-07-22T14:00:00Z', merged: 1 }], parkedNow: [{ num: 104, repo: 'plateauapp/plateau-app' }] },
    queuedState: { queued: [{ num: '2611', at: '2026-07-22T14:30:00Z' }] },
    laneItem: { 1: '2611' },
    now,
  });

  it('HEALTHY tick — all sections populated, freeSlots counted, verdict ok', () => {
    const inputs = baseInputs();
    inputs.laneActivity = { 1: now - 5_000 }; // lane-1 active 5s ago
    const s = assembleConveyorState(inputs);
    expect(s.queue).toHaveLength(2);
    expect(s.queue[0]).toEqual({ num: '2611', rank: 1, buildQueued: true, openBlockers: [], scope: null, kind: null, epicState: null, prepared: false, preparedDate: null });
    expect(s.lanes).toEqual([{ lane: 1, num: '2611', session: 'sess-1', lease: ['we:scripts/readiness/conveyor-state.mjs'], breach: [] }]);
    expect(s.freeSlots).toBe(2);
    expect(s.prs).toEqual([{ num: '2611', prNumber: 658, state: 'OPEN', ci: 'pass', labels: ['review:human'], mergeStateStatus: '', stoodDown: false }]);
    expect(s.daemon).toEqual({ resident: true, lastPass: inputs.daemonReport.lastPass, parked: inputs.daemonReport.parkedNow });
    expect(s.idle).toEqual({ lastMerge: '2026-07-22T14:00:00Z', lastQueueAdd: '2026-07-22T14:30:00Z', now });
    expect(s.health).toEqual({ verdict: 'ok', stalled: [], degradedInfra: [], errors: [] });
  });

  it('SIDECAR-QUEUE tick — clearedNums flips queue.buildQueued to the session-local conveyor queue (#2613)', () => {
    const inputs = baseInputs();
    // Committed frontmatter says 2611 cleared, 2612 not — but the session sidecar cleared only 2612.
    inputs.clearedNums = ['2612'];
    const s = assembleConveyorState(inputs);
    expect(s.queue.map((r) => [r.num, r.buildQueued])).toEqual([
      ['2611', false], // committed buildQueued:true but NOT in the sidecar → not armed
      ['2612', true], // in the sidecar → armed, despite committed buildQueued:false
    ]);
    expect(s.clearedNotReady).toEqual([]); // both are ready rows
  });

  it('UNSHAPED tick — armed rows with no scope surface in state.unshaped; a scoped armed row does not (#2613)', () => {
    const inputs = baseInputs();
    // 2611 is scope-enriched (would parallelize); 2612 is armed but has no scope → the auto-prepare surface.
    inputs.buildQueue = { queue: [{ num: '2611', rank: 1, scope: ['we:scripts/readiness/conveyor-state.mjs'] }, { num: '2612', rank: 2 }] };
    inputs.clearedNums = ['2611', '2612'];
    const s = assembleConveyorState(inputs);
    expect(s.unshaped).toEqual([{ num: '2612', scope: null }]); // only the scope-less armed row
    expect(s.clearedNotReady).toEqual([]); // both are ready rows
  });

  it('CLEARED-NOT-READY tick — a cleared id with no ready row surfaces in state.clearedNotReady (#2613 review 2b)', () => {
    const inputs = baseInputs();
    inputs.clearedNums = ['2612', '9999999']; // 9999999 is not a ready build-queue row
    const s = assembleConveyorState(inputs);
    expect(s.clearedNotReady).toEqual(['9999999']); // surfaced, not silently dropped
    expect(s.queue.find((r) => r.num === '2612').buildQueued).toBe(true);
  });

  it('STALLED-LANE tick — a lane silent past the threshold → verdict warn + a stalled entry', () => {
    const inputs = baseInputs();
    inputs.laneActivity = { 1: now - (DEFAULT_STALL_MS + 120_000) }; // lane-1 silent > stall window
    const s = assembleConveyorState(inputs);
    expect(s.health.verdict).toBe('warn');
    expect(s.health.stalled).toEqual([{ lane: 1, num: '2611', session: 'sess-1', idleS: Math.round((DEFAULT_STALL_MS + 120_000) / 1000) }]);
    // the emitted lanes section itself stays activity-free (activity is folded in only for the health scan)
    expect('lastActivity' in s.lanes[0]).toBe(false);
  });

  it('DAEMON-UNAVAILABLE tick — a null report degrades to "unavailable" with NO health impact (real absent path)', () => {
    const inputs = baseInputs();
    // The REAL absent/errored daemon path: the shell routes a missing OR throwing daemon read to null WITHOUT
    // pushing an errors[] row (the daemon is best-effort/cross-repo), so no error is injected here.
    inputs.daemonReport = null;
    const s = assembleConveyorState(inputs);
    expect(s.daemon).toBe('unavailable');
    expect(s.idle.lastMerge).toBe(null); // no daemon ⇒ no merge clock
    expect(s.idle.lastQueueAdd).toBe('2026-07-22T14:30:00Z'); // queue-add still comes from queued.json
    expect(s.health.verdict).toBe('ok'); // a vanished daemon must NOT flip the tick to warn
    expect(s.health.errors).toEqual([]);
    // the rest of the tick is intact
    expect(s.queue).toHaveLength(2);
    expect(s.lanes).toHaveLength(1);
  });

  it('a genuine COLLECTOR error (e.g. lane-pool status failed) DOES flip the verdict to warn', () => {
    // Distinct from the best-effort daemon: a core collector failing IS surfaced as a warn (the shell passes its
    // errors[] through). This pins that the daemon is the ONLY read exempted from the health verdict.
    const inputs = baseInputs();
    inputs.errors = ['lane-pool status: spawn failed'];
    const s = assembleConveyorState(inputs);
    expect(s.health.verdict).toBe('warn');
    expect(s.health.errors).toEqual(['lane-pool status: spawn failed']);
  });

  it('INFRA-BLOCKED tick — a blocked item attaches infra to its lane, is NOT a stall, and surfaces in infraBlocked (#2659)', () => {
    const inputs = baseInputs();
    // lane-1 (mapped to #2611) is infra-blocked; its transcript is silent PAST the stall window — infra must win,
    // so it NEVER reads as a stall (the whole point of the first-class state vs a stall/gate-red).
    inputs.laneActivity = { 1: now - (DEFAULT_STALL_MS + 300_000) };
    inputs.infraBlocks = [{ num: '2611', ref: 'lane/2611-conveyor-state', sha: 'abc', base: 'main', cause: 'GitHub outage', attempt: 2, nextRetryAt: new Date(now + 45_000).toISOString() }];
    const s = assembleConveyorState(inputs);
    // the lane carries the exact infra detail status-board reads (⊘ marker + OUTAGE banner).
    expect(s.lanes[0].infra).toEqual({ cause: 'GitHub outage', attempt: 2, nextRetrySec: 45, capped: false });
    // NOT a stall — the infra lane is excluded from the health scan.
    expect(s.health.verdict).toBe('ok');
    expect(s.health.stalled).toEqual([]);
    // #2661 — instead of being dropped, the infra lane surfaces as ONE degraded-infra cluster keyed on its cause.
    expect(s.health.degradedInfra).toEqual([{ cause: 'GitHub outage', count: 1, members: [{ lane: 1, num: '2611' }] }]);
    // the raw entries are emitted whole for the /conveyor skill to surface.
    expect(s.infraBlocked).toHaveLength(1);
    expect(s.infraBlocked[0].num).toBe('2611');
    // a NON-infra lane is unaffected — no infra key on a clean tick.
    const clean = assembleConveyorState(baseInputs());
    expect('infra' in clean.lanes[0]).toBe(false);
    expect(clean.infraBlocked).toEqual([]);
  });
});

// ── CLI FLUSH regression pin (the IO shell) ──────────────────────────────────────────────────────────────────
// The pure core above is fixture-driven; this ONE test exercises the real `main()` CLI over an execFileSync PIPE
// — the exact consumer shape that TRUNCATED before the flush fix. `process.stdout.write` is async to a pipe, and
// the old `process.exit(0)` dropped the unflushed tail, so a large `--json` payload arrived as INVALID/partial
// JSON. The CLI now emits synchronously (writeAllSync) so the whole ~24KB payload drains before exit. If anyone
// reverts to async-write-then-exit, this JSON.parse throws on the truncated tail. The CLI's collectors degrade
// gracefully (a missing gh/daemon/lane-pool → empty section + errors[]), so the read never crashes; the build
// queue is derived from the repo's own backlog files, keeping the payload comfortably past the pipe buffer.
describe('CLI --json flush — the full payload round-trips through an execFileSync pipe (no truncation)', () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'conveyor-state.mjs');
  it('emits complete, parseable JSON with every top-level section present', () => {
    // `--no-lane-pool` (#x7xv2xt): the payload size comes from the build queue, not the lanes, so there is no
    // reason for a unit test to scan every real lane (`lane-pool status` + a per-lane git walk).
    // Hermetic (xcu4cqf): the PR collector shells `gh pr list`; a stub `gh` first on the child's PATH answers an
    // empty PR list so the read never reaches GitHub (the payload size under test comes from the build queue).
    const ghDir = mkdtempSync(join(tmpdir(), 'conveyor-state-gh-'));
    let out;
    try {
      writeFileSync(join(ghDir, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
      out = execFileSync('node', [CLI, '--json', '--no-lane-pool'], {
        encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` },
      });
    } finally { rmSync(ghDir, { recursive: true, force: true }); }
    // The whole payload arrived (a truncated tail would make this throw — the bug this pins).
    const state = JSON.parse(out);
    for (const key of ['queue', 'clearedNotReady', 'unshaped', 'lanes', 'freeSlots', 'prs', 'daemon', 'idle', 'health']) {
      expect(state, `missing top-level key: ${key}`).toHaveProperty(key);
    }
    // The trailing brace + newline made it through intact — the precise tail the async-exit race dropped.
    expect(out.trimEnd().endsWith('}')).toBe(true);
  }, 60_000); // the shell spawns several collectors — generous timeout, not a perf assertion
});
