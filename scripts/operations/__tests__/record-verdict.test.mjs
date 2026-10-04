/**
 * @file record-verdict.test.mjs — carrying a verdict from a credential-less host (#xrk6hmj).
 *
 * THE DEFECT IT CLOSES is retyping, not tedium. Every hand-rolled request restated the PR number, the repo,
 * the actor and the session id in a fresh `JSON.stringify` next to a body path copied from a directory
 * listing — eight times in one session. A wrong number there records a verdict on the WRONG PR, which is the
 * class #1466 fixed on the reading side.
 *
 * So the assertions below are mostly about PROVENANCE: every fact in the request has to come out of the run
 * record the review itself wrote, and the operation has to refuse rather than invent when the record cannot
 * supply one.
 */
import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importGraph } from './import-graph.mjs';
import {
  recordVerdictOperation, factsFromRun, buildRequest, RECORD_VERDICT_OP, STAGE_REQUEST_EFFECT, describeNoWriteUp,
} from '../record-verdict.mjs';
import {
  writeUpName, TRANSPORT_BRANCH, createRecordVerdictSinks, resolveTransportRoot,
  APPLIER_WORKFLOW, BOARD_SOURCE_BRANCH, trackingRefspec,
} from '../record-verdict-io.mjs';
import { validateRequest, APPLIABLE_TARGETS } from '../../apply-review-request.mjs';

const run = (over = {}) => ({
  id: 'review-pr-abc',
  op: 'review-pr',
  input: { pr: 1496, repo: 'web-everything/web-everything', lens: 'correctness', actor: 'operator' },
  verdict: { verdict: 'accept' },
  telemetry: [{ step: 'judge', sessionId: 'sess-123' }],
  ...over,
});
const ops = (readRun) => recordVerdictOperation({ readRun }, { validateRequest, appliableTargets: APPLIABLE_TARGETS });
/**
 * `steps` is an ARRAY of `{ name, index, step }`, not a map, and the callable body is the INNER `step` —
 * looked up rather than indexed so a rename or a reorder surfaces here as a missing step instead of as an
 * off-by-one calling the wrong function.
 */
const step = (decl, name) => decl.steps.find((s) => s.name === name).step;

describe('the declaration', () => {
  // THE POINT OF THE WHOLE OPERATION: there is no `--pr`, so it cannot be mistyped onto another PR.
  it('takes a run id and NOT a PR number — the subject is read, never retyped', () => {
    const decl = ops(() => ({ record: run(), body: 'x' }));
    expect(decl.name).toBe(RECORD_VERDICT_OP);
    expect(Object.keys(decl.input)).toEqual(['runId', 'to', 'actor', 'operatorInstruction', 'repoRoot']);
    expect(Object.keys(decl.input)).not.toContain('pr');
    expect(Object.keys(decl.input)).not.toContain('repo');
  });

  it('takes its target enum from the APPLIER, so the two cannot disagree about what is legal', () => {
    expect(ops(() => ({ record: run(), body: 'x' })).input.to.enum).toEqual([...APPLIABLE_TARGETS]);
  });

  it('refuses to build without the applier\'s own validator — it states no request rule of its own', () => {
    expect(() => recordVerdictOperation({ readRun: () => ({}) }, {})).toThrow(/validateRequest/);
    expect(() => recordVerdictOperation({}, { validateRequest, appliableTargets: APPLIABLE_TARGETS })).toThrow(/readRun/);
  });

  /**
   * THE DECLARATION REACHES NOTHING THAT CAN ACT — the #3036 property, asserted here because this operation
   * PUSHES. `record-verdict` is not read-only and never will be, so `http-adapter.test.mjs`'s pinned
   * read-only list cannot make this claim on its behalf; without this test the module could quietly grow a
   * `child_process` import and stage-and-push straight out of a `compute` step, where no effect ledger and
   * no `--json` `applied` list would ever show it happened.
   */
  it('imports nothing that can act — every git call lives in the io shell', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(importGraph(resolve(here, '..', 'record-verdict.mjs')).external).toEqual([]);
    // …and the boundary of that guarantee, stated rather than implied: the shell it delegates to DOES act.
    expect(importGraph(resolve(here, '..', 'record-verdict-io.mjs')).external).toContain('node:child_process');
  });
});

