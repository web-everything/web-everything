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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { LEDGER_DIR, LEDGER_TRANSPORT_BRANCH, appendLedgerRows, ledgerGitPath } from '../lib/verdict-ledger-io.mjs';
import { buildVerdictRecord } from '../lib/verdict-ledger.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
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

/**
 * Ledger plan slice C3 (#3255 part 3): the applier workflow may push ledger rows, and a ledger-only push must
 * not re-trigger it. The workflow's permissions and trigger filter are the contract, so they are asserted
 * on the parsed YAML, not by grepping text.
 */
describe('the applier workflow can push ledger rows without re-triggering itself (C3)', () => {
  const wf = yaml.load(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'apply-review-request.yml'), 'utf8'));
  const push = wf.on.push;

  it('has contents: write and keeps the other grants exactly as narrow as before', () => {
    expect(wf.permissions).toEqual({ 'pull-requests': 'write', issues: 'write', contents: 'write' });
  });

  it('triggers only on the transport branch', () => {
    expect(push.branches).toEqual([LEDGER_TRANSPORT_BRANCH]);
  });

  it('has a path filter that leaves the ledger directory out', () => {
    expect(push.paths).toEqual([`${LEDGER_TRANSPORT_BRANCH}/*.json`]);
    const ledgerFile = ledgerGitPath('web-everything/web-everything');
    expect(ledgerFile.startsWith(`${LEDGER_DIR}/`)).toBe(true);
    // GitHub's `*` does not cross `/`: a pattern matches a file only at the same directory depth.
    const matches = (pattern, file) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(file);
    for (const pattern of push.paths) expect(matches(pattern, ledgerFile)).toBe(false);
    expect(matches(push.paths[0], `${LEDGER_TRANSPORT_BRANCH}/request-1.json`)).toBe(true);
  });

  it('checks out main and sets a git identity before applying', () => {
    const steps = wf.jobs.apply.steps;
    const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
    expect(checkout.with.ref).toBe('main');
    const identity = steps.findIndex((s) => /user\.email/.test(s.run ?? ''));
    const apply = steps.findIndex((s) => /apply-review-request\.mjs/.test(s.run ?? ''));
    expect(identity).toBeGreaterThan(-1);
    expect(identity).toBeLessThan(apply);
  });
});

/**
 * THE WRITE TOKEN'S REACH (PR #4318 review, security/least-privilege). `contents: write` makes GITHUB_TOKEN a
 * push credential. Left in `.git/config` by the checkout it would be readable by every later step, including
 * `npm ci` and every `node` process that loads node_modules. So the checkout must not persist it, and the
 * token may be handed only to the steps that need it, each by name. A new step that mentions the token, or a
 * checkout that persists it again, reddens here.
 */
