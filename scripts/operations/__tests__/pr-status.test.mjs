/**
 * @file pr-status.test.mjs — #xewnork: did a check actually RUN on the head that is there now?
 *
 * THE PROPERTY UNDER TEST IS THAT `unchecked` NEVER SOFTENS. Every other state is easy; this one is the
 * reason the file exists. PRs #1510 and #1511 sat for twelve hours holding zero check runs while a `checking`
 * label asserted otherwise, and every plausible bug here — folding empty into `pending`, treating a skipped
 * suite as green, reading a superseded commit's marks — turns that stall back into something that looks
 * normal. So the tests below are mostly about refusing to be reassured.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  prStatusOperation, reduceCheckState, labelDisagreements, shapeReadFinding, assessPrs,
  PR_STATUS_OP, CHECK_STATES, LABEL_CLAIMS, FAILING_CONCLUSIONS,
} from '../pr-status.mjs';
import { collapseRollupToLatestPerName } from '../../lib/rollup-collapse.mjs';
import { listArgv, checksArgv, parseJsonLines, labelNames, createPrReader, LIST_LIMIT } from '../pr-status-io.mjs';

// `reduceCheckState` collapses to the LATEST run per check NAME first (`collapseRollupToLatestPerName`,
// #2925/#xkfv491 — see that function's own header, and `reduceCheckState`'s, for why). Two helper calls that
// share a `name` (the default, when omitted) are therefore NOT two independent checks — they are two RUNS of
// the SAME check, and only the LAST one in the array is read. Give every check in a test its own distinct
// `name` unless the point of that specific test IS the same-name collapse.
const done = (conclusion, name = 'test') => ({ name, status: 'completed', conclusion });
const running = (name = 'test') => ({ name, status: 'in_progress', conclusion: null });

describe('reduceCheckState — the empty list is the whole point', () => {
  it('reports `unchecked` for zero check runs, and says why', () => {
    // The live case. `total_count: 0` for twelve hours on two PRs, read by everyone as "still building".
    const r = reduceCheckState([]);
    expect(r.state).toBe('unchecked');
    expect(r.why).toMatch(/no check run exists for this head/);
    expect(r.counts.total).toBe(0);
  });

  it('does NOT fold `unchecked` into `pending` — they are different facts', () => {
    expect(reduceCheckState([]).state).not.toBe('pending');
    expect(reduceCheckState([running()]).state).toBe('pending');
  });

  it('a completed check with NO readable conclusion is unchecked, never green', () => {
    // Absence of evidence is not evidence of absence — the same line `verify` draws around `unrun`.
    for (const c of [null, '', 'something_new']) {
      expect(reduceCheckState([done(c)]).state).toBe('unchecked');
    }
  });

  it('a suite that only skipped gated nothing, so it is unchecked', () => {
    expect(reduceCheckState([done('skipped'), done('neutral')]).state).toBe('unchecked');
  });

  it('green requires at least one check that actually succeeded', () => {
    expect(reduceCheckState([done('success')]).state).toBe('green');
    // Two DISTINCT checks (never the SAME name twice — see the `collapseRollupToLatestPerName` note below):
    // one real check passed, a separate one merely skipped. Still green.
    expect(reduceCheckState([done('success'), done('skipped', 'visual')]).state).toBe('green');
  });

  it('pending outranks failure outranks success — a caller acts on the worst thing still true', () => {
    // One job still running is not green however many siblings passed.
    expect(reduceCheckState([done('success'), done('failure'), running()]).state).toBe('pending');
    expect(reduceCheckState([done('success'), done('failure')]).state).toBe('red');
    expect(reduceCheckState([done('success'), done('success')]).state).toBe('green');
  });

  it('treats every failing conclusion as red, not just `failure`', () => {
    for (const c of ['failure', 'timed_out', 'cancelled', 'action_required', 'stale']) {
      expect(reduceCheckState([done(c)]).state).toBe('red');
    }
  });

  it('excludes review-gate from CI truth — it is BY DESIGN red until a PR is reviewed, not a code-health signal (x3hg6h2)', () => {
    // Live rollup shape confirmed 2026-09-05: every real check green, only review-gate red. Must read green
    // (not red) here — this is what let the review-dispatch deadlock happen upstream (reconcile-core.mjs /
    // classifyPr both read CI truth off this same shape).
    expect(reduceCheckState([done('success'), done('failure', 'review-gate')]).state).toBe('green');
    // review-gate alone, nothing else run yet, still reads unchecked (not green, not red) — no real check has
    // reported anything about this commit yet.
    expect(reduceCheckState([done('failure', 'review-gate')]).state).toBe('unchecked');
    // A real failing check beside review-gate's expected failure still reads red.
    expect(reduceCheckState([done('failure'), done('failure', 'review-gate')]).state).toBe('red');
  });

  // #2748 false-red follow-up (soak-replay-gate, PR #2775) — `requiredChecks`, when supplied, replaces the
  // exclusion list with the inverse question: only a check IN that set counts at all. Future-proof against a
  // brand-new advisory check whose name nobody has added to `CI_TRUTH_EXCLUDED_CHECKS` yet.
  it('requiredChecks: only a required-set check counts — an unlisted advisory red (soak-replay-gate) is invisible', () => {
    const required = ['test', 'smoke', 'daemon-soak'];
    expect(reduceCheckState([...required.map(name => done('success', name)), done('failure', 'soak-replay-gate')], required).state).toBe('green');
    expect(reduceCheckState([done('failure', 'soak-replay-gate')], required).state).toBe('unchecked');
    expect(reduceCheckState([done('success', 'test'), done('failure', 'test')], required).state).toBe('red');
    // Omitted/empty falls back to the exclusion-list default, unchanged.
    expect(reduceCheckState([done('success', 'test'), done('failure', 'soak-replay-gate')]).state).toBe('green');
    expect(reduceCheckState([done('success', 'test'), done('failure', 'soak-replay-gate')], []).state).toBe('green');
  });

  // we:backlog/fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878, web-everything/web-everything) —
  // a required check that RE-RUNS more than once on one head (a `-gate`-shaped check retriggered by a
  // `labeled`/`unlabeled`/`edited` event: `review-gate.yml`, `soak-replay-gate.yml`) can leave a STALE
  // `FAILURE` run beside a later `SUCCESS` rerun of the SAME name in one `statusCheckRollup` fetch. Before the
  // `collapseRollupToLatestPerName` fix, a flat `.filter()` counted the stale run too, reading `red` off a
  // check whose CURRENT run had already gone green — dispatching a ci-heal that could only ever find nothing
  // to fix. Confirmed against #2878's own real rollup (fetched live via `gh pr view --json statusCheckRollup`).
  it('collapses to the LATEST run per check name before judging — a stale failure superseded by a later success reads green, not red', () => {
    const required = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
    // The exact live shape: `soak-replay-gate` failed once, then reran green on the SAME head — no new push,
    // just a rerun (GitHub keeps both check runs). Every OTHER required check only ever ran once, green.
    expect(reduceCheckState([
      done('failure', 'soak-replay-gate'), // stale — superseded below
      done('success', 'test'),
      done('success', 'smoke'),
      done('success', 'daemon-soak'),
      done('success', 'soak-replay-gate'), // the LATEST run of the same check — this is the one that counts
    ], required).state).toBe('green');
    // The mirror case: a check that PASSED once and then genuinely failed on a LATER rerun must still read
    // red — collapsing to the latest run is not "ever green, always green".
    expect(reduceCheckState([
      done('success', 'soak-replay-gate'),
      done('failure', 'soak-replay-gate'),
    ], required).state).toBe('red');
  });

  // PR #2894 review (CONFIRMED): the REST `commits/<sha>/check-runs` feed (`checksArgv` — used by
  // `assessPrs`/`pr-reconcile` and `promote-draft-pr-dispatch.mjs#defaultReadHeadCheckState`) lists runs
  // NEWEST-FIRST, the opposite of `statusCheckRollup`. A positional "last entry wins" collapse would keep the
  // OLDEST run there, so a check that passed and then genuinely failed on a later rerun read green — and
  // promote-draft could `gh pr ready` a draft whose latest required check is red. Each REST row carries its
  // run `id` (monotonic by creation), so the collapse ranks by it whenever every run of a name has one.
  it('REST newest-first feed: ranks by run id, so a later failure is never hidden behind an older success', () => {
    const required = ['soak-replay-gate'];
    const run = (id, conclusion) => ({ id, name: 'soak-replay-gate', status: 'completed', conclusion });
    expect(reduceCheckState([run(109255880842, 'failure'), run(109255874532, 'success')], required).state).toBe('red');
    expect(reduceCheckState([run(109255880842, 'success'), run(109255874532, 'failure')], required).state).toBe('green');
    // Same runs, rollup (oldest-first) order — the answer must not depend on the feed's ordering.
    expect(reduceCheckState([run(109255874532, 'success'), run(109255880842, 'failure')], required).state).toBe('red');
  });

  it('falls back to last-by-position unless EVERY run of a name has a numeric id (the rollup carries none)', () => {
    const row = (id, conclusion) => ({ ...(id === undefined ? {} : { id }), name: 'x', status: 'completed', conclusion });
    const pick = (rows) => collapseRollupToLatestPerName(rows)[0].conclusion;
    expect(pick([row(undefined, 'failure'), row(undefined, 'success')])).toBe('success'); // rollup: no ids
    expect(pick([row(9, 'success'), row(undefined, 'failure')])).toBe('failure');         // mixed → positional
    expect(pick([row('CR_kwA', 'success'), row('CR_kwB', 'failure')])).toBe('failure');   // GraphQL node ids → positional
    expect(pick([row('20', 'failure'), row('10', 'success')])).toBe('failure');           // numeric strings rank
  });

  it('only ever answers with a declared state', () => {
    const inputs = [[], [running()], [done('success')], [done('failure')], [done('skipped')], [done(null)]];
    for (const i of inputs) expect(CHECK_STATES).toContain(reduceCheckState(i).state);
  });
});

describe('labelDisagreements — the pair that made a stall look normal', () => {
  it('flags `checking` beside zero check runs', () => {
    const d = labelDisagreements({ labels: ['checking'], state: 'unchecked' });
    expect(d).toHaveLength(1);
    expect(d[0].why).toMatch(/DO NOT EXIST for this head/);
  });

  it('flags `ready-to-merge` on anything but green — the drain acts on that label', () => {
    for (const state of ['unchecked', 'red', 'pending']) {
      expect(labelDisagreements({ labels: ['ready-to-merge'], state })).toHaveLength(1);
    }
    expect(labelDisagreements({ labels: ['ready-to-merge'], state: 'green' })).toEqual([]);
  });

  it('says nothing when the label agrees', () => {
    // Without this, "always flag" passes both tests above.
    expect(labelDisagreements({ labels: ['checking'], state: 'pending' })).toEqual([]);
    expect(labelDisagreements({ labels: ['checking'], state: 'green' })).toEqual([]);
  });

  it('judges ONLY labels that make a claim about checks', () => {
    // A `review:*` label claims something about a REVIEW. Reporting it here would be this operation
    // answering a question it does not own (#2644).
    expect(labelDisagreements({ labels: ['review:pending', 'review:accepted', 'lane'], state: 'unchecked' })).toEqual([]);
    expect(Object.keys(LABEL_CLAIMS).sort()).toEqual(['checking', 'ready-to-merge']);
  });
});

describe('shapeReadFinding — an unreadable result is not "no open PRs"', () => {
  it('refuses a non-list result rather than reporting an empty repo', () => {
    for (const raw of [null, {}, { prs: 'nope' }]) {
      expect(() => shapeReadFinding(raw)).toThrow(/must return .*prs/);
    }
  });

  it('refuses a PR with no headSha — every state here is a claim about one commit', () => {
    expect(() => shapeReadFinding({ prs: [{ number: 1, headSha: '' }] })).toThrow(/no `headSha`/);
  });

  it('refuses a PR with no usable number', () => {
    expect(() => shapeReadFinding({ prs: [{ headSha: 'abc' }] })).toThrow(/no usable `number`/);
  });

  it('accepts a genuinely empty open-PR list — that IS an answer', () => {
    expect(shapeReadFinding({ repo: 'o/r', prs: [] })).toEqual({ repo: 'o/r', prs: [], truncated: false });
  });
});

describe('assessPrs — what a caller should look at, worst-understood first', () => {
  const pr = (number, checks, labels = []) => ({ number, headSha: `${number}aaaaaaa`, title: 't', labels, mergeable: 'mergeable', checks });

  it('orders blocking as unchecked → red → label-disagrees', () => {
    // A PR nothing has checked outranks one whose checks failed: the failure is at least known, and someone
    // can act on it. The silently unchecked one is what costs twelve hours.
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', prs: [
      pr(2, [done('failure')]),
      pr(1, []),
      pr(3, [done('success')], ['ready-to-merge']),
    ] }));
    expect(v.blocking.map((b) => b.why)).toEqual(['unchecked', 'red']);
    expect(v.blocking[0].pr).toBe(1);
  });

  it('counts each state, and reports the head sha beside the finding', () => {
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', prs: [pr(1, []), pr(2, [done('success')]), pr(3, [running()])] }));
    expect({ open: v.open, green: v.green, pending: v.pending, red: v.red, unchecked: v.unchecked })
      .toEqual({ open: 3, green: 1, pending: 1, red: 0, unchecked: 1 });
    expect(v.blocking[0].detail).toMatch(/^1aaaaaaa/);
  });

  it('reproduces the #1510/#1511 shape end to end', () => {
    // `checking` beside zero runs: the state is unchecked AND the label is called out, because either alone
    // is what let this read as normal.
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', prs: [pr(1510, [], ['checking', 'review:accepted'])] }));
    expect(v.prs[0].state).toBe('unchecked');
    expect(v.blocking.map((b) => b.why)).toEqual(['unchecked', 'label-disagrees']);
  });

  it('marks an empty repo explicitly rather than leaving silence to be read as green', () => {
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', prs: [] }));
    expect(v.noOpenPrs).toBe(true);
    expect(v.blocking).toEqual([]);
  });

  it('a fully green repo blocks on nothing', () => {
    // The positive that stops "always block" passing everything above.
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', prs: [pr(1, [done('success')]), pr(2, [done('success')], ['ready-to-merge'])] }));
    expect(v.blocking).toEqual([]);
    expect(v.noOpenPrs).toBeUndefined();
  });
});

describe('the io shell', () => {
  it('asks for headRefOid — without it every PR is unassessable', () => {
    expect(listArgv({ repo: 'o/r' }).join(' ')).toContain('headRefOid');
    expect(listArgv({ repo: 'o/r', pr: 7 })).toEqual(
      ['pr', 'view', '7', '--repo', 'o/r', '--json', 'number,title,labels,mergeable,headRefOid'],
    );
  });

  it('keys checks to the SHA, not the PR number', () => {
    // `gh pr checks <n>` will report a run recorded against a SUPERSEDED commit — the exact reading that let
    // two PRs display green marks belonging to commits that were no longer their heads.
    const argv = checksArgv({ repo: 'o/r', sha: 'deadbeef' });
    expect(argv.join(' ')).toContain('repos/o/r/commits/deadbeef/check-runs');
    expect(argv.join(' ')).not.toMatch(/pr checks/);
  });

  it('selects each run\'s `id` — the REST feed is newest-first, and the per-name collapse ranks by it (PR #2894 review)', () => {
    const jq = checksArgv({ repo: 'o/r', sha: 'deadbeef' }).at(-1);
    expect(jq).toMatch(/\{[^}]*\bid\b[^}]*\}/);
  });

  it('parses newline-delimited json, and reads a blank stream as zero checks', () => {
    expect(parseJsonLines('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonLines('')).toEqual([]);
  });

  it('normalizes gh label objects and bare strings alike', () => {
    expect(labelNames([{ name: 'checking' }, 'lane', { name: '' }, null])).toEqual(['checking', 'lane']);
  });

  it('THROWS when the check fetch fails instead of yielding an empty list', () => {
    // The most important line in the io shell. An empty check list is read as `unchecked` — a real,
    // actionable alarm — so a network error that produced one would manufacture the very finding this
    // operation exists to raise, and a false `unchecked` teaches people to ignore a true one.
    const read = createPrReader({ run: (_bin, argv) => {
      if (argv[0] === 'pr') return JSON.stringify([{ number: 1, title: 't', labels: [], mergeable: 'MERGEABLE', headRefOid: 'abc123' }]);
      throw new Error('gh: network unreachable');
    } });
    expect(() => read({ repo: 'o/r' })).toThrow(/network unreachable/);
  });

  it('reads a PR and its head-keyed checks through one injected runner', () => {
    const seen = [];
    const read = createPrReader({ run: (_bin, argv) => {
      seen.push(argv.join(' '));
      if (argv[0] === 'pr') return JSON.stringify([{ number: 9, title: 't', labels: [{ name: 'checking' }], mergeable: 'MERGEABLE', headRefOid: 'abc123' }]);
      return '{"name":"test","status":"completed","conclusion":"success"}\n';
    } });
    const out = read({ repo: 'o/r' });
    expect(out.prs[0]).toMatchObject({ number: 9, headSha: 'abc123', labels: ['checking'], mergeable: 'mergeable' });
    expect(seen[1]).toContain('commits/abc123/check-runs');
  });
});

// ── THE TWO CARVE-OUTS PR #1521's JUROR CONFIRMED ────────────────────────────────────────────────────────
describe('startup_failure is a check that RAN and failed (#1521 juror)', () => {
  it('reports red, not unchecked', () => {
    // Omitting it sent this case to `unreadable`, which reports `unchecked`. The direction matters: `red`
    // says "someone broke something, go look"; `unchecked` says "nothing has been asked yet". A broken
    // workflow file yields `startup_failure` on EVERY run, so the whole PR would have read as never checked
    // rather than as reliably failing.
    expect(reduceCheckState([done('startup_failure')]).state).toBe('red');
    expect(FAILING_CONCLUSIONS).toContain('startup_failure');
  });

  it('still refuses to guess at a conclusion it genuinely does not know', () => {
    // The list must not become a catch-all: an unrecognised value is still `unchecked`, never `red` and
    // never `green`. Widening it to "anything that is not success" would be the opposite error.
    expect(reduceCheckState([done('a_conclusion_github_adds_in_2027')]).state).toBe('unchecked');
  });
});

describe('the list cap is REPORTED, not silent (#1521 juror)', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: 't', labels: [], mergeable: 'MERGEABLE', headRefOid: `sha${i}` }));
  const readerFor = (n) => createPrReader({ run: (_bin, argv) => (argv[0] === 'pr' ? JSON.stringify(rows(n)) : '') });

  it('marks a FULL listing as truncated — the honest answer is "I cannot tell"', () => {
    // This operation exists so silence does not read as absence, and the first cut silently dropped every PR
    // past the 100th from a report whose whole purpose is noticing a PR nobody is looking at. `gh` does not
    // say whether more existed, so neither may this.
    expect(readerFor(LIST_LIMIT)({ repo: 'o/r' }).truncated).toBe(true);
  });

  it('does NOT cry truncation on a short listing', () => {
    // Without this, "always truncated" passes the test above and the flag means nothing.
    expect(readerFor(3)({ repo: 'o/r' }).truncated).toBe(false);
  });

  it('never marks a single-PR read as truncated — there was nothing to cap', () => {
    const read = createPrReader({ run: (_bin, argv) => (argv[0] === 'pr' ? JSON.stringify(rows(1)[0]) : '') });
    expect(read({ repo: 'o/r', pr: 1 }).truncated).toBe(false);
  });

  it('carries truncation into the verdict, where a caller will see it', () => {
    // A flag the reader sets and the verdict drops is the same silence one layer along.
    const v = assessPrs(shapeReadFinding({ repo: 'o/r', truncated: true, prs: [] }));
    expect(v.truncated).toBe(true);
    expect(assessPrs(shapeReadFinding({ repo: 'o/r', prs: [] })).truncated).toBeUndefined();
  });

  it('asks for the raised limit', () => {
    expect(listArgv({ repo: 'o/r' })).toContain(String(LIST_LIMIT));
  });

  it('PAGINATES the check-runs fetch too — the sibling call, not just the one that was patched', () => {
    // PR #1521 round 2. The REST default page size is 30, so a head with more check runs than that silently
    // drops the later ones — and `reduceCheckState` reads only what it is handed, so a dropped FAILING check
    // turns a `red` head `green`. Fixing the PR-list cap and leaving this one is the same defect one call
    // along, in the file whose whole argument is that silence must not read as absence.
    expect(checksArgv({ repo: 'o/r', sha: 'abc' })).toContain('--paginate');
  });
});

describe('the declaration', () => {
  it('derives its command line and refuses a missing reader', () => {
    expect(() => prStatusOperation({})).toThrow(/needs a `readPrs\(\)` reader/);
    const decl = prStatusOperation({ readPrs: () => ({ repo: 'o/r', prs: [] }) });
    expect(decl.name).toBe(PR_STATUS_OP);
    expect(Object.keys(decl.input)).toEqual(['repo', 'pr']);
    expect(decl.input.repo.required).toBe(true);
  });

  it('is READ-ONLY — both steps are compute, so no effect exists for a sink to apply', () => {
    const decl = prStatusOperation({ readPrs: () => ({ repo: 'o/r', prs: [] }) });
    expect(decl.steps.map((s) => s.step.kind)).toEqual(['compute', 'compute']);
  });

  it('the `read` step threads BOTH inputs into the reader, and declares both reads', () => {
    // The engine projects only declared reads, so a field missing from `reads` arrives `undefined` however
    // the caller called it — PR #1516's round-1 finding, pinned here in advance.
    let seen = null;
    const decl = prStatusOperation({ readPrs: (a) => { seen = a; return { repo: 'o/r', prs: [] }; } });
    const readStep = decl.steps.find((s) => s.name === 'read').step;
    for (const r of ['input.repo', 'input.pr']) expect(readStep.reads).toContain(r);
    readStep.fn({ input: { repo: 'o/r', pr: 42 } });
    expect(seen).toEqual({ repo: 'o/r', pr: 42 });
  });
});

// ── END-TO-END CLI (#3555) ──────────────────────────────────────────────────────────────────────────────────
// we:scripts/workflows/review-parked-prs.mjs's reduce step now tells an agent to run
// `node scripts/operations/run.mjs pr-status --repo=<slug> --pr=<n> --json` and read `.verdict.prs[0].state`
// off the result. Every OTHER test in this file drives pr-status.mjs's functions directly in-process — none
// of them prove `run.mjs` itself accepts these exact flags and prints this exact shape on stdout, which is
// what the agent following that prompt actually depends on. This spawns the REAL CLI as a subprocess, with a
// fake `gh` shimmed onto PATH (no network, no credential), and parses its own stdout — the same thing an
// agent following the prompt would do.
describe('run.mjs pr-status --json — the real CLI, end to end (#3555, no gh network/credential)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const RUN_MJS = join(here, '..', 'run.mjs');
  const binDir = mkdtempSync(join(tmpdir(), 'pr-status-fake-gh-'));
  const ghPath = join(binDir, 'gh');
  // Answers BOTH calls `createPrReader` makes: `gh pr view <n> --repo <repo> --json …` for the PR itself, and
  // `gh api --paginate repos/<repo>/commits/<sha>/check-runs --jq …` for its head's check runs. ECHOES BACK
  // the requested PR number ($3, e.g. `pr view 99 --repo …`) rather than a hardcoded value — a stub that always
  // answers with a FIXED PR number could pass a "--pr filters correctly" test even if the real code ignored
  // the flag entirely and requested some other PR, which is exactly what a round-1 red-team finding caught
  // here (#3555).
  writeFileSync(ghPath, [
    '#!/bin/sh',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    '  echo "{\\"number\\":$3,\\"title\\":\\"fixture\\",\\"labels\\":[],\\"mergeable\\":\\"MERGEABLE\\",\\"headRefOid\\":\\"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\\"}"',
    'elif [ "$1" = "api" ]; then',
    '  echo \'{"name":"test","status":"completed","conclusion":"success"}\'',
    'else',
    '  echo "fake gh: unexpected argv: $*" 1>&2; exit 1',
    'fi',
  ].join('\n'));
  chmodSync(ghPath, 0o755);
  afterAll(() => rmSync(binDir, { recursive: true, force: true }));

  it('accepts --repo=/--pr=/--json exactly as the reduce prompt invokes it, and prints .verdict.prs[0].state', () => {
    const stdout = execFileSync(
      process.execPath,
      [RUN_MJS, 'pr-status', '--repo=o/r', '--pr=42', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );
    const result = JSON.parse(stdout);
    expect(result.verdict.prs[0].state).toBe('green');
    expect(CHECK_STATES).toContain(result.verdict.prs[0].state);
  });

  it('the --pr flag filters to exactly the requested PR, at index 0 — never a repo-wide list', () => {
    // a PR number distinct from the OTHER test's (42) — the fake gh echoes back whatever number it was
    // actually asked for, so this proves the flag's VALUE flows through end to end, not just its presence.
    const stdout = execFileSync(
      process.execPath,
      [RUN_MJS, 'pr-status', '--repo=o/r', '--pr=777', '--json'],
      { encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } },
    );
    const result = JSON.parse(stdout);
    expect(result.verdict.prs).toHaveLength(1);
    expect(result.verdict.prs[0].number).toBe(777);
  });
});

// we:backlog/xxh4zw8 — a partial success is not a complete required verdict.
it('xxh4zw8 missing required checks cannot read green', () => {
  const verdict = reduceCheckState([{ name: 'test', status: 'completed', conclusion: 'success' }], ['test', 'smoke']);
  expect(verdict.state).toBe('unchecked');
  expect(verdict.why).toContain('smoke');
});

it.each([
  [[], 'unchecked'],
  [[{ name: 'test', status: 'completed', conclusion: 'cancelled' }], 'red'],
  [[{ name: 'test', status: 'completed', conclusion: 'failure' }], 'red'],
  [[{ name: 'test', status: 'in_progress', conclusion: null }], 'pending'],
  [[{ name: 'test', status: 'completed', conclusion: 'unknown' }], 'unchecked'],
])('xxh4zw8 missing-required guard preserves observed pending/red precedence %#', (runs, state) => {
  expect(reduceCheckState(runs, ['test', 'smoke']).state).toBe(state);
});

it('xxh4zw8 complete required evidence and latest numeric reruns restore green in either order', () => {
  const runs = [
    { id: 10, name: 'test', status: 'completed', conclusion: 'success' },
    { id: 11, name: 'smoke', status: 'completed', conclusion: 'cancelled' },
    { id: 12, name: 'smoke', status: 'completed', conclusion: 'success' },
  ];
  for (const ordered of [runs, [...runs].reverse()]) {
    expect(reduceCheckState(ordered, ['test', 'smoke'])).toMatchObject({ state: 'green', counts: { total: 2, failed: 0 } });
  }
});