describe('factsFromRun — provenance, or a refusal', () => {
  it('reads the subject and the juror session out of the record', () => {
    expect(factsFromRun(run())).toMatchObject({ pr: 1496, repo: 'web-everything/web-everything', sessionId: 'sess-123', reduced: 'accept' });
  });

  /**
   * Recording a verdict for a run that never produced one is not a partial success — it is a fabricated
   * review, and the staged file would be indistinguishable from a real one on the transport branch.
   */
  it('refuses a run whose judge step never produced a verdict', () => {
    expect(() => factsFromRun(run({ verdict: null }))).toThrow(/no verdict/);
  });

  it('refuses a run that is not a review at all', () => {
    expect(() => factsFromRun(run({ op: 'verify' }))).toThrow(/not a review/);
  });

  it('refuses a missing record rather than defaulting a subject', () => {
    expect(() => factsFromRun(null, { runId: 'nope' })).toThrow(/no run record/);
  });

  it('refuses a record whose subject is unusable', () => {
    for (const input of [{ pr: 0, repo: 'a/b' }, { pr: 5, repo: 'not-a-slug' }, {}]) {
      expect(() => factsFromRun(run({ input }))).toThrow(/no usable subject/);
    }
  });

  // Absent is honest: without it the durable comment records independence as UNPROVEN, which is the truth.
  it('carries no session id rather than inventing one', () => {
    expect(factsFromRun(run({ telemetry: [] })).sessionId).toBeUndefined();
  });
});

describe('buildRequest — the applier\'s rules, applied here', () => {
  const facts = { pr: 1496, repo: 'web-everything/web-everything', sessionId: 'sess-123', reduced: 'accept' };

  it('builds a request the applier accepts', () => {
    const out = buildRequest({ facts, to: 'accepted', body: 'the write-up', actor: 'claude-review-pr' }, validateRequest);
    expect(out.request).toMatchObject({ pr: 1496, repo: 'web-everything/web-everything', to: 'accepted', sessionId: 'sess-123' });
    expect(out.path).toBe('ops/review-requests/1496-accepted.json');
  });

  // The applier's own refusals reach the caller unchanged — not re-worded, not re-derived.
  it('surfaces the APPLIER\'s refusal for a clear-human with no operator instruction', () => {
    expect(() => buildRequest({ facts, to: 'clear-human', body: 'b', actor: 'a' }, validateRequest)).toThrow(/operatorInstruction/);
  });

  it('surfaces the applier\'s refusal for an empty `changes` body', () => {
    expect(() => buildRequest({ facts, to: 'changes', body: '   ', actor: 'a' }, validateRequest)).toThrow(/non-empty `body`/);
  });

  it('surfaces the applier\'s refusal for a stray instruction on an ordinary verdict', () => {
    expect(() => buildRequest({ facts, to: 'accepted', body: 'b', actor: 'a', operatorInstruction: 'go' }, validateRequest))
      .toThrow(/belongs only on a `clear-human`/);
  });

  /**
   * An operator recording `changes` over a panel that reduced to `accept` is a legitimate override — #2409's
   * arc has always allowed it. It is SURFACED rather than blocked, so the record shows the disagreement
   * instead of hiding it.
   */
  it('flags a verdict that overrides the panel, without refusing it', () => {
    expect(buildRequest({ facts, to: 'changes', body: 'b', actor: 'a' }, validateRequest).disagreesWithPanel).toBe(true);
    expect(buildRequest({ facts, to: 'accepted', body: 'b', actor: 'a' }, validateRequest).disagreesWithPanel).toBe(false);
  });
});

describe('the read step refuses a verdict with nothing to say', () => {
  it('refuses when the run staged no write-up — the comment IS the review', () => {
    const decl = ops(() => ({ record: run(), body: '  ' }));
    expect(() => step(decl, 'read').fn({ input: { runId: 'review-pr-abc' } })).toThrow(/staged no write-up/);
  });

  // #3540 — the refusal now NAMES the reason, so "not recorded yet" reads differently from "genuinely empty".
  it('names the specific reason in the refusal, via describeNoWriteUp', () => {
    const decl = ops(() => ({ record: run({ pending: { kind: 'confirm', step: 'confirm' } }), body: '' }));
    expect(() => step(decl, 'read').fn({ input: { runId: 'review-pr-abc' } })).toThrow(/has not been RECORDED yet/);
  });
});

