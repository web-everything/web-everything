/**
 * @file apply-review-request.test.mjs — the machine applier (#x39x752 slice 2).
 *
 * WHAT IS WORTH PINNING is not that a JSON file parses. It is the set of things this applier must refuse,
 * because the whole point of this path is that no human is watching when it runs:
 *
 *   · `clear-human` WITHOUT `operatorInstruction`. The clearance itself is allowed since the operator ruling
 *     of 2026-08-19, but only carrying the words that authorise it, verbatim, into the durable comment.
 *     Nothing verifies those words — #2946 is the open durable fix — so the record has to be WRITTEN.
 *   · `operatorInstruction` on an ORDINARY verdict — that shape is a copied clearance request with its target
 *     edited, and silently dropping the field invites the next edit to flip it back.
 *   · an empty `changes` — a bounce with no findings tells an author nothing (#xd6moh1).
 *   · a malformed subject — a request that cannot name its PR must not reach a subprocess.
 *
 * THIS HEADER SAID THE OPPOSITE until the review of PR #1477 caught it — it still described `clear-human` as
 * unconditionally refused while the tests below already accepted it. A stale header on a TEST file is worse
 * than a stale comment elsewhere: this is the file a reader opens to learn what the rules are.
 *
 * And one thing worth pinning about what it does NOT do: it never builds a `gh` call of its own. The argv it
 * hands over is the single home's CLI, with the single home's flags.
 *
 * THE ARGV WAS NOT THE WHOLE CONTRACT, and #3263 is the bill for assuming it was — see the last describe block.
 * WHERE the child is spawned decides which tree the reviewed-diff fingerprint is read from, and a wrong tree
 * degrades silently rather than failing, so nothing above this line could ever have caught it.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPLIABLE_TARGETS, REPO_ROOT, REPO_ROOT_FLAG, buildEnv, buildLabelArgv, main, resolveVerdictedRoot,
  validateRequest,
} from '../apply-review-request.mjs';

const OK = { repo: 'web-everything/web-everything', pr: 1466, to: 'accepted', actor: 'reviewer', body: '# verdict' };

describe('what this applier REFUSES', () => {
  /**
   * `clear-human` WAS refused outright here. Operator ruling 2026-08-19 — made with the weakness stated in
   * front of them — allows it when the request carries the instruction authorising it. These tests changed
   * DELIBERATELY, and this comment is the record of why, because a suite that quietly flips an invariant is
   * indistinguishable from one that never held it.
   *
   * The ruling gives up less than it looks: the workstation path never verified a human either (#2895 shipped
   * the clearance as "the raw command with better manners", #2946 is the open durable fix). What the field
   * buys is that a clearance nobody asked for requires inventing a quote and publishing it.
   */
  it('ACCEPTS clear-human when the operator instruction is attached', () => {
    const r = validateRequest({ ...OK, to: 'clear-human', operatorInstruction: 'remove the human tag on 1445' });
    expect(r.ok).toBe(true);
    expect(r.request.operatorInstruction).toBe('remove the human tag on 1445');
  });

  it('REFUSES clear-human with no instruction — the authorisation is the whole guard', () => {
    for (const operatorInstruction of [undefined, '', '   ', 42, null]) {
      const r = validateRequest({ ...OK, to: 'clear-human', operatorInstruction });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/operatorInstruction/);
    }
  });

  it('names #2946 in the refusal, so nobody reads the field as verification', () => {
    expect(validateRequest({ ...OK, to: 'clear-human' }).error).toMatch(/#2946/);
  });

  it('refuses an instruction attached to an ORDINARY verdict — that is a copied clearance request', () => {
    expect(validateRequest({ ...OK, to: 'accepted', operatorInstruction: 'x' }).ok).toBe(false);
    expect(validateRequest({ ...OK, to: 'changes', body: 'f', operatorInstruction: 'x' }).ok).toBe(false);
  });

  it('refuses an empty `changes` — a bounce with no findings lands nothing', () => {
    expect(validateRequest({ ...OK, to: 'changes', body: '   ' }).error).toMatch(/non-empty `body`/);
    expect(validateRequest({ ...OK, to: 'changes', body: undefined }).error).toMatch(/non-empty `body`/);
  });

  it('accepts a `changes` that carries its findings', () => {
    expect(validateRequest({ ...OK, to: 'changes', body: '- the thing is wrong' }).ok).toBe(true);
  });

  it('reports the TARGET as wrong when a request is wrong in two ways at once', () => {
    // Guard order is observable, and it was backwards: a request naming an unknown target while also carrying
    // a stray instruction was refused for the stray field, sending a reader to fix the wrong line
    // (review-pr correctness juror on #1477). Whether `to` is a target at all is the more fundamental question.
    const r = validateRequest({ ...OK, to: 'not-a-target', operatorInstruction: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/`to` must be one of/);
    expect(r.error).not.toMatch(/operatorInstruction/);
  });

  it('refuses a verdict target it does not know', () => {
    for (const to of ['rearm', 'merged', 'ACCEPTED', '', null, undefined]) {
      expect(validateRequest({ ...OK, to }).ok).toBe(false);
    }
    expect(APPLIABLE_TARGETS).toEqual(['accepted', 'changes', 'clear-human']);
  });

  it('refuses a subject it cannot name', () => {
    expect(validateRequest({ ...OK, repo: 'not-a-slug' }).error).toMatch(/owner\/name/);
    expect(validateRequest({ ...OK, pr: 0 }).error).toMatch(/positive integer/);
    expect(validateRequest({ ...OK, pr: '1466' }).error).toMatch(/positive integer/);
  });

  it('refuses an unattributed verdict', () => {
    expect(validateRequest({ ...OK, actor: '  ' }).error).toMatch(/`actor` is required/);
  });

  it('refuses anything that is not an object, without throwing', () => {
    for (const raw of [null, undefined, 'accepted', 42, ['accepted']]) {
      expect(validateRequest(raw)).toEqual({ ok: false, error: 'request must be a JSON object' });
    }
  });
});

