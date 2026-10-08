/**
 * @file open-pr.test.mjs — opening a PR THROUGH the home that gates it.
 *
 * THE DEFECT UNDER TEST is a bypass, not a bug. `pr-land.mjs` already refuses a non-lane ref, refuses a
 * bodyless PR, resolves the park label and applies the #2833 verify finish-guard. Three PRs in one session
 * skipped every one of those by calling the GitHub connector directly, and one shipped with a red suite.
 *
 * So these assertions are mostly NEGATIVE SPACE: what this operation must NOT do. It must not re-decide the
 * verify marker, must not reach the network itself, and must not turn a home that could not run into a home
 * that refused. Several exist purely to stop a later "helpful" fallback from reopening the bypass.
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importGraph } from './import-graph.mjs';
import {
  openPrOperation, planOpen, classifySubmit, defaultParkLabel, extractSubmitResult, describeSubmit,
  resolveRef, OPEN_PR_OP, SUBMIT_PR_EFFECT, OPEN_MODES, SUBMIT_OUTCOMES, HOME_REASONS,
} from '../open-pr.mjs';
import { createPrLandRunner, createOpenPrSinks, PR_LAND_CLI, resolveGhCredentialEnv, deriveLaneRef } from '../open-pr-io.mjs';
import { PARK_LABELS } from '../../pr-land.mjs';
import { checkDuplicateBornAs } from '../../lib/duplicate-bornas-added.mjs';

const good = (over = {}) => ({
  ref: 'lane/open-pr-operation', base: 'main', title: 'a title', bodyFile: '/tmp/body.md',
  mode: 'park', parkLabel: 'review:pending', ...over,
});
const ops = () => openPrOperation({ parkLabels: PARK_LABELS });
const step = (decl, name) => decl.steps.find((s) => s.name === name).step;

describe('the declaration', () => {
  it('derives its command line, and takes the park labels from the HOME', () => {
    const decl = ops();
    expect(decl.name).toBe(OPEN_PR_OP);
    expect(decl.input.parkLabel.enum).toEqual([...PARK_LABELS]);
    expect(decl.input.mode.enum).toEqual([...OPEN_MODES]);
  });

  it('refuses to build without the home\'s own park-label list', () => {
    expect(() => openPrOperation({})).toThrow(/PARK_LABELS/);
    expect(() => openPrOperation({ parkLabels: [] })).toThrow(/PARK_LABELS/);
  });

  /**
   * THE DEFAULT PARK IS `pending`, NOT `human`, and this is the assertion that keeps it that way. Defaulting
   * to the human-only gate would push every routine agent PR into the one queue the AI review pass cannot
   * clear — the dilution #2563 caps the scored rubric to avoid. `PARK_LABELS[0]` happens to BE the human
   * label, so the obvious implementation is the wrong one.
   */
  it('defaults the park to the PENDING label, never the human-only gate', () => {
    expect(ops().input.parkLabel.default).toBe('review:pending');
    expect(ops().input.parkLabel.default).not.toBe(PARK_LABELS[0]);
    expect(defaultParkLabel(['review:human', 'review:pending'])).toBe('review:pending');
  });

  it('refuses to guess a default park when the home offers no pending label', () => {
    expect(() => defaultParkLabel(['review:human'])).toThrow(/no safe default park/);
  });

  // Parking is the default MODE too: an agent PR that marches to ready-to-merge unreviewed is the shape park
  // exists to stop, so the un-parked modes must be a deliberate flag rather than an omission.
  it('parks by default', () => {
    expect(ops().input.mode.default).toBe('park');
  });
});