describe('the write token is not left lying around for the whole job (C3)', () => {
  const wf = yaml.load(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'apply-review-request.yml'), 'utf8'));
  const steps = wf.jobs.apply.steps;
  const mentionsToken = (s) => /secrets\.GITHUB_TOKEN|github\.token|GH_TOKEN|GITHUB_TOKEN/.test(JSON.stringify(s));
  const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
  const collect = steps.find((s) => s.id === 'collect');
  const apply = steps.find((s) => /apply-review-request\.mjs/.test(s.run ?? ''));

  it('does not persist the checkout credential into .git/config', () => {
    expect(checkout.with['persist-credentials']).toBe(false);
    // Neither may a custom token be smuggled in through the checkout itself, which would persist nothing but
    // would also bypass the by-name list below.
    expect(checkout.with.token).toBeUndefined();
  });

  it('hands the token to exactly the collect and apply steps, and to no other step', () => {
    expect(steps.filter(mentionsToken)).toEqual([collect, apply]);
  });

  it('cannot reach the other steps through a job- or workflow-level env, a second checkout, or a job container', () => {
    expect(wf.env).toBeUndefined();
    expect(wf.jobs.apply.env).toBeUndefined();
    expect(wf.jobs.apply.container).toBeUndefined();
    expect(steps.filter((s) => String(s.uses ?? '').startsWith('actions/checkout'))).toEqual([checkout]);
    expect(Object.keys(wf.jobs)).toEqual(['apply']);
  });

  it('guards against an empty credential before exporting the header', () => {
    expect(apply.run).toMatch(/\[ -n "\$basic" \]/);
    expect(apply.run.search(/\[ -n "\$basic" \]/)).toBeLessThan(apply.run.indexOf('GIT_CONFIG_KEY_0'));
  });

  it('keeps the token away from the install step', () => {
    const install = steps.find((s) => /npm ci/.test(s.run ?? ''));
    expect(install).toBeDefined();
    expect(mentionsToken(install)).toBe(false);
    expect(install.env).toBeUndefined();
  });

  it('gives the apply step a git credential so the ledger push still authenticates', () => {
    const header = /GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/;
    expect(apply.run).toMatch(header);
    expect(apply.run).toMatch(/GIT_CONFIG_COUNT=1/);
    // Exported BEFORE the loop that runs the applier, and masked so a log line cannot print it.
    expect(apply.run.search(header)).toBeLessThan(apply.run.indexOf('node scripts/apply-review-request.mjs'));
    expect(apply.run).toMatch(/::add-mask::/);
  });

  it('gives the collect step the credential for `git fetch` only, never for its node process', () => {
    const lines = collect.run.split('\n');
    const nodeLine = lines.find((l) => /node scripts\/collect-review-requests\.mjs/.test(l));
    expect(nodeLine).toMatch(/env -u \S+ node scripts\/collect-review-requests\.mjs/);
    // Every fetch goes through the helper that attaches the header to that one command.
    const fetches = lines.filter((x) => !/^\s*#/.test(x) && /\bfetch\b/.test(x));
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const l of fetches) expect(l).toMatch(/authed_git fetch/);
  });
});

/**
 * THE PUSH'S CONTAINMENT (PR #4318 review, security/test-coverage). `contents: write` cannot be scoped to one
 * branch, so the narrowing is the push itself: one explicit refspec to the transport branch, never forced.
 * Prose in the workflow said so and nothing tested it. These drive the REAL io-shell with a recording `git`
 * and pin the argv, so a later `--force`, a `+` refspec, or a push to another ref reddens here.
 */
describe('the ledger push can only fast-forward the transport branch (C3)', () => {
  const REPO = 'web-everything/web-everything';
  const record = buildVerdictRecord({
    repo: REPO, pr: 4318, verdict: 'accepted', at: '2026-10-07T12:00:00.000Z', source: 'test',
  });

  function pushArgvFor(records) {
    const calls = [];
    const run = (args, opts) => { calls.push(Object.assign([...args], { cwd: opts?.cwd })); return args[0] === 'diff' ? 'verdict-ledger/x.jsonl\n' : ''; };
    appendLedgerRows({
      board: '/board', repo: REPO, records, run, sleep: () => {}, now: () => 1,
      mkdir: () => {}, write: () => {}, read: () => null, rm: () => {},
    });
    return calls;
  }

  // The ledger-row shape is owned by verdict-ledger.mjs; when it refuses this fixture, fail loudly rather than
  // silently pinning nothing.
  const calls = (() => { try { return pushArgvFor([record]); } catch (e) { return e; } })();

  it('builds a valid fixture row (guards the cases below from pinning nothing)', () => {
    expect(calls).toBeInstanceOf(Array);
  });

  it('pushes exactly HEAD to the transport branch: no force, no plus-refspec, no other ref', () => {
    const pushes = calls.filter((a) => a[0] === 'push');
    expect(pushes.map((a) => [...a])).toEqual([['push', '--quiet', 'origin', `HEAD:${LEDGER_TRANSPORT_BRANCH}`]]);
  });

  it('pushes from the dedicated transport worktree, never from the board checkout it was called with', () => {
    const [push] = calls.filter((a) => a[0] === 'push');
    expect(push.cwd).toMatch(/^\/board\/\.operations\/transport\/wt-/);
    // Every git call that touches refs or the index runs in the worktree too, so the caller's lane is untouched.
    for (const a of calls.filter((x) => ['checkout', 'add', 'commit', 'push'].includes(x[0]))) {
      expect(a.cwd).toMatch(/\/\.operations\/transport\/wt-/);
    }
  });

  it('never invokes a git subcommand that writes a ref other than the transport branch', () => {
    const refWriters = calls.filter((a) => ['push', 'update-ref', 'tag', 'branch', 'symbolic-ref'].includes(a[0]));
    expect(refWriters.map((a) => a[0])).toEqual(['push']);
  });

  it('keeps the transport branch name pinned to the one the workflow listens on', () => {
    expect(LEDGER_TRANSPORT_BRANCH).toBe('ops/review-requests');
  });
});

