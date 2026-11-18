/**
 * @file fetch-parked.test.mjs — proof of the PURE `assembleParked` + its helpers (#2434). The two `gh` calls
 *   are the I/O boundary (the CLI's concern); the view+diff → contract distillation, the rollup→bucket
 *   normalization, and the review-class read are decided in pure fns and unit-tested against fixtures, no gh.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  assembleParked, rollupToCheckRows, reviewClassFromLabels, labelNames,
  filterToRequired, recoverCheckRows, resolveRequiredNames,
  scopeFilesToNet, resolveNetDiff, sameCommit,
} from '../fetch-parked.mjs';
import { verifyNetDiffPair } from '../merge-ai-prs.mjs';
import { classifyChecks } from '../pr-land.mjs';
import { parseEscalationReason } from '../review-detail.mjs';
import { buildEscalationReasonBlock } from '../lib/review-escalation.mjs';
import { editorAllowedByReasons } from '../lib/review-core.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real-shaped `gh pr view … --json statusCheckRollup` — CheckRun rows carry status/conclusion, not bucket.
const greenRollup = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'visual', status: 'COMPLETED', conclusion: 'SKIPPED' },
];
const pendingRollup = [
  { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
];
const failedRollup = [
  { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
];

describe('rollupToCheckRows — normalizes the GraphQL rollup to gh bucket rows', () => {
  it('maps COMPLETED conclusions to pass/skipping buckets', () => {
    expect(rollupToCheckRows(greenRollup)).toEqual([
      { name: 'test', bucket: 'pass' },
      { name: 'smoke', bucket: 'pass' },
      { name: 'visual', bucket: 'skipping' },
    ]);
  });

  it('maps an in-flight status to pending regardless of a null conclusion', () => {
    expect(rollupToCheckRows(pendingRollup)).toEqual([{ name: 'test', bucket: 'pending' }]);
  });

  it('maps a FAILURE conclusion to fail', () => {
    expect(rollupToCheckRows(failedRollup)).toEqual([{ name: 'test', bucket: 'fail' }]);
  });

  it('reads a StatusContext (state, no status/conclusion)', () => {
    expect(rollupToCheckRows([{ __typename: 'StatusContext', context: 'ci/x', state: 'FAILURE' }]))
      .toEqual([{ name: 'ci/x', bucket: 'fail' }]);
  });

  it('is tolerant of an absent/odd rollup', () => {
    expect(rollupToCheckRows(undefined)).toEqual([]);
    expect(rollupToCheckRows(null)).toEqual([]);
  });

  it('feeds classifyChecks correctly — the whole point (green→passed, pending→pending, fail→failed)', () => {
    expect(classifyChecks(rollupToCheckRows(greenRollup)).status).toBe('passed');
    expect(classifyChecks(rollupToCheckRows(pendingRollup)).status).toBe('pending');
    expect(classifyChecks(rollupToCheckRows(failedRollup)).status).toBe('failed');
  });

  // #2925 — the decisive case: a superseded CANCELLED entry beside the SUCCESS that actually finished, same
  // check name. Before the fix this mapped to TWO rows (`{name:'test',bucket:'cancel'}` and
  // `{name:'test',bucket:'pass'}`) and `classifyChecks`' `some(isFail)` read the whole PR as failed even though
  // the check that finished is green — exactly the #1042 jam, one layer inside `/review`'s bundle and the
  // drain's `checks=` token.
  it('a superseded CANCELLED entry beside a later SUCCESS for the SAME name collapses to ONE green row', () => {
    const cancelledThenSuccess = [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    expect(rollupToCheckRows(cancelledThenSuccess)).toEqual([{ name: 'test', bucket: 'pass' }]);
    expect(classifyChecks(rollupToCheckRows(cancelledThenSuccess)).status).toBe('passed');
  });
});

describe('filterToRequired — narrows rows to the required set (#2482)', () => {
  const rows = [
    { name: 'test', bucket: 'pass' },
    { name: 'lint', bucket: 'fail' },
    { name: 'smoke', bucket: 'pending' },
  ];

  it('keeps only rows whose name is in requiredNames', () => {
    expect(filterToRequired(rows, ['test'])).toEqual([{ name: 'test', bucket: 'pass' }]);
  });

  it('an empty requiredNames yields [] (a no-required-checks PR → classifyChecks passed)', () => {
    expect(filterToRequired(rows, [])).toEqual([]);
    expect(classifyChecks(filterToRequired(rows, [])).status).toBe('passed');
  });

  it('a non-array requiredNames (unknown set) keeps ALL rows — the historical all-checks fallback', () => {
    expect(filterToRequired(rows, undefined)).toEqual(rows);
    expect(filterToRequired(rows, null)).toEqual(rows);
  });

  it('is tolerant of a non-array rows arg', () => {
    expect(filterToRequired(undefined, ['test'])).toEqual([]);
  });

  it('a required name absent from the rollup drops to [] → passed (same reconciliation pr-land makes)', () => {
    // The required `test` check has not reported into the rollup yet — filtering yields [], which classifies as
    // passed. This mirrors what `gh pr checks --required` returns to pr-land for the same PR, so the two agree.
    expect(filterToRequired([{ name: 'other', bucket: 'pass' }], ['test'])).toEqual([]);
    expect(classifyChecks(filterToRequired([{ name: 'other', bucket: 'pass' }], ['test'])).status).toBe('passed');
  });

  it('the point: required green + optional red reads as passed, not failed', () => {
    const mixed = [{ name: 'test', bucket: 'pass' }, { name: 'optional', bucket: 'fail' }];
    expect(classifyChecks(filterToRequired(mixed, ['test'])).status).toBe('passed');
    expect(classifyChecks(mixed).status).toBe('failed'); // the all-checks over-report we are fixing
  });
});

describe('recoverCheckRows — reads a non-zero `gh pr checks` result (#2482)', () => {
  it('recovers the JSON rows gh prints to stdout in the pending/failed case', () => {
    const rows = [{ name: 'test', state: 'IN_PROGRESS', bucket: 'pending' }];
    expect(recoverCheckRows({ stdout: JSON.stringify(rows) })).toEqual({ rows });
  });

  it('reads the genuine no-required-checks case (stderr "no checks reported") as []', () => {
    expect(recoverCheckRows({ stderr: 'no checks reported on the main branch' })).toEqual({ rows: [] });
    // …and that empty array classifies as passed — the exit-0 behaviour finding 3 wants.
    expect(classifyChecks(recoverCheckRows({ stderr: 'no checks reported' }).rows).status).toBe('passed');
  });

  it('matches "no checks reported" on the message too (not just stderr)', () => {
    expect(recoverCheckRows({ message: 'Command failed … no checks reported' })).toEqual({ rows: [] });
  });

  it('treats a real gh/network error as unknown (caller keeps waiting / falls back)', () => {
    expect(recoverCheckRows({ stderr: 'HTTP 503: server error' })).toEqual({ unknown: true });
    expect(recoverCheckRows({})).toEqual({ unknown: true });
  });

  it('non-JSON stdout that is not a no-checks message is unknown', () => {
    expect(recoverCheckRows({ stdout: 'garbage' })).toEqual({ unknown: true });
  });
});

describe('resolveRequiredNames — via an injected gh runner (#2482)', () => {
  it('maps the required rows to their names', () => {
    const runGh = () => JSON.stringify([{ name: 'test' }, { name: 'build' }]);
    expect(resolveRequiredNames(runGh, 472)).toEqual(['test', 'build']);
  });

  it('a no-required-checks PR (gh throws with the message) → []', () => {
    const runGh = () => { throw Object.assign(new Error('boom'), { stderr: 'no checks reported' }); };
    expect(resolveRequiredNames(runGh, 472)).toEqual([]);
  });

  it('recovers names from stdout when gh exits non-zero but printed rows', () => {
    const runGh = () => { throw Object.assign(new Error('boom'), { stdout: JSON.stringify([{ name: 'test' }]) }); };
    expect(resolveRequiredNames(runGh, 472)).toEqual(['test']);
  });

  it('a transient gh error → undefined (caller falls back to all-checks)', () => {
    const runGh = () => { throw Object.assign(new Error('boom'), { stderr: 'HTTP 503' }); };
    expect(resolveRequiredNames(runGh, 472)).toBeUndefined();
  });
});

describe('reviewClassFromLabels — reuses the ratified REVIEW_LABELS', () => {
  it('human wins over pending', () => {
    expect(reviewClassFromLabels(['review:human', 'review:pending'])).toBe('human');
  });
  it('pending when only pending is present', () => {
    expect(reviewClassFromLabels(['review:pending', 'ready-to-merge'])).toBe('pending');
  });
  it('none when no review label is present', () => {
    expect(reviewClassFromLabels(['ready-to-merge'])).toBe('none');
  });
});

describe('labelNames — normalizes {name}/string label shapes', () => {
  it('maps object and string labels to names, dropping empties', () => {
    expect(labelNames([{ name: 'a' }, 'b', null, {}])).toEqual(['a', 'b']);
  });
  it('is tolerant of a non-array', () => {
    expect(labelNames(undefined)).toEqual([]);
  });
});

describe('assembleParked — the per-PR bundle contract', () => {
  const view = {
    number: 472,
    title: 'scripts: drain helpers',
    body: 'the body',
    files: [{ path: 'scripts/fetch-parked.mjs', additions: 100, deletions: 0 }],
    state: 'OPEN',
    statusCheckRollup: greenRollup,
    labels: [{ name: 'ready-to-merge' }, { name: 'review:pending' }],
    headRefName: 'lane/2434-drain-helpers',
    mergeable: 'MERGEABLE',
  };
  const d = assembleParked({ view, diff: 'diff --git a/x b/x\n+hi' });

  it('carries the full contract shape', () => {
    expect(d.number).toBe(472);
    expect(d.title).toBe('scripts: drain helpers');
    expect(d.body).toBe('the body');
    expect(d.files).toEqual([{ path: 'scripts/fetch-parked.mjs', additions: 100, deletions: 0 }]);
    expect(d.state).toBe('OPEN');
    expect(d.headRefName).toBe('lane/2434-drain-helpers');
    expect(d.mergeable).toBe('MERGEABLE');
    expect(d.diff).toBe('diff --git a/x b/x\n+hi');
  });

  it('checks come from classifyChecks over the normalized rollup', () => {
    expect(d.checks.status).toBe('passed');
  });

  it('defaults checksScope to "all" when no requiredNames is supplied', () => {
    expect(d.checksScope).toBe('all');
  });

  it('narrows checks to the required set + marks checksScope when requiredNames is supplied (#2482)', () => {
    const mixed = {
      ...view,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    };
    const narrowed = assembleParked({ view: mixed, requiredNames: ['test'] });
    expect(narrowed.checks.status).toBe('passed');   // required green — over-report of the optional red is gone
    expect(narrowed.checksScope).toBe('required');
    // …whereas with no requiredNames the same PR over-reports the optional red.
    expect(assembleParked({ view: mixed }).checks.status).toBe('failed');
  });

  it('carries label names + the derived review class', () => {
    expect(d.labels).toEqual(['ready-to-merge', 'review:pending']);
    expect(d.reviewClass).toBe('pending');
  });
});

describe('assembleParked — tolerance of missing fields', () => {
  it('an empty view degrades to the empty contract, never throws', () => {
    const d = assembleParked({ view: {} });
    expect(d.number).toBe(0);
    expect(d.title).toBe('');
    expect(d.files).toEqual([]);
    expect(d.labels).toEqual([]);
    expect(d.reviewClass).toBe('none');
    expect(d.diff).toBe('');
    // no rollup → classifyChecks' no-checks default is "passed"
    expect(d.checks.status).toBe('passed');
    expect(d.checksScope).toBe('all');
  });

  it('a missing arg object does not throw', () => {
    expect(() => assembleParked()).not.toThrow();
  });
});

describe('#2901 — diffBasis: the bundle must say WHICH diff it is carrying', () => {
  // PR #1031 review, finding 5: the first cut guarded this field only with source-text greps in another file —
  // which pass on a file whose net-diff call is commented out, and fail on a behaviour-preserving rename. These
  // are behavioural, on the exported pure assembler, in the module's own canonical suite.
  const view = { number: 7, title: 't', body: '', files: [], state: 'OPEN', labels: [], headRefName: 'lane/x', mergeable: 'MERGEABLE' };

  it("reports 'net' only when the caller states it", () => {
    expect(assembleParked({ view, diff: 'd', diffBasis: 'net' }).diffBasis).toBe('net');
  });

  it("DEFAULTS to the degraded label — an unstated basis must never read as net", () => {
    // The whole point of the field: a degraded basis that looks identical to a good one is how a confident,
    // well-argued, wrong finding reaches a PR author (observed on PR #1018).
    expect(assembleParked({ view, diff: 'd' }).diffBasis).toBe('three-dot');
    expect(assembleParked({ view, diff: 'd', diffBasis: undefined }).diffBasis).toBe('three-dot');
    expect(assembleParked({ view, diff: 'd', diffBasis: null }).diffBasis).toBe('three-dot');
  });

  it('treats any unrecognised value as degraded, never as net', () => {
    for (const v of ['NET', 'net ', 'true', true, 1, {}, [], 'two-dot']) {
      expect(assembleParked({ view, diff: 'd', diffBasis: v }).diffBasis, `basis=${JSON.stringify(v)}`).toBe('three-dot');
    }
  });

  it('is present on every bundle, so a consumer can always ask', () => {
    expect(assembleParked({ view })).toHaveProperty('diffBasis');
    expect(assembleParked({})).toHaveProperty('diffBasis', 'three-dot');
  });
});

describe('#2864 — headSha: the bundle must say WHICH TREE its diff was read at', () => {
  // PR #1034 review, finding 1: the ledger's `reviewedSha` was write-dead because no production path could supply
  // a sha. The review loop reads its diff through THIS bundle, so the head it judged has to travel with the diff —
  // otherwise the loop has nothing to record and every ledger folds to `reviewedSha: null`.
  const view = { number: 7, title: 't', body: '', files: [], state: 'OPEN', labels: [], headRefName: 'lane/x', mergeable: 'MERGEABLE' };

  it('carries the head commit gh reported', () => {
    expect(assembleParked({ view: { ...view, headRefOid: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' }, diff: 'd' }).headSha)
      .toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  });

  it("degrades to '' when gh reported none — an unknown tree must read as unknown, never as another commit", () => {
    expect(assembleParked({ view, diff: 'd' }).headSha).toBe('');
    expect(assembleParked({}).headSha).toBe('');
  });

  it('is present on every bundle, so a consumer can always ask', () => {
    expect(assembleParked({ view })).toHaveProperty('headSha');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2908 / PR #1106 review F2 — escalationReason is PARSED here, not read by eye downstream.
// The convergence loop's fetch agent used to LLM-parse the `## Escalation reason` bullets out of `body`. Since
// #2908 that list decides whether a machine may push to the author's branch, and one dropped bullet flips it:
// ['size'] → low → editor ON, ['size','blast-radius'] → elevated → editor OFF. PR #1018 — the PR the ruling is
// built on — was parked with exactly those two. The exact parser already existed in review-detail.mjs; the
// bundle now carries its output so the agent copies rather than reads.
// ─────────────────────────────────────────────────────────────────────────────
describe('escalationReason — the drain\'s reason block, parsed exactly (#2908 / PR #1106 F2)', () => {
  const base = { number: 9, title: 't', files: [], state: 'OPEN', labels: [], headRefName: 'lane/x' };
  const bodyWith = (block) => `Some PR body.\n\n## Escalation reason\n\n${block}\n\n## Something else\n\n- not a reason\n`;

  it('reads BOTH bullets of the PR #1018 park — the pair that bands to elevated', () => {
    const body = bodyWith('- blast-radius (scripts/lib/review-core.mjs)\n- size (602 ≥ 400 changed lines)');
    expect(assembleParked({ view: { ...base, body } }).escalationReason)
      .toEqual(['blast-radius (scripts/lib/review-core.mjs)', 'size (602 ≥ 400 changed lines)']);
  });

  it('is the SAME output as the shared parser — one definition, not a second one here', () => {
    const body = bodyWith('- size (500 lines)\n- cross-repo (frontierui)');
    expect(assembleParked({ view: { ...base, body } }).escalationReason).toEqual(parseEscalationReason(body));
  });

  it('stops at the next heading and strips the bullet marker', () => {
    const body = bodyWith('- size (500 lines)');
    expect(assembleParked({ view: { ...base, body } }).escalationReason).toEqual(['size (500 lines)']);
  });

  it('[] when the PR carries no reason block — a REAL state (--park=review:pending, #2622), not only a bad read', () => {
    expect(assembleParked({ view: { ...base, body: 'Opened parked for review. No reason block.' } }).escalationReason).toEqual([]);
    expect(assembleParked({ view: base }).escalationReason).toEqual([]);
    expect(assembleParked({}).escalationReason).toEqual([]);
  });

  it('is present on every bundle, so a consumer can always ask', () => {
    expect(assembleParked({ view: base })).toHaveProperty('escalationReason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3101 — the real-world shape `bodyWith` above never exercises: `buildEscalationReasonBlock`'s trailing
// `<!-- policy-set: … -->` stamp with NO heading after it (end-of-body), which is what the drain actually
// writes. `bodyWith` always terminates the block with `## Something else` — a shape that already worked before
// the fix and so never caught this. Built with the real writer, not a hand-typed body, so the fixture cannot
// drift from what `buildEscalationReasonBlock` actually emits.
// ─────────────────────────────────────────────────────────────────────────────
describe('escalationReason — the stamped, end-of-body shape buildEscalationReasonBlock actually writes (#3101)', () => {
  const base = { number: 9, title: 't', files: [], state: 'OPEN', labels: [], headRefName: 'lane/x' };

  it('the trailing policy-stamp comment is not read as a bogus extra reason', () => {
    const body = `A PR description.${buildEscalationReasonBlock(['size (602 ≥ 400 changed lines)'])}`;
    expect(assembleParked({ view: { ...base, body } }).escalationReason).toEqual(['size (602 ≥ 400 changed lines)']);
  });

  it('THE #2908 REGRESSION PROOF: a stamped size-only park is editor-allowed — was false, is now true', () => {
    const body = `A PR description.${buildEscalationReasonBlock(['size (602 ≥ 400 changed lines)'])}`;
    const escalationReason = assembleParked({ view: { ...base, body } }).escalationReason;
    // The corrupted (pre-#3101) array would have carried the stamp as a bogus second element, and
    // editorAllowedByReasons — imported here from its real, exported source, not re-derived — fails CLOSED on
    // any reason it cannot canonicalize, forcing false on EVERY stamped park regardless of how low-risk its
    // real reasons are. A `size`-only park is exactly the editor-ON case #2908 was built for.
    expect(editorAllowedByReasons(escalationReason)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #1031 review, finding 4 — the DECISION is now testable, not just its default.
// The earlier repair asserted `assembleParked`'s one-line `diffBasis` ternary while everything that DECIDES the
// value lived inline in the unexported `runCli()`: the fetch-proof, the path parse, the fail-open rule, the
// scoped view. ~55 lines with no reachable assertion, explained by ~25 lines of comment doing a 3-line
// assertion's job. Those two decisions are now `scopeFilesToNet` (pure) and `resolveNetDiff` (exec-injected).
// ─────────────────────────────────────────────────────────────────────────────

describe('sameCommit — fail-closed object-name identity', () => {
  it('matches on the common prefix, both directions', () => {
    expect(sameCommit('a1b2c3d', 'a1b2c3d4e5f6789')).toBe(true);
    expect(sameCommit('a1b2c3d4e5f6789', 'a1b2c3d')).toBe(true);
    expect(sameCommit('A1B2C3D', ' a1b2c3d ')).toBe(true);
  });
  it('is false on a mismatch, and on anything it cannot verify', () => {
    expect(sameCommit('a1b2c3d', 'b2c3d4e')).toBe(false);
    for (const v of [null, undefined, '', '  ', 'abc', 'not-a-sha', 'abc123g', 123, {}]) {
      expect(sameCommit(v, 'a1b2c3d4'), `left=${JSON.stringify(v)}`).toBe(false);
      expect(sameCommit('a1b2c3d4', v), `right=${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('scopeFilesToNet — the file list rides the diff\'s basis, or refuses to', () => {
  const f = (...paths) => paths.map((path) => ({ path }));

  it('narrows the gh list to the net set when gh contains every net path', () => {
    const r = scopeFilesToNet({ ghFiles: f('a.ts', 'b.ts', 'sibling.md'), netPaths: ['a.ts', 'b.ts'] });
    expect(r.scoped).toBe(true);
    expect(r.files.map((x) => x.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('reads `filename` as well as `path` (gh spells it both ways)', () => {
    const r = scopeFilesToNet({ ghFiles: [{ filename: 'a.ts' }, { filename: 'z.md' }], netPaths: ['a.ts'] });
    expect(r.scoped).toBe(true);
    expect(r.files).toEqual([{ filename: 'a.ts' }]);
  });

  it('FAILS OPEN when a net path is missing from the gh list — the sources disagree', () => {
    // The dangerous direction: scoping here would present a SHORT list as authoritative, telling a reviewer a
    // real file is absent from the PR. Keep everything and let the caller drop the `net` claim.
    const gh = f('a.ts', 'sibling.md');
    const r = scopeFilesToNet({ ghFiles: gh, netPaths: ['a.ts', 'renamed.ts'] });
    expect(r.scoped).toBe(false);
    expect(r.files).toBe(gh);
  });

  it('compares SETS, not counts — a duplicate in gh\'s list must not mask a missing net path', () => {
    // PR #1039 finding 8. The old rule was `kept.length >= candidate.size`. gh reporting [a.ts, a.ts, c.md]
    // against net [a.ts, b.ts] gives kept.length 2 >= size 2, so it scoped — and b.ts vanished from the list a
    // juror is handed. That is the SHORT-list-as-authoritative outcome this function's own contract calls the
    // worse error, produced by the guard meant to prevent it.
    const gh = [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'c.md' }];
    const r = scopeFilesToNet({ ghFiles: gh, netPaths: ['a.ts', 'b.ts'] });
    expect(r.scoped, 'a duplicate masked a net path missing from gh\'s list').toBe(false);
    expect(r.files).toBe(gh);
  });

  it('refuses on an empty or absent net list rather than scoping to nothing', () => {
    const gh = f('a.ts');
    for (const netPaths of [[], null, undefined]) {
      const r = scopeFilesToNet({ ghFiles: gh, netPaths });
      expect(r.scoped).toBe(false);
      expect(r.files).toBe(gh);
    }
  });
});

describe('resolveNetDiff — a `net` basis is CLAIMED only when it is PROVEN', () => {
  const OID = 'a2a99afb73cde5f2d1c1be09a15d10e3b7083885';
  // A fake git that answers the shape resolveNetDiff drives. `overrides` swap in one behaviour at a time.
  function fakeExec({ fetchThrows = false, refAt = OID, diffText = 'diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\ndiff --git a/b.ts b/b.ts\nold mode 100644\nnew mode 100755\n', names = 'a.ts\0b.ts\0', unresolvable = false } = {}) {
    const calls = [];
    return {
      calls,
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        const a = args.join(' ');
        if (a.startsWith('fetch')) { if (fetchThrows) throw new Error('transport failed'); return ''; }
        if (a.startsWith('rev-parse --verify --end-of-options refs/remotes/origin/')) { if (refAt === null) throw new Error('unknown revision'); return `${refAt}\n`; }
        // A fake CANNOT prove the real argv is right — the real-git block below is what covers that. This arm
        // only keeps the fake honest about WHICH form the code asks for, so an argv change shows up here too.
        if (a.startsWith('rev-parse --end-of-options')) throw new Error('fake: unguarded rev-parse form is not the one under test');
        if (unresolvable) throw new Error('unknown revision');
        if (a.includes('--name-only')) return names;
        if (a.startsWith('rev-parse')) return `${OID}\n`;          // resolveNetDiffBasis' own probes
        if (a.startsWith('merge-base')) return `${OID}\n`;
        if (args.includes('--raw')) return names.split('\0').filter(Boolean).map(path => `:100644 100755 ${OID} ${OID} M\0${path}\0`).join('');
        if (args.includes('--numstat')) return names.split('\0').filter(Boolean).map(path => `0\t0\t${path}\n`).join('');
        if (args.includes('diff')) return diffText;
        return '';
      },
    };
  }

  it('claims `net` and returns text + plain paths on the happy path', () => {
    const { exec } = fakeExec();
    const r = resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID });
    expect(r.basis).toBe('net');
    expect(r.text).toContain('diff --git');
    expect(r.paths).toEqual(['a.ts', 'b.ts']);
  });

  it('refuses the probe: first text omits x.ts while the later path read includes it', () => {
    const full = fakeExec({ names: 'x.ts\0y.ts\0', diffText: 'diff --git a/x.ts b/x.ts\nold mode 100644\nnew mode 100755\ndiff --git a/y.ts b/y.ts\nold mode 100644\nnew mode 100755\n' });
    let renders = 0;
    const exec = (cmd, args, opts) => {
      if (args.includes('diff') && !args.some(a => ['--raw', '--numstat', '--name-only'].includes(a))) {
        renders++;
        if (renders === 1) return 'diff --git a/y.ts b/y.ts\nold mode 100644\nnew mode 100755\n';
      }
      // Each read is internally consistent; only cross-checking the returned pair catches this.
      if (args.includes('--raw') && renders === 1) return `:100644 100755 ${OID} ${OID} M\0y.ts\0`;
      return full.exec(cmd, args, opts);
    };
    expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID }))
      .toEqual({ text: '', paths: [], basis: 'three-dot' });
    expect(renders).toBe(2);
  });

  it('pins one base resolution even when a later fetch would advance main', () => {
    const fake = fakeExec();
    let baseFetches = 0;
    const bases = [];
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch' && args.includes('+main:refs/remotes/origin/main')) baseFetches++;
      if (args[0] === 'rev-parse' && /(?:main|FETCH_HEAD)\^\{commit\}$/.test(args.at(-1))) {
        return (baseFetches > 1 ? 'f'.repeat(40) : OID) + '\n';
      }
      if (args.includes('diff') && !args.includes('--numstat')) bases.push(args.slice(args.indexOf('--end-of-options') + 1));
      return fake.exec(cmd, args, opts);
    };
    expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID }).basis).toBe('net');
    expect(baseFetches).toBe(1);
    expect(bases.length).toBeGreaterThan(0);
    expect(bases.every(refs => refs[0] === OID || refs[0] === `${OID}..${OID}`)).toBe(true);
  });

  it.each(['baseSha', 'base', 'revSha'])('refuses paired outputs with differing %s before raw verification', field => {
    const basis = { ok: true, revSha: OID, baseSha: OID, diffBase: OID, candidate: OID };
    const text = { scored: true, text: '', revSha: OID, baseSha: OID, base: OID, rev: OID };
    const paths = { ...text, paths: [], [field]: 'f'.repeat(40) };
    expect(() => verifyNetDiffPair({ exec: () => { throw new Error('must not read'); }, basis, text, paths }))
      .toThrow(/paired diff basis mismatch/);
  });

  it('guards EVERY caller-supplied argv position with --end-of-options', () => {
    // `headRef` comes from the gh API, and `git check-ref-format 'refs/heads/--output=/tmp/pwn'` exits 0 — so a
    // dash-leading refname is legal and would otherwise be parsed as an option (`--upload-pack=<script>` runs).
    const { exec, calls } = fakeExec();
    resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID });
    const fetches = calls.filter((c) => c.startsWith('git fetch'));
    expect(fetches.length).toBeGreaterThan(0);
    for (const c of fetches) {
      expect(c, `unguarded fetch argv: ${c}`).toContain('--end-of-options');
      expect(c.indexOf('--end-of-options'), 'the guard must PRECEDE the ref').toBeLessThan(c.indexOf('lane/x'));
    }
  });

  it('degrades when the fetch fails — a swallowed transport error must not yield a `net` label', () => {
    const { exec } = fakeExec({ fetchThrows: true });
    expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID })).toEqual({ text: '', paths: [], basis: 'three-dot' });
  });

  it('degrades when the fetched ref is NOT the head gh reported — exit 0 is not currency', () => {
    // A clone with a narrowed refspec returns 0 from `git fetch origin lane/x` while never creating the ref, so
    // the basis would silently resolve against a stale local branch: the panel signs off commit A at head B.
    const { exec } = fakeExec({ refAt: 'ffffffffffffffffffffffffffffffffffffffff' });
    expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID }).basis).toBe('three-dot');
    const missing = fakeExec({ refAt: null });
    expect(resolveNetDiff({ exec: missing.exec, headRef: 'lane/x', headRefOid: OID }).basis).toBe('three-dot');
  });

  it('degrades when there is no oid to prove currency AGAINST', () => {
    const { exec } = fakeExec();
    for (const oid of [undefined, '', null, 'not-a-sha']) {
      expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: oid }).basis, `oid=${JSON.stringify(oid)}`).toBe('three-dot');
    }
  });

  it('KEEPS an empty net diff — it is the most valuable signal this basis produces (PR #1039 finding 10)', () => {
    // A branch content-identical to main. The old code threw this away and shipped the inflated three-dot diff
    // instead, hiding the one case a reviewer most needs told about. `scored` already separates "empty" from
    // "could not resolve", so emptiness never has to be read as failure.
    const r = resolveNetDiff({ exec: fakeExec({ diffText: '', names: '' }).exec, headRef: 'lane/x', headRefOid: OID });
    expect(r.basis).toBe('net');
    expect(r.text).toBe('');
    expect(r.paths).toEqual([]);
  });

  it('still degrades when the basis could not be RESOLVED (scored:false), which is a real failure', () => {
    const { exec } = fakeExec({ unresolvable: true });
    expect(resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID }).basis).toBe('three-dot');
  });

  it('degrades with no headRef and no exec at all', () => {
    expect(resolveNetDiff({ exec: fakeExec().exec, headRef: '' }).basis).toBe('three-dot');
    expect(resolveNetDiff({ headRef: 'lane/x', headRefOid: OID }).basis).toBe('three-dot');
    expect(resolveNetDiff().basis).toBe('three-dot');
  });

  it('uses hardened rename expansion consistently for text and path evidence', () => {
    const { exec, calls } = fakeExec();
    const result = resolveNetDiff({ exec, headRef: 'lane/x', headRefOid: OID });
    expect(result.basis).toBe('net');
    expect(result.paths).toEqual(['a.ts', 'b.ts']);
    const pathReads = calls.filter(c => c.includes('--name-only'));
    expect(pathReads.length).toBeGreaterThan(0);
    for (const call of pathReads) expect(call).toContain('--no-renames');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL GIT — the case the fakes structurally cannot cover.
//
// The third #1031 review found `resolveNetDiff` returning `degraded` on EVERY real invocation: plain
// `git rev-parse --end-of-options <ref>` ECHOES the guard as an output line, so the sha never parsed. Twenty
// fake-driven cases passed over a dead path, because the fake answered that command with the bare sha — it
// encoded what git was ASSUMED to do, not what git does. No amount of additional fake coverage catches that
// class; only running the real binary does. So this block spawns real git in a throwaway repo under tmpdir and
// asserts the ONE thing the fakes cannot: that the net basis actually engages end-to-end.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveNetDiff binds the diff to the OID, not the ref NAME (PR #1039 finding 1)', () => {
  const OID2 = 'a2a99afb73cde5f2d1c1be09a15d10e3b7083885';

  it('passes the OID as `rev`, so the diff cannot resolve a shadowing tag or local branch', () => {
    // The bug: proof took `refs/remotes/origin/<ref>` while the diff took the shorthand `origin/<ref>`, and git
    // resolves refs/tags/ and refs/heads/ BEFORE refs/remotes/. Reproduced on 2.50.1 — proof saw the head,
    // the diff saw a tag of the same name, and `net` was still claimed.
    const seen = [];
    const exec = (cmd, args) => {
      const a = args.join(' ');
      if (a.startsWith('fetch')) return '';
      if (a.startsWith('rev-parse --verify --end-of-options refs/remotes/')) return `${OID2}\n`;
      if (a.includes('--name-only')) { seen.push(a); return 'a.ts\0'; }
      if (args.includes('--raw')) return `:100644 100755 ${OID2} ${OID2} M\0a.ts\0`;
      if (args.includes('--numstat')) return '0\t0\ta.ts\n';
      if (args.includes('diff')) { seen.push(a); return 'diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n'; }
      if (a.startsWith('rev-parse')) return `${OID2}\n`;
      if (a.startsWith('merge-base')) return `${OID2}\n`;
      return '';
    };
    const r = resolveNetDiff({ exec, headRef: 'lane/y', headRefOid: OID2 });
    expect(r.basis).toBe('net');
    expect(seen.length, 'no diff was taken — the assertion would pass vacuously').toBeGreaterThan(0);
    for (const cmd of seen) {
      expect(cmd, `diff resolved a NAME, not the oid: ${cmd}`).not.toMatch(/origin\/lane\/y/);
      expect(cmd).toContain(OID2);
    }
  });

  it('still fetches by NAME — the oid is not fetchable, only diffable', () => {
    const fetches = [];
    const exec = (cmd, args) => {
      const a = args.join(' ');
      if (a.startsWith('fetch')) { fetches.push(a); return ''; }
      if (a.startsWith('rev-parse')) return `${OID2}\n`;
      if (a.startsWith('merge-base')) return `${OID2}\n`;
      if (a.includes('--name-only')) return 'a.ts\0';
      if (a.startsWith('diff')) return 'd\n';
      return '';
    };
    resolveNetDiff({ exec, headRef: 'lane/y', headRefOid: OID2 });
    expect(fetches.some((f) => f.includes('lane/y')), 'the head ref must still be fetched by name').toBe(true);
    // …and with an EXPLICIT destination refspec, never the bare opportunistic form (#2373 / finding 9).
    expect(fetches.some((f) => f.includes('+lane/y:refs/remotes/origin/lane/y'))).toBe(true);
  });
});

describe('resolveNetDiff against REAL git (the fake-vs-reality guard)', () => {

  let dir; let clone; let headOid;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fetch-parked-realgit-'));
    const up = join(dir, 'up');
    const git = (cwd, ...args) => String(execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
    execFileSync('git', ['init', '-q', '--initial-branch=main', up], { stdio: 'ignore' });
    git(up, 'config', 'user.email', 'a@b.c');
    git(up, 'config', 'user.name', 'test');
    writeFileSync(join(up, 'README.md'), 'base\n');
    git(up, 'add', 'README.md');
    git(up, 'commit', '-qm', 'base');
    // A head ref that is AHEAD of main by one commit, created without ever switching branches.
    const baseOid = git(up, 'rev-parse', 'HEAD');
    writeFileSync(join(up, 'feature.txt'), 'new\n');
    git(up, 'add', 'feature.txt');
    const tree = git(up, 'write-tree');
    headOid = git(up, 'commit-tree', tree, '-p', baseOid, '-m', 'feature');
    git(up, 'update-ref', 'refs/heads/lane/x', headOid);
    git(up, 'reset', '-q', '--hard', baseOid); // main stays at base; lane/x is the PR head
    clone = join(dir, 'down');
    execFileSync('git', ['clone', '-q', up, clone], { stdio: 'ignore' });
  });

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const realExec = () => (c, a, o) => execFileSync(c, a, { cwd: clone, maxBuffer: 64 * 1024 * 1024, ...o });

  it('ENGAGES the net basis — the assertion that was dead for a whole review round', () => {
    const r = resolveNetDiff({ exec: realExec(), headRef: 'lane/x', headRefOid: headOid });
    expect(r.basis, 'the net basis never engaged against real git').toBe('net');
    expect(r.paths).toEqual(['feature.txt']);
    expect(r.text).toContain('feature.txt');
  });

  it('rev-parse returns a BARE sha under --verify (plain --end-of-options echoes the guard)', () => {
    // Pin the exact git behaviour the bug turned on, so a future edit back to the un-verified form fails here.
    const exec = realExec();
    const verified = String(exec('git', ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/lane/x'], { encoding: 'utf8' })).trim();
    expect(verified).toMatch(/^[0-9a-f]{40}$/);
    const echoed = String(exec('git', ['rev-parse', '--end-of-options', 'refs/remotes/origin/lane/x'], { encoding: 'utf8' })).trim();
    expect(echoed.split('\n')[0], 'git no longer echoes the guard — the workaround may be removable').toBe('--end-of-options');
  });

  it('still REFUSES an option-shaped ref, so --verify did not weaken the guard', () => {
    const exec = realExec();
    expect(() => exec('git', ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/--output=/tmp/pwn'], { encoding: 'utf8' })).toThrow();
  });

  it('degrades against a real repo when the head moved under it (currency, not just resolvability)', () => {
    const other = 'ffffffffffffffffffffffffffffffffffffffff';
    expect(resolveNetDiff({ exec: realExec(), headRef: 'lane/x', headRefOid: other }).basis).toBe('three-dot');
  });
});