describe('#3540 describeNoWriteUp — WHY is the write-up missing?', () => {
  it('names a deliberate abstain as deliberate, not a defect', () => {
    expect(describeNoWriteUp(run({ findings: { confirm: 'abstain' } }))).toMatch(/deliberate/);
  });

  it('names a still-unanswered confirm, and points at the self-sufficient CLI', () => {
    const msg = describeNoWriteUp(run({ pending: { kind: 'confirm', step: 'confirm' } }));
    expect(msg).toMatch(/has not been RECORDED yet/);
    expect(msg).toMatch(/record-verdict-cli\.mjs/);
  });

  it('names anything else as a genuine defect — the judge shape should make this unreachable', () => {
    expect(describeNoWriteUp(run())).toMatch(/should not be reachable/);
  });

  it('never throws on a missing or malformed record', () => {
    expect(describeNoWriteUp(null)).toMatch(/No run record/);
    expect(describeNoWriteUp(undefined)).toMatch(/No run record/);
  });
});

describe('the stage effect', () => {
  it('declares one idempotent effect carrying bytes the plan already computed', () => {
    const decl = ops(() => ({ record: run(), body: 'x' }));
    const effects = step(decl, 'stage').effects({ verdict: { path: 'ops/review-requests/1496-accepted.json', request: { pr: 1496, to: 'accepted', repo: 'web-everything/web-everything' } } });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: STAGE_REQUEST_EFFECT, idempotent: true });
    expect(JSON.parse(effects[0].payload.content)).toMatchObject({ pr: 1496 });
  });
});

/**
 * The two PROBES #3264 added, answered as a HEALTHY board would answer them: the branch exists on `origin`,
 * and its tree carries the applier workflow.
 *
 * Shared by the stubs of the tests that are about something ELSE, and answered rather than left to fall
 * through to `''` — because '' is not "don't care" for either verb. An empty `ls-remote` means "no board",
 * which would send every one of those tests down the genesis path; an empty `ls-tree` means "no applier",
 * which would make every one of them refuse. Both would still be green for tests asserting a throw, and
 * green for the wrong reason, which is the failure mode this file already fought once over the empty diff.
 */
const healthyBoard = (args) => {
  if (args[0] === 'ls-remote') return `sha\trefs/heads/${TRANSPORT_BRANCH}\n`;
  if (args[0] === 'ls-tree') return `${APPLIER_WORKFLOW}\n`;
  return undefined;
};