describe('planOpen — the home\'s rules as a pre-flight, and nothing more', () => {
  it('builds the argv the home takes', () => {
    expect(planOpen(good()).argv).toEqual([
      '--ref=lane/open-pr-operation', '--base=main', '--title=a title', '--body-file=/tmp/body.md',
      '--park=review:pending',
    ]);
  });

  it('uses the home\'s own flag for each non-park mode', () => {
    expect(planOpen(good({ mode: 'label-on-green' })).argv).toContain('--label-on-green');
    expect(planOpen(good({ mode: 'no-wait' })).argv).toContain('--no-wait');
    // …and does not smuggle a park label in when it was not asked for.
    expect(planOpen(good({ mode: 'no-wait' })).argv.some((a) => a.startsWith('--park'))).toBe(false);
  });

  it('refuses a ref that is not a lane ref', () => {
    for (const ref of ['main', 'feature/x', '', null]) {
      expect(() => planOpen(good({ ref }))).toThrow(/lane\/\* ref/);
    }
  });

  it('refuses an empty title and a missing body file', () => {
    // `title` no longer refuses empty — see the #3245 block below. The body-file refusal still stands.
    expect(() => planOpen(good({ bodyFile: '' }))).toThrow(/bodyless PR/);
  });

  it('names every problem at once rather than one per attempt', () => {
    // Still three problems, and still all in one message — `title` simply is not one of them any more
    // (#3245: empty means "the home derives it"), so the assertion names the three that remain.
    expect(() => planOpen({ ref: 'main', base: 'main', title: '', bodyFile: '', mode: 'park' }))
      .toThrow(/lane\/\* ref.*bodyless.*parkLabel/s);
  });

  /**
   * THE LOAD-BEARING NEGATIVE. The verify marker has ONE home — `verifyGateDecision`, which `pr-land.mjs`
   * already calls. If this operation ever grows its own check, it becomes a second answer that can disagree
   * with the one that actually blocks the land, which is the exact defect `verify` committed against
   * `verify-lane.mjs`. Asserted structurally: the planner takes no marker and reads no marker file.
   *
   * NARROWED DELIBERATELY BY #3242, and the distinction is the whole point of the rule rather than a
   * loosening of it:
   *
   *   · RE-DECIDING is reading the marker here and forming a verdict — still forbidden, still asserted.
   *   · FORWARDING `--require-verified` is the CALLER asking the single home to apply its own guard more
   *     strictly. That is not a second answer; it is the same home, told to be stricter, and it is the only
   *     way the six skill call sites that pass the flag can ever name this operation (#1508's shape is
   *     dropping it, not forwarding it).
   *
   * So the flag ban keeps exactly the direction that was dangerous — anything that turns the guard OFF —
   * and no longer bans the one that turns it UP. The original test could lump all three together only
   * because the operation had no way to pass any of them.
   */
  it('does NOT re-decide the lane-verification gate — that has one home', () => {
    const plan = planOpen(good());
    expect(Object.keys(plan).sort())
      .toEqual(['actor', 'argv', 'base', 'bodyFile', 'dryRun', 'mode', 'operatorInstruction', 'parkLabel', 'ref', 'requireVerified', 'sha', 'skipPrePrReview', 'title']);
    // No marker, no verdict, no gate decision — only the caller's own request, echoed back.
    expect(plan.requireVerified).toBe(false);
    expect(JSON.stringify(plan)).not.toMatch(/marker|break-glass|verifyGate/i);
    // The DISABLING flags stay banned outright: this operation must never be the thing that waives the gate.
    expect(plan.argv.some((a) => /break-glass|no-verify/.test(a))).toBe(false);
    // And an unasked-for guard is never added on the caller's behalf.
    expect(plan.argv.some((a) => a.startsWith('--require-verified'))).toBe(false);
  });

  it('CANNOT waive the gate — no input reaches a disabling flag', () => {
    // The other half of the narrowing. `requireVerified` may only ever ADD the flag; there is no value of any
    // input that emits `--break-glass` or `--no-verify`, so widening the schema later cannot quietly create a
    // waiver path through this operation.
    for (const requireVerified of [true, false, 'false', undefined]) {
      const argv = planOpen(good({ requireVerified })).argv;
      expect(argv.some((a) => /break-glass|no-verify/.test(a))).toBe(false);
    }
  });
});

// ── #3242: THE THREE FLAGS EVERY REAL CALL SITE PASSES ───────────────────────────────────────────────────
// Without these the operation could not replace a single one of the six skill instructions of
// `we:scripts/pr-land.mjs` — rewiring any of them would have silently dropped a flag, which is the PR #1508
// regression shape. Tested at BOTH layers because each can lose the value independently: PR #1516's round-1
// juror found exactly that hole in `verify`, where the argv builder was covered and the declaration was not.
describe('the sha / requireVerified / dryRun pass-through (#3242)', () => {
  it('forwards each flag when set', () => {
    const argv = planOpen(good({ sha: 'abc1234', requireVerified: true, dryRun: true })).argv;
    expect(argv).toContain('--sha=abc1234');
    expect(argv).toContain('--require-verified');
    expect(argv).toContain('--dry-run');
  });

  it('OMITS an unset sha so the home applies its own `HEAD` default', () => {
    // The home reads `typeof flags.sha === 'string' ? flags.sha : 'HEAD'`. Restating `HEAD` here would be a
    // second answer to "which commit" (#2644); passing `--sha=` would publish the empty string.
    for (const sha of ['', '   ', undefined]) {
      expect(planOpen(good({ sha })).argv.some((a) => a.startsWith('--sha'))).toBe(false);
    }
  });

  it('OMITS a false boolean rather than passing it — `--dry-run=false` would REQUEST a dry run', () => {
    // The trap this test exists for: the home reads `!!flags['dry-run']`, and `!!'false'` is TRUE. A caller
    // who set `dryRun: false` and got a rehearsal instead of a landed PR would have no way to see why.
    const argv = planOpen(good({ requireVerified: false, dryRun: false })).argv;
    expect(argv.some((a) => a.startsWith('--dry-run'))).toBe(false);
    expect(argv.some((a) => a.startsWith('--require-verified'))).toBe(false);
  });

  it('treats only a literal `true` as on, never a truthy string', () => {
    // A CLI that handed through `'false'` must not enable the guard.
    const argv = planOpen(good({ requireVerified: 'false', dryRun: 'false' })).argv;
    expect(argv.some((a) => a.startsWith('--require-verified'))).toBe(false);
    expect(argv.some((a) => a.startsWith('--dry-run'))).toBe(false);
  });

  it('reports all three in the verdict, so a caller need not re-parse argv', () => {
    expect(planOpen(good({ sha: ' abc ', requireVerified: true, dryRun: false })))
      .toMatchObject({ sha: 'abc', requireVerified: true, dryRun: false });
  });

  it('the `plan` STEP threads all three into planOpen, and DECLARES the reads', () => {
    // The declaration layer, which is where PR #1516's round-1 finding lived. The engine projects only the
    // declared reads, so a field missing from `reads` arrives as `undefined` however the caller called it —
    // the read list is wiring, not bookkeeping, and both halves need pinning.
    const decl = openPrOperation({ parkLabels: PARK_LABELS });
    const planStep = decl.steps.find((st) => st.name === 'plan').step;
    for (const r of ['input.sha', 'input.requireVerified', 'input.dryRun']) expect(planStep.reads).toContain(r);
    const out = planStep.fn({ input: { ...good(), sha: 'deadbee', requireVerified: true, dryRun: true } });
    expect(out.argv).toEqual(expect.arrayContaining(['--sha=deadbee', '--require-verified', '--dry-run']));
  });

  it('declares the three inputs as optional with off-by-default values', () => {
    const decl = openPrOperation({ parkLabels: PARK_LABELS });
    expect(decl.input.sha).toMatchObject({ type: 'string', required: false, default: '' });
    expect(decl.input.requireVerified).toMatchObject({ type: 'boolean', required: false, default: false });
    // Defaulting `requireVerified` to true would be a policy change smuggled in as a schema edit.
    expect(decl.input.dryRun).toMatchObject({ type: 'boolean', required: false, default: false });
  });
});

