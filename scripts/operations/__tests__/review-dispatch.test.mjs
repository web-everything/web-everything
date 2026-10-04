import { readReviewCiGate } from '../../lib/review-ci-gate-io.mjs';
/**
 * @file review-dispatch.test.mjs — `#3279`: dispatch an independent review to a fresh session.
 *
 * NOTHING HERE SPAWNS A REAL PROCESS: `spawnAgent` is a recorder, `readBrief` is a stub template, and
 * `mintSessionId` is deterministic — so every assertion is about the ARGV and the FILLED PROMPT this operation
 * would actually send, not about `claude` itself (which `dispatch-lane-io.mjs`'s own live-spawn test already
 * covers for the shared `buildAgentArgv`/`defaultSpawnAgent` machinery this file reuses verbatim).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, it, expect, vi } from 'vitest';

import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import {
  assertMainNotStale, canonicalReviewPlaceholder, dispatchReview, fillReviewBrief, formatSessionDispatchResult, isReviewCodePath, planReviewDispatch,
  reviewDispatchDisallowedToolsArgs, reviewSessionSlug, REVIEW_BRIEF_PLACEHOLDERS,
  REVIEW_DISPATCH_DISALLOWED_TOOLS, REVIEW_DISPATCH_SYSTEM_PROMPT_FILE,
  REVIEW_SANDBOX_ROOTS, TOOL_FREE_ONLY_JUDGE_PROVIDERS,
} from '../review-dispatch.mjs';
import { buildReviewJudgeRequest, DEFAULT_LENS } from '../review-pr.mjs';
import { dispatchSessionCwd } from '../dispatch-lane-io.mjs';
import { repoProfile } from '../../lib/repo-profile.mjs';

// Landing-freeze fix (lane-leftover-reclaim) — `we`'s lane-pool `--repo=` value is now ALWAYS an absolute path
// (see `repo-profile.mjs`'s own docblock: the literal `.` broke for a dispatched session, whose cwd is a
// scratch directory outside the checkout, not the checkout itself). Computed once here, from the SAME
// `repoProfile` this file's own code under test calls, rather than re-hardcoded.
const WE_LANE_REPO = repoProfile('we').lanePoolRepo;

// #3433 — the two argv elements every dispatched review session carries, ahead of anything else, so the tests
// below don't hand-duplicate the join.
const DISALLOWED_TOOLS_ARGV = reviewDispatchDisallowedToolsArgs();

// A `checkStaleness` stub that never touches git — every `dispatchReview` test below injects one, so none of
// them depend on real subprocess/network fail-soft behavior for a nonexistent `root`.
const GREEN_CI = () => ({ allowed: true, headSha: 'a'.repeat(40) });
const FRESH = () => ({ fresh: true, behind: 0 });

const REAL_TEMPLATE_STUB = [
  '# brief for {{PR}} in {{REPO}}',
  'acquire: node scripts/lane-pool.mjs acquire --session={{SESSION_SLUG}}',
  'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
].join('\n');

describe('planReviewDispatch', () => {
  it('derives a distinct, review-only session slug', () => {
    expect(planReviewDispatch({ pr: 1234, repo: 'web-everything/web-everything' })).toEqual({
      pr: 1234, repo: 'web-everything/web-everything', repoKey: 'we', laneRepo: WE_LANE_REPO, sessionSlug: 'review-1234',
    });
  });

  it('refuses a non-positive-integer PR', () => {
    expect(() => planReviewDispatch({ pr: 0, repo: 'web-everything/web-everything' })).toThrow(/positive integer/);
    expect(() => planReviewDispatch({ pr: 'abc', repo: 'web-everything/web-everything' })).toThrow(/positive integer/);
    expect(() => planReviewDispatch({ pr: -5, repo: 'web-everything/web-everything' })).toThrow(/positive integer/);
  });

  it('refuses a repo that is not an owner/repo slug', () => {
    expect(() => planReviewDispatch({ pr: 1, repo: 'not-a-slug' })).toThrow(/not a constellation repo/);
    expect(() => planReviewDispatch({ pr: 1, repo: '' })).toThrow(/not a constellation repo/);
  });
});

describe('reviewSessionSlug', () => {
  it('is its own namespace, distinct from dispatch-lane\'s conveyor-<num>/prepare-<num>', () => {
    expect(reviewSessionSlug(42)).toBe('review-42');
  });

  it('refuses an empty PR', () => {
    expect(() => reviewSessionSlug('')).toThrow(/needs a PR number/);
  });
});

describe('fillReviewBrief', () => {
  // #4174 — WE_ROOT joined REVIEW_BRIEF_PLACEHOLDERS; see that export's own comment.
  const values = {
    PR: 1234, REPO: 'web-everything/web-everything', SESSION_SLUG: 'review-1234', JUDGE_PROVIDER: 'claude', LANE_REPO: '.',
    WE_ROOT: '/repo',
  };

  it('substitutes the placeholders the template actually uses, and reports (never refuses) an unrelated '
    + 'bracketed token', () => {
    const { prompt, unknownTokens } = fillReviewBrief(REAL_TEMPLATE_STUB, values);
    expect(prompt).toContain('# brief for 1234 in web-everything/web-everything');
    expect(prompt).toContain('--session=review-1234');
    expect(unknownTokens).toEqual(['{{LIKE_THIS}}']);
  });

  it('refuses an empty template', () => {
    expect(() => fillReviewBrief('', values)).toThrow(/template is empty/);
  });

  it('refuses a missing value', () => {
    expect(() => fillReviewBrief('{{PR}} {{REPO}} {{SESSION_SLUG}}', { PR: 1, REPO: 'web-everything/web-everything' }))
      .toThrow(/no value for the brief placeholder \{\{SESSION_SLUG\}\}/);
  });

  it('refuses a value carrying shell-unsafe characters', () => {
    expect(() => fillReviewBrief('{{PR}} {{REPO}} {{SESSION_SLUG}}', { ...values, REPO: 'o/r; rm -rf /' }))
      .toThrow(/characters the brief cannot carry safely/);
  });

  it('refuses a MISSPELLED placeholder rather than shipping it unfilled', () => {
    expect(() => fillReviewBrief('{{ PR }} {{REPO}} {{SESSION_SLUG}}', values))
      .toThrow(/MISSPELLED placeholder/);
  });

  it('canonicalizes separator/case variants of the three real names', () => {
    expect(canonicalReviewPlaceholder('session_slug')).toBe('SESSION_SLUG');
    expect(canonicalReviewPlaceholder('Session-Slug')).toBe('SESSION_SLUG');
    expect(canonicalReviewPlaceholder('bogus')).toBeNull();
  });

  it('the placeholder roster is exactly PR, REPO, SESSION_SLUG, JUDGE_PROVIDER, LANE_REPO, WE_ROOT (#xqa9ttq / #4174)', () => {
    expect(REVIEW_BRIEF_PLACEHOLDERS).toEqual(['PR', 'REPO', 'SESSION_SLUG', 'JUDGE_PROVIDER', 'LANE_REPO', 'WE_ROOT']);
  });

  it('refuses a missing JUDGE_PROVIDER value exactly like any other declared placeholder (#xqa9ttq)', () => {
    expect(() => fillReviewBrief('{{PR}} {{REPO}} {{SESSION_SLUG}} {{JUDGE_PROVIDER}}', {
      PR: 1, REPO: 'web-everything/web-everything', SESSION_SLUG: 'review-1',
    })).toThrow(/no value for the brief placeholder \{\{JUDGE_PROVIDER\}\}/);
  });
});

describe('dispatchReview — the composition: plan → fill → mint → spawn', () => {
  it('spawns exactly once, with a freshly minted session id and the filled brief as the prompt', () => {
    const calls = [];
    const result = dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
    });

    expect(calls).toHaveLength(1);
    // #4174 — cwd is a scratch directory outside `root`, never `root` itself.
    expect(calls[0].opts).toEqual({ cwd: dispatchSessionCwd('11111111-1111-4111-8111-111111111111', { root: '/repo' }) });
    expect(calls[0].argv).toEqual([
      // #3331 — no `--session-id`: `claude --bg` discards it and assigns its own id.
      '--bg',
      '-n', 'review-1234',
      '--settings', JSON.stringify({ env: { WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } }), // xgqz204 — the worker marker, always
      '--append-system-prompt-file', REVIEW_DISPATCH_SYSTEM_PROMPT_FILE,
      '--effort', 'high', '--model', 'sonnet',
      ...DISALLOWED_TOOLS_ARGV,
      '# brief for 1234 in web-everything/web-everything\n'
      + 'acquire: node scripts/lane-pool.mjs acquire --session=review-1234\n'
      + 'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
    ]);

    expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.sessionSlug).toBe('review-1234');
    expect(result.pr).toBe(1234);
    expect(result.repo).toBe('web-everything/web-everything');
    expect(result.unknownTokens).toEqual(['{{LIKE_THIS}}']);
  });

  it.each([
    [{ careLevel: 'none' }, 'sonnet'],
    [{ careLevel: 'elevated' }, 'sonnet'],
    [{ careLevel: 'high' }, 'opus'],
    [{ escalationReason: ['statute'] }, 'opus'],
    [{ scopePaths: ['docs/agent/platform-decisions.md'] }, 'opus'],
  ])('passes an explicit review model for %j', (signals, model) => {
    const spawnAgent = vi.fn();
    dispatchReview({ ciGate: GREEN_CI, pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB, checkStaleness: FRESH, spawnAgent,
      ensureSessionCwd: d => d, resolveSettingsEnv: () => null,
      isolateSession: () => ({ worktreeSettings: null }), ...signals });
    const argv = spawnAgent.mock.calls[0][0];
    expect(argv.filter(a => a === '--model')).toHaveLength(1);
    expect(argv[argv.indexOf('--model') + 1]).toBe(model);
  });

  // #x8mpubm follow-up (live-caught 2026-09-24, review-2591/2593/2600/2599/2594/2582) — this dispatch NEVER
  // wired the gh-app-shim: `resolveSettingsEnv` was called nowhere and `settingsEnv` was never passed to
  // `buildAgentArgv`, so no review session ever got the App-token shim on PATH by any mechanism at all. This
  // is the regression test for that fix, mirroring dispatch-lane.test.mjs's own #x8mpubm coverage.
  it('#x8mpubm follow-up — resolveSettingsEnv is called with root, and its result reaches buildAgentArgv via settingsEnv', () => {
    const calls = [];
    const resolveSettingsEnv = vi.fn(() => ({ PATH: '/shim:/usr/bin' }));
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
      resolveSettingsEnv,
    });
    expect(resolveSettingsEnv).toHaveBeenCalledTimes(1);
    // #4174 — the session's OWN cwd (a scratch dir, never `root` any more).
    expect(resolveSettingsEnv).toHaveBeenCalledWith(dispatchSessionCwd('11111111-1111-4111-8111-111111111111', { root: '/repo' }));
    expect(calls[0].argv).toContain('--settings');
    expect(calls[0].argv[calls[0].argv.indexOf('--settings') + 1]).toBe(JSON.stringify({ env: { PATH: '/shim:/usr/bin', WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } }));
  });

  it('#x8mpubm follow-up — resolveSettingsEnv returning null (the real default, unconfigured host) emits no --settings at all', () => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
      resolveSettingsEnv: () => null,
    });
    expect(calls[0].argv[calls[0].argv.indexOf('--settings') + 1]).toBe(JSON.stringify({ env: { WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } })); // xgqz204
  });

  it('refuses to dispatch from inside a lane checkout, same guard dispatch-lane-io.mjs uses', () => {
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: 1, repo: 'web-everything/web-everything', root: '/some/path/.lanes/web-everything/lane-3',
      readBrief: () => REAL_TEMPLATE_STUB,
      spawnAgent: () => { throw new Error('must not be called'); },
      checkStaleness: FRESH,
    })).toThrow(/lane/i);
  });

  it('never spawns when the plan itself refuses (bad PR/repo caught before any fs/spawn call)', () => {
    let readBriefCalls = 0;
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: -1, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => { readBriefCalls += 1; return REAL_TEMPLATE_STUB; },
      spawnAgent: () => { throw new Error('must not be called'); },
      checkStaleness: FRESH,
    })).toThrow(/positive integer/);
    expect(readBriefCalls).toBe(0);
  });

  // #xw3k2v9 — PR #1756 review finding: `extraArgs` was accepted and documented as forwarded, but the call to
  // `buildAgentArgv` never referenced it, so any caller-supplied flag (a `--permission-mode`, a `--model`
  // override) was silently dropped. This is the regression test for that fix.
  it('forwards extraArgs to buildAgentArgv, exactly like dispatch-lane-io.mjs does for its own dispatch', () => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      extraArgs: ['--permission-mode', 'plan'],
      checkStaleness: FRESH,
    });
    expect(calls[0].argv).toEqual([
      // #3331 — no `--session-id`: `claude --bg` discards it and assigns its own id.
      '--bg',
      '-n', 'review-1234',
      '--settings', JSON.stringify({ env: { WE_CONVEYOR_WORKER: '1' }, worktree: { bgIsolation: 'none' } }), // xgqz204 — the worker marker, always
      '--append-system-prompt-file', REVIEW_DISPATCH_SYSTEM_PROMPT_FILE,
      '--effort', 'high', '--model', 'sonnet',
      ...DISALLOWED_TOOLS_ARGV,
      '--permission-mode', 'plan',
      '# brief for 1234 in web-everything/web-everything\n'
      + 'acquire: node scripts/lane-pool.mjs acquire --session=review-1234\n'
      + 'this brief documents {{LIKE_THIS}} as an example convention, not a real token',
    ]);
  });

  // #xy8di3v — extending #3418/#xqyyoje's static system-prompt fix to review-dispatch: live-confirmed
  // 2026-09-07, review-1998/2024/2027 each read a genuinely, correctly instantiated brief and wrongly
  // concluded they'd been handed a raw template — see we:backlog/3606-*.md. Pin the argv shape directly, the
  // same way dispatch-lane-io.test.mjs pins it for the build-dispatch side.
  it('#xy8di3v — always passes REVIEW_DISPATCH_SYSTEM_PROMPT_FILE via --append-system-prompt-file, ahead of '
    + 'the disallowed-tools deny list and any extraArgs', () => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
    });
    const promptFileIdx = calls[0].argv.indexOf('--append-system-prompt-file');
    expect(promptFileIdx).toBeGreaterThan(-1);
    expect(calls[0].argv[promptFileIdx + 1]).toBe(REVIEW_DISPATCH_SYSTEM_PROMPT_FILE);
    const disallowedIdx = calls[0].argv.findIndex((a) => a.startsWith('--disallowedTools='));
    expect(disallowedIdx).toBeGreaterThan(promptFileIdx);
  });
});

// #xqa9ttq — the dispatched session's OWN `review-loop-cli.mjs` invocation (brief step 2) is the seam that
// carries an opt-in Codex judge provider selection out to the dispatcher-shaped "fix-dispatch path" #3581's
// ratified sequencing names — NOT a tool-bearing dispatch of Codex itself (see `dispatchReview`'s own header
// note on what this does and does not do).
describe('dispatchReview — judgeProvider (#xqa9ttq)', () => {
  const JUDGE_PROVIDER_TEMPLATE = [
    '# brief for {{PR}} in {{REPO}}',
    'run: node scripts/operations/review-loop-cli.mjs --pr={{PR}} --repo={{REPO}} --provider={{JUDGE_PROVIDER}}',
  ].join('\n');

  it('defaults to claude when omitted — additive, never a default flip', () => {
    const calls = [];
    const result = dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => JUDGE_PROVIDER_TEMPLATE,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
    });
    expect(result.judgeProvider).toBe('claude');
    expect(calls[0].argv.at(-1)).toContain('--provider=claude');
  });

  it('refuses judgeProvider \'codex\' BEFORE reading the brief or spawning - review-pr\'s judge steps are tool-bearing (PR #2115 review)', () => {
    let readBriefCalls = 0;
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => { readBriefCalls += 1; return JUDGE_PROVIDER_TEMPLATE; },
      spawnAgent: () => { throw new Error('must not be called'); },
      checkStaleness: FRESH,
      judgeProvider: 'codex',
    })).toThrow(/TOOL-FREE-only/);
    expect(readBriefCalls).toBe(0);
  });

  it('premise pin: review-pr\'s REAL judge request is tool-bearing, which is why codex is refused (fails if review-pr ever grows a tool-free-only roster)', () => {
    const read = {
      repo: 'web-everything/web-everything', pr: 1, title: 't', body: '', netChangedFiles: ['a.mjs'], diffText: 'diff',
    };
    const request = buildReviewJudgeRequest({ read, lens: DEFAULT_LENS });
    expect(Array.isArray(request.allowedTools) && request.allowedTools.length > 0).toBe(true);
    expect(TOOL_FREE_ONLY_JUDGE_PROVIDERS).toEqual(['codex']);
  });

  it('refuses an unrecognised provider name BEFORE reading the brief or spawning', () => {
    let readBriefCalls = 0;
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => { readBriefCalls += 1; return JUDGE_PROVIDER_TEMPLATE; },
      spawnAgent: () => { throw new Error('must not be called'); },
      checkStaleness: FRESH,
      judgeProvider: 'gemini',
    })).toThrow(/judgeProvider.*must be one of claude\|codex/);
    expect(readBriefCalls).toBe(0);
  });
});

// #3433 — PR #1756 r1's residual: nothing technically restricted a dispatched review session's tools, so a
// prompt-injection payload in the reviewed diff could in principle talk it into merging the PR it is reviewing,
// or clearing the `review:human` park on it, directly. These prove the deny list is real, is baked in
// unconditionally (not opt-in), and covers every script that can reach either.
describe('REVIEW_DISPATCH_DISALLOWED_TOOLS (#3433)', () => {
  // r1 (this item's own step-6 adversarial pass): denying only `Bash(gh pr merge:*)` still left `gh pr edit
  // --add-label review:accepted --remove-label review:human` and `gh api repos/*/pulls/*/merge -X PUT` open —
  // the same two outcomes under a different verb. Denying `gh` wholesale is what actually closes both.
  it('denies the WHOLE gh CLI — not just `gh pr merge` (r1: a label-edit or gh api call reaches the same '
    + 'outcomes under a different verb)', () => {
    expect(REVIEW_DISPATCH_DISALLOWED_TOOLS).toContain('Bash(gh:*)');
    expect(REVIEW_DISPATCH_DISALLOWED_TOOLS).not.toContain('Bash(gh pr merge:*)');
  });

  it('denies every script that can reach the review:human --to=clear-human ceremony', () => {
    expect(REVIEW_DISPATCH_DISALLOWED_TOOLS).toContain('Bash(node scripts/review-set-label.mjs:*)');
    expect(REVIEW_DISPATCH_DISALLOWED_TOOLS).toContain('Bash(node scripts/apply-review-request.mjs:*)');
    expect(REVIEW_DISPATCH_DISALLOWED_TOOLS).toContain('Bash(node scripts/operations/run.mjs:*)');
  });

  // r2 (this item's own SECOND adversarial pass, verified against the real `claude` binary): a `['--disallowedTools',
  // '<joined>']` TWO-element form still gets eaten whole by the variadic parser — the joined value AND the
  // prompt right after it both get consumed as "tool patterns", and the dispatched session starts with NO
  // prompt at all. Only a single `--disallowedTools=<joined>` element is safe. This must stay exactly ONE argv
  // element, or every dispatched review silently no-ops.
  it('reviewDispatchDisallowedToolsArgs returns exactly ONE `=`-joined argv element, never a separate flag+value '
    + 'pair (r2: a variadic CLI option eats the prompt that follows a two-element form)', () => {
    expect(DISALLOWED_TOOLS_ARGV).toEqual([
      `--disallowedTools=${REVIEW_DISPATCH_DISALLOWED_TOOLS.join(',')}`,
    ]);
    expect(DISALLOWED_TOOLS_ARGV).toHaveLength(1);
    expect(DISALLOWED_TOOLS_ARGV[0]).not.toBe('--disallowedTools');
  });

  it('the deny list is baked in even when the caller supplies NO extraArgs at all — not opt-in', () => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
    });
    expect(calls[0].argv).toEqual(expect.arrayContaining(DISALLOWED_TOOLS_ARGV));
  });

  it('keeps the deny list before caller-supplied extraArgs', () => {
    const spawnAgent = vi.fn();
    dispatchReview({ ciGate: GREEN_CI, pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB, spawnAgent, checkStaleness: FRESH,
      extraArgs: ['--permission-mode', 'plan'] });
    const argv = spawnAgent.mock.calls[0][0];
    const denyIndex = argv.findIndex(a => a.startsWith('--disallowedTools='));
    expect(denyIndex).toBeGreaterThan(-1);
    expect(argv.indexOf('--permission-mode')).toBeGreaterThan(denyIndex);
  });

  it('refuses an ambient model override rather than bypassing review risk routing', () => {
    const spawnAgent = vi.fn();
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB, spawnAgent,
      extraArgs: ['--model', 'opus'], checkStaleness: FRESH,
    })).toThrow(/hand-set --model/);
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});

// #3439 — a dispatched review spawns with its own `cwd`-relative import path, so a dispatching checkout N
// commits behind origin/main silently runs pre-fix code with no error. These prove the refusal is real.
describe('assertMainNotStale', () => {
  it('passes through a fresh checkout untouched', () => {
    expect(assertMainNotStale('/repo', FRESH)).toEqual({ fresh: true, behind: 0 });
  });

  it('refuses a checkout N commits behind origin/main, naming the count', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', behind: 12, ahead: 0, dirty: false, warning: 'stub' })))
      .toThrow(/12 commit\(s\) behind origin\/main/);
  });

  it('refuses a DIVERGED checkout the same way — being behind at all is disqualifying, not just non-fast-forwardable', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', behind: 3, ahead: 2, dirty: false, warning: 'stub' })))
      .toThrow(/3 commit\(s\) behind/);
  });

  it('does not refuse when the staleness check is offline (fail-soft, matching main-staleness.mjs itself)', () => {
    expect(assertMainNotStale('/repo', () => ({ offline: true }))).toEqual({ offline: true });
  });

  // #3637 — a checkout sitting on a POC branch is behind `origin/main` BY CONSTRUCTION, so the question this
  // guard asks has to be "behind its own delivery target", not "behind main".
  it('measures staleness against a NAMED base, and says which one it meant', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', behind: 7, ahead: 0, dirty: false, warning: 'stub' }), { base: 'lane/mechanical-dispatcher' }))
      .toThrow(/7 commit\(s\) behind origin\/lane\/mechanical-dispatcher/);
  });

  it('defaults to main, so every pre-#3637 caller is byte-identical', () => {
    expect(() => assertMainNotStale('/repo', () => ({ action: 'warn', behind: 1, ahead: 0, dirty: false, warning: 'stub' })))
      .toThrow(/behind origin\/main/);
    expect(assertMainNotStale('/repo', FRESH)).toEqual({ fresh: true, behind: 0 });
  });

  // ── #3474 — the REAL mechanism: a temp git repo with a bare origin, no mocked git. ────────────────────────────
  // A dispatching checkout that is merely behind, with a clean tree, is fast-forwarded (zero judgment); anything
  // that is not a mechanical fast-forward still refuses, and the refusal must not have touched the checkout.
  describe('#3474 — auto-sync a clean fast-forward, on a real repo with a bare origin', () => {
    const dirs = [];
    // each test builds 1–2 real repos (a dozen git spawns) — well inside the default 5s alone, but a loaded host is not.
    vi.setConfig({ testTimeout: 30_000 });
    afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    const git = (cwd, ...args) => execFileSync('git', [
      '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args,
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, 'commit', '-m', `edit ${file}`); };

    /** origin (bare) ← pusher; `checkout` is a clone of origin taken at C1, then the pusher lands 2 more commits
     *  so the checkout is exactly 2 behind origin/main by the time the guard fetches. */
    function behindFixture() {
      const dir = mkdtempSync(join(tmpdir(), 'rd-stale-'));
      dirs.push(dir);
      const origin = join(dir, 'origin.git');
      const pusher = join(dir, 'pusher');
      const checkout = join(dir, 'checkout');
      git(dir, 'init', '--bare', '-b', 'main', origin);
      git(dir, 'init', '-b', 'main', pusher);
      git(pusher, 'remote', 'add', 'origin', origin);
      commit(pusher, 'tracked.txt', 'one\n');
      git(pusher, 'push', 'origin', 'main');
      git(dir, 'clone', origin, checkout);
      commit(pusher, 'landed-a.txt', 'a\n');
      commit(pusher, 'landed-b.txt', 'b\n');
      git(pusher, 'push', 'origin', 'main');
      return { dir, origin, pusher, checkout, originHead: git(pusher, 'rev-parse', 'HEAD') };
    }

    it('(a) behind + clean → no throw, fast-forwards, HEAD equals origin/main, dispatch proceeds', () => {
      const { checkout, originHead } = behindFixture();
      const note = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(git(checkout, 'rev-parse', 'HEAD')).not.toBe(originHead);

      const st = assertMainNotStale(checkout);

      expect(st).toMatchObject({ synced: true, behind: 2, to: originHead });
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(originHead);
      expect(git(checkout, 'status', '--porcelain')).toBe('');
      expect(note).toHaveBeenCalledWith(expect.stringMatching(/fast-forwarded .* 2 commit\(s\) to origin\/main/));
      // ...and a second call is now simply fresh — the sync was real, not remembered.
      expect(assertMainNotStale(checkout)).toEqual({ fresh: true, behind: 0 });
    });

    it('(b) behind + DIVERGED (local commit ahead) → still throws, HEAD untouched, message names the divergence', () => {
      const { checkout, originHead } = behindFixture();
      commit(checkout, 'local-only.txt', 'mine\n');
      const headBefore = git(checkout, 'rev-parse', 'HEAD');

      let err;
      try { assertMainNotStale(checkout); } catch (e) { err = e; }

      expect(err?.message).toMatch(/2 commit\(s\) behind origin\/main/);
      expect(err.message).toMatch(/DIVERGED \(1 local commit\(s\) ahead of origin\/main\)/);
      expect(err.message).toMatch(/#3439/);
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(headBefore).not.toBe(originHead);
    });

    it('(c) behind + DIRTY tree → still throws, auto-sync NOT attempted: HEAD, the dirty file and the stash are untouched', () => {
      const { checkout, originHead } = behindFixture();
      writeFileSync(join(checkout, 'tracked.txt'), 'one\nuncommitted edit\n');
      const headBefore = git(checkout, 'rev-parse', 'HEAD');

      let err;
      try { assertMainNotStale(checkout); } catch (e) { err = e; }

      expect(err?.message).toMatch(/2 commit\(s\) behind origin\/main/);
      expect(err.message).toMatch(/uncommitted changes, so the automatic fast-forward was NOT attempted/);
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
      expect(headBefore).not.toBe(originHead);
      expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('one\nuncommitted edit\n');
      expect(git(checkout, 'status', '--porcelain')).toBe('M tracked.txt');
      expect(git(checkout, 'stash', 'list')).toBe(''); // no --autostash round-trip either
    });

    it('an UNTRACKED file also counts as a dirty tree (nothing is fast-forwarded over it)', () => {
      const { checkout } = behindFixture();
      writeFileSync(join(checkout, 'scratch.txt'), 'x\n');
      const headBefore = git(checkout, 'rev-parse', 'HEAD');
      expect(() => assertMainNotStale(checkout)).toThrow(/uncommitted changes/);
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
    });

    it('a fetch failure / offline stays fail-soft — no throw, nothing touched', () => {
      const { dir, checkout } = behindFixture();
      git(checkout, 'remote', 'set-url', 'origin', join(dir, 'no-such-origin.git'));
      const headBefore = git(checkout, 'rev-parse', 'HEAD');
      expect(assertMainNotStale(checkout)).toEqual({ offline: true });
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
    });

    it('reconcile-fix-dispatch gets the same behaviour through the same function (no per-caller copy)', () => {
      const stubs = { reconcile: () => ({ dispatch: [], refusals: [], notes: [] }), pickFreeLanes: () => [], loadItems: () => [] };

      const clean = behindFixture();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(() => runReconcileFixDispatch({ root: clean.checkout, ...stubs })).not.toThrow();
      expect(git(clean.checkout, 'rev-parse', 'HEAD')).toBe(clean.originHead);

      const dirty = behindFixture();
      writeFileSync(join(dirty.checkout, 'tracked.txt'), 'edited\n');
      const headBefore = git(dirty.checkout, 'rev-parse', 'HEAD');
      expect(() => runReconcileFixDispatch({ root: dirty.checkout, ...stubs })).toThrow(/uncommitted changes/);
      expect(git(dirty.checkout, 'rev-parse', 'HEAD')).toBe(headBefore);
    });
  });
});