describe('the sink — a worktree, never a branch switch in the caller\'s lane', () => {
  /**
   * EVERY side effect is stubbed, filesystem included, and that is not belt-and-braces.
   *
   * The first version of this helper injected `run` only. The sink's own `mkdirSync` therefore ran for real
   * against the fixture root `/repo` — and as root it SUCCEEDED, creating a directory at the filesystem root
   * while the suite reported green. CI, running as an ordinary user, failed it `EACCES` and reddened four
   * tests. The red was the honest result; the local green was a suite asserting a sink's behaviour while that
   * sink wrote outside its checkout, unnoticed.
   *
   * `fs` records into the same `calls` array as `run`, so a test can assert on where the sink writes as
   * readily as on what it shells.
   */
  const stub = (calls, over = {}, onRun) => createRecordVerdictSinks({
    root: '/repo',
    // #3261 — the board is chosen by matching the checkout's origin to the request's repo, and a mismatch is
    // REFUSED rather than defaulted. These stubs push for `web-everything/web-everything`, so the fixture checkout
    // claims to be that repo. Injected, so no test shells `git remote`.
    originRepo: () => 'web-everything/web-everything',
    now: () => 111,
    run: (args, opts) => {
      calls.push({ args, cwd: opts?.cwd });
      if (onRun) { const r = onRun(args); if (r !== undefined) return r; }
      const healthy = healthyBoard(args);
      if (healthy !== undefined) return healthy;
      return over[args[0]] ?? '';
    },
    mkdir: (p, o) => calls.push({ fs: 'mkdir', path: p, opts: o }),
    write: (p, c) => calls.push({ fs: 'write', path: p, content: c }),
    rm: (p, o) => calls.push({ fs: 'rm', path: p, opts: o }),
  });
  const sink = (calls, over = {}) => stub(calls, over)[STAGE_REQUEST_EFFECT];

  /**
   * THE REGRESSION GUARD for the above: a sink built with no fs stubs must not be what these tests exercise.
   * Asserted by construction — the builder accepts the three, and passing them is what keeps the suite
   * hermetic. If someone removes the parameters, this stops compiling against the real signature.
   */
  it('takes its filesystem calls as injected parameters, so a test never writes for real', async () => {
    const calls = [];
    await sink(calls, { diff: '' })({ path: 'ops/review-requests/1-accepted.json', content: '{}\n', pr: 1, to: 'accepted', repo: 'web-everything/web-everything' });
    const writes = calls.filter((c) => c.fs);
    expect(writes.length).toBeGreaterThan(0);
    // …and every path it touched is under the worktree it created, never the caller's root itself.
    for (const w of writes) expect(w.path.startsWith('/repo/.operations/transport')).toBe(true);
  });

  /**
   * Checking the transport branch out over the caller's lane would take their uncommitted work with it. I did
   * the equivalent by hand earlier and it disrupted a running juror mid-review, which is why this is a
   * worktree and why it is asserted rather than assumed.
   */
  it('never runs a checkout in the caller\'s root — only inside its own worktree', async () => {
    const calls = [];
    await sink(calls, { diff: 'ops/review-requests/1496-accepted.json' })({ path: 'ops/review-requests/1496-accepted.json', content: '{}\n', pr: 1496, to: 'accepted', repo: 'web-everything/web-everything' })
      .catch(() => {});
    const checkouts = calls.filter((c) => c.args?.[0] === 'checkout');
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c.cwd).not.toBe('/repo');
  });

  it('always prunes the worktree, even when the push throws', async () => {
    const calls = [];
    const sinks = stub(calls, { diff: 'ops/review-requests/1496-accepted.json' }, (args) => {
      if (args[0] === 'push') throw new Error('network');
      return undefined;
    });
    await expect(sinks[STAGE_REQUEST_EFFECT]({ path: 'ops/review-requests/1496-accepted.json', content: '{}\n', pr: 1496, to: 'accepted', repo: 'web-everything/web-everything' })).rejects.toThrow(/network/);
    expect(calls.some((c) => c.args?.[0] === 'worktree' && c.args?.[1] === 'prune')).toBe(true);
    // The DIRECTORY removal too, not just the registration prune — a `finally` that dropped one of the two
    // would still pass a check for the other.
    expect(calls.some((c) => c.fs === 'rm')).toBe(true);
  });

  // A replay that stages identical bytes has nothing to commit, and that is the `idempotent: true` promise
  // being kept rather than an error to report.
  it('treats "nothing to commit" as success, not failure', async () => {
    const calls = [];
    const out = await sink(calls, { diff: '' })({ path: 'ops/review-requests/1496-accepted.json', content: '{}\n', pr: 1496, to: 'accepted', repo: 'web-everything/web-everything' });
    expect(out).toMatchObject({ pushed: false });
    expect(calls.some((c) => c.args?.[0] === 'push')).toBe(false);
  });

  it('pushes to the branch CI actually watches', async () => {
    const calls = [];
    await sink(calls, { diff: 'x' })({ path: 'ops/review-requests/1496-accepted.json', content: '{}\n', pr: 1496, to: 'accepted', repo: 'web-everything/web-everything' });
    const push = calls.find((c) => c.args?.[0] === 'push');
    expect(push.args).toContain(`HEAD:${TRANSPORT_BRANCH}`);
  });
});

describe('the write-up name matches what review-pr stages', () => {
  it('is repo-and-pr keyed, with the slash flattened', () => {
    expect(writeUpName('web-everything/web-everything', 1496)).toBe('web-everything-web-everything-1496-verdict.md');
  });
});