// ── #3245: `title` MATCHES THE HOME, WHICH DERIVES ONE ───────────────────────────────────────────────────
describe('an omitted title lets the home derive one', () => {
  const noTitle = () => { const g = good(); delete g.title; return g; };

  it('OMITS the flag entirely when no title is given', () => {
    // `we:scripts/pr-land.mjs` computes `derivedTitle = TITLE ?? <commit subject> ?? "land <ref>"`, so the
    // home always has one. Requiring a title here made this operation stricter than the thing it declares
    // over, and every skill instruction of the home omits it.
    expect(planOpen(noTitle()).argv.some((a) => a.startsWith('--title'))).toBe(false);
  });

  it('never passes `--title=` empty — that is a blank title, not a derived one', () => {
    expect(planOpen(good({ title: '' })).argv.some((a) => a.startsWith('--title'))).toBe(false);
  });

  it('treats WHITESPACE as omitted too, like `sha` and `verify`\'s `gate`', () => {
    // Consistency here is load-bearing rather than cosmetic. The input declares `default: ''`, so the command
    // line hands `planOpen` an EMPTY STRING whenever `--title` is absent — a guard that refused empty-as-given
    // would refuse every call that omitted the flag, which is all six sites this change exists to unblock.
    expect(planOpen(good({ title: '   ' })).argv.some((a) => a.startsWith('--title'))).toBe(false);
  });

  it('forwards a real title unchanged', () => {
    expect(planOpen(good({ title: 'a real title' })).argv).toContain('--title=a real title');
  });

  it('still requires bodyFile, so the argv can never be TITLE-ONLY', () => {
    // The home is headless-safe only because a bare `--title` with no body drops into an interactive prompt
    // and dies (#2176). Making the title optional must not open that shape.
    expect(() => planOpen({ ...noTitle(), bodyFile: '' })).toThrow(/bodyless PR/);
  });

  it('argv and verdict agree on the title — both trimmed (PR #1522 juror)', () => {
    // The verdict already reported `title.trim()` while the argv pushed the raw value, so the two disagreed
    // whenever a caller's title carried surrounding whitespace: the argv would publish "  a title  " while
    // the verdict claimed "a title". The verdict is what a caller reads back, so one value, decided once.
    const plan = planOpen(good({ title: '  spaced title  ' }));
    expect(plan.title).toBe('spaced title');
    expect(plan.argv).toContain('--title=spaced title');
  });

  it('declares the input as optional with an empty default', () => {
    const decl = openPrOperation({ parkLabels: PARK_LABELS });
    expect(decl.input.title).toMatchObject({ type: 'string', required: false, default: '' });
  });
});