describe('dispatchReview — refuses to spawn from a stale checkout (#3439)', () => {
  it('refuses before reading the brief or spawning, when behind origin/main', () => {
    let readBriefCalls = 0;
    expect(() => dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => { readBriefCalls += 1; return REAL_TEMPLATE_STUB; },
      spawnAgent: () => { throw new Error('must not be called'); },
      checkStaleness: () => ({ action: 'warn', behind: 9, ahead: 0, dirty: false, warning: 'stub' }),
    })).toThrow(/9 commit\(s\) behind origin\/main/);
    expect(readBriefCalls).toBe(0);
  });

  it('proceeds to spawn when the checkout is fresh', () => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      checkStaleness: FRESH,
    });
    expect(calls).toHaveLength(1);
  });
});

// ── #4387 — a managed clone refuses only when the commits it is behind touch the review code path ─────────────

describe('isReviewCodePath (#4387)', () => {
  it('names the review operation, its adapter, the judge/jury/review libs, and the guard itself', () => {
    expect([
      'scripts/operations/review-pr.mjs', 'scripts/operations/review-dispatch.mjs', 'scripts/operations/cli-adapter.mjs',
      'scripts/operations/review-loop-cli.mjs', 'scripts/lib/judge-spawn.mjs', 'scripts/lib/jury-core.mjs',
      'scripts/lib/codex-judge-spawn.mjs', 'scripts/lib/review-policy.contract.json', 'scripts/lib/main-staleness.mjs',
    ].every(isReviewCodePath)).toBe(true);
  });
  it('rejects unrelated code, backlog cards, nested dirs, and non-strings', () => {
    expect([
      'scripts/backlog/frontmatter.mjs', 'scripts/lane-pool.mjs', 'backlog/4387-review.md',
      'scripts/lib/__tests__/review-core.test.mjs', 'docs/review/x.mjs', '', null, undefined,
    ].some(isReviewCodePath)).toBe(false);
  });
  // PR #2916 review: the dispatcher's own direct imports (provider routing, session isolation, the gh shim in
  // dispatch-lane-io) were left off the path, so a clone behind only in those files dispatched with stale
  // sandbox code. Fail closed: a new relative import of any review entry file reddens this until it is listed.
  it('covers every relative import of the review entry files (fail closed on a new import)', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const entries = [
      'scripts/operations/review-dispatch.mjs', 'scripts/operations/review-pr.mjs',
      'scripts/operations/cli-adapter.mjs', 'scripts/operations/review-loop-cli.mjs',
      'scripts/operations/review-job.mjs',
    ];
    const missing = [];
    for (const entry of entries) {
      const src = readFileSync(join(repoRoot, entry), 'utf8');
      for (const m of src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const target = posix.normalize(posix.join(posix.dirname(entry), m[1]));
        if (!isReviewCodePath(target)) missing.push(`${entry} → ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
  // PR #2916 review, round 2: the credential sandbox sits one import deeper than the entry files (dispatch-lane-io
  // → gh-app-shim; review-core → mandate-fence; judge-spawn → session-role), so direct imports alone missed it.
  it('puts the sandbox modules\' deeper imports on the path (PR #2916 review, round 2)', () => {
    expect([
      'scripts/lib/gh-app-shim.mjs', 'scripts/lib/github-app-auth-env.mjs', 'scripts/operations/session-role.mjs',
      'scripts/lib/spawn-to-completion.mjs', 'scripts/lib/gh-throttle.mjs', 'scripts/lib/mandate-fence.mjs',
      'scripts/lib/dispatch-contracts.mjs', 'scripts/operations/detached-dispatch.mjs',
      'scripts/operations/dispatch-lane.mjs', 'scripts/lib/github-app-token.mjs', 'scripts/lib/secret-scrub.mjs',
      'scripts/guard-lane.mjs', 'scripts/lib/atomic-json-file.mjs',
    ].filter((f) => !isReviewCodePath(f))).toEqual([]);
  });
  // A renamed or deleted root would silently drop out of the closure (collectImportClosure skips it).
  it('every sandbox root exists in the tree', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(REVIEW_SANDBOX_ROOTS.filter((f) => !existsSync(join(repoRoot, f)))).toEqual([]);
  });
  it('fails closed when the sandbox closure is unknown or incomplete', () => {
    for (const closure of [null, { files: new Set(), complete: false, bareDeps: false, jsonNames: new Set() }]) {
      expect(isReviewCodePath('scripts/lane-pool.mjs', { closure })).toBe(true);
      expect(isReviewCodePath('backlog/4387-review.md', { closure })).toBe(false);
    }
  });
});

describe('dispatchReview — managed clone behind origin/main (#4387)', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`);
  };
  function behindClone(...behindFiles) {
    dir = mkdtempSync(join(tmpdir(), 'review-dispatch-4387-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'clone');
    for (const f of behindFiles) commit(up, f, 'two\n');
    git(up, 'push', '-q', 'origin', 'main');
    return join(dir, 'clone');
  }
  const run = (root) => {
    const calls = [];
    dispatchReview({ ciGate: GREEN_CI,
      pr: 1234, repo: 'web-everything/web-everything', root, home: '/home/test', checkoutExists: () => true,
      readBrief: () => REAL_TEMPLATE_STUB, mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: (argv, opts) => { calls.push({ argv, opts }); return ''; },
      resolveSettingsEnv: () => ({}), sessionCwdFor: () => join(dir, 'session'), ensureSessionCwd: () => {},
      isolateSession: () => ({}),
    });
    return calls;
  };
  let prevEnv;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE; else process.env.WE_DAEMON_MANAGED_CLONE = prevEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const managed = () => { prevEnv = process.env.WE_DAEMON_MANAGED_CLONE; process.env.WE_DAEMON_MANAGED_CLONE = '1'; };

  it('behind only in code OFF the review path: the review dispatches (before #4387: refused)', () => {
    const root = behindClone('scripts/backlog/frontmatter.mjs', 'scripts/lane-pool.mjs', 'backlog/1-card.md');
    managed();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(run(root)).toHaveLength(1);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/3 commit\(s\) behind origin\/main .*scripts\/backlog\/frontmatter\.mjs.*tolerating the lag/);
    } finally { stderr.mockRestore(); }
    expect(git(root, 'rev-list', '--count', 'HEAD..origin/main').trim()).toBe('3'); // the clone is never moved
  });

  it('behind in a review-path file: still refuses, before spawning', () => {
    const root = behindClone('scripts/lane-pool.mjs', 'scripts/operations/review-pr.mjs');
    managed();
    expect(() => run(root)).toThrow(/2 commit\(s\) behind origin\/main.*STALE code from this checkout/s);
  });

  it('behind only in the dispatcher\'s sandbox/routing imports: still refuses (PR #2916 review)', () => {
    const root = behindClone('scripts/operations/dispatch-lane-io.mjs', 'scripts/lib/dispatch-bg-isolation.mjs');
    managed();
    expect(() => run(root)).toThrow(/2 commit\(s\) behind origin\/main.*STALE code from this checkout/s);
  });

  it('behind only in the credential sandbox (gh-app-shim, mandate-fence): still refuses (PR #2916 review, round 2)', () => {
    const root = behindClone('scripts/lib/gh-app-shim.mjs', 'scripts/lib/mandate-fence.mjs');
    managed();
    expect(() => run(root)).toThrow(/2 commit\(s\) behind origin\/main.*STALE code from this checkout/s);
  });
});

// ── #3331 — the id this operation REPORTS has to be the one that addresses the session ────────────────────────

describe('#3331 — dispatchReview reports the id `claude --bg` assigned, not the uuid it minted', () => {
  /** Verbatim the first line CLI 2.1.269 prints on stdout for a `--bg` spawn. */
  const BANNER = (id) => `backgrounded \u00b7 ${id} \u00b7 review-1234\n  claude agents             list sessions\n`;

  it('returns `agentId` parsed off the spawn\'s stdout', () => {
    // The bug this pins: `claude --bg` discards `--session-id` and assigns its own id, so the minted uuid
    // this operation used to print named NO session. `claude agents --json | grep <uuid>` was always empty and
    // no transcript existed under it, which is why a dispatch that had in fact run a full review to an accept
    // verdict (live: review-2129) read to every operator as a silent failure.
    const result = dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: () => BANNER('91035f2f'),
      checkStaleness: FRESH,
    });
    expect(result.agentId).toBe('91035f2f');
    // The minted id is still returned, so an existing caller reading `sessionId` sees the documented shape —
    // it is simply no longer the thing that addresses the session.
    expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('reports `agentId: null` rather than a fabricated one when the banner cannot be read', () => {
    const result = dispatchReview({ ciGate: GREEN_CI,
      pr: 1234,
      repo: 'web-everything/web-everything',
      root: '/repo',
      readBrief: () => REAL_TEMPLATE_STUB,
      mintSessionId: () => '11111111-1111-4111-8111-111111111111',
      spawnAgent: () => '',
      checkStaleness: FRESH,
    });
    expect(result.agentId).toBeNull();
  });
});

it('plans tagged sibling reviews and rejects unknown owner slugs', () => {
  expect(planReviewDispatch({ pr: 49, repo: 'frontier-ui/frontierui', home: '/home/test', checkoutExists: () => true })).toEqual({ pr: 49, repo: 'frontier-ui/frontierui', repoKey: 'frontierui', laneRepo: '/home/test/workspace/frontierui', sessionSlug: 'review-fui-49' });
  expect(() => planReviewDispatch({ pr: 49, repo: 'other/repo' })).toThrow(/not a constellation repo/);
});

it('fills the real brief with the selected repo pool on acquire and release', async () => {
  const { readFileSync } = await import('node:fs');
  const template = readFileSync('skills-src/review/review-agent-brief.md', 'utf8');
  for (const [repo, laneRepo, sessionSlug] of [
    ['we', WE_LANE_REPO, 'review-49'], ['frontierui', '/home/test/workspace/frontierui', 'review-fui-49'],
  ]) {
    const result = dispatchReview({ ciGate: GREEN_CI, pr: 49, repo, root: '/repo', home: '/home/test', checkoutExists: () => true,
      checkStaleness: FRESH, readBrief: () => template, spawnAgent: () => '', mintSessionId: () => 'session',
    });
    expect(result.sessionSlug).toBe(sessionSlug);
    // #4174 — the acquire line is now `node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire …`, absolute-path
    // qualified (the closing quote lands right before `acquire`).
    expect(result.prompt).toContain(`lane-pool.mjs" acquire --repo=${laneRepo}`);
    expect(result.prompt).toContain(`lane-pool.mjs release --all-pools --session=${sessionSlug}`);
    expect(result.unknownTokens).not.toContain('{{LANE_REPO}}');
  }
});

it('refuses a missing foreign checkout before spawning', () => {
  const calls = [];
  const options = { pr: 49, repo: 'plateau-app', home: '/missing', checkoutExists: () => false };
  expect(() => planReviewDispatch(options)).toThrow(/unsupported-repo.*plateau-app.*\/missing\/workspace\/plateau-app/);
  expect(() => dispatchReview({ ciGate: GREEN_CI, ...options, root: '/repo', checkStaleness: FRESH, spawnAgent: (...args) => calls.push(args) })).toThrow(/unsupported-repo/);
  expect(calls).toEqual([]);
  expect(() => fillReviewBrief('{{lane-repo}}', {
    PR: 49, REPO: 'plateauapp/plateau-app', SESSION_SLUG: 'review-pa-49', JUDGE_PROVIDER: 'claude',
    LANE_REPO: '/home/test/workspace/plateau-app', WE_ROOT: '/repo',
  })).toThrow(/MISSPELLED/);
});

describe('x6n7c2p required checks before review — fresh dispatch boundary', () => {
  it.each(['pending', 'red', 'missing', 'head-moved', 'stale-cache', 'fallback', 'error', 'green'])('stale green plan, fresh %s', state => {
    const reads = [];
    const headSha = 'a'.repeat(40);
    let headReads = 0;
    let spawns = 0;
    let sessionWrites = 0;
    const ciGate = ({ repo, pr }) => readReviewCiGate({ repo, pr,
      readHead: args => { reads.push(['head', args]); return state === 'head-moved' && headReads++ ? 'b'.repeat(40) : headSha; },
      readRequired: args => { reads.push(['required', args]); return { source: ['stale-cache', 'fallback'].includes(state) ? state : 'live', checks: ['test', 'daemon-soak'] }; },
      readChecks: args => {
        reads.push(['checks', args]);
        if (state === 'error') throw new Error('offline');
        return [{ name: 'test', status: 'completed', conclusion: 'success' },
          ...(state === 'missing' ? [] : [{ name: 'daemon-soak', status: state === 'pending' ? 'in_progress' : 'completed', conclusion: state === 'red' ? 'failure' : 'success' }])];
      },
    });
    const out = dispatchReview({ pr: 3432, repo: 'web-everything/web-everything', root: '/repo', ciGate,
      checkStaleness: FRESH, readBrief: () => 'review {{PR}}', mintSessionId: () => 'ci-regression',
      ensureSessionCwd: path => { sessionWrites++; return path; }, resolveSettingsEnv: () => ({}),
      isolateSession: () => ({ worktreeSettings: {} }), spawnAgent: () => { spawns++; return ''; } });
    expect(sessionWrites).toBe(state === 'green' ? 1 : 0);
    expect(spawns).toBe(state === 'green' ? 1 : 0);
    expect(Boolean(out.skipped)).toBe(state !== 'green');
    expect(reads[0]).toEqual(['head', { repo: 'web-everything/web-everything', pr: 3432 }]);
    expect(reads[1]).toEqual(['required', { repo: 'web-everything/web-everything', ttlMs: 0 }]);
    if (!['stale-cache', 'fallback'].includes(state)) expect(reads[2]).toEqual(['checks', { repo: 'web-everything/web-everything', headSha }]);
    if (state !== 'green') expect(out.headSha).toBe(headSha);
  });
});

describe('x6n7c2p session-mode CLI report for a skipped dispatch', () => {
  it('reports a CI-refused (skipped) result as not started instead of reading launch fields off it', () => {
    const skipped = { pr: 3432, repo: 'web-everything/web-everything', headSha: 'a'.repeat(40), skipped: 'review-ci: required-checks-not-successful', ci: { allowed: false } };
    expect(formatSessionDispatchResult(skipped)).toBe('dispatch-review: web-everything/web-everything#3432 not started — review-ci: required-checks-not-successful\n');
  });
  it('still reports a launched session with its id and unknown tokens', () => {
    const out = formatSessionDispatchResult({ agentId: 'ag1', sessionSlug: 'review-1', pr: 7, repo: 'o/r', judgeProvider: 'claude', unknownTokens: ['X'] });
    expect(out).toContain('started agent ag1 (slug review-1) reviewing o/r#7');
    expect(out).toContain('unrecognized brief tokens (reported, not fatal): X');
  });
});