describe('the argv handed to the SINGLE HOME', () => {
  it('invokes review-set-label.mjs with its own flags, and builds no gh call of its own', () => {
    const { request } = validateRequest(OK);
    const argv = buildLabelArgv(request, '/tmp/body.md');
    expect(argv[0]).toBe(join(REPO_ROOT, 'scripts', 'review-set-label.mjs'));
    expect(argv).toContain('1466');
    expect(argv).toContain('--repo=web-everything/web-everything');
    expect(argv).toContain('--to=accepted');
    expect(argv).toContain('--actor=reviewer');
    expect(argv).toContain('--body-file=/tmp/body.md');
    expect(argv.join(' ')).not.toContain('gh ');
  });

  it('passes the channel through when the request names one, and omits it otherwise', () => {
    const withCh = validateRequest({ ...OK, channel: 'ci-applier' }).request;
    expect(buildLabelArgv(withCh, '/tmp/b.md')).toContain('--channel=ci-applier');
    expect(buildLabelArgv(validateRequest(OK).request, '/tmp/b.md').some((a) => a.startsWith('--channel='))).toBe(false);
  });

  it('passes the operator instruction as --reason, verbatim, for a clearance', () => {
    // VERBATIM, not paraphrased: a paraphrase is the agent's account of what it was told rather than what it
    // was told, and the single home posts this straight into the durable comment.
    const words = 'For now, I want to allow you to accept an explicit demand to remove human tag.';
    const { request } = validateRequest({ ...OK, to: 'clear-human', operatorInstruction: words });
    expect(buildLabelArgv(request, null)).toContain(`--reason=${words}`);
  });

  it('adds no --reason to an ordinary verdict', () => {
    const { request } = validateRequest(OK);
    expect(buildLabelArgv(request, null).some((a) => a.startsWith('--reason='))).toBe(false);
  });

  it('omits --body-file when there is no body to pass', () => {
    expect(buildLabelArgv(validateRequest(OK).request, null).some((a) => a.startsWith('--body-file='))).toBe(false);
  });
});