// ── #x6ry8mf: THE HOME'S DEFAULT PATH, AND A REHEARSAL THAT OPENS NOTHING ────────────────────────────────
describe('`land` mode — the home\'s default, named rather than omitted', () => {
  it('passes NO mode flag, because that IS the default path', () => {
    // `pr-land` with no mode flag opens, waits, labels `ready-to-merge` and TRIGGERS the fast drain that
    // lands the PR. Inventing a `--land` the home does not accept would fail at the shell instead.
    const argv = planOpen(good({ mode: 'land' })).argv;
    for (const flag of ['--park', '--label-on-green', '--no-wait', '--land']) {
      expect(argv.some((a) => a.startsWith(flag))).toBe(false);
    }
  });

  it('is NOT the same as label-on-green — that one stops at the label', () => {
    // The distinction the whole card is about: pointing a caller of the default path at `label-on-green`
    // leaves the PR open, labelled and UNLANDED. A test, so a later "simplify the modes" cannot merge them.
    expect(planOpen(good({ mode: 'label-on-green' })).argv).toContain('--label-on-green');
    expect(planOpen(good({ mode: 'land' })).argv).not.toContain('--label-on-green');
  });

  it('is not the default — publishing must stay a deliberate flag', () => {
    const decl = openPrOperation({ parkLabels: PARK_LABELS });
    expect(decl.input.mode.default).toBe('park');
    expect(decl.input.mode.enum).toEqual([...OPEN_MODES]);
    expect(OPEN_MODES).toContain('land');
  });

  it('REFUSES a mode outside the declared set rather than silently landing', () => {
    // The `else` that used to catch everything now throws. Without it, a fifth mode added to OPEN_MODES and
    // forgotten here would inherit "pass nothing" — which is `land`, the one mode that publishes.
    expect(() => planOpen(good({ mode: 'no-wait' })).argv).not.toThrow();
    expect(() => planOpen({ ...good(), mode: 'typo' })).toThrow(/`mode` must be one of/);
  });
});

describe('a dry run opens nothing, so it needs no body', () => {
  const noBody = (over = {}) => { const g = good({ ...over }); delete g.bodyFile; return g; };

  it('ACCEPTS a bodyless dry run', () => {
    // #2332 exists because a bodyless PR passes the producer and is REFUSED at land, stalling the queue.
    // A `--dry-run` opens nothing, so there is no PR to stall — the home draws that line itself.
    expect(() => planOpen(noBody({ dryRun: true }))).not.toThrow();
  });

  it('still REFUSES a bodyless real open', () => {
    // The half that must not be lost with it.
    expect(() => planOpen(noBody({ dryRun: false }))).toThrow(/bodyless PR/);
    expect(() => planOpen(noBody())).toThrow(/bodyless PR/);
  });

  it('OMITS `--body-file` entirely rather than passing it empty', () => {
    // The third field in this function to need the rule, and the first two did not carry it here.
    // `--body-file=` is not "no body": the home reads the flag as a string and would try to READ that path.
    const argv = planOpen(noBody({ dryRun: true })).argv;
    expect(argv.some((a) => a.startsWith('--body-file'))).toBe(false);
    expect(argv).toContain('--dry-run');
  });
});