// ── #3261: each repo owns its own notes, and the wrong board is REFUSED ──────────────────────────────────────
describe('#3261 — resolveTransportRoot picks the board, and refuses the wrong one', () => {
  it('returns the checkout whose origin IS the request repo', () => {
    expect(resolveTransportRoot({ repo: 'o/x', root: '/co', originRepo: () => 'o/x' })).toBe('/co');
  });

  it('REFUSES a verdict for another repo rather than defaulting to this checkout', () => {
    // THE WHOLE POINT. Before the ruling this pushed a plateau-app verdict onto web-everything's board, where
    // the applier's repo-scoped token could not resolve the repository — one failure in fifty applier runs,
    // and it was the only cross-repo request. Defaulting is what stranded it; refusing names both repos.
    expect(() => resolveTransportRoot({ repo: 'o/other', root: '/co', originRepo: () => 'o/x' }))
      .toThrow(/refusing to stage a verdict for o\/other on o\/x's transport branch/);
  });

  it('the refusal names the flag that fixes it', () => {
    expect(() => resolveTransportRoot({ repo: 'o/other', root: '/co', originRepo: () => 'o/x' }))
      .toThrow(/--repoRoot=<path to a o\/other checkout>/);
  });

  it('an explicit repoRoot wins over the driver checkout', () => {
    const seen = [];
    const got = resolveTransportRoot({
      repo: 'o/other', root: '/driver', repoRoot: '/sibling',
      originRepo: (cwd) => { seen.push(cwd); return cwd === '/sibling' ? 'o/other' : 'o/x'; },
    });
    expect(got).toBe('/sibling');
    expect(seen).toEqual(['/sibling']); // it never probes the driver when told where to look
  });

  it('refuses a request with no repo at all — no board can be chosen', () => {
    expect(() => resolveTransportRoot({ repo: '', root: '/co' })).toThrow(/no `repo` on the request/);
  });

  it('an unreadable origin refuses rather than guessing', () => {
    // `defaultOriginRepo` returns '' when git cannot answer. That must not compare equal to anything.
    expect(() => resolveTransportRoot({ repo: 'o/x', root: '/co', originRepo: () => '' }))
      .toThrow(/refusing to stage a verdict for o\/x on \(unknown\)/);
  });
});

// ── #3261: the sink must USE the board it resolved, not merely resolve it (PR #1533 juror) ───────────────────
//
// The six tests above pin `resolveTransportRoot`'s DECISION. They say nothing about whether the sink acts on
// it — and the PR #1533 correctness juror proved that gap by mutation: reverting the sink's three git call
// sites back to the driver's `root` left the whole suite green. A decision nothing consumes is a vacuous
// guard, which is exactly the failure this whole card is about, one layer in.
//
// So these drive the sink with `board` DIFFERENT from `root` and assert every git call lands on the board.
describe('#3261 — the sink runs its git against the BOARD, not the driver', () => {
  const OTHER = '/sibling-checkout';
  const build = (calls, onRun) => createRecordVerdictSinks({
    root: '/driver',
    // The driver is web-everything; the board is the sibling whose origin IS the request's repo.
    originRepo: (cwd) => (cwd === OTHER ? 'o/other' : 'web-everything/web-everything'),
    now: () => 111,
    run: (args, opts) => {
      calls.push({ args, cwd: opts?.cwd });
      if (onRun) { const r = onRun(args); if (r !== undefined) return r; }
      const healthy = healthyBoard(args);
      if (healthy !== undefined) return healthy;
      // A NON-EMPTY staged diff, so these drive the FULL path through commit+push. Returning '' here makes the
      // sink take its "identical request already staged" early return, and the assertions below would then be
      // testing a branch that never pushes — passing for the wrong reason.
      return args[0] === 'diff' ? `${'ops/review-requests/144-accepted.json'}\n` : '';
    },
    mkdir: () => {}, write: () => {}, rm: () => {},
  })[STAGE_REQUEST_EFFECT];

  const payload = { path: 'ops/review-requests/144-accepted.json', content: '{}\n', pr: 144, to: 'accepted', repo: 'o/other', repoRoot: OTHER };
  const cwdOf = (calls, verb, sub) => calls.find((c) => c.args?.[0] === verb && (sub === undefined || c.args?.[1] === sub))?.cwd;

  it('fetches the transport branch in the BOARD', async () => {
    const calls = []; await build(calls)(payload);
    expect(cwdOf(calls, 'fetch')).toBe(OTHER);
  });

  it('adds the worktree from the BOARD', async () => {
    const calls = []; await build(calls)(payload);
    expect(cwdOf(calls, 'worktree', 'add')).toBe(OTHER);
  });

  it('PRUNES in the board too — a stale registration in the target repo wedges its next stage', async () => {
    // The sibling of the two above, and the one that was wrong first: the prune kept the driver's cwd while
    // the worktree moved. Pinned separately so fixing two of three cannot pass.
    const calls = []; await build(calls)(payload);
    expect(cwdOf(calls, 'worktree', 'prune')).toBe(OTHER);
  });

  it('prunes in the board even when the push FAILS', async () => {
    const calls = [];
    await expect(build(calls, (a) => { if (a[0] === 'push') throw new Error('network'); })(payload)).rejects.toThrow(/network/);
    expect(cwdOf(calls, 'worktree', 'prune')).toBe(OTHER);
  });

  it('never touches the driver checkout at all', async () => {
    // The strongest form: not "the board was used somewhere" but "the driver was used nowhere".
    const calls = []; await build(calls)(payload);
    expect(calls.filter((c) => c.cwd === '/driver')).toEqual([]);
  });
});

// ── #3264: a repo onboarding to the transport, and a board that cannot apply ─────────────────────────────────
//
// THESE DRIVE A FIXTURE ORIGIN, not a stub that says yes to everything, and that is the whole reason they are
// worth having. Every one of the three failures on this card is a DISAGREEMENT between what the sink assumed
// git would do and what git does — so a `run` that returns `''` for any verb and never throws cannot express
// them, and a test written against one would have passed on the broken sink.
//
// The fixture therefore models the three behaviours that actually bit, live, onboarding plateau-app:
//   · `fetch` of a ref the remote does not have FAILS, which is failure (1): the first verdict for a repo with
//     no board died right there;
//   · `fetch origin <name>` creates NO remote-tracking ref, and `worktree add origin/<name>` then fails with
//     `invalid reference` — failure (3), the narrow-clone geometry the sink read as universal;
//   · the board's tree is a real set of paths, so a board without the applier can be asked about — failure (2),
//     which git itself never reports because a push to a board with no workflow SUCCEEDS and does nothing.
describe('#3264 — board genesis, and a board that cannot apply is REFUSED', () => {
  const BOARD = '/board-checkout';
  const REPO = 'o/onboarding';
  const BOARD_REF = `refs/heads/${TRANSPORT_BRANCH}`;
  const MAIN_REF = `refs/heads/${BOARD_SOURCE_BRANCH}`;

  /**
   * A fake `origin` plus a fake clone geometry. `heads` is what the remote carries; `tracking` is what THIS
   * clone has under `refs/remotes/`, which starts EMPTY — a narrow clone, the case the sink got wrong.
   */
  const fixture = ({ heads = [MAIN_REF], tree = [APPLIER_WORKFLOW], calls, onRun } = {}) => {
    const remote = new Set(heads);
    const tracking = new Set();
    const git = (args, opts) => {
      calls.push({ args, cwd: opts?.cwd });
      if (onRun) { const r = onRun(args); if (r !== undefined) return r; }
      const last = args[args.length - 1];
      switch (args[0]) {
        case 'ls-remote': {
          // `--heads origin <pat>…`, printed as git prints it: `<sha>\t<ref>`, absent refs simply not listed.
          // The patterns match a ref's TAIL, as git's do — so `ops/review-requests` also answers for
          // `refs/heads/legacy/ops/review-requests`, and reading the raw output by substring would call that
          // "the board exists". Modelled rather than idealised so that distinction is testable.
          const pats = args.slice(3);
          const hit = (ref) => pats.some((p) => ref === `refs/heads/${p}` || ref.endsWith(`/${p}`));
          return [...remote].filter(hit).map((ref) => `sha\t${ref}\n`).join('');
        }
        case 'fetch': {
          const [src, dst] = last.replace(/^\+/, '').split(':');
          if (!remote.has(src)) throw new Error(`fatal: couldn't find remote ref ${src}`);
          // THE NARROW-CLONE TRUTH: the remote-tracking ref appears only when the refspec NAMES it. A bare
          // `fetch origin <branch>` writes FETCH_HEAD and leaves `refs/remotes/origin/<branch>` absent.
          if (dst) tracking.add(dst);
          return '';
        }
        case 'push': {
          const [src, dst] = last.split(':');
          if (src.startsWith('refs/remotes/') && !tracking.has(src)) throw new Error(`error: src refspec ${src} does not match any`);
          remote.add(dst.startsWith('refs/') ? dst : `refs/heads/${dst}`);
          return '';
        }
        case 'worktree':
          if (args[1] === 'add' && !tracking.has(`refs/remotes/${last}`)) throw new Error(`fatal: invalid reference: ${last}`);
          return '';
        case 'ls-tree':
          return tree.includes(last) ? `${last}\n` : '';
        // A NON-EMPTY staged diff, so every one of these runs the FULL path through commit+push rather than
        // the "identical request already staged" early return — the same trap #3261's block documents.
        case 'diff': return `${payload.path}\n`;
        default: return '';
      }
    };
    return { git, remote, tracking };
  };

  const payload = { path: 'ops/review-requests/7-accepted.json', content: '{}\n', pr: 7, to: 'accepted', repo: REPO, repoRoot: BOARD };
  const sinkOver = (git) => createRecordVerdictSinks({
    root: '/driver', originRepo: () => REPO, now: () => 111, run: git,
    mkdir: () => {}, write: () => {}, rm: () => {},
  })[STAGE_REQUEST_EFFECT];
  const drive = (opts = {}) => {
    const calls = [];
    const f = fixture({ ...opts, calls });
    return { calls, ...f, stage: sinkOver(f.git) };
  };
  const pushes = (calls) => calls.filter((c) => c.args?.[0] === 'push').map((c) => c.args[c.args.length - 1]);

  // ── Failure 1: the genesis fetch had no genesis case ──
  it('creates the board from main when origin carries no ops/review-requests, then stages onto it', async () => {
    // RED before this card: the sink fetched the board unconditionally and this died on `couldn't find remote
    // ref` — the first verdict for EVERY newly-onboarded repo, which #3261 made the normal path.
    const d = drive({ heads: [MAIN_REF] });
    const out = await d.stage(payload);
    expect(pushes(d.calls)).toContain(`refs/remotes/origin/${BOARD_SOURCE_BRANCH}:${BOARD_REF}`);
    expect(d.remote.has(BOARD_REF)).toBe(true);
    // …and it did not merely create the branch: the verdict it was called for went out too.
    expect(out).toMatchObject({ pushed: true, path: payload.path });
  });

  it('cuts the board from the REMOTE main tip, fetched by refspec — never from the local checkout', async () => {
    // Pushing local `main` would publish whatever the checkout is sitting on (stale, or a lane), and in a
    // narrow clone `refs/remotes/origin/main` does not exist until something asks for it by name. The fixture
    // fails the push when it is not there, so this pins the fetch as well as the source.
    const d = drive({ heads: [MAIN_REF] });
    await d.stage(payload);
    const fetches = d.calls.filter((c) => c.args?.[0] === 'fetch').map((c) => c.args[c.args.length - 1]);
    expect(fetches).toContain(trackingRefspec(BOARD_SOURCE_BRANCH));
    expect(pushes(d.calls).some((s) => s.startsWith(`${BOARD_SOURCE_BRANCH}:`))).toBe(false);
  });

  it('refuses, naming the onboarding step, when the board cannot be created', async () => {
    const d = drive({ heads: [MAIN_REF], onRun: (a) => { if (a[0] === 'push') throw new Error('denied'); } });
    await expect(d.stage(payload)).rejects.toThrow(
      new RegExp(`git push origin origin/${BOARD_SOURCE_BRANCH}:refs/heads/${TRANSPORT_BRANCH}`),
    );
    // The underlying git failure survives into the message; a refusal that swallowed it would send the reader
    // hunting for a permissions problem the sink already knew about.
    await expect(drive({ heads: [MAIN_REF], onRun: (a) => { if (a[0] === 'push') throw new Error('denied'); } }).stage(payload))
      .rejects.toThrow(/denied/);
  });

  it('refuses when origin has no main to cut the board from', async () => {
    const d = drive({ heads: [] });
    await expect(d.stage(payload)).rejects.toThrow(/carries no `ops\/review-requests` board and no `main`/);
    await expect(drive({ heads: [] }).stage(payload)).rejects.toThrow(new RegExp(REPO.replace('/', '\\/')));
  });

  it('leaves an existing board alone — genesis runs once, not on every verdict', async () => {
    // The other half of the branch: a board that already exists must not be re-cut from `main`, which would
    // throw away every request on it and, worse, is a force-push shape nothing here should ever reach for.
    const d = drive({ heads: [MAIN_REF, BOARD_REF] });
    await d.stage(payload);
    expect(pushes(d.calls)).not.toContain(`refs/remotes/origin/${BOARD_SOURCE_BRANCH}:${BOARD_REF}`);
    expect(pushes(d.calls)).toEqual([`HEAD:${TRANSPORT_BRANCH}`]);
  });

  it('a similarly-named branch is NOT the board — a non-empty ls-remote is not an answer', async () => {
    // `git ls-remote --heads origin ops/review-requests main` matches a ref's TAIL, so it also lists
    // `refs/heads/legacy/ops/review-requests` — and it lists `main` in every healthy case anyway. So the
    // probe's output is non-empty far more often than the board exists, and the two shortcuts that invite
    // themselves here — "output is non-empty" and "some ref came back" — would both skip genesis and hand the
    // caller back the original `couldn't find remote ref`, which is the failure this card exists to close.
    // (A `.includes()` on the raw output is NOT among the shortcuts this can catch: git's own tail-matching
    // never returns a ref that contains the board's full name as a substring without BEING it.)
    const d = drive({ heads: [MAIN_REF, `refs/heads/legacy/${TRANSPORT_BRANCH}`] });
    await d.stage(payload);
    expect(pushes(d.calls)).toContain(`refs/remotes/origin/${BOARD_SOURCE_BRANCH}:${BOARD_REF}`);
  });

  // ── Failure 3: `fetch origin <branch>` does not create `origin/<branch>` ──
  it('fetches the board by an EXPLICIT refspec, so a narrow clone can worktree-add it', async () => {
    // RED before this card, and hit live: the bare fetch SUCCEEDED, wrote only FETCH_HEAD, and the next line
    // died `fatal: invalid reference: origin/ops/review-requests`. The fixture reproduces exactly that, so
    // this test cannot be satisfied by anything but naming the destination ref.
    const d = drive({ heads: [MAIN_REF, BOARD_REF] });
    await d.stage(payload);
    const fetches = d.calls.filter((c) => c.args?.[0] === 'fetch').map((c) => c.args[c.args.length - 1]);
    expect(fetches).toContain(trackingRefspec(TRANSPORT_BRANCH));
    expect(d.tracking.has(`refs/remotes/origin/${TRANSPORT_BRANCH}`)).toBe(true);
  });

  // ── Failure 2: the board that accepts the push and applies nothing ──
  it('refuses to stage onto a board whose tree lacks the applier workflow', async () => {
    // The fail-SILENT turned loud. git reports nothing here — the push succeeds and no workflow is defined on
    // the pushed ref — so the only place this can be caught is a deliberate look at the board's own tree.
    const d = drive({ heads: [MAIN_REF, BOARD_REF], tree: [] });
    await expect(d.stage(payload)).rejects.toThrow(/does not carry `\.github\/workflows\/apply-review-request\.yml`/);
    await expect(drive({ heads: [MAIN_REF, BOARD_REF], tree: [] }).stage(payload)).rejects.toThrow(/ON THE PUSHED REF/);
  });

  it('does NOT tell the reader their unapplied requests are safe to discard', async () => {
    // The refusal recommends a `--force` re-cut, and its first draft justified that with "every request on it
    // has already been applied". That is exactly BACKWARDS: this refusal fires only when no applier rode the
    // board, so the push-triggered workflow never ran on it, so anything sitting there was never applied. A
    // maintainer trusting that sentence would force-push away the only record of those verdicts.
    // Found by the PR #1544 correctness juror. The message must justify itself with what the check PROVED.
    const d = drive({ heads: [MAIN_REF, BOARD_REF], tree: [] });
    const err = await d.stage(payload).then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err.message).not.toMatch(/already been applied/);
    expect(err.message).toMatch(/NEVER applied/);
    // …and it must say to look before destroying, not merely omit the false reassurance.
    expect(err.message).toMatch(/INSPECT THE BOARD BEFORE RE-CUTTING IT/);
  });

  it('pushes NOTHING when it refuses a board that cannot apply', async () => {
    // A refusal after the push would be decoration: the dead request would already be on the board. This is
    // the assertion that makes the check worth having rather than merely present.
    const d = drive({ heads: [MAIN_REF, BOARD_REF], tree: [] });
    await d.stage(payload).catch(() => {});
    expect(pushes(d.calls)).toEqual([]);
    expect(d.calls.some((c) => c.args?.[0] === 'commit')).toBe(false);
  });

  it('reads the applier from the BOARD\'s worktree, not from the driver checkout', async () => {
    // The driver having the applier on `main` says nothing about what rides the branch being pushed to —
    // conflating the two is precisely the assumption that let a dead board look healthy.
    const d = drive({ heads: [MAIN_REF, BOARD_REF] });
    await d.stage(payload);
    const look = d.calls.find((c) => c.args?.[0] === 'ls-tree');
    expect(look.args).toContain(APPLIER_WORKFLOW);
    expect(look.cwd.startsWith(`${BOARD}/.operations/transport`)).toBe(true);
  });

  it('still prunes the board worktree when the applier check refuses', async () => {
    // The refusal is thrown from inside the `try`, so the existing `finally` has to cover it too — a check
    // that leaked a worktree would wedge every subsequent stage on that board.
    const d = drive({ heads: [MAIN_REF, BOARD_REF], tree: [] });
    await d.stage(payload).catch(() => {});
    expect(d.calls.some((c) => c.args?.[0] === 'worktree' && c.args?.[1] === 'prune' && c.cwd === BOARD)).toBe(true);
  });
});