/**
 * The same containment, from the other side: no OTHER code on the ledger path may push. Scans the static import
 * closure of the ledger io-shell (and the applier's own two scripts) for a git push and pins the per-file count
 * of every push site found. Comments are skipped; a new push anywhere in this closure changes the map.
 */
describe('no other code on the ledger path pushes (C3)', () => {
  const SCRIPTS = join(REPO_ROOT, 'scripts');
  const TRANSPORT = 'scripts/lib/git-transport-branch.mjs';
  // The ledger append's push is the transport's. The other files are in the STATIC import closure only because
  // the verdict-ledger / review-escalation modules import them; they push lane refs, not the transport branch,
  // and are not on the ledger-append call path. They are pinned by count rather than ignored: a NEW push in any
  // file here, or in a file newly pulled into the closure, changes this map and must be reviewed on purpose.
  // (`fix-procedure.mjs` counts three because one hit is the `cmd === 'push'` CLI verb, not a git call.)
  const KNOWN_PUSH_SITES = {
    [TRANSPORT]: 1,
    'scripts/lib/rebase-drop-manifest.mjs': 1,
    'scripts/lib/nnn-collision-heal.mjs': 1,
    'scripts/conveyor/fix-procedure.mjs': 3,
  };
  const rel = (f) => f.slice(REPO_ROOT.length + 1).split(sep).join('/');

  function closure(roots) {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f) || !existsSync(f)) continue;
      seen.add(f);
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(resolvePath(dirname(f), m[1]));
    }
    return seen;
  }

  const files = closure([join(SCRIPTS, 'lib', 'verdict-ledger-io.mjs')]);
  files.add(join(SCRIPTS, 'apply-review-request.mjs'));
  files.add(join(SCRIPTS, 'collect-review-requests.mjs'));

  const pushSites = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/['"`]push['"`]|\bgit\s+push\b|\bpush\s+(--|origin)/.test(line)) pushSites.push(`${rel(f)}:${i + 1}`);
    });
  }

  it('scans the ledger io-shell and its transport', () => {
    expect([...files].map(rel)).toEqual(expect.arrayContaining([
      'scripts/lib/verdict-ledger-io.mjs', 'scripts/lib/git-transport-branch.mjs',
      'scripts/apply-review-request.mjs', 'scripts/collect-review-requests.mjs',
    ]));
  });

  it('finds exactly the known push sites per file, so a new one cannot appear unnoticed', () => {
    const perFile = {};
    for (const s of pushSites) { const f = s.slice(0, s.lastIndexOf(':')); perFile[f] = (perFile[f] ?? 0) + 1; }
    expect(perFile).toEqual(KNOWN_PUSH_SITES);
  });

  // The spawned child holds the same token as the applier but is reached by `spawnSync`, not an import, so the
  // closure above would never see it. Its OWN source is scanned directly (its static closure is ~190 files of
  // unrelated daemon code, which this test deliberately does not own): it may not push, merge, or write refs or
  // file contents through the GitHub API. Same for the applier, the collector, and the io-shell.
  it('the applier, its spawned child, the collector and the io-shell contain no GitHub write path of their own', () => {
    const writeShape = /\bgit\s+push\b|['"`]push['"`]|['"`]merge['"`]|pr\s+merge\b|\/git\/refs|\/contents\/|\brelease\s+(create|upload)\b|-X\s+(PUT|DELETE|PATCH)\b|--method\s+(PUT|DELETE|PATCH)\b/;
    const direct = ['apply-review-request.mjs', 'review-set-label.mjs', 'collect-review-requests.mjs', join('lib', 'verdict-ledger-io.mjs')];
    const hits = [];
    for (const name of direct) {
      readFileSync(join(SCRIPTS, name), 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (writeShape.test(line)) hits.push(`scripts/${name.split(sep).join('/')}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