describe('classifySubmit — refused and could-not-run are different facts', () => {
  it('reports an opened PR', () => {
    const r = classifySubmit({ status: 0, stdout: JSON.stringify({ pr: 1500, url: 'https://x/1500', parked: 'review:pending' }) });
    expect(r).toMatchObject({ outcome: 'opened', pr: 1500 });
  });

  /**
   * A refusal is an ANSWER: the home looked and said no, and it said why. #2833's stall guard is the one that
   * matters most — it is exactly the guard the bypass skipped — so its detail has to survive to the caller.
   */
  it('reports the home\'s refusal, carrying the guard that fired', () => {
    const r = classifySubmit({
      status: 3,
      stdout: JSON.stringify({ reason: 'verify-unfinished', detail: 'refusing to land lane/x — verification is UNFINISHED', verifyStatus: 'running' }),
    });
    expect(r).toMatchObject({ outcome: 'refused', reason: 'verify-unfinished', verifyStatus: 'running' });
  });

  /**
   * FOUND BY RUNNING IT, not by reading it. `gh pr create` failing for want of a credential comes back from
   * the home as a STRUCTURED `reason: 'gh-error'`, and the first cut of this function treated any structured
   * reason as a refusal. That sent the caller off to fix a request that was never the problem — the request
   * was fine and the host had no credential. The home's own word decides, not the exit code, because pr-land
   * exits 3 for both kinds.
   */
  it('calls a missing credential unrun, not a refusal — the request was never what was wrong', () => {
    const r = classifySubmit({ status: 3, stdout: JSON.stringify({ reason: 'gh-error', detail: 'gh pr create failed' }) });
    expect(r.outcome).toBe('unrun');
    expect(r.reason).toBe('gh-error');
  });

  it('splits the home\'s vocabulary by what the caller should DO about it', () => {
    const outcomeFor = (reason) => classifySubmit({ status: 3, stdout: JSON.stringify({ reason }) }).outcome;
    // A guard answered — editing the request or the lane is the fix.
    for (const reason of ['bad-delegation', 'bad-ref', 'empty-body', 'no-such-src', 'behind', 'conflict', 'check-red', 'locus-prefix',
      // the #2833 guard's own vocabulary, from `lib/lane-verify.mjs` — the reasons this operation exists for
      'verify-unfinished', 'verify-red', 'verify-corrupt', 'unverified', 'untracked', 'red-ci-gated']) {
      expect({ reason, outcome: outcomeFor(reason) }).toEqual({ reason, outcome: 'refused' });
    }
    // The environment could not complete — the request is not what is wrong.
    for (const reason of ['gh-error', 'push-failed', 'blocked-on-infra', 'fallback-failed']) {
      expect({ reason, outcome: outcomeFor(reason) }).toEqual({ reason, outcome: 'unrun' });
    }
    for (const reason of ['opened', 'parked', 'merged-git-fallback', 'enqueued', 'labelled-on-green']) {
      expect({ reason, outcome: outcomeFor(reason) }).toEqual({ reason, outcome: 'opened' });
    }
    // Every key of the table is one of the three, so a typo'd value cannot slip in.
    for (const v of Object.values(HOME_REASONS)) expect(SUBMIT_OUTCOMES).toContain(v);
  });

  /**
   * THE PRECEDENCE BUG, AND THE CONTRACT GATE FOR IT (found by the correctness juror on PR #1500).
   *
   * A `pr` field does NOT mean success. In `label-on-green` mode the home opens the PR and THEN waits on
   * required checks, so its post-open refusals carry BOTH a `pr` and a refusal `reason`. Checking
   * `parsed.pr` first reported a RED REQUIRED CHECK as `opened` — the exact failure class this operation
   * exists to prevent, inside the operation, in the CI-gating mode.
   *
   * These are the REAL shapes, transcribed from `pr-land.mjs`'s own `emit()` call sites rather than
   * hand-composed as `{reason}` alone — which is precisely why the original suite missed it: every refusal
   * test built a payload the home never actually emits.
   */
  const POST_OPEN_REFUSALS = [
    { reason: 'conflict', pr: 1501, detail: 'PR #1501 has merge conflicts with main', want: 'refused' },
    { reason: 'check-red', pr: 1501, detail: 'PR #1501 required check RED', want: 'refused' },
    { reason: 'behind', pr: 1501, detail: 'PR #1501 is behind main (strict up-to-date)', want: 'refused' },
    { reason: 'check-timeout', pr: 1501, detail: 'PR #1501 not ready past timeout', want: 'opened' },
    { reason: 'empty-body', pr: 1501, detail: 'PR #1501 has an empty/whitespace description', want: 'refused' },
  ];

  it('never reports a POST-OPEN refusal as opened, even though it carries a pr number', () => {
    for (const { want, ...payload } of POST_OPEN_REFUSALS) {
      const r = classifySubmit({ status: 3, stdout: JSON.stringify({ repo: 'web-everything/web-everything', merged: false, ...payload }) });
      expect({ reason: payload.reason, outcome: r.outcome }).toEqual({ reason: payload.reason, outcome: want });
      // …and the PR number still reaches the caller, who needs it to go look at what was opened-then-refused.
      expect(r.pr).toBe(1501);
    }
  });

  // The mirror image: with NO reason, a pr/url genuinely does mean opened.
  it('still reports a bare pr/url with no reason as opened', () => {
    expect(classifySubmit({ status: 0, stdout: JSON.stringify({ pr: 1501, url: 'u' }) }).outcome).toBe('opened');
  });

  /**
   * THE DURABLE GATE the juror asked for: derive the reason vocabulary from the HOME's source rather than
   * from this file's memory of it, so a reason added to `pr-land.mjs` that `HOME_REASONS` has not learned
   * fails here instead of silently classifying as `unrun` forever.
   */
  it('has an opinion about every reason pr-land can actually emit', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pr-land.mjs'), 'utf8');
    const direct = [...src.matchAll(/reason:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    // A reason picked by a ternary (`reason: cond ? 'a' : 'b'`, e.g. label-on-green's enqueued/labelled-on-green
    // split) has no literal directly after `reason:`, so the direct scan above misses BOTH branches — this is
    // exactly how `enqueued`/`labelled-on-green` went unclassified and got reported as `unrun` failures for two
    // days before anyone traced it back to this table.
    const ternary = [...src.matchAll(/reason:\s*[\w.]+\s*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)]
      .flatMap((m) => [m[1], m[2]]);
    const emitted = [...direct, ...ternary];
    expect(emitted.length).toBeGreaterThan(10);
    const unknown = [...new Set(emitted)].filter((r) => !(r in HOME_REASONS) && r !== 'dry-run');
    expect(unknown, `pr-land emits reason(s) HOME_REASONS does not classify: ${unknown.join(', ')}`).toEqual([]);
  });

  /**
   * A reason the table has not learned is `unrun`, and flagged. The home may grow one, and "we cannot tell
   * whether a guard fired" is not "a guard fired" — reporting `refused` there would claim an answer nobody
   * gave, which is the exact failure this family of operations exists to refuse.
   */
  it('treats an unrecognised reason as unrun and marks it unclassified', () => {
    const r = classifySubmit({ status: 3, stdout: JSON.stringify({ reason: 'some-new-guard' }) });
    expect(r).toMatchObject({ outcome: 'unrun', reason: 'some-new-guard', unclassified: true });
  });

  it('reports a home that could not run as unrun, NOT as a refusal', () => {
    for (const r of [
      classifySubmit({ error: new Error('ENOENT') }),
      classifySubmit({ status: null, signal: 'SIGKILL', stdout: '' }),
      classifySubmit({ status: 1, stdout: 'gh: not authenticated' }),
    ]) {
      expect(r.outcome).toBe('unrun');
      expect(r.outcome).not.toBe('refused');
    }
    expect(SUBMIT_OUTCOMES).toEqual(['opened', 'refused', 'unrun']);
  });

  // The no-credential case specifically: it must never read as an open, and never as a refusal to fix.
  it('a kill says plainly that it is not a refusal', () => {
    expect(classifySubmit({ status: null, signal: 'SIGKILL' }).reason).toMatch(/NOT a refusal/);
  });
});

describe('the submit effect', () => {
  it('declares one NON-idempotent effect carrying the planned argv', () => {
    const effects = step(ops(), 'submit').effects({ verdict: planOpen(good()) });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: SUBMIT_PR_EFFECT, idempotent: false });
    expect(effects[0].payload.argv).toContain('--ref=lane/open-pr-operation');
  });

  /**
   * NOT idempotent, asserted rather than assumed. Opening a PR twice for one ref does not converge — the home
   * may already have created one and the second call's outcome depends on state this operation does not own.
   * Marking it idempotent would let the engine blind-retry a PR creation.
   */
  it('never claims the submission is safe to replay', () => {
    expect(step(ops(), 'submit').effects({ verdict: planOpen(good()) })[0].idempotent).toBe(false);
  });
});