/**
 * The actor identity. The request DECLARES a session id and nothing verifies it — the same self-assertion an
 * env var on a workstation already is (#2895 deferred the unforgeable signal; #2946 is the durable fix). What
 * these pin is that an ABSENT id is left absent, so the durable comment records independence as unproven
 * rather than inheriting whatever the runner happened to carry.
 */
describe('the session identity handed to the CLI', () => {
  it('carries the judging session id, so the record names who DECIDED', () => {
    const { request } = validateRequest({ ...OK, sessionId: 'sess-judge-1' });
    expect(buildEnv(request, {}).CLAUDE_CODE_SESSION_ID).toBe('sess-judge-1');
  });

  it('DELETES an inherited id when the request declares none — never silently reuses the runner’s', () => {
    const { request } = validateRequest(OK);
    const env = buildEnv(request, { CLAUDE_CODE_SESSION_ID: 'sess-of-some-other-thing', PATH: '/bin' });
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('refuses a present-but-empty session id rather than treating it as absent', () => {
    expect(validateRequest({ ...OK, sessionId: '' }).ok).toBe(false);
  });
});

/**
 * WHICH TREE THE CHILD RUNS FROM (#3263) — the half of this applier that is not argv.
 *
 * The suite above asserts the argv shape and nothing else, which is exactly why the defect shipped green: the
 * applier spawned the label CLI with `cwd: REPO_ROOT`, its OWN script dirname, and that was correct for as long
 * as the only applier lived inside the repo it verdicted. `plateau-app:.github/workflows/apply-review-request.yml`
 * makes web-everything a SIBLING checkout beside the judged repo, so the child then ran from the wrong tree —
 * and `we:scripts/review-set-label.mjs` fingerprints the reviewed diff from the PROCESS's own cwd (its header
 * states that contract in capitals). Wrong tree, head ref unresolvable, `reviewedDiff` degrades to '', no
 * marker, SHA-identity fallback, and an already-accepted PR re-parks on the next content-preserving rebase.
 *
 * NONE OF THAT THROWS. That is the whole reason these are here: the failure mode is a silent empty fingerprint,
 * so the only thing that can catch it is an assertion on where the child was pinned.
 *
 * `spawn` and `originRepo` are injected, so this pins the behaviour with no subprocess and no second clone on
 * disk — the same discipline `we:scripts/merge-ai-prs.mjs`'s `restampAcceptance` applies to its own spawn.
 */
describe('the checkout the child is pinned to', () => {
  const PLATEAU = '/checkouts/plateau-app';
  const ORIGINS = { [PLATEAU]: 'plateauapp/plateau-app', [REPO_ROOT]: 'web-everything/web-everything' };
  const originRepo = (dir) => ORIGINS[dir] ?? '';

  /** Stage a real request file — `main` reads one from disk, so the applier is exercised end to end. */
  function stage(request) {
    const dir = mkdtempSync(join(tmpdir(), 'apply-review-request-test-'));
    const path = join(dir, 'request.json');
    writeFileSync(path, JSON.stringify(request), 'utf8');
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** A spawn that records HOW it was called and reports the CLI's success contract. */
  function recordingSpawn() {
    const calls = [];
    const spawn = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { status: 0, stdout: '', stderr: '' }; };
    return { calls, spawn };
  }

  it('runs the child from the VERDICTED repo’s checkout, not the applier’s own REPO_ROOT', () => {
    // The plateau-app layout: the applier's own checkout IS web-everything (that is what `REPO_ROOT` names),
    // and the verdict belongs to a repo whose tree is somewhere else entirely.
    const { path, cleanup } = stage({ ...OK, repo: 'plateauapp/plateau-app' });
    const { calls, spawn } = recordingSpawn();
    try {
      expect(main([path, `${REPO_ROOT_FLAG}${PLATEAU}`], { spawn, originRepo, cwd: REPO_ROOT })).toBe(0);
    } finally { cleanup(); }

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.cwd).toBe(PLATEAU);
    // Stated as its own assertion because `REPO_ROOT` is the specific wrong answer this test exists to kill.
    expect(calls[0].opts.cwd).not.toBe(REPO_ROOT);
    // …while the CODE still comes from THIS checkout. Run our script, from their tree.
    expect(calls[0].argv[0]).toBe(join(REPO_ROOT, 'scripts', 'review-set-label.mjs'));
    expect(calls[0].argv).toContain('--repo=plateauapp/plateau-app');
  });

  it('defaults to the process cwd — the plateau-app workflow’s layout, with no flag passed', () => {
    // That workflow runs from the judged repo's root with web-everything checked out beneath it, so the cwd is
    // already right. It is CHOSEN and CHECKED all the same: `REPO_ROOT` also "happened to be right" once.
    const { path, cleanup } = stage({ ...OK, repo: 'plateauapp/plateau-app', body: '' });
    const { calls, spawn } = recordingSpawn();
    try {
      expect(main([path], { spawn, originRepo, cwd: PLATEAU })).toBe(0);
    } finally { cleanup(); }
    expect(calls[0].opts.cwd).toBe(PLATEAU);
    expect(calls[0].opts.cwd).not.toBe(REPO_ROOT);
  });

  it('REFUSES a tree whose origin is not the repo the verdict names, instead of fingerprinting it empty', () => {
    const { path, cleanup } = stage({ ...OK, repo: 'plateauapp/plateau-app' });
    const { calls, spawn } = recordingSpawn();
    try {
      // Standing in web-everything, holding a plateau-app verdict: the exact situation that used to run.
      expect(() => main([path], { spawn, originRepo, cwd: REPO_ROOT })).toThrow(/#3263/);
    } finally { cleanup(); }
    // NOTHING SPAWNED. A refusal that still ran the CLI would be a comment, not a guard.
    expect(calls).toHaveLength(0);
  });

  it('names both repos and the flag that fixes it, so the refusal is actionable', () => {
    const boom = () => resolveVerdictedRoot({ repo: 'plateauapp/plateau-app', root: REPO_ROOT, originRepo });
    expect(boom).toThrow(/plateauapp\/plateau-app/);
    expect(boom).toThrow(/web-everything\/web-everything/);
    expect(boom).toThrow(new RegExp(REPO_ROOT_FLAG));
  });

  it('says "(not a checkout)" rather than nothing when the tree cannot be probed at all', () => {
    // `defaultOriginRepo` returns '' for a directory that is not a git repo, and an error reading
    // "…for X from 's tree" would send a reader looking for a repo called nothing.
    expect(() => resolveVerdictedRoot({ repo: 'plateauapp/plateau-app', root: '/nowhere', originRepo }))
      .toThrow(/not a checkout/);
  });

  it('stages the body in a temp dir, so a child pinned to another tree can still read it', () => {
    // The CLI's `--body-file` allowlist is rooted at `process.cwd()` — the trap `restampAcceptance` sidesteps by
    // passing no body at all. A body written under the APPLIER's checkout would be refused by a child standing
    // in the verdicted repo, so the temp path is part of the pinning, not an implementation detail.
    const { path, cleanup } = stage({ ...OK, repo: 'plateauapp/plateau-app', body: '# findings' });
    const { calls, spawn } = recordingSpawn();
    try {
      main([path, `${REPO_ROOT_FLAG}${PLATEAU}`], { spawn, originRepo, cwd: REPO_ROOT });
    } finally { cleanup(); }
    const bodyArg = calls[0].argv.find((a) => a.startsWith('--body-file='));
    expect(bodyArg.slice('--body-file='.length).startsWith(tmpdir())).toBe(true);
  });

  it('leaves `--check` free of the tree probe — it promises to validate and touch nothing', () => {
    // A validate-only run legitimately happens far from the verdicted checkout (linting the staged files on
    // `ops/review-requests`), where the sibling repo's tree need not exist at all.
    const { path, cleanup } = stage({ ...OK, repo: 'plateauapp/plateau-app' });
    const { calls, spawn } = recordingSpawn();
    const originExplodes = () => { throw new Error('probed the world on --check'); };
    try {
      expect(main([path, '--check'], { spawn, originRepo: originExplodes, cwd: REPO_ROOT })).toBe(0);
    } finally { cleanup(); }
    expect(calls).toHaveLength(0);
  });
});