describe('the io shell — one spawn of the home, and no second route', () => {
  it('spawns pr-land.mjs with the planned argv and --json', () => {
    const calls = [];
    const run = createPrLandRunner({
      prePrReview: () => ({ action: 'pass' }),
      spawn: (cmd, argv) => { calls.push(argv); return { status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) }; },
    });
    expect(run({ argv: ['--ref=lane/x'] })).toMatchObject({ outcome: 'opened', pr: 7 });
    expect(calls[0][0]).toBe(PR_LAND_CLI);
    expect(calls[0]).toContain('--json');
  });

  it('resolves the home from its own location, not the lane being opened', () => {
    expect(PR_LAND_CLI).toMatch(/scripts\/pr-land\.mjs$/);
    expect(PR_LAND_CLI.startsWith('/')).toBe(true);
  });

  // A refusal belongs in the run record where the caller can read which guard fired — not thrown away as an
  // error indistinguishable from a crash.
  it('returns a refusal rather than throwing on it', async () => {
    const sinks = createOpenPrSinks({ run: () => ({ outcome: 'refused', reason: 'verify-not-green' }) });
    await expect(sinks[SUBMIT_PR_EFFECT]({ argv: [] })).resolves.toMatchObject({ outcome: 'refused' });
  });

  it('throws on unrun, and hands the caller the argv to submit elsewhere', async () => {
    const sinks = createOpenPrSinks({ run: () => ({ outcome: 'unrun', reason: 'gh not authenticated' }) });
    await expect(sinks[SUBMIT_PR_EFFECT]({ argv: ['--ref=lane/x'] })).rejects.toThrow(/--ref=lane\/x/);
  });

  /**
   * A `--dry-run` also classifies as `unrun` (nothing was opened) — but it is the REQUESTED outcome, not an
   * environment failure, so it must return the plan rather than throw. Found live: the skill's own "dry-run
   * first" step (`--dryRun=true`) hit this throw for a plan that rendered correctly.
   */
  it('does NOT throw on a requested dry run, even though it is also unrun', async () => {
    const sinks = createOpenPrSinks({ run: () => ({ outcome: 'unrun', reason: 'dry-run', plan: ['gh pr create …'] }) });
    await expect(sinks[SUBMIT_PR_EFFECT]({ argv: ['--ref=lane/x', '--dry-run'] })).resolves.toMatchObject({ outcome: 'unrun', reason: 'dry-run' });
  });

  /**
   * THE GAP INDEPENDENT REVIEW FOUND (PR #1715): a `--dry-run` REQUEST is not a guarantee pr-land ever reached
   * its own dry-run branch. A spawn error, a kill signal, or unparseable stdout is `unrun` for a genuinely
   * different reason, and must still throw — keying the exemption off the request's argv rather than the
   * home's own reported `reason` would silently swallow exactly this as an unremarkable rehearsal.
   */
  it('STILL throws on a dry-run REQUEST whose actual reason is not dry-run — a real failure, not a rehearsal', async () => {
    const sinks = createOpenPrSinks({ run: () => ({ outcome: 'unrun', reason: 'could not run pr-land: spawn ENOENT' }) });
    await expect(sinks[SUBMIT_PR_EFFECT]({ argv: ['--ref=lane/x', '--dry-run'] })).rejects.toThrow(/spawn ENOENT/);
  });

  /**
   * THE ANTI-BYPASS ASSERTION. The whole point of routing through the home is undone the moment this shell
   * learns to talk to GitHub itself. It may reach `child_process` (to spawn the home) and nothing else that
   * can make a request.
   */
  it('reaches no network of its own — the home is the only route', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const { external } = importGraph(resolve(here, '..', 'open-pr-io.mjs'));
    expect(external).toContain('node:child_process');
    for (const forbidden of ['node:https', 'node:http', 'node:net', 'undici', 'node-fetch']) {
      expect(external).not.toContain(forbidden);
    }
    // …and the declaration itself reaches nothing at all.
    expect(importGraph(resolve(here, '..', 'open-pr.mjs')).external).toEqual([]);
  });
});

/**
 * #3627 bug 13 (the REAL fix) — a caller of `run.mjs open-pr --json` must read `.pr` off
 * `extractSubmitResult`'s return, never off the raw parsed stdout. The raw stdout is
 * `cli-adapter.mjs#outcomePayload`'s FULL run-outcome envelope (`{runId, op, stopped, ..., findings, ...}`),
 * which carries no top-level `pr`/`url` at all — the actual submit result sits at
 * `findings.submit.effects[0].result`. A prior fix attempt renamed `.number` to `.pr` on the raw parsed object
 * and still printed "PR #undefined" live (PR #2109), because the field it renamed was never at that path
 * either. These fixtures are transcribed from a REAL `node scripts/operations/run.mjs open-pr --json` run
 * (both a completed dry-run and a `plan`-step refusal), not hand-composed guesses.
 */
describe('extractSubmitResult — reads the REAL submit outcome out of the full run envelope, never the top level', () => {
  it('extracts pr/url out of a completed run\'s nested findings.submit.effects[0].result', () => {
    const envelope = {
      runId: 'open-pr-abc', op: 'open-pr', stopped: 'complete', applied: ['open-pr-abc#1#0'],
      inFlight: [], pending: null,
      verdict: { ref: 'lane/9999-x', base: 'main', mode: 'park', parkLabel: 'review:pending' }, // the PLAN, no `pr`
      findings: {
        plan: { ref: 'lane/9999-x', base: 'main', mode: 'park', parkLabel: 'review:pending' },
        submit: {
          applied: true,
          effects: [{
            type: 'open-pr.submit', status: 'applied',
            result: { outcome: 'opened', pr: 2140, url: 'https://example/pr/2140', parked: 'review:pending' },
            error: null,
          }],
        },
      },
      telemetry: [], spend: { jurors: 0, costUsd: 0, wallMs: 0, durationMs: 0 },
    };
    expect(extractSubmitResult(envelope)).toEqual({ outcome: 'opened', pr: 2140, url: 'https://example/pr/2140', parked: 'review:pending' });
  });

  it('never mistakes the top-level `verdict` (the PRE-submit plan) for the submit result', () => {
    // The plan step's own output has no `pr` field — reading `.pr` straight off `envelope.verdict` (what the
    // first, insufficient fix attempt effectively did) would silently read `undefined` past this.
    const envelope = {
      stopped: 'complete', findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 7, url: 'u' } }] } },
      verdict: { ref: 'lane/1-x', base: 'main' },
    };
    const r = extractSubmitResult(envelope);
    expect(r.pr).toBe(7);
    expect(r).not.toBe(envelope.verdict);
  });

  it('synthesizes an `unrun` outcome (pr/url null) when the run never reached submit — a plan-step refusal', () => {
    // The real shape of a bad-ref refusal: `findings` is `{}` (submit never ran) and the envelope carries its
    // own top-level `error` instead.
    const envelope = {
      runId: 'open-pr-def', op: 'open-pr', stopped: 'step-refused', applied: [], inFlight: [], pending: null,
      verdict: null, findings: {}, telemetry: [], spend: { jurors: 0, costUsd: 0, wallMs: 0, durationMs: 0 },
      error: 'open-pr: cannot plan this PR — `ref` must be a lane/* ref, got "bad-ref"',
    };
    const r = extractSubmitResult(envelope);
    expect(r.outcome).toBe('unrun');
    expect(r.pr).toBeNull();
    expect(r.url).toBeNull();
    expect(r.reason).toMatch(/lane\/\* ref/);
  });

  it('never throws on a malformed/empty payload — synthesizes unrun instead', () => {
    for (const bad of [null, undefined, {}, { findings: null }, { findings: {} }]) {
      const r = extractSubmitResult(bad);
      expect(r.outcome).toBe('unrun');
      expect(r.pr).toBeNull();
    }
  });
});

describe('#4386 submit summaries', () => {
  it.each([
    [{ outcome: 'refused', reason: 'empty-body' }, true, /REFUSED.*empty-body/],
    [{ outcome: 'opened', pr: 123, url: 'https://example.test/123' }, false, /opened #123 https:\/\/example.test\/123/],
    [{ outcome: 'unrun', reason: 'push-failed' }, true, /NOT RUN.*push-failed/],
    [{ outcome: 'unrun', reason: 'dry-run' }, false, /dry run.*nothing opened/],
    [{ outcome: 'refused', reason: 'check-red', pr: 9, detail: 'checks failed' }, true, /REFUSED.*check-red.*#9.*checks failed/],
  ])('describes %j', (result, failed, line) => {
    expect(describeSubmit(result)).toEqual({ failed, line: expect.stringMatching(line) });
  });
});

describe('items 79/81 — truthful label-on-green outcome, credential env, --branch', () => {
  it('check-timeout WITH a pr reports the PR as opened and the label step as deferred (#79)', () => {
    const r = classifySubmit({ status: 3, stdout: JSON.stringify({ reason: 'check-timeout', pr: 4056, url: 'https://x/4056' }) });
    expect(r).toMatchObject({ outcome: 'opened', pr: 4056, labelStep: 'deferred' });
    expect(describeSubmit(r)).toMatchObject({ failed: false });
    expect(describeSubmit(r).line).toMatch(/#4056.*label step deferred to the drain's ci-lifecycle reconcile/);
  });

  it('check-timeout with NO pr stays unrun (#79)', () => {
    expect(classifySubmit({ status: 3, stdout: JSON.stringify({ reason: 'check-timeout' }) }).outcome).toBe('unrun');
  });

  it('the sink never says "NOT opened" when the home named a PR (#79)', async () => {
    const sinks = createOpenPrSinks({ run: () => ({ outcome: 'unrun', reason: 'gh-error', pr: 4051 }) });
    const err = await sinks[SUBMIT_PR_EFFECT]({ argv: ['--ref=lane/x'] }).catch((e) => e);
    expect(String(err.message)).toMatch(/PR #4051 is open/);
    expect(String(err.message)).not.toMatch(/NOT opened/);
  });

  it('the runner spawns pr-land with the app-token shim on PATH (#79)', () => {
    const env = resolveGhCredentialEnv({ env: { PATH: '/usr/bin' }, build: () => null, exists: () => true, orgShimDir: () => null });
    expect(env.PATH).toMatch(/gh-shim:\/usr\/bin$/);
    let seen;
    createPrLandRunner({ prePrReview: () => ({ action: 'pass' }), env, spawn: (_n, _a, o) => { seen = o.env; return { status: 0, stdout: '{"pr":1}' }; } })({ argv: ['--ref=lane/x'] });
    expect(seen.PATH).toBe(env.PATH);
  });

  // xbdzt01 — open-pr passes `--ref=` (never `--branch=`), so the duplicate-card scan must exclude the PR at
  // that head ref. Before the fix it read `--branch`, excluded nothing, and updating PR #4478 warned that every
  // card it adds is "also in #4478" — the PR compared against itself.
  it('the duplicate-card scan excludes the PR being opened/updated, but still flags a different open PR (xbdzt01)', () => {
    const exec = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'diff') return 'backlog/xdeqs8k-a.md\nbacklog/xbb6fgj-b.md\n';
      if (cmd === 'git' && args[0] === 'show') return 'bornAs: ' + args[1].split(':backlog/')[1].slice(0, 7) + '\n';
      if (cmd === 'git' && args[0] === 'grep') throw new Error('no match');
      if (cmd === 'gh') return JSON.stringify([
        { number: 4478, headRefName: 'lane/x', files: [{ path: 'backlog/xdeqs8k-a.md' }, { path: 'backlog/xbb6fgj-b.md' }] },
        { number: 99, headRefName: 'lane/other', files: [{ path: 'backlog/xbb6fgj-b.md' }] },
      ]);
      throw new Error('unexpected ' + cmd);
    };
    const warned = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { warned.push(String(s)); return true; };
    try {
      createPrLandRunner({
        prePrReview: () => ({ action: 'pass' }),
        dupBornAs: (opts) => checkDuplicateBornAs({ ...opts, exec }),
        spawn: () => ({ status: 0, stdout: '{"pr":4478}' }),
      })({ argv: ['--ref=lane/x', '--base=main'] });
    } finally { process.stderr.write = orig; }
    const dups = warned.filter((w) => /duplicate card/.test(w));
    expect(dups.some((w) => /#4478/.test(w))).toBe(false);
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatch(/xbb6fgj.*#99/);
  });

  it('--branch is the ref; ref wins; with neither it derives from the lease purpose (#81)', () => {
    expect(resolveRef({ branch: 'lane/a' })).toBe('lane/a');
    expect(resolveRef({ ref: 'lane/r', branch: 'lane/a' })).toBe('lane/r');
    expect(resolveRef({ derive: () => deriveLaneRef({ read: () => '{"purpose":"items 79/81"}' }) })).toBe('lane/items-79-81');
    expect(deriveLaneRef({ read: () => { throw new Error('none'); } })).toBe('');
  });
});
