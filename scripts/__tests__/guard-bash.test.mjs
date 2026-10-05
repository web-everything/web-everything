/**
 * @file guard-bash.test.mjs — proof of the PreToolUse(Bash) banned-command table, focused on the #2203
 *   strict lane-only enforcement: a DIRECT push to `main` is blocked, a `lane/*` push is allowed, and the
 *   sanctioned `MAIN_PUSH_OK=1` escape passes through. The stdin/JSON I/O is the boundary; `decide` is pure.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  decide, reason, isBacklogMutation, isPrimaryCwd, isLaneCwd, resolveEffectiveCwd,
  siblingLaneLeases,
  laneRootFromCwd, isDestructiveLaneGitOp, hasDestructiveLaneOp, canonicalGitOp,
  isVerificationRun, isBackgrounded, backgroundedVerificationReason, dispatchedAgentVerificationReason,
  isHeavyRawRun, isAdmittedWrapperRun, admittedVitestWatchReason,
  isDirectTaskInvocation, backgroundedDirectTaskReason,
  usageReportSecretReadReason,
  isTruncatedOperationJson, truncatedOperationJsonReason,
  isTreeWritingBuildRun, isGeneratorScriptRun, isFileWriteRedirect, primaryTreeWriteReason,
  daemonCloneWriteReason,
  mainSessionDelegateNudge, hasLeadingEnvEscape, canonicalCommand, shellTokens, stripHeredocBodies,
  splitSegments, runnerInvocation, parseSegments, unparseableReason, heredocScan,
  nestedCommandStrings, fileWriteTargets, collateralStepsNotice, mergeBreakGlassUsed,
  rawHeavyCommandReason, vitestRunFileTargetCount,
} from '../guard-bash.mjs';
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// xxna58l (#3383) — the raw-heavy-command arm (a raw eleventy/vitest/playwright invocation reached directly,
// or through this file's own nested-command extraction) denies a raw command for an UNRELATED reason (it
// skips the #3461 admission queue) than every arm that predates it. Older corpora asserting "always allowed"
// or "untouched in a lane" for a raw command never anticipated this new denial, so both this predicate and the
// exclusion pattern it powers are shared module-wide rather than re-derived per describe block.
const isRawHeavyVerdict = (verdict) => /heavy-enforce|heavy-command admission queue|bare FULL-SUITE unit run/.test(String(verdict || ''));
/** xpnhz4o — the bare full-suite deny specifically. */
const isFullSuiteVerdict = (verdict) => /bare FULL-SUITE unit run/.test(String(verdict || ''));

describe('guard-bash — backgrounded direct tasks are denied (#3383)', () => {
  it('isDirectTaskInvocation matches either exact script operand, not a mention or a different script', () => {
    for (const command of [
      'node scripts/codex-direct-task.mjs',
      'node scripts/codex-direct-task.mjs --task="x"',
      'node scripts/gemini-direct-task.mjs',
      'node scripts/gemini-direct-task.mjs --task="x" --dir=/tmp/work',
      'node /absolute/path/scripts/codex-direct-task.mjs --task="x"',
      'node "/absolute/path with spaces/gemini-direct-task.mjs" --task="x"',
      'cd /tmp && node scripts/codex-direct-task.mjs',
      'nohup node scripts/codex-direct-task.mjs',
    ]) expect(isDirectTaskInvocation(command), command).toBe(true);
    for (const command of [
      'node scripts/codex-judge-spawn.mjs --task="x"',
      'node scripts/my-codex-direct-task.mjs',
      'node scripts/codex-direct-task.mjs.bak',
      'node scripts/other.mjs scripts/codex-direct-task.mjs',
      'echo "node scripts/codex-direct-task.mjs --task=x"',
      '# node scripts/gemini-direct-task.mjs --task=x',
      'echo done # node scripts/codex-direct-task.mjs',
      'cat <<\'EOF\'\nnode scripts/codex-direct-task.mjs\nEOF',
    ]) expect(isDirectTaskInvocation(command), command).toBe(false);
  });
  it('backgroundedDirectTaskReason fires only when BOTH a direct task AND backgrounded', () => {
    for (const script of ['codex', 'gemini']) {
      const command = `node scripts/${script}-direct-task.mjs --task="x"`;
      expect(backgroundedDirectTaskReason(command, true)).toMatch(/SYNCHRONOUS/);
      for (const background of [`${command} &`, `nohup ${command}`, `setsid ${command}`, `${command}; disown`]) {
        expect(backgroundedDirectTaskReason(background)).toMatch(/FOREGROUND/);
      }
      expect(backgroundedDirectTaskReason(command)).toBeNull();
      expect(backgroundedDirectTaskReason(command, false)).toBeNull();
      expect(backgroundedDirectTaskReason(`${command} > log 2>&1 && echo done`)).toBeNull();
      expect(backgroundedDirectTaskReason(`${command} &> log || echo failed`)).toBeNull();
    }
    expect(backgroundedDirectTaskReason('sleep 60 &')).toBeNull();
    expect(backgroundedDirectTaskReason('npm run dev &')).toBeNull();
    expect(backgroundedDirectTaskReason('node scripts/codex-judge-spawn.mjs', true)).toBeNull();
  });
  it('decide denies the tool-param and shell-background forms and allows foreground', () => {
    const command = 'node scripts/codex-direct-task.mjs --task="x"';
    expect(decide(command, { runInBackground: true })).toMatch(/FOREGROUND/);
    expect(decide('node scripts/gemini-direct-task.mjs --task="x" &')).toMatch(/SYNCHRONOUS/);
    expect(decide(command)).toBeNull();
    expect(decide('node scripts/gemini-direct-task.mjs --task="x"')).toBeNull();
  });
});

describe('guard-bash — backgrounded verification is denied (#2833 finding 3)', () => {
  it('isVerificationRun matches the verification set (verify-lane / check:standards / test:unit), not a mention', () => {
    expect(isVerificationRun('node scripts/verify-lane.mjs --gate="npm run check:standards"')).toBe(true);
    expect(isVerificationRun('npm run check:standards')).toBe(true);
    expect(isVerificationRun('npm run test:unit')).toBe(true);
    expect(isVerificationRun('npm test')).toBe(true);
    expect(isVerificationRun('pnpm run test:unit')).toBe(true);
    // a mere mention is not a run
    expect(isVerificationRun('echo "run check:standards later"')).toBe(false);
    expect(isVerificationRun('grep check:standards docs/x.md')).toBe(false);
    expect(isVerificationRun('git commit -m "wire verify-lane"')).toBe(false);
  });
  it('isBackgrounded: run_in_background param, a trailing &, and nohup/setsid/disown — but NOT && / redirections', () => {
    expect(isBackgrounded('npm run check:standards', true)).toBe(true);          // the Bash tool param
    expect(isBackgrounded('npm run check:standards &')).toBe(true);              // shell background operator
    expect(isBackgrounded('nohup npm run test:unit')).toBe(true);
    expect(isBackgrounded('setsid npm test')).toBe(true);
    expect(isBackgrounded('npm run check:standards && echo done')).toBe(false);  // logical AND, not backgrounding
    expect(isBackgrounded('npm run test:unit > log 2>&1')).toBe(false);          // fd redirection, not backgrounding
    expect(isBackgrounded('npm run check:standards')).toBe(false);               // plain foreground
  });
  it('backgroundedVerificationReason fires only when BOTH a verification run AND backgrounded', () => {
    expect(backgroundedVerificationReason('npm run check:standards', true)).toMatch(/SYNCHRONOUSLY in the FOREGROUND/);
    expect(backgroundedVerificationReason('node scripts/verify-lane.mjs &')).toMatch(/#2833 subagent stall/);
    // a foreground verification run → allowed
    expect(backgroundedVerificationReason('npm run check:standards')).toBeNull();
    expect(backgroundedVerificationReason('npm run check:standards', false)).toBeNull();
    // a backgrounded NON-verification command → not our concern
    expect(backgroundedVerificationReason('npm run dev &')).toBeNull();
    expect(backgroundedVerificationReason('sleep 60 &', true)).toBeNull();
  });
  it('decide denies a backgrounded verification run (via the run_in_background ctx) and allows the foreground form', () => {
    expect(decide('npm run check:standards', { runInBackground: true })).toMatch(/never backgrounded/);
    expect(decide('node scripts/verify-lane.mjs --gate="npm run test:unit" &')).toMatch(/never backgrounded/);
    expect(decide('npm run check:standards', { runInBackground: false })).toBeNull();
    expect(decide('npm run check:standards')).toBeNull();
  });
});

describe('guard-bash — the raw heavy spellings join the verification set (xaipsbs)', () => {
  const RAW = [
    'npx vitest run',
    'npx vitest run scripts/__tests__/guard-bash.test.mjs',
    'npx vitest related scripts/guard-bash.mjs --run',
    'npx --yes vitest run',
    './node_modules/.bin/vitest run',
    'npm run verify',
    'node scripts/check-standards.mjs',
    'node scripts/check-standards.mjs --json',
    'npx playwright test',
    'npx playwright test tests/a11y',
    'cd /x/.lanes/web-everything/lane-3 && npx vitest run a.test.mjs',
  ];
  const NOT = [
    'npx vitest --version',
    'npx vitest',                                    // watch mode, not a one-shot run
    'git commit -m "npx vitest run"',
    'grep -rn "npx vitest run" scripts',
    'grep -rn "node scripts/check-standards.mjs" docs',
    'echo npx playwright test',
    'npm run verify-lane',
    'npx playwright install',
    'cat <<EOF\nnpx vitest run\nEOF',
  ];
  it.each(RAW)('matches the raw run %j', (c) => {
    expect(isHeavyRawRun(c)).toBe(true);
    expect(isVerificationRun(c)).toBe(true);
  });
  it.each(NOT)('does not match the mention / non-run %j', (c) => {
    expect(isHeavyRawRun(c)).toBe(false);
    expect(isVerificationRun(c)).toBe(false);
  });
  it('a dispatched agent is denied each raw spelling, and the message names the admitted wrapper and verify-lane', () => {
    for (const c of RAW) {
      const r = dispatchedAgentVerificationReason(c, 'build');
      expect(r).toMatch(/mechanically-dispatched build agent/);
      expect(r).toContain('node scripts/readiness/heavy-admission.mjs run -- <cmd>');
      expect(r).toContain('node scripts/verify-lane.mjs request');
    }
  });
  it('the admitted wrapper form of a targeted vitest run is NOT denied to a dispatched agent', () => {
    const c = 'node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs';
    expect(isAdmittedWrapperRun(c)).toBe(true);
    expect(isHeavyRawRun(c)).toBe(false);
    expect(dispatchedAgentVerificationReason(c, 'build')).toBeNull();
  });
  // #4294 — the generic delivery brief's mid-work check uses `vitest related`, not `vitest run`; prove the
  // same admitted-wrapper exemption holds for that spelling too, for every dispatch kind a delivery agent
  // can carry (never just 'build').
  it('the admitted wrapper form of a targeted `vitest related` is NOT denied to a dispatched agent, any kind', () => {
    const c = 'node scripts/readiness/heavy-admission.mjs run -- npx vitest related scripts/guard-bash.mjs scripts/lib/verify-lane-gate.mjs --run --passWithNoTests';
    expect(isAdmittedWrapperRun(c)).toBe(true);
    expect(isHeavyRawRun(c)).toBe(false);
    for (const kind of ['build', 'fix', 'ci-heal']) {
      expect(dispatchedAgentVerificationReason(c, kind)).toBeNull();
    }
  });
  it('an interactive session requires admission for heavy runs and may not background verification', () => {
    // xxna58l (#3383) — a subset of RAW is now ALSO denied in the foreground, for the unrelated reason that it
    // skips the #3461 admission queue entirely (a raw whole-suite `vitest run`, or any raw `playwright test`
    // — see the dedicated xxna58l describe block below). That is a NEW, deliberate exception to this test's
    // own "foreground raw run is never denied" invariant, not a regression in it — xaipsbs never had to
    // consider that a raw run could ALSO bypass the capacity cap. Excluded here via `decide()`'s own verdict,
    // never a hand-maintained list.
    for (const c of RAW) {
      if (isRawHeavyVerdict(decide(c))) continue;
      expect(decide(c)).toBeNull();
      expect(dispatchedAgentVerificationReason(c, null)).toBeNull();
      expect(backgroundedVerificationReason(c, true)).toMatch(/never backgrounded/);
      expect(backgroundedVerificationReason(`${c} &`)).toMatch(/never backgrounded/);
    }
    expect(backgroundedVerificationReason('node scripts/readiness/heavy-admission.mjs run -- npx vitest run', true)).toMatch(/never backgrounded/);
    // xpnhz4o — the wrapped WHOLE-suite run is now denied in the foreground too (bare full suite); a wrapped
    // targeted run is still allowed.
    expect(decide('node scripts/readiness/heavy-admission.mjs run -- npx vitest run')).toMatch(/bare FULL-SUITE/);
    expect(decide('node scripts/readiness/heavy-admission.mjs run -- npx vitest run a.test.mjs')).toBeNull();
  });
  it('xxna58l (#3383): the RAW entries it denies in the foreground are denied for the admission-queue reason specifically, and backgrounding them is STILL separately refused too', () => {
    const nowDeniedInForeground = RAW.filter((c) => isRawHeavyVerdict(decide(c)));
    expect(nowDeniedInForeground).toEqual([
      'npx vitest run',
      'npx vitest run scripts/__tests__/guard-bash.test.mjs',
      'npx vitest related scripts/guard-bash.mjs --run',
      'npx --yes vitest run', './node_modules/.bin/vitest run',
      'node scripts/check-standards.mjs', 'node scripts/check-standards.mjs --json',
      'npx playwright test', 'npx playwright test tests/a11y',
      'cd /x/.lanes/web-everything/lane-3 && npx vitest run a.test.mjs',
    ]);
    for (const c of nowDeniedInForeground) {
      // xpnhz4o — a whole-suite `vitest run` now hits the bare-full-suite arm (which names the diff-selected
      // gate); playwright keeps the admission-queue message.
      expect(decide(c)).toMatch(isFullSuiteVerdict(decide(c)) ? /verify-lane\.mjs run/ : /heavy-enforce|heavy-admission\.mjs run/);
      expect(backgroundedVerificationReason(c, true)).toMatch(/never backgrounded/); // still ALSO true
    }
  });
  it('a mention is still allowed when backgrounded — it is not a run', () => {
    for (const c of NOT) expect(backgroundedVerificationReason(c, true)).toBeNull();
  });
});

describe('guard-bash — a dispatched agent may never reference the usage-report external admin-key location (#3383)', () => {
  it('denies a Bash segment naming the external secret directory, for ANY dispatch kind', () => {
    expect(usageReportSecretReadReason('cat ~/.we-usage-report/.env', 'build')).toMatch(/usage-report tool's external admin-key location/);
    expect(usageReportSecretReadReason('cat ~/.we-usage-report/.env', 'delivery')).toMatch(/#3383/);
    expect(usageReportSecretReadReason('ls -la ~/.we-usage-report', 'fix')).toMatch(/#3383/);
  });
  it('denies a Bash segment naming the resolved absolute secret directory too, not just the ~/ spelling', () => {
    const abs = `${homedir()}/.we-usage-report/.env`;
    expect(usageReportSecretReadReason(`cat ${abs}`, 'build')).toMatch(/#3383/);
  });
  it('denies a Bash segment querying the Keychain service by name', () => {
    expect(usageReportSecretReadReason("security find-generic-password -s we-usage-report -a anthropic-admin-key -w", 'build'))
      .toMatch(/#3383/);
  });
  it('never fires for an interactive (non-dispatched) session — the operator is the sanctioned caller of that tool', () => {
    expect(usageReportSecretReadReason('cat ~/.we-usage-report/.env', null)).toBeNull();
    expect(usageReportSecretReadReason('cat ~/.we-usage-report/.env', undefined)).toBeNull();
    expect(usageReportSecretReadReason('cat ~/.we-usage-report/.env', '')).toBeNull();
    expect(usageReportSecretReadReason('node scripts/usage-report/usage-report.mjs', null)).toBeNull();
  });
  it('never fires for an unrelated command, dispatched or not', () => {
    expect(usageReportSecretReadReason('npm run check:standards', 'build')).toBeNull();
    expect(usageReportSecretReadReason('cat ~/.other-tool/.env', 'build')).toBeNull();
  });
  // PR #2570 review — every spelling below still resolves to the real secret (macOS APFS is case-insensitive;
  // the shell removes quotes/backslashes and expands globs/variables before `cat` ever sees the path), and each
  // one returned null before this block existed.
  it.each([
    ['case flip (APFS resolves it to the same file)', 'cat ~/.WE-USAGE-REPORT/.env'],
    ['case flip, absolute spelling', `cat ${homedir()}/.We-Usage-Report/.env`],
    ['case flip on the Keychain service name', 'security find-generic-password -s WE-USAGE-REPORT -w'],
    ['backslash-escaped hyphen', 'cat ~/.we\\-usage\\-report/.env'],
    ['quote-split name', "cat ~/.we'-usage'-report/.env"],
    ['variable-split name', 'cat ~/.${P1}-${P2}/.env'],
    ['variable-split name under $HOME', 'cat $HOME/.${P1}-report/.env'],
    ['whole component held in a variable', 'cat "$HOME/$D/.env"'],
    ['command-substituted (e.g. base64-decoded) name', 'cat ~/.$(echo d2UtdXNhZ2UtcmVwb3J0 | base64 -d)/.env'],
    ['glob under $HOME', 'cat $HOME/.w*-usage-report/.env'],
    ['glob under ${HOME}', 'ls ${HOME}/.we-usage-*'],
    ['character-class glob', 'cat ~/.[w]e-usage-report/.env'],
    ['glob outside a home-rooted path (after `cd ~`)', 'cat .we-us?ge-rep*/.env'],
    ['brace expansion', 'cat ~/.we-usage-{report,x}/.env'],
    ['glob split by a quoted literal', "cat ~/.we'-'usage-rep*/.env"],
    ['empty first component', 'cat ~//$D/.env'],
    ['dot first component', 'cat ~/./$D/.env'],
    ['expansion after `..`', 'cat ~/x/../$D/.env'],
    ['parameter-expansion HOME', 'cat ${HOME%/}/.$D/.env'],
    ['default-valued HOME', 'cat ${HOME:-/x}/.$D/.env'],
    ['Keychain service name in a variable', 'security find-generic-password -s "$S" -w'],
    ['Keychain service name built from a variable', 'security find-generic-password -s ${A}-report -w'],
    ['Keychain dump', 'security dump-keychain -d'],
    ['leading `]` in a bracket class', 'cat ~/.[]w]e-usage-report/.env'],
    ['POSIX character class', 'cat ~/.we-usage-rep[[:alpha:]]rt/.env'],
    ['sequence brace', 'cat ~/.we-usage-r{e..e}port/.env'],
  ])('denies an obfuscated spelling of the secret location — %s', (_label, cmd) => {
    expect(usageReportSecretReadReason(cmd, 'build'), cmd).toMatch(/#3383/);
    expect(decide(cmd, { dispatchKind: 'delivery' }), cmd).toMatch(/#3383/);
  });
  it('does not over-block ordinary home-rooted or globbed commands a dispatched agent legitimately runs', () => {
    for (const cmd of [
      'ls ~/.claude/jobs',
      'cat $HOME/.npmrc',
      'ls scripts/*.mjs',
      'cat ./.env.example',
      'ls .github/*',
      'echo $HOME',
      'node scripts/usage-report/usage-report.mjs --help',
      // quoted regexes are never globbed by the shell, so `.*` inside them is not a dotfile glob
      "rg 'import .* from' src",
      "grep -E 'TODO: .*' -r scripts",
      "rg -n 'describe\\(.*'",
      "grep -oE '(.*)' x",
      "find . -type f -not -path '*/.*'",
      "sed 's/.*//' f",
      'rg "a.*b" src',
      'echo \\.\\*',
      'security find-generic-password -s other-tool -w',
      // a `~` inside a word is not a home root; a dotfile glob below some other dir cannot reach home
      'git show HEAD~1:src/$F',
      'git diff HEAD~2/$x',
      'cp -r src/.* dst',
    ]) {
      expect(usageReportSecretReadReason(cmd, 'build'), cmd).toBeNull();
      expect(String(decide(cmd, { dispatchKind: 'build' }) ?? ''), cmd).not.toMatch(/#3383/);
    }
  });
  it('stays linear on hostile wildcard runs (the hook runs on every dispatched Bash call)', () => {
    for (const cmd of [
      `cat ~/.${'*'.repeat(3000)}x`,
      `cat .${'*a'.repeat(1500)}x`,
      `cat .${'?*'.repeat(1500)}x`,
      `cat .${'{a,b}'.repeat(40)}x`,
      `.{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}[${'[:'.repeat(110)} `.repeat(40),
      `.[${'[:'.repeat(120)} `.repeat(400),
      '~'.repeat(100000),
      '${HOME'.repeat(16666),
    ]) {
      const start = performance.now();
      usageReportSecretReadReason(cmd, 'build');
      expect(performance.now() - start, cmd.slice(0, 20)).toBeLessThan(250);
    }
  });
  it('is wired into reason()/decide() so a real dispatched Bash call is actually denied end to end', () => {
    expect(reason('cat ~/.we-usage-report/.env', { dispatchKind: 'build' })).toMatch(/#3383/);
    expect(decide('cat ~/.we-usage-report/.env', { dispatchKind: 'delivery' })).toMatch(/#3383/);
    expect(decide('cat ~/.we-usage-report/.env')).toBeNull(); // no dispatchKind ⇒ interactive session ⇒ allowed
  });
});

describe('guard-bash — a dispatched agent may not run the gate directly, only request/check it (#3105)', () => {
  it('dispatchedAgentVerificationReason fires for a dispatched agent, foreground or background alike', () => {
    expect(dispatchedAgentVerificationReason('npm run check:standards', 'build')).toMatch(/mechanically-dispatched build agent/);
    expect(dispatchedAgentVerificationReason('npm run test:unit', 'fix')).toMatch(/mechanically-dispatched fix agent/);
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs --gate=true', 'ci-heal')).toMatch(/mechanically-dispatched ci-heal agent/);
  });
  it("the fix/ci-heal briefs' request/check gate shape is permitted; run, quoted-path and wrapped run stay denied (#4369)", () => {
    const permitted = [
      'node /we/scripts/verify-lane.mjs request --repo=.',
      'node /we/scripts/verify-lane.mjs check --wait=60000 --json --repo=.',
    ];
    const denied = [
      'node /we/scripts/verify-lane.mjs run --repo=.',
      'node "/we/scripts/verify-lane.mjs" request --repo=.',
      'node /we/scripts/readiness/heavy-admission.mjs run -- node /we/scripts/verify-lane.mjs run --repo=.',
    ];
    for (const kind of ['fix', 'ci-heal']) {
      for (const c of permitted) {
        expect(dispatchedAgentVerificationReason(c, kind)).toBeNull();
        expect(decide(c, { dispatchKind: kind })).toBeNull();
      }
      for (const c of denied) expect(dispatchedAgentVerificationReason(c, kind)).not.toBeNull();
    }
  });
  it('never fires for an interactive (non-dispatched) session — no WE_DISPATCH_KIND', () => {
    expect(dispatchedAgentVerificationReason('npm run check:standards', null)).toBeNull();
    expect(dispatchedAgentVerificationReason('npm run check:standards', undefined)).toBeNull();
    expect(dispatchedAgentVerificationReason('npm run check:standards', '')).toBeNull();
  });
  it('never fires for a non-verification command, dispatched or not', () => {
    expect(dispatchedAgentVerificationReason('npm run dev', 'build')).toBeNull();
    expect(dispatchedAgentVerificationReason('git status', 'build')).toBeNull();
  });
  it('allows the sanctioned request/check/reset queries even for a dispatched agent — the whole point of #3105', () => {
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs request', 'build')).toBeNull();
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs check', 'build')).toBeNull();
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs check --require-verified', 'fix')).toBeNull();
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs reset', 'ci-heal')).toBeNull();
  });
  it('#4358 — `check --wait=<ms>` (a FLAG on the same sanctioned `check` subcommand) is allowed too, any spelling', () => {
    // SANCTIONED_VERIFY_LANE_QUERY matches on the subcommand WORD, not what follows it, so adding a flag to an
    // already-allowed subcommand needed no guard change — pinned here as a regression test, not just prose.
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs check --wait=60000', 'delivery')).toBeNull();
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs check --wait=60000 --json', 'delivery')).toBeNull();
    expect(dispatchedAgentVerificationReason('node we:scripts/verify-lane.mjs check --wait=90000', 'delivery')).toBeNull();
  });
  it('a bare (default-mode) verify-lane.mjs invocation still denies — only request/check/reset are exempt', () => {
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs', 'build')).toMatch(/#3105/);
    expect(dispatchedAgentVerificationReason('node scripts/verify-lane.mjs --gate="npm run test:unit"', 'build')).toMatch(/#3105/);
  });
  it('the declared run.mjs verify operation is caught too — it shells the same synchronous suite run', () => {
    expect(isVerificationRun('node scripts/operations/run.mjs verify --checkout="$PWD" --json')).toBe(true);
    expect(dispatchedAgentVerificationReason('node scripts/operations/run.mjs verify --checkout="$PWD" --json', 'build')).toMatch(/#3105/);
    expect(backgroundedVerificationReason('node scripts/operations/run.mjs verify --checkout="$PWD" &')).toMatch(/#2833 subagent stall/);
  });
  it('decide denies via the dispatchKind ctx and allows the identical command with no ctx (operator session)', () => {
    expect(decide('npm run check:standards', { dispatchKind: 'build' })).toMatch(/mechanically-dispatched/);
    expect(decide('npm run check:standards', {})).toBeNull();
    expect(decide('npm run check:standards')).toBeNull();
    // the sanctioned query still passes even under a dispatched ctx
    expect(decide('node scripts/verify-lane.mjs check', { dispatchKind: 'build' })).toBeNull();
  });
});

describe('guard-bash — primary-cwd backlog-mutation block (#2302)', () => {
  const P = ['/ws/webeverything', '/ws/frontierui'];
  it('isBacklogMutation matches EVERY item-mutation verb (incl. release/cost), not the session-state verbs', () => {
    for (const v of ['claim', 'resolve', 'release', 'scaffold', 'settle', 'retype', 'yield', 'cost', 'prepare-stamp'])
      expect(isBacklogMutation(`node scripts/backlog.mjs ${v} 2279`)).toBe(true);
    for (const v of ['reserve', 'unreserve', 'queue', 'unqueue', 'calibrate', 'prepare-hold', 'prepare-release']) // don't touch an item .md → not blocked
      expect(isBacklogMutation(`node scripts/backlog.mjs ${v} 2279 --session=s`)).toBe(false);
    expect(isBacklogMutation('echo backlog.mjs claim 1')).toBe(false); // a mention, not a `node` invocation
  });
  it('isPrimaryCwd: a primary root is primary, a lane clone is not', () => {
    expect(isPrimaryCwd('/ws/webeverything', P)).toBe(true);
    expect(isPrimaryCwd('/ws/webeverything/scripts', P)).toBe(true);
    expect(isPrimaryCwd('/ws/.lanes/pipeline-2302/lane-1', P)).toBe(false); // lane clone → allowed
    expect(isPrimaryCwd('/ws/some-other-repo', P)).toBe(false);
  });
  it('denies a claim/resolve/scaffold ONLY when cwd is primary', () => {
    const cmd = 'node scripts/backlog.mjs resolve 2287';
    expect(reason(cmd, { primaryCwd: true })).toMatch(/must run in a LANE clone/);
    expect(reason(cmd, { primaryCwd: false })).toBeNull();      // in a lane → allowed
    expect(reason(cmd)).toBeNull();                              // default ctx (no cwd known) → allow
  });
  it('release + cost are blocked from primary too (same writeBacklogMd path — #2302 PR review)', () => {
    for (const v of ['release', 'cost']) {
      expect(reason(`node scripts/backlog.mjs ${v} 2287`, { primaryCwd: true })).toMatch(/must run in a LANE clone/);
      expect(reason(`node scripts/backlog.mjs ${v} 2287`, { primaryCwd: false })).toBeNull(); // in a lane → allowed
    }
  });
  it('#2339 — the former BACKLOG_MUTATE_OK=1 override is REMOVED; primary is denied unconditionally, no escape', () => {
    expect(reason('BACKLOG_MUTATE_OK=1 node scripts/backlog.mjs resolve 2287', { primaryCwd: true })).toMatch(/must run in a LANE clone/);
  });
  it('a session-state verb (reserve) is allowed from primary', () => {
    expect(reason('node scripts/backlog.mjs reserve 2279 --session=s', { primaryCwd: true })).toBeNull();
  });
  it('prepare-stamp is blocked from primary (item-file splice); prepare-hold/release are local-only → allowed', () => {
    expect(reason('node scripts/backlog.mjs prepare-stamp 2264', { primaryCwd: true })).toMatch(/must run in a LANE clone/);
    expect(reason('node scripts/backlog.mjs prepare-stamp 2264', { primaryCwd: false })).toBeNull(); // in a lane → allowed
    for (const v of ['prepare-hold', 'prepare-release'])
      expect(reason(`node scripts/backlog.mjs ${v} 2264`, { primaryCwd: true })).toBeNull(); // local token, not a mutation
  });
});

describe('guard-bash — stale-lane backlog-mutation block (#2323)', () => {
  it('isLaneCwd: a `.lanes/` path is a lane clone; a primary or unrelated path is not', () => {
    expect(isLaneCwd('/ws/.lanes/web-everything/lane-1')).toBe(true);
    expect(isLaneCwd('/ws/.lanes/web-everything/lane-12/scripts')).toBe(true);
    expect(isLaneCwd('/ws/webeverything')).toBe(false);
    expect(isLaneCwd('/ws/some-other-repo')).toBe(false);
    expect(isLaneCwd(undefined)).toBe(false);
  });
  it('denies a claim/resolve/scaffold in a lane whose HEAD is behind its upstream', () => {
    const cmd = 'node scripts/backlog.mjs claim 2323';
    expect(reason(cmd, { primaryCwd: false, staleBehind: 19 })).toMatch(/19 commit\(s\) behind origin\/main/);
    expect(reason(cmd, { primaryCwd: false, staleBehind: 1 })).toMatch(/behind origin\/main/);
  });
  it('allows the same mutation once the lane is caught up (staleBehind: 0, the default)', () => {
    expect(reason('node scripts/backlog.mjs claim 2323', { primaryCwd: false, staleBehind: 0 })).toBeNull();
    expect(reason('node scripts/backlog.mjs claim 2323', { primaryCwd: false })).toBeNull(); // default ctx
  });
  it('never fires from a primary cwd — that path is already denied by the #2302 rule instead', () => {
    // primaryCwd:true wins the #2302 message even if a stale count were (incorrectly) supplied.
    expect(reason('node scripts/backlog.mjs claim 2323', { primaryCwd: true, staleBehind: 19 })).toMatch(/must run in a LANE clone/);
  });
  it('does not fire on a non-mutation verb, even when stale', () => {
    expect(reason('node scripts/backlog.mjs reserve 2323 --session=s', { primaryCwd: false, staleBehind: 19 })).toBeNull();
  });
  it('the STALE_LANE_OK=1 override passes a stale-lane mutation through', () => {
    expect(reason('STALE_LANE_OK=1 node scripts/backlog.mjs claim 2323', { primaryCwd: false, staleBehind: 19 })).toBeNull();
  });
});

describe('guard-bash — resolveEffectiveCwd honours a leading `cd` (#2335)', () => {
  const PRIMARY = '/ws/webeverything';
  const LANE = '/ws/.lanes/web-everything/lane-5';

  it('resolves a literal `cd <abs-lane>` regardless of the reported (reset-to-primary) cwd', () => {
    expect(resolveEffectiveCwd(`cd ${LANE} && node scripts/backlog.mjs claim 2335`, PRIMARY)).toBe(LANE);
  });
  it('resolves `cd "$LANE"` against a literal LANE=/abs assignment in the same command (the lane idiom)', () => {
    const cmd = `LANE=${LANE}\ncd "$LANE" && STALE_LANE_OK=1 node scripts/backlog.mjs claim 2335`;
    expect(resolveEffectiveCwd(cmd, PRIMARY)).toBe(LANE);
  });
  it('resolves `cd ${LANE}` brace form too', () => {
    expect(resolveEffectiveCwd(`LANE=${LANE}; cd \${LANE} && ls`, PRIMARY)).toBe(LANE);
  });
  it('falls back to the reported cwd with no cd, or an unresolvable ($VAR unknown / command-subst) target', () => {
    expect(resolveEffectiveCwd('node scripts/backlog.mjs claim 2335', PRIMARY)).toBe(PRIMARY);
    expect(resolveEffectiveCwd('cd "$UNSET" && ls', PRIMARY)).toBe(PRIMARY);
    expect(resolveEffectiveCwd('cd "$(mktemp -d)" && ls', PRIMARY)).toBe(PRIMARY);
  });
  it('a genuine primary mutation (no cd, or cd into the primary) still resolves to the primary → stays denied', () => {
    const P = [PRIMARY];
    const eff1 = resolveEffectiveCwd('node scripts/backlog.mjs resolve 2335', PRIMARY);
    expect(reason('node scripts/backlog.mjs resolve 2335', { primaryCwd: isPrimaryCwd(eff1, P) })).toMatch(/must run in a LANE clone/);
    const eff2 = resolveEffectiveCwd(`cd ${PRIMARY} && node scripts/backlog.mjs resolve 2335`, '/somewhere');
    expect(reason('node scripts/backlog.mjs resolve 2335', { primaryCwd: isPrimaryCwd(eff2, P) })).toMatch(/must run in a LANE clone/);
  });
  it('the lane mutation is ALLOWED once the effective cwd is the lane (no override needed)', () => {
    const eff = resolveEffectiveCwd(`cd ${LANE} && node scripts/backlog.mjs claim 2335`, PRIMARY);
    expect(isPrimaryCwd(eff, [PRIMARY])).toBe(false);
    expect(isLaneCwd(eff)).toBe(true);
    expect(reason('node scripts/backlog.mjs claim 2335', { primaryCwd: false })).toBeNull();
  });
});

describe('guard-bash — foreign-live-lease destructive-op block (#2367)', () => {
  it('laneRootFromCwd: extracts the lane ROOT from cwd at or under it; null off a lane', () => {
    expect(laneRootFromCwd('/ws/.lanes/web-everything/lane-8')).toBe('/ws/.lanes/web-everything/lane-8');
    expect(laneRootFromCwd('/ws/.lanes/web-everything/lane-8/scripts')).toBe('/ws/.lanes/web-everything/lane-8');
    expect(laneRootFromCwd('/ws/.lanes/frontierui/lane-12/src/deep/dir')).toBe('/ws/.lanes/frontierui/lane-12');
    expect(laneRootFromCwd('/ws/webeverything')).toBeNull();
    expect(laneRootFromCwd(undefined)).toBeNull();
  });

  it('isDestructiveLaneGitOp: recognizes reset --hard, clean (any force flag), checkout/restore/switch discard, force-push', () => {
    expect(isDestructiveLaneGitOp('git reset --hard origin/main')).toBe(true);
    expect(isDestructiveLaneGitOp('git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('git reset --soft HEAD~1')).toBe(false);
    expect(isDestructiveLaneGitOp('git clean -fd')).toBe(true);
    expect(isDestructiveLaneGitOp('git clean -df')).toBe(true);
    expect(isDestructiveLaneGitOp('git clean -f -d')).toBe(true);
    expect(isDestructiveLaneGitOp('git clean --force -d')).toBe(true);
    expect(isDestructiveLaneGitOp('git clean -f')).toBe(true);        // #2367 gap — -f alone still DELETES untracked files
    expect(isDestructiveLaneGitOp('git clean -fx')).toBe(true);       // -fx (files + ignored) without -d — still destructive
    expect(isDestructiveLaneGitOp('git clean -n')).toBe(false);       // dry-run, no force → harmless
    expect(isDestructiveLaneGitOp('git clean -n -fd')).toBe(true);    // dry-run flag alongside a force flag — matched (conservative)
    expect(isDestructiveLaneGitOp('git checkout -- .')).toBe(true);
    expect(isDestructiveLaneGitOp('git checkout .')).toBe(true);
    expect(isDestructiveLaneGitOp('git checkout HEAD -- .')).toBe(true);  // #2367 gap — ref before the pathspec
    expect(isDestructiveLaneGitOp('git checkout -f main')).toBe(true);    // #2367 gap — force-checkout discards the tree
    expect(isDestructiveLaneGitOp('git checkout -- src/foo.ts')).toBe(false);
    expect(isDestructiveLaneGitOp('git checkout main')).toBe(false);
    expect(isDestructiveLaneGitOp('git restore .')).toBe(true);          // #2367 gap
    expect(isDestructiveLaneGitOp('git restore --worktree .')).toBe(true);
    expect(isDestructiveLaneGitOp('git restore --staged -- .')).toBe(true);
    expect(isDestructiveLaneGitOp('git restore src/foo.ts')).toBe(false);
    expect(isDestructiveLaneGitOp('git switch -f main')).toBe(true);      // #2367 gap — force-switch discards the tree
    expect(isDestructiveLaneGitOp('git switch --discard-changes main')).toBe(true);
    expect(isDestructiveLaneGitOp('git switch main')).toBe(false);
    expect(isDestructiveLaneGitOp('git push --force origin lane/foo')).toBe(true);
    expect(isDestructiveLaneGitOp('git push -f origin lane/foo')).toBe(true);
    expect(isDestructiveLaneGitOp('git push --force-with-lease origin lane/foo')).toBe(true);
    expect(isDestructiveLaneGitOp('git push origin +main')).toBe(true);          // #2367 gap — +refspec force syntax
    expect(isDestructiveLaneGitOp('git push origin +HEAD:lane/x')).toBe(true);
    expect(isDestructiveLaneGitOp('git push origin lane/foo')).toBe(false);
    expect(isDestructiveLaneGitOp('git status')).toBe(false);
    expect(isDestructiveLaneGitOp('')).toBe(false);
  });

  it('canonicalGitOp / isDestructiveLaneGitOp: matcher-BYPASS forms no longer evade the check (#2367)', () => {
    // path-qualified git
    expect(canonicalGitOp('/usr/bin/git reset --hard')).toBe('git reset --hard');
    expect(isDestructiveLaneGitOp('/usr/bin/git reset --hard')).toBe(true);
    // wrapper commands
    expect(isDestructiveLaneGitOp('env git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('env GIT_PAGER=cat git clean -fd')).toBe(true);
    expect(isDestructiveLaneGitOp('time git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('command git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('xargs git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('xargs -n1 git checkout -- .')).toBe(true);
    // git global flags before the subcommand
    expect(canonicalGitOp('git -C /some/path reset --hard')).toBe('git reset --hard');
    expect(isDestructiveLaneGitOp('git -C /some/path reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('git -c core.pager=cat clean -fd')).toBe(true);
    // leading subshell / brace-group open
    expect(isDestructiveLaneGitOp('(git reset --hard)')).toBe(true);
    expect(isDestructiveLaneGitOp('{ git clean -fd')).toBe(true);
    // r2 — quoted / backslash-escaped git token normalizes to `git`
    expect(canonicalGitOp('"git" reset --hard')).toBe('git reset --hard');
    expect(canonicalGitOp("'git' reset --hard")).toBe('git reset --hard');
    expect(canonicalGitOp('\\git reset --hard')).toBe('git reset --hard');
    expect(isDestructiveLaneGitOp('"git" reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp("'git' clean -fd")).toBe(true);
    expect(isDestructiveLaneGitOp('\\git checkout -- .')).toBe(true);
    // r2 — `sudo [-n] [-u <user>]` prefix peeled off before the git token
    expect(canonicalGitOp('sudo git reset --hard')).toBe('git reset --hard');
    expect(canonicalGitOp('sudo -u deploy git reset --hard')).toBe('git reset --hard');
    expect(canonicalGitOp('sudo -n -u deploy git clean -fd')).toBe('git clean -fd');
    expect(isDestructiveLaneGitOp('sudo -u deploy git reset --hard')).toBe(true);
    expect(isDestructiveLaneGitOp('sudo -n git clean -fd')).toBe(true);
    // r2 — a bare `VAR=val` shell-assignment prefix is peeled too (canonicalGitOp is now self-sufficient)
    expect(canonicalGitOp('FOO=1 git reset --hard')).toBe('git reset --hard');
    expect(isDestructiveLaneGitOp('FOO=1 BAR=2 git reset --hard')).toBe(true);
    // still returns '' / false for non-git
    expect(canonicalGitOp('echo git reset --hard')).toBe('');
    expect(isDestructiveLaneGitOp('echo git reset --hard')).toBe(false);
    // DISMISSED (adversarial-evasion gold-plating, #2367 r2) — advisory guard, accidental-collision threat
    // model, one-env-var escape (LANE_CLOBBER_OK=1); an evader never needs these, so they stay UN-matched.
    expect(canonicalGitOp('git$IFS$9reset --hard')).toBe('');   // IFS word-splitting trick
    expect(canonicalGitOp('$(echo git) reset --hard')).toBe(''); // command substitution
    expect(canonicalGitOp('bash -c "git reset --hard"')).toBe(''); // nested shell
    expect(canonicalGitOp('sh -c "git reset --hard"')).toBe('');
    expect(canonicalGitOp('ssh host git reset --hard')).toBe(''); // remote exec
    expect(isDestructiveLaneGitOp('bash -c "git reset --hard"')).toBe(false);
  });

  it('hasDestructiveLaneOp: true if ANY &&/;/| segment is destructive, honouring env/sudo + bypass normalization', () => {
    expect(hasDestructiveLaneOp('git fetch origin && git reset --hard origin/main')).toBe(true);
    expect(hasDestructiveLaneOp('FOO=1 git reset --hard')).toBe(true);
    expect(hasDestructiveLaneOp('git fetch && /usr/bin/git -C . reset --hard')).toBe(true); // bypass form in a later segment
    expect(hasDestructiveLaneOp('echo x | xargs git clean -fd')).toBe(true);
    expect(hasDestructiveLaneOp('git status && sudo -u deploy git reset --hard')).toBe(true); // r2 — sudo -u form
    expect(hasDestructiveLaneOp('git status; git log')).toBe(false);
    expect(hasDestructiveLaneOp('')).toBe(false);
  });

  it('denies a destructive op only when foreignLiveLease is true, not for own/absent/stale-lease lanes', () => {
    const cmd = 'git reset --hard origin/main';
    expect(reason(cmd, { primaryCwd: false, foreignLiveLease: true })).toMatch(/LIVE lease held by ANOTHER session/);
    expect(reason(cmd, { primaryCwd: false, foreignLiveLease: false })).toBeNull(); // own lane / no live lease
    expect(reason(cmd, { primaryCwd: false })).toBeNull();                          // default ctx
  });

  it('r2 — reason() sees through a sudo/quoted disguise on the destructive op', () => {
    expect(reason('sudo -u deploy git reset --hard origin/main', { primaryCwd: false, foreignLiveLease: true }))
      .toMatch(/LIVE lease held by ANOTHER session/);
    expect(reason('"git" clean -fd', { primaryCwd: false, foreignLiveLease: true }))
      .toMatch(/LIVE lease held by ANOTHER session/);
  });

  it('never fires from a primary cwd (a lane-only concept)', () => {
    expect(reason('git reset --hard', { primaryCwd: true, foreignLiveLease: true })).toBeNull();
  });

  it('does not fire on a non-destructive command, even with a foreign live lease', () => {
    expect(reason('git status', { primaryCwd: false, foreignLiveLease: true })).toBeNull();
    expect(reason('git push origin lane/foo', { primaryCwd: false, foreignLiveLease: true })).toBeNull();
  });

  it('the LANE_CLOBBER_OK=1 override passes a foreign-live-lease destructive op through', () => {
    expect(reason('LANE_CLOBBER_OK=1 git reset --hard', { primaryCwd: false, foreignLiveLease: true })).toBeNull();
    expect(decide('LANE_CLOBBER_OK=1 git clean -fd', { primaryCwd: false, foreignLiveLease: true })).toBeNull();
  });

  it('decide() surfaces the #2367 denial across a full command via ctx', () => {
    expect(decide('git fetch && git reset --hard origin/main', { primaryCwd: false, foreignLiveLease: true }))
      .toMatch(/LIVE lease held by ANOTHER session/);
  });
});

describe('guard-bash — marked (workflow-lane) lease slug-assertion block (#2413)', () => {
  const SLUG = 'batch-x-2427';
  const marked = (over = {}) => ({ primaryCwd: false, markedLeaseSlug: SLUG, ...over });

  it('DENIES a destructive op that does NOT assert the lease slug (fail-closed absence)', () => {
    expect(reason('git reset --hard origin/main', marked())).toMatch(/must ASSERT the lease's own slug/);
    expect(reason('git clean -fd', marked())).toMatch(/LANE_SESSION=batch-x-2427/);
    expect(reason('git checkout -- .', marked())).toMatch(/denied fail-closed/);
  });

  it('DENIES a destructive op that asserts the WRONG slug (fail-closed mismatch)', () => {
    expect(reason('LANE_SESSION=batch-x-9999 git reset --hard origin/main', marked())).toMatch(/a MISMATCH/);
  });

  it('ALLOWS the owning lane\'s own op once it re-asserts the exact slug', () => {
    expect(reason(`LANE_SESSION=${SLUG} git reset --hard origin/main`, marked())).toBeNull();
    expect(reason(`LANE_SESSION=${SLUG} git clean -fd`, marked())).toBeNull();
  });

  it('the marked check SUPERSEDES the #2367 ownerSession fail-open (foreignLiveLease is ignored when marked)', () => {
    // A marked lane with NO assertion is denied even though foreignLiveLease is false (own-lane in the #2367
    // regime would have been ALLOWED) — fail-closed replaces fail-open for marked lanes.
    expect(reason('git reset --hard', marked({ foreignLiveLease: false }))).toMatch(/workflow-lane lease/);
    // And a matching assertion allows it even if foreignLiveLease were true — the marked branch wins first.
    expect(reason(`LANE_SESSION=${SLUG} git reset --hard`, marked({ foreignLiveLease: true }))).toBeNull();
  });

  it('the LANE_CLOBBER_OK=1 escape passes a marked-lane destructive op through (mismatch or absence)', () => {
    expect(reason('LANE_CLOBBER_OK=1 git reset --hard', marked())).toBeNull();
    expect(reason('LANE_CLOBBER_OK=1 LANE_SESSION=wrong git clean -fd', marked())).toBeNull();
  });

  it('never fires on a non-destructive command, even under a marked lease', () => {
    expect(reason('git status', marked())).toBeNull();
    expect(reason('git push origin lane/foo', marked())).toBeNull();
    expect(reason(`node scripts/lane-pool.mjs release --lane=3`, marked())).toBeNull();
  });

  it('never fires from a primary cwd (a lane-only concept)', () => {
    expect(reason('git reset --hard', { primaryCwd: true, markedLeaseSlug: SLUG })).toBeNull();
  });

  it('no marked lease (markedLeaseSlug null) → falls back to the #2367 unmarked regime', () => {
    expect(reason('git reset --hard', { primaryCwd: false, markedLeaseSlug: null, foreignLiveLease: true })).toMatch(/LIVE lease held by ANOTHER session/);
    expect(reason('git reset --hard', { primaryCwd: false, markedLeaseSlug: null, foreignLiveLease: false })).toBeNull();
  });

  it('decide() surfaces the #2413 denial across a &&-chained command (the incident shape)', () => {
    expect(decide('git fetch origin && git reset --hard origin/main', marked())).toMatch(/must ASSERT the lease's own slug/);
    // the same chain, slug asserted on the destructive segment → allowed
    expect(decide(`git fetch origin && LANE_SESSION=${SLUG} git reset --hard origin/main`, marked())).toBeNull();
  });
});

// ── #2997 — the contested-sibling arm, and the repro table it closes ─────────────────────────────────────
describe('guard-bash — contested-sibling lease slug-assertion block (#2997)', () => {
  const HOLDER = 'conveyor-delivery-lane-5-9f3a1c07';
  const contested = (over = {}) => ({ primaryCwd: false, contestedHolderSlug: HOLDER, ...over });

  // THE GAP, as the card's repro table states it. Rows 1–3 are the SHIPPED behaviour verified against
  // #2367/#2413; row 4 is the hole this item closes — an unmarked lease whose ownerSession equals mine
  // because a SIBLING AGENT of my own session holds it, which read as "my own lane" and was ALLOWED.
  it('the 3-row repro table still decides exactly as #2367/#2413 shipped it (no refusal weakened)', () => {
    const cmd = 'git reset --hard HEAD~3';
    // row 1 — unmarked lease, ownerSession OTHER ⇒ DENY (#2367)
    expect(reason(cmd, { primaryCwd: false, foreignLiveLease: true })).toMatch(/LIVE lease held by ANOTHER session/);
    // row 2 — marked workflowLane, no slug asserted ⇒ DENY (#2413)
    expect(reason(cmd, { primaryCwd: false, markedLeaseSlug: 'batch-x-2427' })).toMatch(/workflow-lane lease/);
    // row 3 — unmarked lease, ownerSession MINE, and NO sibling holds a lane ⇒ ALLOW (genuinely my own lane)
    expect(reason(cmd, { primaryCwd: false, foreignLiveLease: false, contestedHolderSlug: null })).toBeNull();
  });

  it('row 4 (THE GAP) — an unmarked lease held by a SIBLING of my own session is now DENIED', () => {
    // Pre-#2997 this ctx produced exactly `null`: ownerSession matched, the lease was unmarked, and the
    // guard had no third signal. The 2026-08-08 `reset --hard` in a same-session sibling's lane is this row.
    expect(reason('git reset --hard HEAD~3', contested())).toMatch(/CONTESTED/);
    expect(reason('git clean -fd', contested())).toMatch(/LANE_SESSION=conveyor-delivery-lane-5-9f3a1c07/);
    expect(reason('git checkout -- .', contested())).toMatch(/denied fail-closed/);
    expect(reason('git push --force origin lane/x', contested())).toMatch(/CONTESTED/);
  });

  it('DENIES a destructive op that asserts the WRONG holder slug (fail-closed mismatch)', () => {
    expect(reason('LANE_SESSION=some-other-lane-3-11112222 git reset --hard', contested())).toMatch(/a MISMATCH/);
  });

  it('ALLOWS the true holder\'s own op once it asserts the exact minted slug', () => {
    expect(reason(`LANE_SESSION=${HOLDER} git reset --hard origin/main`, contested())).toBeNull();
    expect(reason(`LANE_SESSION=${HOLDER} git clean -fd`, contested())).toBeNull();
  });

  it('MUST-ALLOW: an uncontested own lane is completely unaffected — no new friction on the normal flow', () => {
    // The solo topology (one session, one lane) never sets contestedHolderSlug, so every ordinary refresh
    // idiom stays exactly as allowed as it was before #2997.
    const solo = { primaryCwd: false, foreignLiveLease: false, contestedHolderSlug: null };
    expect(reason('git reset --hard origin/main', solo)).toBeNull();
    expect(reason('git clean -fd', solo)).toBeNull();
    expect(decide('git fetch origin -q && git reset --hard origin/main && git clean -fd', solo)).toBeNull();
  });

  it('a MARKED lease keeps #2413 precedence — the contested arm never displaces it', () => {
    // Both signals present: the marked message (and the marked slug) must win, so #2413's refusal is intact.
    const both = { primaryCwd: false, markedLeaseSlug: 'batch-x-2427', contestedHolderSlug: HOLDER };
    expect(reason('git reset --hard', both)).toMatch(/workflow-lane lease/);
    expect(reason(`LANE_SESSION=${HOLDER} git reset --hard`, both)).toMatch(/a MISMATCH/); // holder slug is NOT the marked slug
    expect(reason('LANE_SESSION=batch-x-2427 git reset --hard', both)).toBeNull();
  });

  it('the LANE_CLOBBER_OK=1 escape passes a contested destructive op through (absence or mismatch)', () => {
    expect(reason('LANE_CLOBBER_OK=1 git reset --hard', contested())).toBeNull();
    expect(reason('LANE_CLOBBER_OK=1 LANE_SESSION=wrong git clean -fd', contested())).toBeNull();
  });

  it('never fires on a non-destructive command, nor from a primary cwd', () => {
    expect(reason('git status', contested())).toBeNull();
    expect(reason('git push origin lane/foo', contested())).toBeNull();
    expect(reason('git reset --hard', { primaryCwd: true, contestedHolderSlug: HOLDER })).toBeNull();
  });

  it('decide() surfaces the #2997 denial across a &&-chained command (the real refresh idiom)', () => {
    expect(decide('git fetch origin -q && git reset --hard origin/main', contested())).toMatch(/CONTESTED/);
    expect(decide(`git fetch origin -q && LANE_SESSION=${HOLDER} git reset --hard origin/main`, contested())).toBeNull();
  });
});

// The impure half of the #2997 Bash arm: which OTHER lanes in the pool hold a live lease. Proved against a
// real on-disk pool layout, because that is where the "sibling" set actually comes from.
describe('guard-bash — siblingLaneLeases reads the real pool layout (#2997)', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'guard-bash-pool-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pool = join(root, '.lanes', 'web-everything');
  const NOW = Date.parse('2026-08-14T12:00:00.000Z');
  const writeLease = (n, lease) => {
    mkdirSync(join(pool, `lane-${n}`, '.git'), { recursive: true });
    writeFileSync(join(pool, `lane-${n}`, '.git', '.lane-lease'), JSON.stringify(lease));
  };
  const live = (over) => ({ session: 's', acquiredAt: new Date(NOW - 60_000).toISOString(), ttlMinutes: 240, ...over });

  it('returns every OTHER lane\'s LIVE lease, excluding this lane and any stale one', () => {
    writeLease(3, live({ ownerSession: 'sess-shared', holder: 'h-3' }));                                   // this lane
    writeLease(5, live({ ownerSession: 'sess-shared', holder: 'h-5' }));                                   // live sibling
    writeLease(6, live({ ownerSession: 'sess-other', holder: 'h-6' }));                                    // live, other session
    writeLease(7, { session: 's', acquiredAt: '2020-01-01T00:00:00.000Z', ttlMinutes: 240, holder: 'h-7' }); // STALE
    mkdirSync(join(pool, 'lane-8'), { recursive: true });                                                   // no lease at all

    const got = siblingLaneLeases(join(pool, 'lane-3'), NOW).map((l) => l.holder).sort();
    expect(got).toEqual(['h-5', 'h-6']);
  });

  // r2 (independent review of PR #1234, F3/R2). The first cut scanned only `dirname(laneRoot)` — this lane's
  // OWN pool — so a sibling agent holding a lane in a DIFFERENT pool left nothing to find and the destructive
  // op was allowed. That shape is ordinary, not exotic: a cross-locus couple leases one lane in the
  // web-everything pool and one in the plateau-app pool (the exact case `release --all-pools` exists for), and
  // the ambient session id is precisely as ambiguous across pools as within one.
  it('scans EVERY pool under .lanes/, not just this lane\'s own pool (review F3/R2)', () => {
    const other = join(root, '.lanes', 'plateau-app');
    mkdirSync(join(other, 'lane-2', '.git'), { recursive: true });
    writeFileSync(join(other, 'lane-2', '.git', '.lane-lease'), JSON.stringify(live({ ownerSession: 'sess-shared', holder: 'h-cross' })));
    // A file sitting where a pool would be, and a pool holding a stale lease: neither may throw or leak.
    writeFileSync(join(root, '.lanes', 'not-a-pool'), 'x\n');

    const got = siblingLaneLeases(join(pool, 'lane-3'), NOW).map((l) => l.holder).sort();
    expect(got).toContain('h-cross');
    expect(got).toEqual(['h-5', 'h-6', 'h-cross']);
  });

  it('fails OPEN (empty) on a missing pool — a guard fault must never wedge the agent', () => {
    expect(siblingLaneLeases(join(root, 'nope', 'lane-1'), NOW)).toEqual([]);
  });
});

describe('guard-bash — direct-push-to-main block (#2203)', () => {
  const blocked = (c) => expect(decide(c), c).toMatch(/direct push to `main` is blocked/);
  const allowed = (c) => expect(decide(c), c).toBeNull();

  it('blocks an explicit push to main (bare branch, HEAD:main, refs/heads/main)', () => {
    blocked('git push origin main');
    blocked('git push origin HEAD:main');
    blocked('git push origin HEAD:refs/heads/main');
    blocked('git push origin main:main');
    blocked('git push --force origin main');
  });
  it('blocks a bare push (defaults to the current branch — on the primary that is main)', () => {
    blocked('git push');
    blocked('git push origin');
    blocked('git push --force-with-lease');
  });
  it('ALLOWS a lane/* push (the sanctioned path — PR-gated)', () => {
    allowed('git push origin HEAD:refs/heads/lane/foo-2210');
    allowed('git push origin abc123:refs/heads/lane/batch-x-1');
    allowed('git push origin HEAD:refs/heads/lane/x --force-with-lease');
    allowed('git push origin --delete lane/old'); // deleting a lane ref
  });
  it('the MAIN_PUSH_OK=1 escape passes a main push through (pr-land --fallback-git, emergencies)', () => {
    allowed('MAIN_PUSH_OK=1 git push origin main:main');
    allowed('MAIN_PUSH_OK=1 git push origin HEAD:refs/heads/main');
  });
  it('does not fire on non-push git, or a push MENTIONED in a message', () => {
    allowed('git fetch origin main');
    allowed('git pull --ff-only origin main');
    allowed('git log origin/main');
    allowed('echo "remember to git push origin main"'); // command word is echo, not git
    allowed('git commit -m "wire git push origin main into the drain"');
  });
  it('still enforces the pre-existing rules (regression guard)', () => {
    expect(decide('pkill -f vite')).toMatch(/dev server/);
    expect(decide('git rm backlog/2200-foo.md')).toMatch(/Never delete a backlog/);
    expect(decide('git mv backlog/2200-a.md backlog/2201-a.md')).toMatch(/immutable/);
    expect(reason('sed -i s/x/y/ backlog/2200-a.md')).toMatch(/locus-prefix/);
  });
});

describe('guard-bash — sed/tee/perl backlog|reports write vs. mere-mention (#3390)', () => {
  const denied = (c) => expect(reason(c), c).toMatch(/locus-prefix/);
  const allowed = (c) => expect(reason(c), c).toBeNull();

  it.each([
    "sed -i'' -e 's/x/y/' backlog/a.md",
    'sed -i"" -e \'s/x/y/\' backlog/a.md',
    "perl -0pi -e 's/x/y/' reports/a.md",
    "perl -0pi.bak -e 's/x/y/' reports/a.md",
    '(sed -i s/x/y/ backlog/a.md)',
    '{ sed -i s/x/y/ backlog/a.md; }',
    "sed -n 'w backlog/x.md' f",
    "sed -n 'p;w backlog/x.md' f",
    "sed -n '{w backlog/x.md\n}' f",
    "sed -n '1,/x/w backlog/x.md' f",
    "sed -n '/re/,$w backlog/x.md' f",
    "sed -n '/re/,+2w backlog/x.md' f",
    "sed -n '/re/I w backlog/x.md' f",
  ])('denies the confirmed write regression: %s', (command) => {
    denied(command);
    expect(fileWriteTargets(command).some((path) => /^(backlog|reports)\//.test(path))).toBe(true);
  });

  it.each([
    'grep foo backlog/a.md',
    "sed -n 's/x/y/p' backlog/a.md",
    'cat reports/a.md',
    "(sed -n 's/x/y/p' backlog/a.md)",
    "{ sed -n 'p' reports/a.md; }",
    "perl -0p -e 's/x/y/' reports/a.md",
  ])('allows read-only mentions after the regression fixes: %s', (command) => {
    allowed(command);
    expect(fileWriteTargets(command)).toEqual([]);
  });

  it('still denies a REAL sed/perl in-place edit or tee write into backlog|reports (unchanged from before)', () => {
    denied('sed -i s/x/y/ backlog/2200-a.md');
    denied("sed -i '' s/x/y/ backlog/2200-a.md"); // BSD empty in-place suffix
    denied('sed --in-place s/x/y/ reports/2200-a.md');
    denied("perl -pi -e 's/x/y/' backlog/2200-a.md");
    denied("perl -i -pe 's/x/y/' backlog/2200-a.md");
    denied('tee -a backlog/2200-a.md');
    denied('tee reports/2200-a.md'); // bare tee still WRITES the named file
    denied('echo hi >> backlog/2200-a.md'); // the untouched `>>` half of the OR
    denied('echo hi >> ./reports/2200-a.md');
  });

  it('does NOT deny a READ-ONLY sed/tee/perl invocation that merely MENTIONS a backlog|reports path (#3390 false positive)', () => {
    allowed("sed -n '1,200p' backlog/123-foo.md");
    allowed("sed -n '1,200p' reports/123-foo.md");
    allowed("perl -ne 'print' backlog/123-foo.md");
    allowed("perl -ne 'print if /x/' reports/123-foo.md");
    allowed('tee /tmp/scratch.md < backlog/123-foo.md'); // reads from backlog, writes only to scratch
    allowed("sed 's/x/y/' backlog/123-foo.md"); // no -i at all — prints to stdout, writes nothing
  });

  it('still denies when the write target is backlog|reports even though the READ input is a different path', () => {
    denied('sed -i s/x/y/ /tmp/scratch.md backlog/2200-a.md');
    denied("tee -a backlog/2200-a.md < /tmp/in.txt");
  });

  // Security review on #2108 — sed's `w` write mechanism needs NO `-i`/`--in-place`: a trailing `w <file>`
  // flag on an `s///` command, or a standalone `/addr/w <file>` address-command, both genuinely write
  // `<file>` from the script text alone. Verified directly against real sed: pre-fix, `fileWriteTargets`
  // only ever read ARGV flags (never the script TEXT), so both commands below returned `[]` and were
  // allowed — a real regression the flag-only rewrite introduced while fixing the mere-mention false
  // positive above.
  it('denies a sed `w`-command/`w`-flag write into backlog|reports with NO -i anywhere (#2108 security finding)', () => {
    denied("sed 's/x/y/w backlog/2200-a.md' file.txt");
    denied("sed -n '/pat/w backlog/2200-a.md' file.txt");
  });

  it('does NOT deny a sed `w`-command/`w`-flag write whose target is NOT backlog|reports', () => {
    allowed("sed 's/x/y/w /tmp/scratch.md' file.txt");
    allowed("sed -n '/pat/w /tmp/scratch.md' file.txt");
  });

  // #2108 review r3 — SED_ADDR_W missed a NEGATED address (`/pat/!w file`), GNU's `first~step` address
  // extension (`0~3w file`), and the uppercase `W` command — three more real sed write shapes with no
  // `-i`/`--in-place` anywhere, verified against real sed to genuinely write the named file.
  it('denies a sed address-write via negation, GNU step address, or the uppercase W command (#2108 review r3)', () => {
    denied("sed -n '/pat/!w backlog/2200-a.md' file.txt");
    denied("sed -n '3,5!w backlog/2200-a.md' file.txt");
    denied("sed -n '0~3w backlog/2200-a.md' file.txt");
    denied("sed -n '/pat/W backlog/2200-a.md' file.txt");
  });

  // #2108 review r3 — an earlier GNU-only flag that takes a SEPARATE argument (`-l N`) shifted the
  // no-`-e`/no-`-f` fallback's "first operand" pick onto that consumed numeral instead of the real
  // script, so the actual `w`-write in the script text was never scanned at all.
  it('still finds the sed script (and its w-write) past a preceding arg-taking flag like -l N (#2108 review r3)', () => {
    denied("sed -l 80 's/x/y/w backlog/2200-a.md' file.txt");
  });

  // #2108 review r3 — the deny arm's `atCommand` gate never matched a `gsed` invocation even though
  // fileWriteTargets/sedScriptTexts already support prog === 'gsed' internally — unreachable from here.
  it('denies a gsed in-place write into backlog|reports, matching sed (#2108 review r3 coverage gap)', () => {
    denied('gsed -i s/x/y/ backlog/2200-a.md');
  });

  // PR #2108 review finding (backlog#x7k9gep follow-up): perl script text open() writes into backlog|reports
  it('denies a perl script text open() write into backlog|reports (#2108 review finding)', () => {
    denied('perl -e \'open(F, ">", "backlog/x.md"); print F "x"\'');
    denied('perl -e \'open(my $fh, ">>", "reports/r.md") or die; print $fh 1\'');
    denied('perl -e \'open(F, ">backlog/x.md"); print F 1\'');
    denied("perl -e \"open F, '>>backlog/x.md'\"");
    denied('perl -E \'open(F, ">:utf8", "backlog/x.md")\'');
  });

  it('does NOT deny a perl script that opens for read or merely mentions a backlog|reports path (#2108 review finding)', () => {
    allowed('perl -e \'open(F, "<", "backlog/x.md"); print <F>\'');
    allowed('perl -e \'open(F, "backlog/x.md")\'');
    allowed('perl -e \'print "backlog/x.md"\'');
    allowed('perl -ne \'print\' backlog/1.md');
    allowed('perl -e \'open(F, ">", "/tmp/x.txt")\'');
  });

  it('denies perl -ne and -lane scripts opening backlog|reports for write', () => {
    denied("perl -ne 'open(O, \">>\", \"backlog/x.md\"); print O $_' in.txt");
    denied("perl -lane 'open(O, \">\", \"reports/r.md\")' in.txt");
  });

  it('allows a perl script file or a loop flag without in-place write mentioning backlog', () => {
    allowed('perl backlog/1.md');
    allowed("perl -pe 's/x/y/' backlog/1.md");
  });

  it('fileWriteTargets extracts literal paths from perl open() and returns empty for reads/mentions', () => {
    expect(fileWriteTargets('perl -e \'open(F, ">", "backlog/x.md"); print F "x"\'')).toEqual(['backlog/x.md']);
    expect(fileWriteTargets('perl -e \'open(my $fh, ">>", "reports/r.md") or die; print $fh 1\'')).toEqual(['reports/r.md']);
    expect(fileWriteTargets('perl -e \'open(F, ">backlog/x.md"); print F 1\'')).toEqual(['backlog/x.md']);
    expect(fileWriteTargets("perl -e \"open F, '>>backlog/x.md'\"")).toEqual(['backlog/x.md']);
    expect(fileWriteTargets('perl -E \'open(F, ">:utf8", "backlog/x.md")\'')).toEqual(['backlog/x.md']);

    expect(fileWriteTargets('perl -e \'open(F, "<", "backlog/x.md"); print <F>\'')).toEqual([]);
    expect(fileWriteTargets('perl -e \'open(F, "backlog/x.md")\'')).toEqual([]);
    expect(fileWriteTargets('perl -e \'print "backlog/x.md"\'')).toEqual([]);
    expect(fileWriteTargets('perl -ne \'print\' backlog/1.md')).toEqual([]);
    expect(fileWriteTargets('perl -e \'open(F, ">", "/tmp/x.txt")\'')).toEqual(['/tmp/x.txt']);
  });
});

// #2108 review r4 — table-driven differential coverage. Every command below was DENIED on `main` (the raw
// CORPUS_MD text match) and really writes into backlog|reports, so it must stay denied; the read-only
// twins in the second table must stay allowed (the whole point of #3390).
describe('guard-bash — sed/tee/perl write-shape tables + ReDoS bound (#2108 review r4)', () => {
  const denied = (c) => expect(reason(c), c).toMatch(/locus-prefix/);
  const allowed = (c) => expect(reason(c), c).toBeNull();

  it.each([
    // in-place suffix spellings — the suffix is ANY text glued to `-i`
    'sed -i~ s/x/y/ backlog/a.md',
    'sed -i_bak s/x/y/ backlog/a.md',
    'sed -i.bak.1 s/x/y/ backlog/a.md',
    "sed -i.orig -e 's/x/y/' backlog/a.md",
    'sed -Ei s/x/y/ backlog/a.md',
    'sed -ni s/x/y/p backlog/a.md',
    'gsed -i~ s/x/y/ reports/a.md',
    "perl -i.bak.1 -pe 's/x/y/' backlog/a.md",
    "perl -i~ -pe 's/x/y/' backlog/a.md",
    "perl -0777 -pi -e 's/x/y/' backlog/a.md",
    'tee -p backlog/a.md',
    'tee --output-error=warn backlog/a.md',
  ])('denies an in-place/tee write spelling: %s', denied);

  it.each([
    // sed write shapes the structured scan cannot parse — the fail-closed script-text scan catches them
    "sed -n '\\,a,w reports/x.md' f", // custom-delimiter address
    "sed 's/[/]/b/w reports/x.md' f", // delimiter inside a bracket expression
    "sed -n 's/a/b/gw reports/x.md' f",
    "sed -e'w backlog/x.md' f", // script attached to -e
    "sed -ne'w backlog/x.md' f",
    "sed -n -e p -e'w backlog/x.md' f",
    "sed -n 'y/a/b/;w backlog/x.md' f",
    "sed -n 'e echo hi > backlog/a.md' f", // the `e` command runs a shell
    "sed -i '' 's/x/y/w backlog/a.md' /tmp/scratch.md", // BSD `-i ''`: the script is NOT the empty operand
    "sed -l 80 -n 'w backlog/x.md' f",
  ])('denies a sed script-text write: %s', denied);

  it.each([
    "perl -e'open(F,\">backlog/x.md\")'", // attached -e
    "perl -ne'open(O,\">>backlog/x.md\")' f",
    "perl -e 'system(\"echo hi > backlog/a.md\")'",
    "perl -e 'rename(\"/tmp/x\",\"backlog/a.md\")'",
    "perl -MFile::Copy=cp -e 'cp(\"/tmp/x\",\"backlog/a.md\")'",
    "perl -e '$f=\"backlog/a.md\"; open(F,\">\",$f)'", // path held in a variable
    "perl -e 'open(F,\">\",\"backlog/\".\"x.md\")'", // path built by concatenation
    "perl -e 'open(F,\">\",q(backlog/x.md))'",
    "perl -e 'system(\"cp /tmp/x backlog/a.md\")'",
  ])('denies a perl script-text write the literal-open() scan cannot parse: %s', denied);

  it.each([
    "sed -n 's/backlog\\/x.md/y/' f", // mentions a corpus path in the PATTERN, writes nothing
    "sed -n '/reports\\/x.md/p' f",
    "sed -n 'p' backlog/a.md",
    "sed -ne'p' backlog/a.md",
    "sed -n 's/a/b/w /tmp/scratch.md' backlog/a.md", // w target is scratch; backlog is only READ
    "sed -i '' 's/x/y/' /tmp/scratch.md",
    'sed -i~ s/x/y/ /tmp/scratch.md',
    "perl -Ilib -e 'print 1' backlog/a.md", // `-Ilib` is an include dir, not `-i`
    "perl -Mfeature=say -e 'say 1' backlog/a.md",
    "perl -ne'print' backlog/a.md",
    "perl -e 'open(F,\"<\",\"backlog/x.md\"); print <F>'",
    "perl -e 'print \"see backlog/x.md\"'",
    "perl -e 'open(F,\">\",\"/tmp/x.txt\")'",
    'tee -p /tmp/scratch.md',
  ])('still allows a read-only / scratch-only invocation: %s', allowed);

  it('scans a pathologically long escaped sed script in bounded time (SED_SUB_W was exponential)', () => {
    for (const cmd of [
      `sed 's/${'\\'.repeat(200)}' f`,
      `sed -n 's/${'\\.'.repeat(60)}/x/g' backlog/x.md`,
      `sed -n '/${'\\/'.repeat(200)}' f`,
    ]) {
      const t = performance.now();
      reason(cmd);
      expect(performance.now() - t, cmd.slice(0, 40)).toBeLessThan(250);
    }
  });
});

describe('guard-bash — differential write-shape table (#2108 review r5)', () => {
  const denied = (c) => expect(reason(c), c).toMatch(/locus-prefix/);
  const allowed = (c) => expect(reason(c), c).toBeNull();
  const inPlaceCases = [];
  for (const prog of ['sed', 'gsed', 'perl']) {
    for (const inplace of ['-i', '-i.bak', '-i~', ...(prog === 'perl' ? ['-pi'] : [])]) {
      for (const script of ['-e s/x/y/', '-es/x/y/', '-nes/x/y/', "-e's/x/y/'",
        ...(prog === 'perl' ? [] : ['--expression=s/x/y/'])]) {
        inPlaceCases.push(`${prog} ${inplace} ${script} backlog/a.md`);
      }
      if (prog !== 'perl') {
        for (const script of ['-fx.sed', '-ne s/x/y/', '-nf x.sed', '--file=x.sed', '-es/a/b/ -es/c/d/']) {
          inPlaceCases.push(`${prog} ${inplace} ${script} backlog/a.md`);
        }
      }
    }
  }
  it.each(inPlaceCases)('denies parsed in-place target: %s', denied);
  it.each([
    'perl -pi -es/x/z/ backlog/a.md',
    `perl -pe 'BEGIN{$^I=".bak"}' backlog/a.md`,
    `perl -e 'open(F,">",shift); print F 1' backlog/a.md`,
    `perl -e 'open(F,">",$ARGV[0])' backlog/a.md`,
    `perl -e 'unlink shift' backlog/a.md`,
    `perl -e 'open(F,shift)' '>backlog/a.md'`,
    `perl -e '$INPLACE_EDIT=""' backlog/a.md`,
    `perl -e '$^I=""; @ARGV=("backlog/a.md"); while(<>){s/x/y/; print}'`,
    `perl -e 'unlink "backlog/a.md"'`,
    `perl -e 'chmod 0644, "backlog/a.md"'`,
    `perl -e 'truncate("backlog/a.md",0)'`,
    `perl -e 'sysopen(F,"backlog/a.md",1)'`,
    `perl -e 'open(F,"|tee backlog/a.md")'`,
    `perl -e 'open(F,"<",shift); open(G,">",shift)' backlog/a.md`,
    `perl -e 'open(F,"<","|tee backlog/a.md")'`,
    'perl fix.pl backlog/a.md',
    'perl -I lib fix.PM reports/a.md',
    'perl fix.t backlog/a.md',
    `sed '1e cp /tmp/x backlog/a.md' f`,
    `sed -n '1e tee backlog/a.md' f`,
    `sed 's/x/y/e' backlog/a.md`,
    `sed 's/x/y/eg' backlog/a.md`,
    `sed 's|x|y|ge; # backlog/a.md' f`,
    `sed -n -f - f <<< 'w backlog/a.md'`,
    `sed -n -f /dev/stdin f <<< 'w backlog/a.md'`,
    `sed -n --file=- f <<< 'w backlog/a.md'`,
    `sed -n -f - f <<< '1e tee backlog/a.md'`,
    `sed -i -e s/x/y/ -- backlog/a.md`,
    `perl -fi s/x/y/ backlog/a.md`, // perl -f is not a script option
  ])('denies differential write shape: %s', denied);
  it.each([
    'sed -n -es/x/y/p backlog/a.md',
    'sed -es/x/y/ backlog/a.md',
    'perl -es/x/z/ backlog/a.md',
    `perl -ne 'print' backlog/a.md`,
    `perl -pe 's/x/y/' backlog/1.md`,
    `perl -ne 'print if /x/' reports/123-foo.md`,
    `perl -0p -e 's/x/y/' reports/a.md`,
    `perl -ne 'print if /rename|unlink|link/' backlog/a.md`, // builtin NAMES inside a regex are not calls
    `perl -ne 'print "rename\\n" if /mkdir/' reports/a.md`,
    `perl -Ilib -e 'print 1' backlog/a.md`,
    `perl -I lib -e 'print 1' backlog/a.md`,
    `perl -e 'open(F,"<",shift); print <F>' backlog/a.md`,
    `perl -e 'open(F,"<:utf8",shift); open(G,"<",shift)' backlog/a.md`,
    'perl backlog/1.md',
    'perl fix.other backlog/a.md', // accepted script-extension limit
    'sed -f script.sed backlog/a.md',
    'sed -i -es/x/y/ /tmp/x.md',
    'perl -pi -es/x/z/ /tmp/x.md',
    `sed -n -f - backlog/a.md <<< 'p'`,
    `sed -- -i backlog/a.md`,
    `sed -n '1,120p' backlog/3390-guard-bash-sed-tee-perl-corpus-fp.md`,
    `sed -n '/^## /p' ~/workspace/web-everything/backlog/3390-x.md`,
    `cd ~/workspace/x && sed -n '1,40p' backlog/2108-y.md | head`,
  ])('allows read-only / scratch twin and reviewer-shell regression: %s', allowed);

  // Exercise each new regex through the public scanner, including escaped near misses.
  it.each([
    ['SED_SUB_E', `sed 's/${'\\'.repeat(2000)}' backlog/a.md`],
    ['SED_EXEC', `sed '/${'\\/'.repeat(1000)}' backlog/a.md`],
    ['SED_EXEC whitespace', `sed '${' '.repeat(100)}# backlog/a.md' f`],
    ['PERL_MUTATING', `perl -e '${'\\'.repeat(2000)} $INPLACE_EDI' backlog/a.md`],
    ['PERL_WRITE_PRIMITIVE', `perl -e '${'\\'.repeat(2000)} system "read backlog/a.md"'`],
    ['PERL_OPEN_WORD', `perl -e '${'openly '.repeat(400)}' backlog/a.md`],
    ['PERL_READ_OPEN', `perl -e 'open(${ ' '.repeat(2000)}F,"<",shift)' backlog/a.md`],
    ['PERL_OPEN_STRING', `perl -e 'open(F,"<","${'\\'.repeat(2000)}")' backlog/a.md`],
    ['script extension', `perl ${'a'.repeat(2000)}.other backlog/a.md`],
  ])('bounds %s scanning', (_name, cmd) => {
    const start = performance.now();
    reason(cmd);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('guard-bash — raw PR creation loses the author stamp', () => {
  it('denies raw creation across repositories and command prefixes', () => {
    for (const command of ['gh pr create -R plateauapp/plateau-app --title t --body-file f',
      'cd /x && gh pr create --fill', 'env FOO=1 /usr/bin/gh pr create --fill']) {
      expect(decide(command), command).toMatch(/authored-by-actor/);
    }
  });
  it('allows the explicit escape, reads and quoted mentions', () => {
    for (const command of ['RAW_PR_CREATE_OK=1 gh pr create --fill',
      'gh pr view 204 -R plateauapp/plateau-app', 'git commit -m "mention gh pr create here"']) {
      expect(decide(command), command).toBeNull();
    }
  });
});

describe('guard-bash — raw gh-merge bypass block (#2290 assertMayMerge)', () => {
  const blockedMerge = (c) => expect(decide(c), c).toMatch(/assertMayMerge/);
  const allowed = (c) => expect(decide(c), c).toBeNull();

  it('blocks a bare `gh pr merge <n>` in any of its usual flag forms', () => {
    blockedMerge('gh pr merge 1234');
    blockedMerge('gh pr merge 1234 --merge --delete-branch');
    blockedMerge('gh pr merge 1234 --squash');
    blockedMerge('gh pr merge 1234 --admin');
    blockedMerge('gh pr merge --repo owner/repo 1234');
  });

  it('blocks disguised forms — wrapper/path/quote peeling, subshell, nested exec (mirrors the #2203 push arm)', () => {
    blockedMerge('/usr/bin/gh pr merge 1234');
    blockedMerge('"gh" pr merge 1234');
    blockedMerge('env FOO=1 gh pr merge 1234');
    blockedMerge('time gh pr merge 1234');
    blockedMerge('sudo gh pr merge 1234');
    blockedMerge('(gh pr merge 1234)');
    blockedMerge('{ gh pr merge 1234; }');
    blockedMerge('bash -c "gh pr merge 1234"');
    blockedMerge('sh -c \'gh pr merge 1234\'');
    blockedMerge('echo "$(gh pr merge 1234)"');
    blockedMerge('echo done && gh pr merge 1234');
    blockedMerge('gh pr checks 1234 ; gh pr merge 1234');
  });

  it('blocks the REST equivalent — `gh api …/pulls/<n>/merge` with a MUTATING method, every spelling', () => {
    blockedMerge('gh api repos/acme/web-everything/pulls/1234/merge -X PUT');
    blockedMerge('gh api /repos/acme/web-everything/pulls/1234/merge -X PUT');
    blockedMerge('gh api repos/acme/web-everything/pulls/1234/merge --method PUT');
    blockedMerge('gh api repos/acme/web-everything/pulls/1234/merge --method=PUT');
    blockedMerge('gh api repos/acme/web-everything/pulls/1234/merge -XPUT'); // glued no-space form
    blockedMerge('gh api repos/acme/web-everything/pulls/1234/merge -X put'); // case-insensitive method value
    blockedMerge('bash -c "gh api repos/acme/web-everything/pulls/1234/merge -X PUT"'); // disguised too
  });

  it('does NOT block a read-only `gh api …/pulls/<n>/merge` (no mutating method — checks merged status)', () => {
    allowed('gh api repos/acme/web-everything/pulls/1234/merge');
    allowed('gh api repos/acme/web-everything/pulls/1234/merge -X GET');
  });

  it('does NOT block ordinary non-merging `gh pr`/`gh api` calls', () => {
    allowed('gh pr view 1234');
    allowed('gh pr checks 1234');
    allowed('gh pr comment 1234 --body-file=/tmp/c.md');
    allowed('gh pr edit 1234 --add-label ready-to-merge');
    allowed('gh api repos/acme/web-everything/pulls/1234');
    allowed('gh api repos/acme/web-everything/pulls/1234/reviews');
  });

  it('does NOT block the sanctioned land scripts — they call assertMayMerge internally, no raw gh-merge text', () => {
    // No `--flag` on the pr-land invocation here (unlike a real call site) — deliberately, so this line
    // isn't itself HARVESTED as a real invocation by #3321's repo-wide pr-land-posture sweep
    // (scripts/__tests__/lane-verify.test.mjs), which would then want it to declare a verify posture it has
    // no reason to. guard-bash doesn't inspect pr-land's flags at all; only the command WORD matters here.
    allowed('node scripts/pr-land.mjs');
    allowed('node scripts/merge-ai-prs.mjs --json');
    allowed('node scripts/lane-resume.mjs --lane=3');
  });

  it('a mere MENTION of the merge command (a message, a grep) is not an invocation', () => {
    allowed('echo "remember to gh pr merge later"');
    allowed('git commit -m "wire gh pr merge into pr-merge-gate.mjs"');
    allowed('grep "gh pr merge" docs/agent/delivery-loop.md');
  });

  it('the WE_MERGE_BREAK_GLASS=1 escape passes both raw forms through (pr-merge-gate.mjs\'s own escape, reused)', () => {
    allowed('WE_MERGE_BREAK_GLASS=1 gh pr merge 1234');
    allowed('WE_MERGE_BREAK_GLASS=1 gh api repos/acme/web-everything/pulls/1234/merge -X PUT');
  });

  it('mergeBreakGlassUsed: true only when the escape actually disarmed THIS arm, false otherwise', () => {
    expect(mergeBreakGlassUsed('WE_MERGE_BREAK_GLASS=1 gh pr merge 1234')).toBe(true);
    expect(mergeBreakGlassUsed('WE_MERGE_BREAK_GLASS=1 gh api repos/acme/web-everything/pulls/1234/merge -X PUT')).toBe(true);
    // no escape token present
    expect(mergeBreakGlassUsed('gh pr merge 1234')).toBe(false);
    // escape present but this command was never denied by this arm in the first place
    expect(mergeBreakGlassUsed('WE_MERGE_BREAK_GLASS=1 gh pr view 1234')).toBe(false);
    expect(mergeBreakGlassUsed('WE_MERGE_BREAK_GLASS=1 npm run check:standards')).toBe(false);
    // escape present but a DIFFERENT arm still denies (main push) — the merge escape didn't do anything here
    expect(mergeBreakGlassUsed('WE_MERGE_BREAK_GLASS=1 git push origin main')).toBe(false);
  });

  it('still enforces the pre-existing rules (regression guard)', () => {
    expect(decide('git push origin main')).toMatch(/direct push to `main` is blocked/);
    expect(decide('pkill -f vite')).toMatch(/dev server/);
  });
});

describe('guard-bash — primary-tree-write build backstop (#2749/#2788, 4th arm)', () => {
  it('isTreeWritingBuildRun: an actual RUN of build/build:docs/build:demo (npm/pnpm/yarn/run-s/run-p), excluding build:check + build:plugs', () => {
    expect(isTreeWritingBuildRun('npm run build')).toBe(true);
    expect(isTreeWritingBuildRun('npm run build:docs')).toBe(true);
    expect(isTreeWritingBuildRun('npm run build:demo')).toBe(true);
    expect(isTreeWritingBuildRun('pnpm build')).toBe(true);
    expect(isTreeWritingBuildRun('yarn build')).toBe(true);
    expect(isTreeWritingBuildRun('run-s build:docs build:demo')).toBe(true);
    // excluded — /tmp output + already its own separate arm
    expect(isTreeWritingBuildRun('npm run build:check')).toBe(false);
    expect(isTreeWritingBuildRun('npm run build:plugs')).toBe(false);
    // a mention, not a run
    expect(isTreeWritingBuildRun('echo "run npm run build later"')).toBe(false);
    expect(isTreeWritingBuildRun('git commit -m "wire npm run build into ci"')).toBe(false);
    // an unrelated identifier that merely contains "build" is not a build run
    expect(isTreeWritingBuildRun('npm run buildSomethingElse')).toBe(false);
    expect(isTreeWritingBuildRun('npm test')).toBe(false);
  });

  it('isGeneratorScriptRun: a node invocation of a generate*/scaffold*.mjs script by name', () => {
    expect(isGeneratorScriptRun('node scripts/generate-report.mjs')).toBe(true);
    expect(isGeneratorScriptRun('node scripts/new-standard-scaffold.mjs --name=foo')).toBe(true);
    expect(isGeneratorScriptRun('node scripts/Generate.js')).toBe(true);
    // NOT a generator script: an unrelated script, or a `scaffold` SUBCOMMAND argument (not the script's own name)
    expect(isGeneratorScriptRun('node scripts/backlog.mjs scaffold 1234')).toBe(false);
    expect(isGeneratorScriptRun('node scripts/lane-pool.mjs acquire --lane=1')).toBe(false);
  });

  it('isFileWriteRedirect: sed -i / perl -pi / tee / a trailing shell redirect writing a non-scratch file', () => {
    expect(isFileWriteRedirect('sed -i s/x/y/ config/app.json')).toBe(true);
    expect(isFileWriteRedirect('perl -pi -e "s/x/y/" config/app.json')).toBe(true);
    expect(isFileWriteRedirect('tee config/app.json')).toBe(true);
    expect(isFileWriteRedirect('tee -a config/app.json')).toBe(true);
    expect(isFileWriteRedirect('echo hello > config/app.json')).toBe(true);
    expect(isFileWriteRedirect('cat template.json >> config/app.json')).toBe(true);
    // scratch targets (/tmp, /dev) are allowed — the standard lane-workflow idiom for scratch files
    expect(isFileWriteRedirect('sed -i s/x/y/ /tmp/scratch.json')).toBe(false);
    expect(isFileWriteRedirect('tee /tmp/pr-body-2788.md')).toBe(false);
    expect(isFileWriteRedirect('echo hello > /tmp/out.log')).toBe(false);
    expect(isFileWriteRedirect('node scripts/x.mjs > /dev/null')).toBe(false);
    // a literal `>` inside a quoted string is NOT a redirect (the trailing-anchor + closing-quote breaks it)
    expect(isFileWriteRedirect('git commit -m "fix > bug"')).toBe(false);
    expect(isFileWriteRedirect('git commit -m "fix > bug.txt"')).toBe(false);
    // fd-duplication / combined redirects are not a file write
    expect(isFileWriteRedirect('npm run check:standards > log.txt 2>&1')).toBe(true); // still writes log.txt
    expect(isFileWriteRedirect('npm test 2>&1')).toBe(false);
    // no redirect/tee/sed/perl at all
    expect(isFileWriteRedirect('git status')).toBe(false);
    expect(isFileWriteRedirect('')).toBe(false);
  });

  // ── #2788 review regressions ────────────────────────────────────────────────────────────────────
  // Each case below FAILED on the first cut of this arm and was caught by the review jury.

  it('isFileWriteRedirect: the REAL platform scratch roots are scratch, not primary-tree writes', () => {
    // The sanctioned per-session scratchpad every agent is handed is spelled `/private/tmp/claude-<uid>/…`
    // (macOS resolves `/tmp` through that symlink); `$TMPDIR` resolves to `/var/folders/<xx>/<yy>/T/…`.
    // Matching only `^/tmp/` denied an agent's own scratchpad — the most common legitimate write there is.
    expect(isFileWriteRedirect('echo hi > /private/tmp/claude-501/sess/scratch.txt')).toBe(false);
    expect(isFileWriteRedirect('tee /private/tmp/claude-501/sess/body.md')).toBe(false);
    expect(isFileWriteRedirect('echo hi > /var/folders/ab/cd/T/scratch.txt')).toBe(false);
    expect(isFileWriteRedirect('echo hi > /var/tmp/scratch.txt')).toBe(false);
    // …while a path that merely CONTAINS a temp-looking segment is still a tree write (anchored, not loose)
    expect(isFileWriteRedirect('echo hi > docs/private/tmp/notes.md')).toBe(true);
    expect(isFileWriteRedirect('echo hi > ./tmp/notes.md')).toBe(true);
  });

  it('isTreeWritingBuildRun: an excluded target named ELSEWHERE cannot disarm a real tree build', () => {
    const CHECK = `build:${'check'}`;
    const PLUGS = `build:${'plugs'}`;
    // the exclusion is tested against the MATCHED target, never the whole segment
    expect(isTreeWritingBuildRun(`npm run build && echo ${CHECK}`)).toBe(true);
    expect(isTreeWritingBuildRun(`npm run build # see ${PLUGS}`)).toBe(true);
    // a genuinely excluded target still excludes
    expect(isTreeWritingBuildRun(`npm run ${CHECK}`)).toBe(false);
    expect(isTreeWritingBuildRun(`npm run ${PLUGS}`)).toBe(false);
  });

  // ── #2788 review ROUND 2 regressions ────────────────────────────────────────────────────────────
  // The round-1 fixes were themselves bypassable; each case below failed on that cut.

  it('isTreeWritingBuildRun: NO placement of an excluded target can disarm a real build', () => {
    const CHECK = `build:${'check'}`;
    const PLUGS = `build:${'plugs'}`;
    // r1 extracted ONE target (the first in a greedy match), so an excluded name placed BEFORE a real one
    // disarmed the arm — the same bypass r1 was meant to close, one spelling further out.
    expect(isTreeWritingBuildRun(`run-s ${CHECK} build`)).toBe(true);
    expect(isTreeWritingBuildRun(`run-s build ${CHECK}`)).toBe(true);
    expect(isTreeWritingBuildRun(`run-p ${PLUGS} build:docs`)).toBe(true);
    // …while a segment whose targets are ALL excluded still stays quiet
    expect(isTreeWritingBuildRun(`run-s ${CHECK} ${PLUGS}`)).toBe(false);
    expect(isTreeWritingBuildRun(`npm run ${CHECK}`)).toBe(false);
    // and a word merely CONTAINING "build" is not a build target
    expect(isTreeWritingBuildRun('npm run test --rebuild-cache')).toBe(false);
    expect(isTreeWritingBuildRun('git commit -m "npm run build"')).toBe(false);
  });

  it('isFileWriteRedirect: a QUOTED path is unquoted before the scratch allowlist sees it', () => {
    // r1 tested the raw shell token against an anchored `^/tmp/`, so quoting a scratch path — ordinary
    // hygiene, and required for a path with a space — read as a primary-tree write and was denied.
    expect(isFileWriteRedirect('tee "/tmp/x"')).toBe(false);
    expect(isFileWriteRedirect("tee '/tmp/x'")).toBe(false);
    expect(isFileWriteRedirect('sed -i s/a/b/ "/tmp/x"')).toBe(false);
    expect(isFileWriteRedirect('echo hi > "/private/tmp/claude-501/s.txt"')).toBe(false);
    // …and the mirror bypass: a QUOTED tree target must still be caught (the old `[\w./-]+` class
    // excluded quote chars, so a quoted redirect matched nothing at all).
    expect(isFileWriteRedirect('echo hi > "config/app.json"')).toBe(true);
    expect(isFileWriteRedirect('tee "docs/x.md"')).toBe(true);
  });

  it('hasLeadingEnvEscape: the escape counts only as a LEADING assignment, never as a mention', () => {
    const V = 'MAIN_SESSION_BUILD_OK';
    expect(hasLeadingEnvEscape(`${V}=1 npm run build`, V)).toBe(true);
    expect(hasLeadingEnvEscape(`FOO=x ${V}=1 npm run build`, V)).toBe(true);
    // a mention anywhere else must NOT disarm the guard
    expect(hasLeadingEnvEscape(`git commit -m "see ${V}=1 in docs"`, V)).toBe(false);
    expect(hasLeadingEnvEscape(`echo ${V}=1`, V)).toBe(false);
    expect(hasLeadingEnvEscape(`grep ${V}=1 docs/agent/x.md`, V)).toBe(false);
    // only the documented `=1` value opts out
    expect(hasLeadingEnvEscape(`${V}=0 npm run build`, V)).toBe(false);
    expect(hasLeadingEnvEscape('npm run build', V)).toBe(false);
  });

  it('primaryTreeWriteReason returns a reason for each of the three shapes, null otherwise', () => {
    expect(primaryTreeWriteReason('npm run build')).toMatch(/WRITES the shared PRIMARY tree/);
    expect(primaryTreeWriteReason('node scripts/generate-report.mjs')).toMatch(/generator\/scaffold script/);
    expect(primaryTreeWriteReason('echo hi > config/app.json')).toMatch(/redirect.*writing a file/);
    expect(primaryTreeWriteReason('npm run build:check')).toBeNull();
    expect(primaryTreeWriteReason('git status')).toBeNull();
  });

  it('reason() denies the tree-write ONLY when cwd is primary; a lane clone is untouched', () => {
    expect(reason('npm run build', { primaryCwd: true })).toMatch(/#2749\/#2788/);
    expect(reason('npm run build', { primaryCwd: false })).toBeNull();
    expect(reason('node scripts/generate-report.mjs', { primaryCwd: true })).toMatch(/generator\/scaffold script/);
    expect(reason('node scripts/generate-report.mjs', { primaryCwd: false })).toBeNull();
    expect(reason('echo hi > config/app.json', { primaryCwd: true })).toMatch(/writing a file/);
    expect(reason('echo hi > config/app.json', { primaryCwd: false })).toBeNull();
  });

  it('the MAIN_SESSION_BUILD_OK=1 escape passes a primary-cwd tree-write through (mirrors MAIN_PUSH_OK)', () => {
    expect(reason('MAIN_SESSION_BUILD_OK=1 npm run build', { primaryCwd: true })).toBeNull();
    expect(reason('MAIN_SESSION_BUILD_OK=1 node scripts/generate-report.mjs', { primaryCwd: true })).toBeNull();
    expect(reason('MAIN_SESSION_BUILD_OK=1 echo hi > config/app.json', { primaryCwd: true })).toBeNull();
  });

  it('decide() surfaces the tree-write denial across a full &&-chained command', () => {
    expect(decide('cd /ws/webeverything && npm run build', { primaryCwd: true })).toMatch(/#2749\/#2788/);
  });

  it('does not fire on a genuinely unrelated primary-cwd command', () => {
    expect(reason('git status', { primaryCwd: true })).toBeNull();
    expect(reason('ls backlog', { primaryCwd: true })).toBeNull();
    expect(reason('node scripts/lane-pool.mjs acquire --lane=1', { primaryCwd: true })).toBeNull();
  });

  it('mainSessionDelegateNudge: WARNS (never denies) on a verification-set run at primary cwd; null otherwise', () => {
    expect(mainSessionDelegateNudge('npm run check:standards', { primaryCwd: true })).toMatch(/should delegate mechanical work/);
    expect(mainSessionDelegateNudge('npm test', { primaryCwd: true })).toMatch(/WARN, not a denial/);
    // not primary cwd → no nudge (a lane's own verify is sanctioned, nothing to nudge)
    expect(mainSessionDelegateNudge('npm run check:standards', { primaryCwd: false })).toBeNull();
    expect(mainSessionDelegateNudge('npm run check:standards')).toBeNull(); // default ctx
    // not a verification run → no nudge
    expect(mainSessionDelegateNudge('git status', { primaryCwd: true })).toBeNull();
    // the nudge never feeds the deny channel — reason()/decide() are untouched by it
    expect(reason('npm run check:standards', { primaryCwd: true })).toBeNull();
    expect(decide('npm run check:standards', { primaryCwd: true })).toBeNull();
  });
});

// ── #2788 review ROUND 3 — the two-sided fixture corpus ─────────────────────────────────────────────────
// Round 3 found the same defect five ways: a hand-written regex validated against the examples it was
// written from, so precision fixes silently ate recall and vice-versa. The durable guard is a TWO-SIDED
// table — every family lists EQUIVALENT SPELLINGS of one effect and asserts they all decide identically —
// so the two sides get tuned against each other instead of one example at a time.
describe('guard-bash — #2788 r3: equivalent spellings decide identically', () => {
  const CHECK = `build:${'check'}`;
  const PLUGS = `build:${'plugs'}`;
  const at = (cmd) => decide(cmd, { primaryCwd: true });

  // MUST ALWAYS DENY — one family per row: the same tree write, spelled every way it is reachable.
  const MUST_DENY = {
    'wrapper-prefixed build (r3 finding 1)': [
      'npm run build', 'env npm run build', 'time npm run build', 'command npm run build',
      'nice npm run build', 'sudo npm run build', 'FOO=1 npm run build', 'npx run-s build:docs',
      'xargs -n1 npm run build', '(npm run build)',
    ],
    'the build TOOL the alias delegates to (r3 finding 5)': [
      'vite build', 'npx vite build', './node_modules/.bin/eleventy', 'npx eleventy',
      'eleventy --output=_site', 'env vite build',
    ],
    'a redirect anywhere in the segment, not just at its end (r3 finding 2)': [
      'echo hi > config/app.json', 'cat t.json >> config/app.json',
      "cat > config/app.json <<'EOF'", '> config/app.json echo hi', '>| config/app.json',
      'echo hi > "config/app.json"', 'echo hi>config/app.json', 'echo hi &> config/app.json',
      'echo hi 2> config/app.json',
    ],
    "this repo's actual generators (r3 finding 3)": [
      'node scripts/gen-inventory.mjs', 'node scripts/gen-reference-index.mjs',
      'node scripts/gen-wrapper/cli.mjs', 'node scripts/gen-cem.mjs', 'npm run gen:inventory',
      'node scripts/generate-report.mjs', 'node scripts/new-standard-scaffold.mjs --name=foo',
      'env node scripts/gen-inventory.mjs',
    ],
    'multi-target / alternate-flag in-place writes (r3 finding 4)': [
      'sed -i s/x/y/ config/app.json', 'sed -i s/x/y/ config/app.json /tmp/x',
      'sed -i s/x/y/ /tmp/x config/app.json', 'sed --in-place s/x/y/ config/app.json',
      'sed -i.bak s/x/y/ config/app.json', 'env sed -i s/x/y/ config/app.json',
      "perl -pi -e 's/x/y/' config/app.json", "perl -i -pe 's/x/y/' config/app.json",
      "perl -i.bak -pe 's/x/y/' config/app.json",
      'tee config/app.json', 'tee -a config/app.json', 'tee /tmp/x config/app.json',
      'tee -a -- config/app.json',
    ],
    // #2994 — the recall half of the quote-aware split. A REAL unquoted redirect after a REAL unquoted pipe
    // must still deny. The quote-blind split used to TEAR at a quoted pipe and leave the tail fragment with
    // an unbalanced quote that SWALLOWED the trailing redirect — so these were wrongly ALLOWED before, and
    // the split fix closes that hole in the same stroke it clears the false denies below.
    'a real unquoted pipe into a real unquoted write (#2994, recall half)': [
      'ls | grep x > config/app.json', 'cat a.txt | tee config/app.json',
      'ls | grep x | tee -a config/app.json', 'echo hi | sed -i s/a/b/ config/app.json',
      "gh pr list --jq '.[] | .number' > config/app.json",
      "gh pr list --jq '.[] | select(.n > 5)' | tee config/app.json",
      "echo 'a | b' > config/app.json", 'echo "a|b" > config/app.json',
      "jq '.a | .b' x.json > config/app.json",
      "perl -i -pe 's/x|y/z/' config/app.json",
      'ls; npm run build', 'ls && echo hi > config/app.json',
    ],
    // The precision family above buys nothing unless its recall mirror holds: the SAME quoted alternation
    // with a REAL trailing redirect must still deny. This is the direction the splitter could plausibly
    // have broken — not cutting inside quotes must not mean failing to see the operator outside them.
    'a quoted alternation followed by a REAL write (#2994 fifth class, recall half)': [
      'grep -cE "a|=>" AGENTS.md > config/app.json',
      'grep -cE "a|=>" AGENTS.md >> config/app.json',
      "grep -cE 'a|=>' AGENTS.md | tee config/app.json",
      'rg -e "x|y=>z" src > config/app.json',
      'sed -n "/a|=>/p" f.txt > config/app.json',
      'node -e \'console.log("a|b" + "=>")\' > config/app.json',
    ],
    // #2986(2) — the recall half of the script-name scan: every real build alias, in every runner spelling.
    'a real build alias, only the script-name position (#2986/2, recall half)': [
      'npm run build', 'npm run-script build', 'npm run --silent build', 'npm run build -- --mode=prod',
      'pnpm build', 'pnpm run build', 'yarn build', 'yarn run build:docs', 'run-s lint build',
      'run-s build build:check', 'npm-run-all --parallel build:demo', 'npm run build-docs',
      // …and the runner-`exec`/`dlx` form, whose remainder is a COMMAND, not a script name.
      'pnpm exec vite build', 'npm exec -- vite build', 'yarn dlx eleventy', 'pnpm dlx vite build',
    ],
    // #2986(1) — the recall half of the empty-operand drop: a BSD `-i ''` edit of a TRACKED file still denies.
    "BSD in-place `-i ''` on a TRACKED path (#2986/1, recall half)": [
      "sed -i '' s/a/b/ config/app.json", 'sed -i "" s/a/b/ config/app.json',
      "sed -i '' -e s/a/b/ config/app.json", "sed -i '' s/a/b/ /tmp/x config/app.json",
      "sed -i '' -e 's/a|b/c/' config/app.json", "tee '' config/app.json",
    ],
    // #2986(3) — the recall half of the eleventy flag allowlist: the flags that REALLY write the site dir.
    // #2994 review r2 — an ESCAPED quote inside a quoted argument. `splitSegments`/`shellTokens` ended a
    // quoted run at the first `"` they found, so `\"` (which bash reads as a LITERAL quote inside a
    // double-quoted run — `bash -c 'echo "a\"b"'` prints `a"b`) left the parser one quote out of phase; the
    // NEXT `"` then opened a run with no closer and swallowed the whole rest of the line as one blob, so
    // EVERY deny arm below read a single unrecognisable segment. An EVEN number of escaped quotes does not
    // re-sync it (`"a\"b\"c"` shifts the phase twice). Escaping a quote inside a commit message / `node -e`
    // / `jq` filter is everyday work, which is what made this a live total bypass rather than a corner case.
    'an escaped quote inside a quoted argument (#2994 r2, recall half)': [
      'git commit -m "guard: reject \\"a|b\\" input" && npm run build',
      'node -e "console.log(\\"hi\\")" && npm run build',
      'jq -r "\\"x\\"" /tmp/a.json && echo y > src/foo.ts',
      "echo \"a\\\"b\" && sed -i '' s/a/b/ config/app.json",
      'echo "a\\"b" && eleventy',
      'echo "a\\"b" && vite build',
      "echo $'a\\'b' && npm run build",          // `$'…'` (ANSI-C) honours `\'` the same way
      'echo "a\\"b\\"c" && npm run build',       // an EVEN count does NOT re-sync the old scanner
      'echo "a\\"b" > config/app.json',          // the same desync in `shellTokens`, no separator involved
    ],
    // #2994 review r2 — the `exec`/`dlx` narrowing only matched `<runner> exec|dlx [--] <program>`, so ANY
    // flag in between became the recursed "program", and the script-name scan took the first non-flag word,
    // so a runner-level selector's VALUE (or a workspace NAME) was mistaken for the subcommand. Every row
    // here is a real build that writes `dist/`/`_site/` at the cwd it runs in.
    'a runner exec/dlx or workspace form with flags in the way (#2994 r2, recall half)': [
      'npm exec --package=vite vite build', 'npm exec --package=vite -- vite build',
      "npm exec -c 'vite build'", 'npm exec --yes vite build', 'npm exec --no vite build',
      'pnpm exec --silent vite build', 'pnpm dlx --package=vite vite build',
      'pnpm --filter web exec vite build', 'pnpm --filter web dlx vite build',
      'yarn workspace web build', 'yarn dlx -q eleventy',
      'npm exec --package=vite -- vite build --mode=prod',
      // …and the spellings that were ALREADY right, pinned so the rewrite keeps them
      'npm run --workspace=web build', 'npm --workspace=web run build', 'pnpm -r run build',
    ],
    // ── #2994 review r3 — the PARSER'S OWN failure modes ──────────────────────────────────────────────
    // Every round of this review closed one shape and opened another of the same class, because the corpus
    // kept testing the class the author was thinking about (which tree writes count) and never the states
    // the PARSER can reach. Not one row above exercises an unterminated quote, a `#` comment or a
    // `\`+newline. These families do. Each was cross-checked against real `bash -c` before being written.
    'an apostrophe in a `#` comment must not swallow the next line (r3 F1)': [
      "# don't forget\nnpm run build",
      "echo one # don't forget\nnpm run build",
      "npm run build:check # don't\nvite build",
      "ls # it's a comment\necho hi > config/app.json",
      "ls # don't\nsed -i s/a/b/ config/app.json",
      'ls # see the "docs"\nnpm run build',
      "ls # don't; npm run build",              // a separator inside a comment still cuts, as it always did
    ],
    'a `#` that does NOT start a comment must not disarm the arm (r3 F1 mirror)': [
      'echo a#b > config/app.json',             // bash: `a#b` is one word, not a comment
      'echo "# not a comment" > config/app.json',
      "sed -i 's/#a/#b/' config/app.json",
      'npm run build "#tag"',
      'echo ${#PATH} > config/app.json',
    ],
    'a `\\`+newline line continuation must not hide the tree write (r3 F2)': [
      'echo a && \\\nnpm run build',            // after a separator — the reported F2 shape
      'echo a; \\\nnpm run build',
      'echo a || \\\nvite build',
      'vite \\\nbuild',                         // mid-command — bash splices it into one word list
      'npm run \\\ngen:inventory',
      'echo hi > \\\nconfig/app.json',
      'tee \\\nconfig/app.json',
      'npm run build \\',                       // a LONE trailing backslash on a real build
      'sed -i \\\ns/a/b/ config/app.json',
    ],
    'a phantom heredoc must not swallow the rest of the command (r3 audit)': [
      'echo "x << EOF"\nnpm run build',         // the `<<` is inside quotes — not an opener
      "echo 'a << b'\nvite build",
      'ls # see <<EOF\nnpm run build',          // …nor inside a comment
    ],
    'a subshell CLOSER must not defeat the arm (r3 audit — found by the differential fuzz)': [
      '(pnpm --filter web exec vite build)', '(npm exec vite build)', '(vite build)', '(vite build) \\',
      '{ npm run build; }', '(env "FOO=a b" npm run build)', 'sudo -u "some user" npm run build',
    ],
    // r5 F2 — the r3 fix above was POSITIONAL: `canonicalCommand` peeled a `)` only when it was the LAST
    // character of the segment, so ONE trailing token re-opened the hole while the r3 test kept passing.
    // Every shape below was confirmed to really build under real bash in a PATH-stubbed sandbox.
    'a subshell closer with a TRAILING token after it (r5 F2)': [
      '(pnpm exec vite build) >/dev/null', '(pnpm exec vite build) 2>/dev/null',
      '(pnpm exec vite build) #x', '(npm exec -- vite build) #x', '(vite build) >/dev/null 2>&1',
      '(npm run build) >/dev/null', '(eleventy) 2>/dev/null', '{ npm run build; } >/dev/null',
      'time (npm run build)', '(pnpm dlx eleventy) | cat',
      // …and the other half of the class: the group's LAST command keeps the closer glued to it when the
      // split cuts the group at a separator inside it.
      '(gh pr list --json number; pnpm dlx eleventy) >/dev/null',
      '(git status; vite build) >/dev/null',
    ],
    // r5 F1 — the text bash RE-EXECUTES. The quote-BLIND split of base tore these open at the separator
    // inside the quoted argument and denied by accident; making the split correct lost that coverage.
    // Recursing into the script-string positions restores it structurally — and covers the separator-free
    // spelling (`bash -c "npm run build"`) that base never caught at all.
    'a command bash RE-EXECUTES from a script string or substitution (r5 F1)': [
      'bash -c "npm run build"', 'sh -c "npm run build"', "bash -c 'npm run build'",
      'bash -c "cd src && npm run build"', 'bash -ec "vite build"', 'sh -c "eleventy"',
      'eval "npm run build"', "eval 'vite build'", 'eval "echo done; echo hi > config/app.json"',
      'OUT="$(cd . && npm run build)"', 'echo "$(npm run build)"', 'X=$(vite build)',
      'echo `npm run build`', 'X=`vite build`', 'echo "`eleventy`"',
      'echo $(gh pr list --json number; node scripts/gen-inventory.mjs)',
      "npm exec -c 'vite build'", 'xargs -n1 bash -c "npm run build"',
    ],
    'eleventy flags that really WRITE the site dir (#2986/3, recall half)': [
      'eleventy', 'eleventy --serve', 'eleventy --watch', 'eleventy --serve --port=8080',
      'eleventy --quiet', 'eleventy --incremental', '11ty --watch', 'npx eleventy',
      // …and `--serve`/`--watch` WIN over the no-write allowlist — they keep writing regardless.
      'eleventy --dryrun --serve', 'eleventy --version --serve', 'eleventy --help --watch',
      // a flag that merely STARTS with an allowlisted name is not on the allowlist
      'eleventy --versionx', 'eleventy --serveme',
    ],
  };

  // MUST NEVER DENY — the mirror side: pure-scratch / read-only work in every flag spelling.
  const MUST_ALLOW = {
    'scratch writes in every flag + quote spelling (r3 finding 6)': [
      'tee /tmp/x.log', 'tee -a /tmp/x.log', 'tee --append /tmp/x.log', 'tee -a -- /tmp/x.log',
      'tee -i -a /tmp/x.log', 'tee "/tmp/x.log"', "tee '/tmp/x.log'",
      'tee /private/tmp/claude-501/sess/body.md', 'tee /var/folders/ab/cd/T/x',
      'sed -i s/x/y/ /tmp/x.json', 'sed --in-place s/x/y/ /tmp/x.json',
      "perl -pi -e 's/x/y/' /tmp/x.json",
      'echo hi > /tmp/out.log', 'echo hi > /dev/null', 'echo hi > "/private/tmp/claude-501/s.txt"',
    ],
    'non-writes that merely LOOK like writes': [
      'git commit -m "fix > bug"', 'git commit -m "npm run build"', 'npm test -- a.test.mjs 2>&1',
      'echo "a > b"', 'sed -n "1,5p" config/app.json', 'grep -rn ">" src/',
      'node scripts/backlog.mjs list', 'git status', 'vite dev', 'vite preview',
      'perl -Mlist::Util -e "print 1" data.txt',
    ],
    // ── the fifth false-deny class, found in ordinary work on 2026-08-08 (#3002 sweep clause) ─────────
    // A QUOTED ALTERNATION whose tail glues a character to `>`. Two conditions must coincide, which is
    // why the 145-command sweep missed it — each half alone is already allowed:
    //   1. a `|` inside quotes, which a quote-BLIND split tears the command at, and
    //   2. an `=`/`-`/digit immediately followed by `>` in the tail, which then reads as a real redirect
    //      operator (`=>`, `->`, `2>`) with the next word as its target.
    // Neither `grep -c "=>" f` nor `grep -c "a|b" f` is denied on base; `grep -cE "a|=>" f` is. The
    // splitter is what fixes it — it never cuts inside the quoted run, so no tail fragment exists.
    'a quoted alternation whose tail glues a char to `>` (#2994 fifth class)': [
      'grep -cE "a|=>" AGENTS.md', "grep -cE 'a|=>' AGENTS.md",
      'grep -E "foo|bar=>baz" README.md', 'grep -cE "a|->" AGENTS.md',
      'grep -cE "a|>=" AGENTS.md', 'grep -cE "a|2>" AGENTS.md',
      'rg -e "x|y=>z" src', 'rg "handler|on[A-Z]\\w+=>" src',
      'sed -n "/a|=>/p" f.txt', 'awk "/a|b/ { print }" f.txt',
      'node -e \'console.log("a|b" + "=>")\'', 'jq -r \'.a | .b\' data.json',
      'command grep -an "splitSegments|=>" scripts/guard-bash.mjs',
      // the arrow shape plus a genuine fd redirect to /dev/null — still a scratch write, still allowed
      'grep -cE "a|=>" AGENTS.md 2>/dev/null',
    ],
    'the excluded / separately-armed build targets': [
      `npm run ${CHECK}`, `run-s ${CHECK} ${CHECK}`, 'eleventy --output=/tmp/we-build-check --quiet',
    ],
    'the sanctioned escape, including through a wrapper': [
      'MAIN_SESSION_BUILD_OK=1 npm run build', 'env MAIN_SESSION_BUILD_OK=1 npm run build',
      'MAIN_SESSION_BUILD_OK=1 sed -i s/x/y/ config/app.json',
      'MAIN_SESSION_BUILD_OK=1 node scripts/gen-inventory.mjs',
    ],
    // ── the four #2986/#2994 false-deny classes. The corpus proved RECALL well (41/41 must-deny) and
    // precision barely at all, which is exactly how all four shipped. These are the mirror side.
    // #2994 — a `|` and a `>` in the SAME quoted argument. Neither alone tripped it; both always did.
    // `--jq '.[] | select(…)'` is *the* house idiom for reading GitHub state, so this one was hit live.
    'a pipe AND an angle bracket inside one quoted argument (#2994)': [
      "gh pr list --jq '.[] | select(.n > 5)' --state open",
      'gh pr list --jq ".[] | select(.n > 5)"',
      "gh pr list --state merged --json number,mergedAt --jq '.[] | select(.mergedAt > \"2026-08-07\") | .number'",
      "jq '.[] | select(.size > 8)' items.json",
      "echo 'a | b > c'", 'echo "a | b > c"',
      "git log --pretty='%h | %s' --since='2026-08-01'",
      "awk -F'|' '$2 > 3 { print }' data.txt",
      "node scripts/backlog.mjs list --filter='size > 8 | open'",
      // …and a real pipe into a real SCRATCH write is still fine
      "gh pr list --jq '.[] | select(.n > 5)' | tee /tmp/prs.json",
      'ls | grep x > /tmp/out.log', 'ls | grep x | tee -a /tmp/out.log',
      'git commit -m "fix: pipe | and > in one message"',
    ],
    // #2986(2) — the word `build` ANYWHERE in a package-runner segment used to fire the arm. Only the
    // runner's script-name argument position is a script name; a path, a package, or a flag is not.
    'the word `build` outside the runner script-name position (#2986/2)': [
      'npm run test:unit -- src/build-graph.test.ts',
      'npm run test:unit scripts/__tests__/build-manifest.test.mjs',
      'npm run test:unit -- --reporter=verbose src/rebuild.test.ts',
      'npm run lint src/build/', 'yarn run lint packages/buildkit',
      'npm install esbuild', 'npm install --build-from-source better-sqlite3',
      'npm ls esbuild', 'pnpm add node-gyp-build',
    ],
    // #2986(1) — BSD's in-place suffix is an EMPTY quoted argument. Counting it as a file operand shifted
    // the `files.slice(1)` so the sed SCRIPT read as the write target.
    "BSD in-place `-i ''` with an empty suffix, on a SCRATCH path (#2986/1)": [
      "sed -i '' s/a/b/ /tmp/scratch.txt", 'sed -i "" s/a/b/ /tmp/scratch.txt',
      "sed -i '' 's/a/b/' /private/tmp/claude-501/sess/x.md",
      "sed -i '' -e s/a/b/ /tmp/scratch.txt",
    ],
    // #2986(3) — bare `eleventy` with a flag that writes nothing. The arm allowed only a scratch `--output=`.
    'eleventy with a NON-build flag (#2986/3)': [
      'eleventy --version', 'eleventy --help', 'eleventy --dryrun', 'eleventy --dry-run',
      'npx eleventy --version', '11ty --version', './node_modules/.bin/eleventy --help',
      'env eleventy --version', 'eleventy --output=_site --dryrun',
    ],
    // #2994 r2 precision mirror — an escaped quote in a command that writes NOTHING must stay allowed, and
    // the single-quote rule must stay DIFFERENT: bash honours no escape inside `'…'`, so `echo 'a\'` is a
    // complete word and applying the double-quote rule there would be a new desync in the other direction.
    'an escaped quote in a command that writes nothing (#2994 r2)': [
      'git commit -m "guard: reject \\"a|b\\" input"',
      'echo "he said \\"hi\\""',
      'node -e "console.log(\\"hi\\")"',
      'gh pr list --jq ".[] | select(.title | test(\\"fix\\"))"',
      'git commit -m "fix \\"quoted\\" > thing"',
      "echo 'a\\' && echo ok",
      'jq -r "\\"x\\"" /tmp/a.json',
      "printf '%s\\n' \"a\\\"b\"",
      'echo "a\\"b" > /tmp/out.log',
      'git commit -m "guard: reject \\"a|b\\" input" && npm run build:check',
      "echo $'a\\'b' && npm run test:unit -- a.test.mjs",
    ],
    // #2994 r2 precision mirror — the exec/dlx rewrite must not turn every flagged runner form into a deny:
    // what matters is the TOOL it lands on, not that a flag was present.
    // ── #2994 review r3 — the precision mirror of the parser's own failure modes ──────────────────────
    // Cross-checked against real `bash -c`: `echo a#b` prints `a#b`; `echo a #b` prints `a`; `echo ${#x}`
    // prints a length; `echo a \`⏎`b` prints `a b`; `echo a \` (lone trailing backslash) prints `a`.
    "the parser's own failure modes, on commands that write NOTHING (r3 audit)": [
      'echo a#b', 'curl https://example.com/#frag', 'git commit -m "fix #123"',
      'echo "# not a comment"', "echo '# nor this'", 'echo ${#PATH}', 'echo $#',
      "ls # don't forget", 'ls # a "quoted" word', 'git status # npm run build:check',
      "ls -la # it's fine\ngit status",
      'echo ok \\', 'ls -la \\', 'echo hello \\\n  world', 'ls -la \\\n  --color=auto',
      "gh pr list \\\n  --jq '.[] | select(.n > 5)'",
      'git status \\\n  --short',
      "cat > /tmp/body.md <<'EOF'\ndon't do it — it's a trap\na \"quoted\" line\nnpm run build\nEOF",
    ],
    // ── r5 precision mirrors — the recursion must not turn every nested command into a deny ─────────
    // The re-execution recursion (F1) reads a `$( )`/backtick body, a subshell body and an
    // `eval`/`sh -c`/`bash -c` string at command position. That is a lot of new text reaching the deny
    // arms, so these are the commands an agent really runs through those same positions.
    'a script string / substitution whose command writes NOTHING (r5 F1)': [
      'echo "$(git rev-parse --short HEAD)"', 'BR="$(git branch --show-current)"; echo "$BR"',
      'N=$(gh pr list --json number --jq "length"); echo $N',
      'test -n "$(git status --porcelain)" && echo dirty',
      'echo `git rev-parse HEAD`', 'X=`date +%s`; echo $X',
      'bash -c "npm run test:unit -- a.test.mjs"', 'sh -c "git status"', 'bash -lc "node --version"',
      'bash scripts/setup.sh', 'eval "$(direnv hook bash)"', 'eval "echo hi"',
      'echo "$(npm run build:check)"', 'for f in $(ls scripts); do echo $f; done',
      // a `"…"` script string arrives with its `\"` escapes RESOLVED, exactly as the inner shell sees it —
      // otherwise the `|` in this message reads as an unquoted separator and #2994's false deny returns
      // one level down.
      'sh -c "git commit -m \\"fix: a | b > c\\""',
      'bash -c "gh pr list --jq \'.[] | select(.n > 5)\'"',
      // …and the sanctioned escape is EXPORTED into the re-executed command, so it must still disarm it
      // (verified: `FOO=1 bash -c \'echo $FOO\'` prints 1).
      'MAIN_SESSION_BUILD_OK=1 bash -c "npm run build"', 'MAIN_SESSION_BUILD_OK=1 eval "npm run build"',
      'MAIN_SESSION_BUILD_OK=1 sh -c "npm run build && npm run build:docs"',
      'MAIN_PUSH_OK=1 bash -c "git push origin main"',
    ],
    'a subshell with a trailing token whose command writes NOTHING (r5 F2)': [
      '(cd /tmp && ls) >/dev/null', '(npm run test:unit -- a.test.mjs) 2>&1', '(git status; git diff) | head -40',
      '{ echo a; echo b; } > /tmp/out.txt', '(eleventy --version) >/dev/null',
      '(eleventy --dryrun) 2>/dev/null', '(npm run build:check) >/dev/null', '(git status) #x',
    ],
    'a runner exec/dlx form whose tool writes nothing (#2994 r2)': [
      'npm exec --package=vitest vitest run a.test.mjs', 'npm exec -- tsc --noEmit', 'pnpm exec eslint src/',
      'npm exec --package=vite vite preview', 'yarn workspace web test', 'pnpm --filter web exec eslint .',
      'npm run --workspace=web test:unit', "npm exec -c 'echo build'",
      'npm exec --package=esbuild esbuild --version',
      'pnpm dlx --package=@11ty/eleventy eleventy --version',
      'npm exec', 'npm exec --', 'npm exec -c',
    ],
  };

  // xxna58l (#3383) — the raw-heavy-command arm (a raw eleventy/vitest invocation, reached directly or
  // through this file's own nested-command extraction: `yarn dlx eleventy`, `sh -c "eleventy"`, `npm exec
  // --package=vitest vitest run`, …) is NOT cwd-gated the way the older tree-write arm is: it denies the SAME
  // command in a lane too, for an unrelated reason (it skips the #3461 admission queue, never primary-tree
  // safety). That is an intentional, ADDITIONAL invariant this corpus never encoded (it predates xxna58l), not
  // a regression in the one it already asserts — so a row this NEW arm reaches is excluded from "untouched in
  // a lane"/"never denied at primary" below, derived from `decide()`'s own verdict (never a hand-maintained
  // list, so it can't silently drift from what the arm actually catches). `isRawHeavyVerdict` is defined once,
  // module-wide, above.

  for (const [family, cmds] of Object.entries(MUST_DENY)) {
    it(`MUST DENY at primary cwd — ${family}`, () => {
      const allowed = cmds.filter((c) => !at(c));
      expect(allowed).toEqual([]);
      // …and every one of them is untouched in a lane clone (the arm keys on WHERE the write lands) — except
      // a row xxna58l's raw-heavy-command arm ALSO denies in a lane (see comment above).
      const stillUntouchedInLane = cmds.filter((c) => !isRawHeavyVerdict(decide(c, { primaryCwd: false })));
      expect(stillUntouchedInLane.filter((c) => decide(c, { primaryCwd: false }))).toEqual([]);
    });
  }

  for (const [family, cmds] of Object.entries(MUST_ALLOW)) {
    it(`MUST NEVER DENY at primary cwd — ${family}`, () => {
      // …except a row xxna58l's raw-heavy-command arm denies for its own, unrelated reason (see comment
      // above) — this family only ever asserted immunity from the tree-write arm, never from every arm ever
      // added afterward.
      const stillNeverDenied = cmds.filter((c) => !isRawHeavyVerdict(at(c)));
      expect(stillNeverDenied.filter((c) => at(c))).toEqual([]);
    });
  }

  it(`${PLUGS} still gets its OWN message, not the tree-write one`, () => {
    expect(at(`npm run ${PLUGS}`)).toMatch(/shadow \.js\/\.d\.ts/);
  });

  it('the deny message names the ACTUAL remedy for a caller already in a lane (r3 finding 7)', () => {
    // "Delegate to a lane clone" is useless advice to a delegated subagent whose reported cwd reset to
    // primary (#2335); the remedy is to make the lane cwd explicit, which `resolveEffectiveCwd` honours.
    for (const cmd of ['npm run build', 'node scripts/gen-inventory.mjs', 'echo hi > config/app.json'])
      expect(at(cmd)).toMatch(/cd <lane-path> && <cmd>/);
    // …and that spelling really is allowed.
    expect(decide('cd /ws/.lanes/web-everything/lane-3 && npm run build', { primaryCwd: false })).toBeNull();
  });
});

// ── #2994 review r2 — the escaped-quote desync, on the arms the corpus above cannot cover ───────────────
// The MUST_DENY loop asserts every row is untouched in a lane clone, which is only true of the cwd-GATED
// tree-write arm. These arms deny regardless of cwd (push/rm/pkill) or only inside a leased lane clone
// (the #2367/#2413 clobber arm), so they get their own assertions — and the clobber arm is exactly where
// the desync did the most damage, because `hasDestructiveLaneOp` is the CLI's pre-filter for reading the
// lease at all: one unrecognisable blob ⇒ no lease read ⇒ a peer's clone clobbered with no deny.
describe('guard-bash — an escaped quote must not bypass the cwd-independent arms (#2994 r2)', () => {
  it('the push / backlog-rm / pkill arms still fire behind an escaped quote, at ANY cwd', () => {
    const rows = [
      ['git commit -m "guard: reject \\"a|b\\" input" && git push origin main', /lane\/\*|MAIN_PUSH_OK/],
      ['echo "he said \\"hi\\"" && rm backlog/2986-x.md', /backlog/],
      ['printf "%s\\n" "a\\"b" ; pkill -f vite', /dev server|pkill|kill/i],
    ];
    for (const [cmd, msg] of rows) {
      expect(decide(cmd, { primaryCwd: true }), cmd).toMatch(msg);
      expect(decide(cmd, { primaryCwd: false }), cmd).toMatch(msg);
    }
  });

  it('hasDestructiveLaneOp (the CLI lease-read pre-filter) still sees the op behind an escaped quote', () => {
    const rows = [
      'echo "a\\"b" && git reset --hard origin/main',
      'git commit -m "fix \\"x\\"" && git reset --hard',
      'echo "a\\"b" && git clean -fd',
      'echo "a\\"b" && git checkout -- .',
      'echo "a\\"b" && git push --force origin lane/x',
    ];
    for (const cmd of rows) expect(hasDestructiveLaneOp(cmd), cmd).toBe(true);
  });

  it('the lane-clobber arm denies behind an escaped quote, in BOTH lease regimes', () => {
    const rows = [
      'echo "a\\"b" && git reset --hard origin/main',
      'git commit -m "fix \\"x\\"" && git reset --hard',
      'echo "a\\"b" && git clean -fd',
      'echo "a\\"b" && git checkout -- .',
      'echo "a\\"b" && git push --force origin lane/x',
    ];
    for (const cmd of rows) {
      expect(decide(cmd, { foreignLiveLease: true }), cmd).toBeTruthy();        // #2367 unmarked-foreign
      expect(decide(cmd, { markedLeaseSlug: 'wf-slug-abc' }), cmd).toBeTruthy(); // #2413 marked, slug unasserted
    }
    // …and the owning caller's slug assertion still passes, escaped quote and all (no new false deny).
    expect(decide('echo "a\\"b" && LANE_SESSION=wf-slug-abc git reset --hard origin/main', { markedLeaseSlug: 'wf-slug-abc' })).toBeNull();
    expect(decide('echo "a\\"b" && LANE_CLOBBER_OK=1 git reset --hard origin/main', { foreignLiveLease: true })).toBeNull();
  });

  it('splitSegments honours bash\'s ACTUAL escape rules — per quote kind, not one rule everywhere', () => {
    // `"…"` — a backslash escapes the next char, so `\"` does NOT close the run.
    expect(splitSegments('git commit -m "a \\"b|c\\" d" && npm run build'))
      .toEqual(['git commit -m "a \\"b|c\\" d" ', ' npm run build']);
    // `$'…'` (ANSI-C) — same, for `\'`.
    expect(splitSegments("echo $'a\\'b' && npm run build")).toEqual(["echo $'a\\'b' ", ' npm run build']);
    // `'…'` — NOTHING is special, not even a backslash: the run ends at the very next `'`.
    // (verified against bash: `bash -c "echo 'a\\' && echo ok"` prints `a\` then `ok`.)
    expect(splitSegments("echo 'a\\' && npm run build")).toEqual(["echo 'a\\' ", ' npm run build']);
    // an unterminated run still consumes to end of string (unchanged fail-safe)
    expect(splitSegments('echo "a && npm run build')).toEqual(['echo "a && npm run build']);
  });

  it('shellTokens ends a quoted token at the REAL closing quote (the same desync, one layer down)', () => {
    expect(shellTokens('echo "a\\"b" > config/app.json').map((t) => t.text))
      .toEqual(['echo', 'a\\"b', '>', 'config/app.json']);
    expect(shellTokens("sed -i '' s/a/b/ /tmp/x").map((t) => t.text)).toEqual(['sed', '-i', '', 's/a/b/', '/tmp/x']);
  });
});

// ── #2994 review r2 — the runner-invocation parse ───────────────────────────────────────────────────────
describe('guard-bash — runnerInvocation reads a package-runner line the way the runner does (#2994 r2)', () => {
  it('an exec/dlx form yields the COMMAND, past any runner-level flags', () => {
    expect(runnerInvocation('pnpm exec vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec -- vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec --package=vite vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec --package=vite -- vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec --package vite vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec --yes vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('pnpm exec --silent vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('pnpm --filter web exec vite build')).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('yarn dlx -q eleventy')).toEqual({ exec: 'eleventy' });
    // npm's `--call/-c` hides the command inside a quoted argument
    expect(runnerInvocation("npm exec -c 'vite build'")).toEqual({ exec: 'vite build' });
    expect(runnerInvocation('npm exec --call="vite build"')).toEqual({ exec: 'vite build' });
    // the remainder is handed on VERBATIM — rejoining unquoted words would drop a `sed -i ''` empty argument
    expect(runnerInvocation("npm exec -- sed -i '' s/a/b/ config/app.json")).toEqual({ exec: "sed -i '' s/a/b/ config/app.json" });
  });

  it('a script form yields ONLY the script-name positions', () => {
    expect(runnerInvocation('npm run build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('npm run --silent build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('npm run --workspace=web build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('npm --workspace=web run build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('pnpm -r run build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('yarn workspace web build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('pnpm --filter web build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('yarn build')).toEqual({ names: ['build'] });
    expect(runnerInvocation('run-s build:check build')).toEqual({ names: ['build:check', 'build'] });
    expect(runnerInvocation('npm run test:unit -- src/build-graph.test.ts')).toEqual({ names: ['test:unit'] });
    // npm has no bare-script form — `npm install …` is never a script name
    expect(runnerInvocation('npm install --build-from-source better-sqlite3')).toEqual({ names: [] });
    expect(runnerInvocation('npm ls esbuild')).toEqual({ names: [] });
  });

  it('degenerate / non-runner input never throws and never invents a command', () => {
    expect(runnerInvocation('git status')).toBeNull();
    expect(runnerInvocation('')).toBeNull();
    expect(runnerInvocation('npm exec')).toEqual({ names: [] });
    expect(runnerInvocation('npm exec --')).toEqual({ names: [] });
    expect(runnerInvocation('npm exec -c')).toEqual({ exec: '' });
  });
});

describe('guard-bash — the shared normalizers the #2788 arms and canonicalGitOp both use (r3 finding 1)', () => {
  it('canonicalCommand peels the SAME wrapper table canonicalGitOp knows about', () => {
    for (const w of ['env', 'time', 'command', 'builtin', 'nice', 'sudo', 'npx'])
      expect(canonicalCommand(`${w} npm run build`)).toBe('npm run build');
    expect(canonicalCommand('FOO=1 BAR=2 npm run build')).toBe('npm run build');
    expect(canonicalCommand('env FOO=1 npm run build')).toBe('npm run build');
    expect(canonicalCommand('./node_modules/.bin/eleventy --quiet')).toBe('eleventy --quiet');
    expect(canonicalCommand('')).toBe('');
  });

  it('canonicalGitOp keeps its #2367 behaviour through the shared peeler', () => {
    expect(canonicalGitOp('env FOO=1 /usr/bin/git -C /x reset --hard')).toBe('git reset --hard');
    expect(canonicalGitOp('npm run build')).toBe('');
    expect(canonicalGitOp('')).toBe('');
  });

  it('splitSegments cuts on UNQUOTED separators only (#2994)', () => {
    // the ordinary separators still cut, and a run of them collapses to one cut
    expect(splitSegments('a && b').map((s) => s.trim())).toEqual(['a', 'b']);
    expect(splitSegments('a || b; c | d & e\nf').map((s) => s.trim())).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // …but a separator INSIDE quotes is text, in either quote style — this is the whole bug
    expect(splitSegments("gh pr list --jq '.[] | select(.n > 5)'")).toHaveLength(1);
    expect(splitSegments('gh pr list --jq ".[] | select(.n > 5)"')).toHaveLength(1);
    expect(splitSegments("echo 'a; b && c'")).toHaveLength(1);
    // the RAW text (quotes intact) is returned — every caller re-parses it
    expect(splitSegments("echo 'a | b' > x")[0]).toBe("echo 'a | b' > x");
    // a redirect operator run is consumed whole, so its glued `|`/`&` is never a separator
    expect(splitSegments('cmd >| x')).toHaveLength(1);
    expect(splitSegments('cmd 2>&1')).toHaveLength(1);
    expect(splitSegments('echo hi &> x')).toHaveLength(1);
    expect(splitSegments('cmd >> x')).toHaveLength(1);
    // an unterminated quote runs to end of string rather than dropping the tail
    expect(splitSegments("echo 'a | b")).toHaveLength(1);
    expect(splitSegments('')).toEqual(['']);
  });

  // The fifth false-deny class (#3002 sweep clause), pinned at the mechanism rather than the outcome.
  // The quote-blind split cut at the `|` inside `"a|=>"`, leaving the tail `=>" AGENTS.md`, in which the
  // `>` read as a redirect whose target was `AGENTS.md`. Cutting nothing keeps the `>` inside a quoted
  // run, where no redirect scan can reach it.
  it('splitSegments does not cut inside a quoted alternation, so a glued `=>` is not a redirect', () => {
    for (const cmd of [
      'grep -cE "a|=>" AGENTS.md', "grep -cE 'a|=>' AGENTS.md",
      'grep -cE "a|->" AGENTS.md', 'grep -cE "a|2>" AGENTS.md',
      'rg -e "x|y=>z" src',
    ]) expect(splitSegments(cmd)).toEqual([cmd]);
    // …and the operator OUTSIDE the quotes is still seen: one segment, redirect intact for the write scan
    expect(splitSegments('grep -cE "a|=>" AGENTS.md > out.txt')).toEqual(['grep -cE "a|=>" AGENTS.md > out.txt']);
    // the quoted `|` is not a separator, but an UNQUOTED one after it still is
    expect(splitSegments('grep -cE "a|=>" f | tee out.txt').map((s) => s.trim()))
      .toEqual(['grep -cE "a|=>" f', 'tee out.txt']);
  });

  it('the quote-aware split closes a real hole, not just the false denies (#2994)', () => {
    // BEFORE: the tear at the quoted pipe left the tail fragment with an UNBALANCED quote that swallowed
    // the trailing redirect, so a genuine primary-tree write was ALLOWED. Both directions are asserted.
    expect(decide("gh pr list --jq '.[] | .number' > config/app.json", { primaryCwd: true })).toMatch(/writing a file/);
    expect(decide("perl -i -pe 's/x|y/z/' config/app.json", { primaryCwd: true })).toMatch(/writing a file/);
    expect(decide("gh pr list --jq '.[] | .number' > /tmp/prs.json", { primaryCwd: true })).toBeNull();
  });

  it('isTreeWritingBuildRun reads only the runner SCRIPT-NAME position (#2986/2)', () => {
    expect(isTreeWritingBuildRun('npm run build')).toBe(true);
    expect(isTreeWritingBuildRun('yarn build')).toBe(true);          // yarn takes a bare script name
    expect(isTreeWritingBuildRun('run-s lint build')).toBe(true);    // every positional is a script name
    expect(isTreeWritingBuildRun('npm run lint src/build/')).toBe(false);
    expect(isTreeWritingBuildRun('npm install --build-from-source better-sqlite3')).toBe(false);
    expect(isTreeWritingBuildRun('npm install esbuild')).toBe(false); // npm has no bare-script form
    expect(isTreeWritingBuildRun('pnpm add node-gyp-build')).toBe(false);
    expect(isTreeWritingBuildRun('pnpm exec vite build')).toBe(true); // `exec` remainder is a COMMAND
  });

  it('the eleventy no-write flag allowlist, and what overrides it (#2986/3)', () => {
    expect(isTreeWritingBuildRun('eleventy --version')).toBe(false);
    expect(isTreeWritingBuildRun('eleventy --dryrun')).toBe(false);
    expect(isTreeWritingBuildRun('eleventy')).toBe(true);
    expect(isTreeWritingBuildRun('eleventy --serve')).toBe(true);
    expect(isTreeWritingBuildRun('eleventy --dryrun --serve')).toBe(true); // writing flags win
    expect(isTreeWritingBuildRun('eleventy --versionx')).toBe(true);       // prefix ≠ allowlisted
  });

  it("fileOperands drops an EMPTY operand, so BSD `sed -i ''` doesn't shift the target slice (#2986/1)", () => {
    expect(isFileWriteRedirect("sed -i '' s/a/b/ /tmp/scratch.txt")).toBe(false);
    expect(isFileWriteRedirect("sed -i '' s/a/b/ config/app.json")).toBe(true);
    expect(isFileWriteRedirect("sed -i '' -e s/a/b/ /tmp/scratch.txt")).toBe(false);
    expect(isFileWriteRedirect("tee '' config/app.json")).toBe(true);
  });

  it('shellTokens: quoting is resolved and redirect operators are split out with their fd prefix', () => {
    expect(shellTokens('echo hi > x').map((t) => t.text)).toEqual(['echo', 'hi', '>', 'x']);
    expect(shellTokens('echo hi>x').map((t) => t.text)).toEqual(['echo', 'hi', '>', 'x']);
    expect(shellTokens('cmd 2>&1').map((t) => t.text)).toEqual(['cmd', '2>&', '1']);
    expect(shellTokens('cmd >| x').map((t) => t.text)).toEqual(['cmd', '>|', 'x']);
    // a `>` inside quotes is TEXT, never an operator — this is what replaces the old end-of-segment anchor
    expect(shellTokens('git commit -m "fix > bug"').map((t) => t.text)).toEqual(['git', 'commit', '-m', 'fix > bug']);
    expect(shellTokens('git commit -m "fix > bug"').some((t) => t.op)).toBe(false);
  });

  it('stripHeredocBodies drops the BODY (and terminator) but keeps the opener line', () => {
    const cmd = "cat > /tmp/body.md <<'EOF'\nFix the > thing\nsed -i s/a/b/ config/app.json\nEOF\necho done";
    expect(stripHeredocBodies(cmd)).toBe("cat > /tmp/body.md <<'EOF'\necho done");
    expect(stripHeredocBodies('echo hi')).toBe('echo hi');
    // …so heredoc PROSE can never produce a phantom denial, while the heredoc's own target still can
    expect(decide(cmd, { primaryCwd: true })).toBeNull();
    expect(decide(cmd.replace('/tmp/body.md', 'config/app.json'), { primaryCwd: true })).toMatch(/writing a file/);
  });
});

// ── #2994 review r3 — the parser must FAIL CLOSED, never silently degrade ───────────────────────────────
// The mechanism behind every loosening this review found: the scanner reached a state it could not
// represent, consumed to end-of-string, and handed the deny arms ONE opaque blob in which nothing is
// anchored at command position — so the tree-write arm, the push arm, the rm-backlog arm and (via
// `hasDestructiveLaneOp`) the entire lane-clobber lease check all missed at once. These assertions pin the
// PROPERTY (an unrepresentable state denies), not the two shapes that happened to be reported.
describe('guard-bash — the parser fails CLOSED on input it cannot represent (#2994 r3)', () => {
  const CONTEXTS = [
    ['primary cwd', { primaryCwd: true }],
    ['a plain lane cwd', { primaryCwd: false }],
    ['a lane with a foreign unmarked lease (#2367)', { primaryCwd: false, foreignLiveLease: true }],
    ['a lane with a marked workflowLane lease (#2413)', { primaryCwd: false, markedLeaseSlug: 'wf-x1' }],
  ];

  it('an UNTERMINATED quote is denied in EVERY context — bash rejects the identical input', () => {
    const cmds = [
      "echo 'abc", 'echo "abc', "echo $'abc", 'echo $"abc',
      "echo 'abc\nnpm run build",                     // …and it can no longer swallow the next line
      'echo "abc\ngit reset --hard origin/main',
      "git commit -m 'oops\ngit push origin main",
      "npm run lint --msg='unclosed",
      'ls "a\nrm backlog/1234-a.md',
    ];
    for (const [label, ctx] of CONTEXTS)
      for (const c of cmds)
        expect(decide(c, ctx), `${label}: ${JSON.stringify(c)}`).toMatch(/UNTERMINATED quote/);
  });

  it('a BALANCED quote — including an apostrophe in a comment or a heredoc body — is NOT that state', () => {
    for (const c of [
      "echo 'abc'", 'echo "abc"', "echo $'a\\'b'", 'echo "a\\"b"', "echo 'a\\'",
      "ls # don't forget", 'ls # a "quoted" word', "ls # don't\nnpm run test:unit",
      "cat > /tmp/b.md <<'EOF'\ndon't do it\nit's fine — a \"quote\" too\nEOF",
      'git commit -m "it\'s fine"',
    ]) expect(unparseableReason(c), JSON.stringify(c)).toBeNull();
  });

  it('there is NO escape hatch for an unparseable command (there is no legitimate one)', () => {
    for (const esc of ['MAIN_SESSION_BUILD_OK=1 ', 'LANE_CLOBBER_OK=1 ', 'MAIN_PUSH_OK=1 ', 'STALE_LANE_OK=1 '])
      expect(decide(`${esc}echo 'abc`, { primaryCwd: true })).toMatch(/UNTERMINATED quote/);
  });

  it('parseSegments REPORTS its state instead of consuming to end of string', () => {
    expect(parseSegments("echo 'a | b").unterminated).toBe(true);
    expect(parseSegments("echo 'a | b'").unterminated).toBe(false);
    // F1 — the comment no longer opens a phantom quoted run, so the newline still cuts.
    const f1 = parseSegments("ls # don't\nnpm run build");
    expect(f1.unterminated).toBe(false);
    expect(f1.segments.map((s) => s.trim())).toEqual(["ls # don't", 'npm run build']);
    // …and a comment's text and separators are STILL handed on, so nothing is hidden from a deny rule.
    expect(parseSegments('ls # a; b').segments.map((s) => s.trim())).toEqual(['ls # a', 'b']);
    // F2 — `\`+newline is spliced the way bash splices it.
    const f2 = parseSegments('echo a && \\\nnpm run build');
    expect(f2.continued).toBe(true);
    expect(f2.segments.map((s) => s.trim())).toEqual(['echo a', 'npm run build']);
    expect(parseSegments('echo a \\\nb').segments).toEqual(['echo a b']);
    // …and the NAIVE reading, which `decide` also checks, reproduces the pre-#2994 text exactly.
    expect(parseSegments('echo a \\\nb', { spliceContinuations: false }).segments)
      .toEqual(['echo a \\', 'b']);
    // A lone trailing backslash is not a continuation at all.
    expect(parseSegments('echo a \\').segments).toEqual(['echo a \\']);
    expect(parseSegments('echo a \\').continued).toBe(false);
  });

  it('heredocScan only opens a heredoc at an UNQUOTED, un-commented `<<`', () => {
    expect(heredocScan('echo "x << EOF"\nnpm run build').text).toBe('echo "x << EOF"\nnpm run build');
    expect(heredocScan('ls # see <<EOF\nnpm run build').text).toBe('ls # see <<EOF\nnpm run build');
    expect(heredocScan("cat <<'EOF'\nbody\nEOF\nls").text).toBe("cat <<'EOF'\nls");
    // …and it reports an unterminated quote in the COMMAND text (a body's apostrophe is data, not a quote)
    expect(heredocScan('echo "abc\ncat <<EOF\nx\nEOF').unterminated).toBe(true);
    expect(heredocScan("cat <<'EOF'\ndon't\nEOF").unterminated).toBe(false);
  });

  it('canonicalCommand is quote-aware, and peels a subshell CLOSER as well as its opener', () => {
    expect(canonicalCommand('(pnpm --filter web exec vite build)')).toBe('pnpm --filter web exec vite build');
    expect(canonicalCommand('(vite build) \\')).toBe('vite build');
    expect(canonicalCommand('{ npm run build }')).toBe('npm run build');
    expect(canonicalCommand('sudo -u "some user" npm run build')).toBe('npm run build');
    expect(canonicalCommand('env "FOO=a b" npm run build')).toBe('npm run build');
    expect(canonicalCommand('echo "a)"')).toBe('echo "a)"');          // a bracket in quotes is not a closer
    expect(canonicalCommand("sed -i '' s/a/b/ /tmp/x")).toBe("sed -i '' s/a/b/ /tmp/x");  // quoting preserved
  });

  it("matches real bash on every parse state it models (bash -c, not an assumption)", () => {
    let bash;
    try { bash = (s) => execFileSync('bash', ['-c', s], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { return; }
    // `#` starts a comment only at a WORD boundary…
    expect(bash('echo a#b')).toBe('a#b');
    expect(bash('echo a #b')).toBe('a');
    expect(bash('x=abc; echo ${#x}')).toBe('3');
    expect(bash("echo 'a # b'")).toBe('a # b');
    // …an apostrophe inside one is not a quote, and the NEXT line really does run (F1)
    expect(bash("echo one # don't forget\necho two")).toBe('one\ntwo');
    // `\`+newline is a splice (F2), and a lone trailing backslash is dropped
    expect(bash('echo a && \\\necho b')).toBe('a\nb');
    expect(bash('echo a \\\nb')).toBe('a b');
    // r5 F3 — a LONE trailing backslash at end-of-input is bash-VERSION-dependent, so it is not a
    // fidelity fact this suite can pin: bash 3.2 (macOS, the author's shell) DROPS it and prints `a`;
    // bash 5 (the Linux CI runner) keeps it as literal text and prints `a \`. POSIX leaves it undefined.
    // Asserting `'a'` made CI red on this PR's own new test while passing locally — a suite that only
    // passes on one machine is worse than no suite. Both readings are accepted; what the GUARD does with
    // it is asserted separately (canonicalCommand peels it; the tokenizers keep it as literal text).
    expect(['a', 'a \\']).toContain(bash('echo a \\'));
    // an unterminated quote is a SYNTAX ERROR — denying it denies nothing that would have run
    expect(() => bash("echo 'abc")).toThrow();
    expect(() => bash('echo "abc')).toThrow();
  });
});

// ── #2994 review r5 — the text bash RE-EXECUTES, and the STRUCTURAL subshell closer ─────────────────────
// Round 4 made the segment split quote-CORRECT, which lost coverage the quote-BLIND split of base had by
// ACCIDENT: base tore `bash -c "git status && git push origin main"` at the `&&` inside the quoted
// argument, so the tail landed on the `git push` arm at command position. Reading the quoting properly
// keeps it as one argument of `bash`, which no arm inspects — while bash still really pushes. Every shape
// below was confirmed under REAL bash in a PATH-stubbed sandbox whose stubs log NUL-separated argv: a
// regression counted only when bash genuinely executed something the guard denies at command position.
describe('guard-bash — the guard follows the text bash re-executes (#2994 r5 F1)', () => {
  it('nestedCommandStrings reads every re-execution position', () => {
    expect(nestedCommandStrings('echo "$(git push origin main)"')).toContain('git push origin main');
    expect(nestedCommandStrings('echo `npm run build`')).toContain('npm run build');
    expect(nestedCommandStrings('bash -c "npm run build"')).toContain('npm run build');
    expect(nestedCommandStrings("sh -c 'vite build'")).toContain('vite build');
    expect(nestedCommandStrings('bash -ec "vite build"')).toContain('vite build');
    expect(nestedCommandStrings('eval "npm run build"')).toContain('npm run build');
    expect(nestedCommandStrings("npm exec -c 'vite build'")).toContain('vite build');
    expect(nestedCommandStrings('xargs -n1 bash -c "npm run build"')).toContain('npm run build');
    // a SCRIPT FILE argument is not a `-c` string
    expect(nestedCommandStrings('bash scripts/setup.sh')).toEqual([]);
    // …and a single-quoted body expands NOTHING, so there is no substitution inside it
    expect(nestedCommandStrings("echo '$(npm run build)'")).toEqual([]);
  });

  it('a `"…"` script string arrives with its escapes RESOLVED, the way the inner shell reads it', () => {
    // Keeping the `\"` verbatim made the `|` read as an unquoted separator and the tail `b > c\"` as a
    // real redirect — #2994's own false deny, re-created one level down.
    expect(nestedCommandStrings('sh -c "git commit -m \\"fix: a | b > c\\""'))
      .toContain('git commit -m "fix: a | b > c"');
    // a `\'…\'` string resolves nothing, so it is passed through verbatim
    expect(nestedCommandStrings("sh -c 'echo \\\"x\\\"'")).toContain('echo \\"x\\"');
  });

  it('a leading env-assignment is EXPORTED into the re-executed command, so the escape still disarms it', () => {
    // Verified against real bash: `FOO=1 bash -c 'echo $FOO'` prints 1 — and it reaches EVERY command in
    // the string, not just the first.
    expect(nestedCommandStrings('MAIN_SESSION_BUILD_OK=1 bash -c "npm run build && vite build"'))
      .toEqual(expect.arrayContaining([expect.stringContaining('MAIN_SESSION_BUILD_OK=1')]));
    expect(decide('MAIN_SESSION_BUILD_OK=1 bash -c "npm run build"', { primaryCwd: true })).toBeNull();
    expect(decide('MAIN_SESSION_BUILD_OK=1 sh -c "npm run build && npm run build:docs"', { primaryCwd: true })).toBeNull();
    expect(decide('MAIN_PUSH_OK=1 bash -c "git push origin main"', { primaryCwd: true })).toBeNull();
    // …but a substitution is expanded BEFORE the prefix applies, so it does NOT inherit it
    // (`FOO=1 echo "$(echo $FOO)"` prints empty) — assuming it did would be a loosening.
    expect(decide('MAIN_SESSION_BUILD_OK=1 echo "$(npm run build)"', { primaryCwd: true })).toMatch(/WRITES the shared PRIMARY tree/);
  });

  it('the five shapes that really executed under bash while the guard allowed them', () => {
    const at = (c) => decide(c, { primaryCwd: true });
    expect(at('bash -c "git status && git push origin main"')).toMatch(/direct push to `main`/);
    expect(at('bash -c "cd src && npm run build"')).toMatch(/WRITES the shared PRIMARY tree/);
    expect(at('eval "echo done; echo hi > config/app.json"')).toMatch(/redirect/);
    expect(at('OUT="$(cd . && npm run build)"')).toMatch(/WRITES the shared PRIMARY tree/);
    expect(at('echo "$(git status && git push origin main)"')).toMatch(/direct push to `main`/);
    // …and the separator-free spelling base never caught either
    expect(at('bash -c "npm run build"')).toMatch(/WRITES the shared PRIMARY tree/);
  });

  it('a substitution inside a DOUBLE-QUOTED run whose body has its own quotes is still read', () => {
    // Consuming the `"…"` run as one opaque span ended it at the `"` before `*.ts`, so the
    // substitution's tail (a real build) was never seen.
    expect(decide('echo "`find . -name "*.ts"; yarn build`"', { primaryCwd: true }))
      .toMatch(/WRITES the shared PRIMARY tree/);
    // …and an apostrophe in a `#` comment must not open a phantom quoted run over the NEXT line
    expect(decide("# a note — don't forget\necho `pnpm exec vite build`", { primaryCwd: true }))
      .toMatch(/WRITES the shared PRIMARY tree/);
  });

  it('the expansion is BOUNDED — a pathological nest neither wedges nor throws', () => {
    let cmd = 'npm run build';
    for (let i = 0; i < 200; i++) cmd = `bash -c "${cmd.replace(/"/g, '\\"')}"`;
    expect(() => decide(cmd, { primaryCwd: true })).not.toThrow();
    let subst = 'npm run build';
    for (let i = 0; i < 200; i++) subst = `echo "$(${subst})"`;
    expect(() => decide(subst, { primaryCwd: true })).not.toThrow();
  });
});

describe('guard-bash — a subshell closer is matched STRUCTURALLY, not positionally (#2994 r5 F2)', () => {
  it('one trailing token after the `)` no longer re-opens the hole', () => {
    const at = (c) => decide(c, { primaryCwd: true });
    for (const c of ['(pnpm exec vite build) >/dev/null', '(pnpm exec vite build) 2>/dev/null',
      '(pnpm exec vite build) #x', '(npm exec -- vite build) #x', '(vite build) >/dev/null 2>&1',
      '(pnpm exec vite build)'])
      expect(at(c)).toMatch(/WRITES the shared PRIMARY tree/);
  });

  it('…and the group\'s LAST command, which keeps the closer glued to it after the split', () => {
    expect(decide('(git status; pnpm dlx eleventy) >/dev/null', { primaryCwd: true }))
      .toMatch(/WRITES the shared PRIMARY tree/);
    expect(decide('(pkill vite; git status) #x', {})).toMatch(/Never kill the running dev server/);
  });

  it('the flag allowlists terminate on a group closer too, so a no-write command stays allowed', () => {
    // The same positional bug on the precision side: `--version)` was not recognised as `--version`.
    expect(decide('(eleventy --version) >/dev/null', { primaryCwd: true })).toBeNull();
    expect(decide('(eleventy --dryrun) 2>/dev/null', { primaryCwd: true })).toBeNull();
    // …and `--serve)` must still DENY — it really writes the site dir.
    expect(decide('(eleventy --serve) >/dev/null', { primaryCwd: true })).toMatch(/WRITES the shared PRIMARY tree/);
    // a flag that merely starts with an allowlisted name is still not on the allowlist
    expect(decide('(eleventy --versionx) >/dev/null', { primaryCwd: true })).toMatch(/WRITES the shared PRIMARY tree/);
    // …and `vite --outDir build-out` is not a `build` subcommand
    expect(isTreeWritingBuildRun('vite --outDir build-out preview')).toBe(false);
  });

  it('a quoted bracket is never a group closer', () => {
    expect(decide('echo "a)"', { primaryCwd: true })).toBeNull();
    expect(decide("git commit -m 'fix (a) thing'", { primaryCwd: true })).toBeNull();
    expect(nestedCommandStrings('echo "a)"')).toEqual([]);
  });
});

describe('guard-bash — the wrapper-peeled command word reaches every anchored arm (#2994 r5)', () => {
  it('a wrapper no longer hides pkill / rm / mv / sed / git push from their arm', () => {
    expect(decide('time rm backlog/2986-x.md', {})).toMatch(/Never delete a backlog/);
    expect(decide('time pkill -f vite', {})).toMatch(/Never kill the running dev server/);
    expect(decide('env FOO=1 git push origin main', {})).toMatch(/direct push to `main`/);
    expect(decide('/usr/bin/git push origin main', {})).toMatch(/direct push to `main`/);
    expect(decide('(pkill vite)', {})).toMatch(/Never kill the running dev server/);
  });

  it('a trailing token after the mv operands no longer disarms the renumber rule', () => {
    // The rule compared the first and LAST TOKEN, so a trailing comment word became the "destination",
    // carried no NNN, and a real renumber was allowed (confirmed executing under real bash).
    expect(decide('mv backlog/2986-x.md backlog/9999-y.md # trailing note', {})).toMatch(/Never renumber/);
    expect(decide('git mv backlog/2986-x.md backlog/9999-y.md >/dev/null', {})).toMatch(/Never renumber/);
    // …and a same-NNN slug rename is still fine
    expect(decide('git mv backlog/2986-x.md backlog/2986-y.md', {})).toBeNull();
  });

  it('a MENTION is still not an invocation', () => {
    expect(decide('git commit -m "stop using pkill vite"', {})).toBeNull();
    expect(decide('echo "rm backlog/2986-x.md"', {})).toBeNull();
    expect(decide('grep -rn "git push origin main" docs/', {})).toBeNull();
  });
});

/**
 * A commit under a HAND-SET identity. The box already ships the correct identity at `--global`, so an
 * override can only make authorship WRONG — and unsigned commits in a human's name land on `main` and stay
 * there. Observed 2026-08-24: four merged before the tip-commit check noticed.
 *
 * The arm is TOKEN-POSITIONAL rather than a regex over the raw text, and the false-positive cases below are
 * why: the first cut denied `git commit -m "docs: never pass -c user.email=foo"` — the commit that documents
 * this very rule. Same lesson the `pkill` arm already paid for.
 */
describe('commit identity override (#3269)', () => {
  it('denies every door onto the author/committer fields', () => {
    for (const cmd of [
      'git -c user.email=x@y.com commit -m hi',
      'git -c user.email=x -c user.name=Z commit -q -F -',
      'git -cuser.email=x@y commit -m hi',          // glued form — git accepts it
      'git commit --author="A <a@b.c>" -m hi',
      'git commit --author "A <a@b.c>" -m hi',
      'GIT_AUTHOR_EMAIL=a@b.c git commit -m hi',
      'GIT_COMMITTER_NAME=Z git commit -m hi',
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity by hand/);
  });

  it('leaves an ordinary commit, a config write, and an unrelated -c alone', () => {
    for (const cmd of [
      'git commit -m hi',
      'git config user.email noreply@anthropic.com',   // setting the MACHINE's identity is legitimate
      'git -c core.pager=cat log',
      'git -c core.pager=cat commit -m ok',            // a non-identity -c on a commit
      'git push origin HEAD:refs/heads/lane/x',
    ]) expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('never fires on a MESSAGE that merely mentions the flags', () => {
    // The regression that caught the first cut: prose is one quoted token, never argv.
    expect(decide('git commit -m "docs: never pass -c user.email=foo"', {})).toBeNull();
    expect(decide('git commit -m "note about --author= forms"', {})).toBeNull();
  });

  it('is not defeated by shell quoting — quoting is invisible to git (#1550 juror)', () => {
    // The first cut required the flag/subcommand token to be UNQUOTED, which made the arm trivially
    // evadable: all three of these override authorship while reading as "quoted, therefore prose".
    for (const cmd of [
      'git -c user.email=x@y "commit" -m hi',
      'git "-c" user.email=x@y commit -m hi',
      'GIT_AUTHOR_EMAIL="a@b.c" git commit -m hi',
      'git -c "user.email=x@y" commit -m hi',
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity by hand/);
  });

  it('skips a message VALUE by position, not by quoting', () => {
    // Prose only ever appears as the value of a message flag, so that is what is exempt — precisely.
    expect(decide('git commit -mquick', {})).toBeNull();          // glued -m
    expect(decide('git commit -F /tmp/msg.txt', {})).toBeNull();  // -F takes a path
  });

  it("folds case the way git's own config parser does (#1550 juror r2)", () => {
    // Verified against real git: `git -c User.Email=case@test.invalid commit` RECORDS that address.
    // Section and variable names fold, so a case-sensitive match was a bypass.
    for (const cmd of [
      'git -c User.Email=x@y commit -m hi',
      'git -c USER.NAME=Z commit -m hi',
      'git -c user.EMAIL=x@y commit -m hi',
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity by hand/);
  });

  it("does not fold the FLAG — -C is git's change-directory, a different thing", () => {
    expect(decide('git -C /some/path commit -m hi', {})).toBeNull();
  });

  it('catches an override that STRADDLES segments (#1550 juror r3)', () => {
    // `reason` sees one segment at a time, so neither half of `export GIT_AUTHOR_EMAIL=x && git commit`
    // trips it alone. Whole-command, same shape as backgroundedVerificationReason.
    for (const cmd of [
      'export GIT_AUTHOR_EMAIL=x@y.com && git commit -m hi',
      'GIT_COMMITTER_EMAIL=x@y; git commit -m hi',
      'git config user.email x@y.com && git commit -m hi',
      'git config --global User.Email x@y && git commit -m hi',   // key folds here too
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity/);
  });

  it('leaves an ordinary chained commit, and a standalone config write, alone', () => {
    // A `git config` write on its own is legitimate — the machine's identity is the operator's to set.
    for (const cmd of [
      'git add file.txt && git commit -m hi',
      'npm run test:unit -- a.test.mjs && git commit -m ok',
      'git config user.email noreply@anthropic.com',
      'git config user.email x@y && git log',
    ]) expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('does not over-reach — it must be GIT committing, and a config READ is not a write (#1550 juror r4)', () => {
    for (const cmd of [
      'git config user.email && echo commit',   // a READ, plus an unrelated word "commit"
      'git config user.email',                  // a READ on its own
      'npm run commit -- --author=me',          // not git
      'my-tool commit --author=x',              // not git
      'git -C /some/path commit -m hi',         // -C is change-directory
    ]) expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('still resolves git through a path or wrapper', () => {
    expect(decide('/usr/bin/git -c user.email=x commit -m hi', {})).toMatch(/identity by hand/);
  });

  it('cannot be spoofed by putting the escape in the MESSAGE (#1551 juror)', () => {
    // A real bypass: the escape was a raw substring test, so quoting it in `-m` disarmed the arm.
    for (const cmd of [
      'git -c user.email=evil@x commit -m "COMMIT_IDENTITY_OK=1"',
      'git -c user.email=evil@x commit -m "note: COMMIT_IDENTITY_OK=1 is the escape"',
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity by hand/);
  });

  it('does not read an env-var NAME inside a message as an assignment (#1551 juror)', () => {
    expect(decide('git commit -m "GIT_AUTHOR_EMAIL=x is an env var" && git commit -m two', {})).toBeNull();
  });

  it('accepts the escape only in env-PREFIX position, where bash actually exports it (#1551 r2)', () => {
    for (const cmd of [
      'git -c user.email=evil@x commit -m hi -- COMMIT_IDENTITY_OK=1',  // a pathspec
      'git -c user.email=evil@x commit COMMIT_IDENTITY_OK=1',           // a stray operand
      'git -c user.email=evil@x commit -m "COMMIT_IDENTITY_OK=1"',      // the message (r1)
    ]) expect(decide(cmd, {}), cmd).toMatch(/identity by hand/);
    // …and still honours it where it genuinely is an assignment.
    expect(decide('COMMIT_IDENTITY_OK=1 git -c user.email=x commit -m r', {})).toBeNull();
  });

  it('honours the sanctioned escape for a deliberate re-attribution', () => {
    expect(decide('COMMIT_IDENTITY_OK=1 git -c user.email=x commit -m repair', {})).toBeNull();
  });
});

/**
 * #3311 — a refusal blocks the WHOLE command, so it silently discards every OTHER step in the chain.
 *
 * The defect cost one session three incidents in a single day, all the same shape and all invisible: the
 * deny message named the git violation, the caller fixed exactly that, and never learned that the
 * `cat > file <<'EOF'` earlier in the same chain had also been dropped. Once it was reported as APPLIED,
 * because the follow-up tool was pointed at a file that had never been written.
 *
 * The fix is a NOTICE, not a behaviour change — see `collateralStepsNotice`'s header for why "gate at the
 * offending step and let the rest run" was rejected (it is strictly MORE permissive than today, it would
 * make the guard a shell rewriter, and it trades a visible failure for a subtle one). So the load-bearing
 * assertions here are the negative ones: `decide` must be byte-identical, and nothing may become allowed.
 */
describe('guard-bash — a refusal names the collateral it takes down with it (#3311)', () => {
  // The three real incidents, in the shape they were actually typed.
  const HEREDOC_THEN_ADD = "cat > /tmp/pr-body.md <<'EOF'\n## Summary\nwhat changed\nEOF\ngit add pr-body.md && git commit -m wip && git push origin main";
  const HEREDOC_THEN_FORCE_PUSH = "cat > /tmp/body.md <<'EOF'\nbody\nEOF\ngit commit -m fix && git push --force-with-lease origin main";

  it('the notice is STRICTLY additive — `decide` still returns exactly its own reason', () => {
    // The golden corpus (scripts/golden-corpus/hook-guard-bash/*.json) asserts decide()'s reason
    // byte-for-byte, and every arm's test matches on its own wording. Composing the notice into `decide`
    // would have churned all of it; it is composed at the CLI deny site instead.
    for (const cmd of [HEREDOC_THEN_ADD, HEREDOC_THEN_FORCE_PUSH, 'echo hi > /tmp/x && git push origin main']) {
      const r = decide(cmd, {});
      expect(r, cmd).toBeTruthy();
      expect(r, cmd).not.toMatch(/COLLATERAL/);
    }
    expect(decide('git push origin main', {}))
      .toBe(decide('cat > /tmp/b.md <<EOF\nx\nEOF\ngit push origin main', {}));
  });

  it('names the dropped heredoc and the dropped commit — incident 1 and incident 3', () => {
    const n = collateralStepsNotice(HEREDOC_THEN_ADD, {});
    expect(n).toMatch(/COLLATERAL \(#3311\)/);
    expect(n).toMatch(/cat > \/tmp\/pr-body\.md/);
    expect(n).toMatch(/heredoc body that exists ONLY in this command text/);
    expect(n).toMatch(/git add/);
    expect(n).toMatch(/git commit/);
    // …and it tells the caller the thing incident 2 got wrong: do not report these as done.
    expect(n).toMatch(/do NOT report them as done/);
    expect(collateralStepsNotice(HEREDOC_THEN_FORCE_PUSH, {})).toMatch(/writes \/tmp\/body\.md/);
  });

  it('a SCRATCH write counts here even though it does not count for the #2749 tree-write arm', () => {
    // The single most important asymmetry in this change. Every one of the three incidents wrote to /tmp —
    // scratch-ness says nothing about whether the caller will notice the file is missing, and a /tmp file is
    // if anything LESS likely to be missed, because nothing downstream is watching it.
    expect(fileWriteTargets('cat > /tmp/pr-body.md')).toEqual(['/tmp/pr-body.md']);
    expect(isFileWriteRedirect('cat > /tmp/pr-body.md')).toBe(false);          // #2749 arm: unchanged
    expect(collateralStepsNotice('cat > /tmp/pr-body.md <<EOF\nx\nEOF\ngit push origin main', {}))
      .toMatch(/\/tmp\/pr-body\.md/);
  });

  it('fileWriteTargets is the SAME path scan isFileWriteRedirect always did (extraction, not a rewrite)', () => {
    // isFileWriteRedirect is now `.some(non-scratch)` over this list; these pin that the list itself still
    // finds every spelling the #2749/#2986 arms depend on.
    expect(fileWriteTargets('echo x > config/app.json')).toEqual(['config/app.json']);
    expect(fileWriteTargets('echo x >> docs/notes.md')).toEqual(['docs/notes.md']);
    expect(fileWriteTargets('npm run build 2>&1')).toEqual([]);                 // fd dup writes no file
    expect(fileWriteTargets("sed -i '' s/a/b/ src/x.ts")).toEqual(['src/x.ts']); // #2986(1) BSD empty suffix
    expect(fileWriteTargets('tee -a reports/out.md')).toEqual(['reports/out.md']);
    expect(fileWriteTargets('env sed -i s/a/b/ src/x.ts')).toEqual(['src/x.ts']); // wrapper still peeled
    expect(fileWriteTargets('git status')).toEqual([]);
    // the boolean the tree-write arm reads is unmoved
    expect(isFileWriteRedirect('echo x > config/app.json')).toBe(true);
    expect(isFileWriteRedirect('echo x > /tmp/scratch.json')).toBe(false);
    expect(isFileWriteRedirect('npm run build 2>&1')).toBe(false);
    expect(primaryTreeWriteReason('echo x > config/app.json')).toMatch(/shell redirect/);
    expect(primaryTreeWriteReason('echo x > /tmp/scratch.json')).toBeNull();
  });

  it('stays SILENT when there is no collateral to name', () => {
    expect(collateralStepsNotice('git push origin main', {})).toBe('');        // single segment
    expect(collateralStepsNotice('git status && git push origin main', {})).toBe(''); // read-only neighbour
    expect(collateralStepsNotice('git log --oneline -5 | head; git push origin main', {})).toBe('');
    expect(collateralStepsNotice('cd /some/lane && npm run build', { primaryCwd: true })).toBe('');
  });

  it('does not list the OFFENDING step as collateral — the reason already names it', () => {
    const n = collateralStepsNotice('echo x > config/app.json && rm -rf dist', { primaryCwd: true });
    expect(n).toMatch(/rm -rf dist/);            // the neighbour that will be lost
    expect(n).not.toMatch(/config\/app\.json/);  // the step the deny message is about
  });

  it('refuses to GUESS on a command the parser cannot represent', () => {
    // An unterminated quote is already denied (unparseableReason); a guessed list of "what you lost" is
    // worse than no list, so the notice says nothing rather than segmenting text it cannot read.
    const bad = "cat > /tmp/x.md <<EOF\nbody\nEOF\ngit commit -m 'oops && git push origin main";
    expect(decide(bad, {})).toMatch(/UNTERMINATED quote/);
    expect(collateralStepsNotice(bad, {})).toBe('');
  });

  it('is bounded — a long chain summarises the tail instead of dumping it', () => {
    const many = Array.from({ length: 9 }, (_, i) => `touch /tmp/f${i}`).join(' && ') + ' && git push origin main';
    const n = collateralStepsNotice(many, {});
    expect(n).toMatch(/9 other step\(s\)/);
    expect(n).toMatch(/…and 4 more\./);
    expect(n.split('\n  • ').length - 1).toBe(6);   // 5 listed + the "…and N more" line
  });

  it('never throws — an advisory note must not be able to take the deny down with it', () => {
    for (const bad of [null, undefined, '', 42, {}, '  && git push origin main'])
      expect(() => collateralStepsNotice(bad, {})).not.toThrow();
  });

  it('reuses the #2749 tree-write predicates rather than a parallel list of its own', () => {
    // "What counts as writing the tree" must have ONE definition in this file, or the notice drifts from
    // the arm that denies it. These two shapes are recognised by isTreeWritingBuildRun/isGeneratorScriptRun.
    expect(collateralStepsNotice('npm run build && git push origin main', {})).toMatch(/tree-writing build/);
    expect(collateralStepsNotice('node scripts/generate-docs.mjs && git push origin main', {}))
      .toMatch(/generator\/scaffold script/);
    // …and at a PRIMARY cwd the build is the DENIED step, so it is not repeated as collateral.
    expect(collateralStepsNotice('cd /some/lane && npm run build', { primaryCwd: true })).toBe('');
  });

  it('resolves the program word the same way every deny arm does (wrappers, paths, quotes)', () => {
    const wrapped = "cat > /tmp/b.md <<EOF\nx\nEOF\nenv /usr/bin/git commit -m hi && git push origin main";
    expect(collateralStepsNotice(wrapped, {})).toMatch(/git commit/);
  });
});

describe('guard-bash — the collateral notice reaches the real deny channel (#3311, CLI boundary)', () => {
  // The house idiom for locating a sibling script (this file is `scripts/__tests__/*`) — a relative
  // `new URL(…, import.meta.url)` does NOT work here, because vitest rewrites `import.meta.url` to a
  // non-file base and `fileURLToPath` then rejects it.
  const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard-bash.mjs');
  const run = (command, cwd = '/tmp') => execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();

  it('a denied chain carries BOTH the original reason and the collateral list', () => {
    const out = run("cat > /tmp/pr-body.md <<'EOF'\nbody\nEOF\ngit add pr-body.md && git push origin main");
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    const msg = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(msg).toMatch(/^Blocked: direct push to `main` is blocked/);   // the reason is still FIRST, unchanged
    expect(msg).toMatch(/COLLATERAL \(#3311\)/);
    expect(msg).toMatch(/\/tmp\/pr-body\.md/);
    expect(msg).toMatch(/git add/);
  });

  it('a denied SINGLE command is byte-identical to what it was before the notice existed', () => {
    const msg = JSON.parse(run('git push origin main')).hookSpecificOutput.permissionDecisionReason;
    expect(msg).toBe('Blocked: ' + decide('git push origin main', {}));
  });

  it('an ALLOWED command is still allowed and still emits nothing — the notice cannot deny', () => {
    expect(run('git push origin HEAD:refs/heads/lane/x')).toBe('');
    expect(run("cat > /tmp/pr-body.md <<'EOF'\nbody\nEOF\ngit add pr-body.md && git commit -m hi")).toBe('');
  });
});

/**
 * #2968 — widen the `git add` hygiene guard to deny an ENUMERATED path set by EFFECT, not flag spelling.
 * PR #1064's own incident: a blocked `git add --intent-to-add --all` was RE-SPELLED as
 * `git ls-files --others --exclude-standard -z | xargs -0 git add --intent-to-add --` — the guard's old
 * flag-spelling matcher (never actually shipped as a persistent rule, only reasoned about in that PR's
 * review) would have missed it entirely. Four sink shapes reach the same effect; each gets its own case.
 */
describe('guard-bash — git add of an ENUMERATED path set is denied by EFFECT (#2968)', () => {
  it('DIRECT — `-A`/`--all`/a bare `.` enumerates on its own, no pipe needed', () => {
    for (const cmd of ['git add -A', 'git add --all', 'git add .', 'git add -A .', 'git add -- .'])
      expect(decide(cmd, {}), cmd).toMatch(/stages a path set you did not name/);
  });

  it('DIRECT — a QUOTED flag reaches git\'s argv identically, so quoting it is not an escape (adversarial review)', () => {
    for (const cmd of ['git add "-A"', "git add '-A'", 'git add "--all"', "git add '--all'"])
      expect(decide(cmd, {}), cmd).toMatch(/stages a path set you did not name/);
  });

  /**
   * PR #1816 review — CONFIRMED bypass: several spellings functionally identical to the four shapes above
   * still returned `allow`. `git add ./` is the same "everything under cwd" operand as a bare `.`; `-Av`/`-vA`
   * are POSIX-combined short-flag CLUSTERS equivalent to `-A -v` (git's own argv parsing does not care which
   * order the letters land in, or whether they're spelled as one token or two); and `git status -su` is the
   * SAME combined-cluster gap on the pipe-sink's enumeration-source side — `-s\b`'s word-boundary regex can
   * never match inside `-su` since a boundary only exists between a word char and a non-word char, and 's' and
   * 'u' are both word chars. Verified against real git 2.50.1 before fixing: `-su` == `-s -u`, but `-us`
   * actually errors ("Invalid untracked files mode 's'") because `-u` takes an optional attached argument that
   * consumes the rest of the cluster — so `-us` is deliberately NOT treated as an enumeration source below.
   */
  it('DIRECT — equivalent spellings of the bare-dot and combined-short-flag shapes (PR #1816 review)', () => {
    for (const cmd of ['git add ./', 'git add ./.', 'git add -Av', 'git add -vA', 'git add -fA', 'git add -Af'])
      expect(decide(cmd, {}), cmd).toMatch(/stages a path set you did not name/);
  });

  it('PIPE/XARGS SINK — a combined `git status -su` short-flag cluster reaches the same sink (PR #1816 review)', () => {
    for (const cmd of ['git status -su | xargs git add', 'git status -sb | xargs git add'])
      expect(decide(cmd, {}), cmd).toMatch(/stages a path set you did not name/);
  });

  it('PIPE/XARGS SINK — `git status -us` is NOT an enumeration source: `-u`\'s optional arg consumes the `s`, and real git rejects it outright (verified against git 2.50.1)', () => {
    expect(decide('git status -us | xargs git add', {})).toBeNull();
  });

  it('PIPE/XARGS SINK — the exact 2026-08 /converge read command (before its PR #1064 fix)', () => {
    expect(decide('git ls-files --others --exclude-standard -z | xargs -0 git add --intent-to-add --', {}))
      .toMatch(/stages a path set you did not name/);
    // …and the other named enumeration sources.
    for (const cmd of [
      'git status --porcelain | xargs git add',
      'find . -name "*.md" | xargs git add',
      'ls *.md | xargs git add',
    ]) expect(decide(cmd, {}), cmd).toMatch(/stages a path set you did not name/);
  });

  it('WHILE-READ SINK — a loop variable fed into `git add`', () => {
    expect(decide(
      "git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do git add -- \"$f\"; done", {},
    )).toMatch(/stages a path set you did not name/);
  });

  it('-exec SINK — `find … -exec git add … ;`/`+`', () => {
    expect(decide('find . -name "*.md" -exec git add {} \\;', {})).toMatch(/stages a path set you did not name/);
    expect(decide('find . -type f -exec git add {} +', {})).toMatch(/stages a path set you did not name/);
  });

  it('WHILE-READ/-exec text INSIDE quotes is DATA, not shell syntax — never denied (adversarial review)', () => {
    // The commit MESSAGE merely mentions the shapes above; none of it is actually executed as shell.
    for (const cmd of [
      'git commit -m "while read f; do git add \\"$f\\"; done"',
      'git commit -m "find . -exec git add {} \\\\;"',
      'echo "while read f; do git add $f; done"',
      'echo "find . -exec git add {} +"',
    ]) expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('an EXPLICIT named path set still passes — the sanctioned form the deny message steers to', () => {
    for (const cmd of [
      'git add path/a path/b',
      'git add -- path/a',
      'git ls-files --others --exclude-standard',                 // enumeration alone, no add sink
      'find . -name "*.md"',                                      // -exec absent
      'git status --porcelain',                                   // no pipe into add
    ]) expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('a narrow `git add` with an unrelated short-flag cluster (no `A`) still passes (PR #1816 review — no new false positive)', () => {
    for (const cmd of ['git add -p file.txt', 'git add -uv file.txt', 'git add -v path/a', 'git add path/a.dot'])
      expect(decide(cmd, {}), cmd).toBeNull();
  });

  it('a `;`/`&&`-separated ls-files and add are UNRELATED commands, not a pipeline — stays allowed', () => {
    // Only a real `|` implicates the enumeration source; `;`/`&&` just sequences two independent commands.
    expect(decide('git ls-files --others --exclude-standard; git add path/a', {})).toBeNull();
    expect(decide('git ls-files --others --exclude-standard && git add path/a', {})).toBeNull();
  });

  it('`||` is logical-or, not a data pipe — does not trip the pipe-sink shape', () => {
    expect(decide('git ls-files --others --exclude-standard || git add path/a', {})).toBeNull();
  });

  it('names the EFFECT, not a flag list, in the deny message (DoD)', () => {
    const msg = decide('git add -A', {});
    expect(msg).toMatch(/ENUMERATION/);
    expect(msg).not.toMatch(/^\s*flags?:/i);
  });
});

// ── The OPERATION spelling of a guarded raw home, and the truncating pipe (2026-09-06) ───────────────
// Both gaps are the same shape: the guard knew a raw home and not the operation that declares over it.
describe('operation forms of guarded commands', () => {
  it('denies a BACKGROUNDED run.mjs verify — it shells verify-lane, so it is the same #2833 stall', () => {
    // Measured: four backgrounded `run.mjs verify` calls in one session, two returning `unrun`.
    expect(backgroundedVerificationReason('node scripts/operations/run.mjs verify --checkout=/x', true))
      .toMatch(/SYNCHRONOUSLY in the FOREGROUND/);
  });

  it('still allows a backgrounded operation that is NOT a verification run', () => {
    expect(backgroundedVerificationReason('node scripts/operations/run.mjs scaffold --title=x', true)).toBeNull();
  });

  it('derives the operation list from DECLARED_HOMES, so a mere mention is not a run', () => {
    expect(isVerificationRun('echo "run.mjs verify is the operation"')).toBe(false);
  });
});

describe('truncated operation --json', () => {
  it('denies piping an operation --json into head/tail — it corrupts the value, not the view', () => {
    expect(truncatedOperationJsonReason('node scripts/operations/run.mjs review-pr --pr=1 --json | tail -40'))
      .toMatch(/corrupts the VALUE/);
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify --json | head -20')).toBe(true);
  });

  it('allows the two correct shapes: redirect to a file, or drop --json for the compact render', () => {
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify --json > /tmp/run.json')).toBe(false);
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify | tail -20')).toBe(false);
  });

  it('names both remedies AND the durable record, so the denial is actionable', () => {
    const r = truncatedOperationJsonReason('node scripts/operations/run.mjs verify --json | tail -5');
    expect(r).toMatch(/DROP `--json`/);
    expect(r).toMatch(/redirect to a file/);
    expect(r).toMatch(/\.operations\/runs/);
  });
});

// #1961 correctness finding 2 — the predicate was tested, its WIRING into decide() was not. decide() is
// what the Bash hook actually calls, so a predicate that is never reached from there enforces nothing.
describe('truncated operation --json — the enforcement path', () => {
  it('decide() DENIES the truncating pipe, not just the predicate in isolation', () => {
    // decide(), not reason(): the pipe spans two segments, so the per-segment path cannot see it.
    const d = decide('node scripts/operations/run.mjs review-pr --pr=1 --json | tail -40');
    expect(d).toBeTruthy();
    expect(String(d)).toMatch(/corrupts the VALUE/);
  });

  it('decide() still allows both correct shapes', () => {
    expect(decide('node scripts/operations/run.mjs verify --json > /tmp/run.json')).toBeFalsy();
    expect(decide('node scripts/operations/run.mjs verify | tail -20')).toBeFalsy();
  });
});

// #1961 review r3 — the truncating-`--json` predicate, scoped to ONE PIPELINE. The juror confirmed a false
// positive across a statement separator; verifying it turned up two more defects in the same regex, so all
// three are pinned here. Mutating `isTruncatedOperationJson` back to a whole-string `[^|]*` regex reddens
// this block, and dropping the `node` anchor reddens the mention case on its own.
describe('truncated operation --json — pipeline scoping, not string scanning', () => {
  it('DENIES the payload-eating pipe, including through an intermediate stage', () => {
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs review-pr --pr=1 --json | tail -40')).toBe(true);
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify --json | head -20')).toBe(true);
    // The FALSE NEGATIVE the first cut shipped: an intervening `|` broke its `[^|]*` run, so the guard walked
    // straight past the exact corruption it exists to stop.
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify --json | jq . | tail -5')).toBe(true);
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify --json | jq . | LC_ALL=C tail -5')).toBe(true);
  });

  it('ALLOWS a safe redirect followed by an unrelated pipe in a LATER statement', () => {
    // The juror's finding: the JSON is already on disk and the `tail` belongs to a different command. A
    // separator ends the pipeline; only `|` continues it.
    for (const sep of [';', '&&', '||', '\n']) {
      const cmd = `node scripts/operations/run.mjs verify --json > /tmp/run.json ${sep} git log | tail -5`;
      expect(isTruncatedOperationJson(cmd), `separator ${JSON.stringify(sep)}`).toBe(false);
    }
  });

  it('ALLOWS a MENTION — anchored on the runner, so prose about a command is not the command', () => {
    // The first cut had no `node` anchor while the PR body claimed it did; this is that claim, made true.
    expect(isTruncatedOperationJson('echo "run.mjs verify --json" | tail -5')).toBe(false);
    expect(isTruncatedOperationJson('grep -n "run.mjs .* --json" docs/*.md | head -5')).toBe(false);
  });

  it('ALLOWS the two shapes that were never the defect', () => {
    expect(isTruncatedOperationJson('node scripts/operations/run.mjs verify | tail -20')).toBe(false); // no --json
    expect(isTruncatedOperationJson('cat notes.txt | tail -5')).toBe(false);                           // not an operation
    expect(isTruncatedOperationJson('')).toBe(false);
  });

  it('still reaches decide() — the enforcement point, not just the predicate', () => {
    expect(String(decide('node scripts/operations/run.mjs review-pr --pr=1 --json | tail -40'))).toMatch(/corrupts the VALUE/);
    expect(decide('node scripts/operations/run.mjs verify --json > /tmp/run.json; git log | tail -5')).toBeFalsy();
  });
});

// #3627 — the delivery agent's OWN Bash session (`--restricted`, spawned by
// `we:scripts/operations/deliver-item-wrapper.mjs`'s `CLAUDE_RESTRICTED_PROVIDER`) may never run any of the
// mechanical lifecycle commands its own wrapper drives end to end. Scoped via `dispatchKind === 'delivery'` —
// the SAME `WE_DISPATCH_KIND` channel the #3105 dispatched-verification arm above already reads, now also
// stamped by `CLAUDE_RESTRICTED_PROVIDER.spawn`. Every arm here is `reason(segment, { dispatchKind })`-level
// (the per-segment table), never `decide`-only, EXCEPT the last describe block, which proves the real
// enforcement point (`decide`) denies too, not just the pure predicate.
describe('guard-bash — a delivery agent may never run the mechanical lifecycle commands itself (#3627)', () => {
  it('denies `lane-pool.mjs` (any subcommand) for a delivery-agent session', () => {
    expect(reason('node scripts/lane-pool.mjs acquire --lane=3', { dispatchKind: 'delivery' })).toMatch(/lane-pool\.mjs/);
    expect(reason('node scripts/lane-pool.mjs status --json', { dispatchKind: 'delivery' })).toMatch(/lane-pool\.mjs/);
    expect(reason('node scripts/lane-pool.mjs release --lane=3', { dispatchKind: 'delivery' })).toMatch(/lane-pool\.mjs/);
  });

  it('denies `backlog.mjs claim` and `backlog.mjs release` for a delivery-agent session', () => {
    expect(reason('node scripts/backlog.mjs claim 1234 --session=x', { dispatchKind: 'delivery' })).toMatch(/backlog\.mjs claim/);
    expect(reason('node scripts/backlog.mjs release 1234 --session=x', { dispatchKind: 'delivery' })).toMatch(/backlog\.mjs release/);
  });

  it('denies `gh pr` (any subcommand) for a delivery-agent session', () => {
    expect(reason('gh pr view 1234', { dispatchKind: 'delivery' })).toMatch(/gh pr/);
    expect(reason('gh pr create --title=x --body=y', { dispatchKind: 'delivery' })).toMatch(/gh pr/);
    expect(reason('gh pr merge 1234', { dispatchKind: 'delivery' })).toMatch(/gh pr/); // the delivery-scoped arm, not just the #2290 merge-only arm
  });

  it('denies `run.mjs open-pr` and `open-pr.mjs` for a delivery-agent session', () => {
    expect(reason('node scripts/operations/run.mjs open-pr --ref=lane/1234-x --sha=HEAD --base=main', { dispatchKind: 'delivery' })).toMatch(/open-pr/);
    expect(reason('node scripts/operations/open-pr.mjs', { dispatchKind: 'delivery' })).toMatch(/open-pr/);
  });

  it('denies `pr-land.mjs` for a delivery-agent session', () => {
    // The `--require-verified` flag is NOT what this case asserts — the deny keys on the script path alone and
    // is flag-independent. It is spelled out because #3321's caller sweep (`we:scripts/__tests__/lane-verify.test.mjs`)
    // harvests EVERY flagged pr-land.mjs command string any tracked file ships and requires each one to
    // declare its verification posture. That sweep has exactly one exclusion (pr-land's own --help banner) and
    // says in-file that the exclusion must be re-argued, never silently widened — so a deny FIXTURE carries the
    // posture too rather than becoming exclusion number two. `--no-require-verified` is the sweep's own
    // sanctioned flag arm (its mutation probe injects exactly that spelling), and it is the honest one for a
    // fixture: this string is INPUT TO A DENY PREDICATE, never executed, so no verification is skipped by it.
    expect(reason('node scripts/pr-land.mjs --no-require-verified --pr=1234', { dispatchKind: 'delivery' })).toMatch(/pr-land\.mjs/);
  });

  it('denies `learnings-drop.mjs` for a delivery-agent session', () => {
    expect(reason('node scripts/conveyor/learnings-drop.mjs --kind=friction --summary=x --area=y --suggestion=z', { dispatchKind: 'delivery' })).toMatch(/learnings-drop\.mjs/);
  });

  it('denies `converge-cli.mjs` for a delivery-agent session', () => {
    expect(reason('node scripts/converge-cli.mjs init --lane=/lane-3 --state=/lane-3/.converge-state.json', { dispatchKind: 'delivery' })).toMatch(/converge-cli\.mjs/);
    expect(reason('node scripts/converge-cli.mjs step --state=/lane-3/.converge-state.json', { dispatchKind: 'delivery' })).toMatch(/converge-cli\.mjs/);
  });

  it('denies `verify-lane.mjs` for a delivery-agent session in EVERY mode — including `request`/`check`/`reset`, '
    + 'unlike the #3105 build/fix/ci-heal carve-out (a delivery agent never runs the gate at all, not even the poll form)', () => {
    expect(reason('node scripts/verify-lane.mjs --json', { dispatchKind: 'delivery' })).toMatch(/verify-lane\.mjs/);
    expect(reason('node scripts/verify-lane.mjs request', { dispatchKind: 'delivery' })).toMatch(/verify-lane\.mjs/);
    expect(reason('node scripts/verify-lane.mjs check', { dispatchKind: 'delivery' })).toMatch(/verify-lane\.mjs/);
  });

  it('denies `review-core-cli.mjs` for a delivery-agent session', () => {
    expect(reason('node scripts/review-core-cli.mjs invite --file=x.json --json', { dispatchKind: 'delivery' })).toMatch(/review-core-cli\.mjs/);
  });

  it('never fires for an interactive session or any OTHER dispatch kind — scoped strictly to `delivery`', () => {
    const commands = [
      'node scripts/lane-pool.mjs acquire --lane=3',
      'node scripts/backlog.mjs claim 1234 --session=x',
      'gh pr view 1234',
      'node scripts/operations/run.mjs open-pr --ref=lane/1234-x',
      'node scripts/pr-land.mjs --no-require-verified --pr=1234', // flag spelled out for #3321's sweep — see above
      'node scripts/conveyor/learnings-drop.mjs --kind=friction',
      'node scripts/converge-cli.mjs init --lane=/lane-3',
      'node scripts/verify-lane.mjs request',
      'node scripts/review-core-cli.mjs invite --file=x.json',
    ];
    for (const cmd of commands) {
      expect(reason(cmd, {}), cmd).toBeNull();
      expect(reason(cmd), cmd).toBeNull();
      expect(reason(cmd, { dispatchKind: null }), cmd).toBeNull();
      expect(reason(cmd, { dispatchKind: 'build' }), cmd).toBeNull(); // a DIFFERENT dispatch kind — not this table
    }
  });

  it('does NOT over-block ordinary build/test/git commands for a delivery-agent session', () => {
    const ordinary = [
      'npm run test:unit -- scripts/operations/__tests__/deliver-item-wrapper.test.mjs', // xpnhz4o: a BARE full suite is denied for every session
      'npm run test:unit -- scripts/operations/__tests__/deliver-item-wrapper.test.mjs',
      'npm run check:standards',
      'node --test scripts/operations/__tests__/deliver-item-wrapper.test.mjs',
      'git status',
      'git diff',
      'git add scripts/operations/deliver-item-wrapper.mjs',
      'git commit -m "build item #1234"',
      'node scripts/some-other-tool.mjs --flag=lane-pool-ish-but-not-really',
    ];
    for (const cmd of ordinary) {
      expect(reason(cmd, { dispatchKind: 'delivery' }), cmd).toBeNull();
    }
  });

  it('reaches decide() — the real enforcement point, not just the pure per-segment predicate', () => {
    expect(String(decide('node scripts/lane-pool.mjs acquire --lane=3', { dispatchKind: 'delivery' }))).toMatch(/lane-pool\.mjs/);
    expect(String(decide('gh pr merge 1234', { dispatchKind: 'delivery' }))).toMatch(/gh pr/);
    // chained: the deny fires even when the denied command sits alongside an otherwise-benign one
    expect(String(decide('git status && node scripts/verify-lane.mjs check', { dispatchKind: 'delivery' }))).toMatch(/verify-lane\.mjs/);
    // an ordinary, undenied chain still passes clean under the same dispatchKind. (`npm test`/check:standards
    // are deliberately NOT used here — those are already denied for ANY dispatchKind by the pre-existing
    // #3105 arm above, which is correct and unrelated to this new table.)
    expect(decide('git status && git add -- scripts/x.mjs && git commit -m "build item #1234"', { dispatchKind: 'delivery' })).toBeNull();
    // the identical commands, no dispatchKind at all (interactive) — untouched
    expect(decide('node scripts/lane-pool.mjs acquire --lane=3')).toBeNull();
  });
});

// PR #2570 review — the `repair` (#3640), `decision-authoring` (#3644) and `scope-authoring` (#3642) deny
// tables had no test passing their dispatchKind, so disabling any of them left every test green. Each kind is
// driven through EVERY arm it owns (one command per arm), through decide() as well as reason(), and each is
// checked to stay scoped to its own kind.
const LIFECYCLE_ARMS = {
  'lane-pool': ['node scripts/lane-pool.mjs acquire --lane=3', /lane-pool\.mjs/],
  'backlog claim': ['node scripts/backlog.mjs claim 1234 --session=x', /backlog\.mjs claim/],
  'backlog release': ['node scripts/backlog.mjs release 1234 --session=x', /backlog\.mjs release/],
  'gh pr': ['gh pr view 1234', /gh pr/],
  'open-pr.mjs': ['node scripts/operations/open-pr.mjs', /open-pr/],
  'run.mjs open-pr': ['node scripts/operations/run.mjs open-pr --ref=lane/1234-x', /open-pr/],
  // flag spelled out for #3321's pr-land caller sweep — see the delivery block above
  'pr-land': ['node scripts/pr-land.mjs --no-require-verified --pr=1234', /pr-land\.mjs/],
  'learnings-drop': ['node scripts/conveyor/learnings-drop.mjs --kind=friction', /learnings-drop\.mjs/],
  'converge-cli': ['node scripts/converge-cli.mjs init --lane=/lane-3', /converge-cli\.mjs/],
  'verify-lane request': ['node scripts/verify-lane.mjs request', /verify-lane\.mjs/],
  'verify-lane check': ['node scripts/verify-lane.mjs check', /verify-lane\.mjs/],
  'review-core-cli': ['node scripts/review-core-cli.mjs invite --file=x.json', /review-core-cli\.mjs/],
};
const KIND_ONLY_ARMS = {
  'decision-authoring': {
    'backlog prepare-stamp': ['node scripts/backlog.mjs prepare-stamp 1234', /prepare-stamp/],
    'backlog prepare-hold': ['node scripts/backlog.mjs prepare-hold 1234', /prepare-hold/],
    'backlog prepare-release': ['node scripts/backlog.mjs prepare-release 1234', /prepare-release/],
    'backlog resolve': ['node scripts/backlog.mjs resolve 1234', /backlog\.mjs resolve/],
  },
  'scope-authoring': {
    'backlog resolve': ['node scripts/backlog.mjs resolve 1234', /backlog\.mjs resolve/],
    'git commit': ['git commit -m "scope: predict #1234"', /git commit/],
  },
};
describe.each([
  ['repair', /repair \(fix \/ ci-heal\) agent/],
  ['decision-authoring', /decision-authoring agent/],
  ['scope-authoring', /scope-authoring agent/],
])('guard-bash — a %s wrapper agent may never run the mechanical lifecycle commands itself', (kind, whoRe) => {
  const arms = Object.entries({ ...LIFECYCLE_ARMS, ...(KIND_ONLY_ARMS[kind] || {}) });
  it.each(arms)('denies %s — via reason() and decide(), naming the kind', (_arm, [cmd, armRe]) => {
    const r = reason(cmd, { dispatchKind: kind });
    expect(r, cmd).toMatch(armRe);
    expect(r, cmd).toMatch(whoRe);
    expect(String(decide(`git status && ${cmd}`, { dispatchKind: kind })), cmd).toMatch(whoRe);
  });
  it.each(arms)('never fires for an interactive session — %s', (_arm, [cmd]) => {
    expect(String(reason(cmd, {}) ?? '')).not.toMatch(whoRe);
    expect(String(reason(cmd, { dispatchKind: 'build' }) ?? '')).not.toMatch(whoRe);
  });
  it('does NOT over-block ordinary read/test/git commands', () => {
    const ordinary = ['git status', 'git diff', 'git add scripts/x.mjs', 'node --test scripts/x.test.mjs', 'gh issue view 1'];
    if (kind !== 'scope-authoring') ordinary.push('git commit -m "x"');
    for (const cmd of ordinary) expect(reason(cmd, { dispatchKind: kind }), cmd).toBeNull();
  });
});

describe('guard-bash — every script-scanning regex is linear on hostile runs (#2108 review r6)', () => {
  const runs = [' ', '\t', '\\', ';', '{', '/', '\\/', '; ', '{ ', ';/', 's', 'w ', 'e '];
  const wrappers = [
    (p) => `sed -n '${p}x' backlog/a.md`,
    (p) => `sed -n ';${p}' backlog/a.md`,
    (p) => `sed -n '{${p}' backlog/a.md`,
    (p) => `sed -n -e '${p}' backlog/a.md`,
    (p) => `sed 's/a/b/${p}' backlog/a.md`,
    (p) => `perl -ne '${p}' backlog/a.md`,
    (p) => `perl -e 'open(${p}' backlog/a.md`,
    (p) => `perl -e 'print "${p}' backlog/a.md`,
    (p) => `perl -e 'open(F,">${p}' backlog/a.md`,
    (p) => `perl -e 'open(F,">", "${p}' backlog/a.md`,
    // Corpus text reaches the allow-list, including literal blanking and interpolated code.
    (p) => `perl -e 'print "backlog/a.md"; ${p}'`,
    (p) => `perl -e 'print "backlog/a.md @{${p}}"'`,
  ];
  it.each(wrappers.flatMap((wrap, w) => runs.map((run) => [w, JSON.stringify(run), wrap(run.repeat(3000))])))
    ('bounds wrapper %s with run %s', (_wrapper, _run, cmd) => {
      const start = performance.now();
      fileWriteTargets(cmd);
      expect(performance.now() - start).toBeLessThan(250);
    });
  it.each([
    "sed -n '1s/a/b/w backlog/x.md' f",
    "sed -n '/x/Is/a/b/w backlog/x.md' f",
    "sed -n '/x/IMs/a/b/w backlog/x.md' f",
    "sed -n '$!s/a/b/w backlog/x.md' f",
    "sed 's/a/b/e' backlog/x.md",
    "sed '/x/Is/a/b/e' backlog/x.md",
  ])('the s-command start bound still finds a real write/exec: %s', (cmd) => {
    expect(reason(cmd), cmd).toMatch(/locus-prefix/);
  });
  it('bounds the exact reviewer whitespace repro', () => {
    const cmd = `sed -n '${' '.repeat(3000)}x' f`;
    const start = performance.now();
    fileWriteTargets(cmd);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('guard-bash — GNU-abbreviated long options and variable-held flags fail closed (#2108 review r6)', () => {
  const denied = (c) => expect(reason(c), c).toMatch(/locus-prefix/);
  const allowed = (c) => expect(reason(c), c).toBeNull();
  it.each([
    ...['--in', '--i', '--in-pl', '--in-pla', '--in-place', '--in-place=.bak'].map((flag) => `sed ${flag} s/x/y/ backlog/a.md`),
    'gsed --in-pl s/x/y/ backlog/a.md',
    'sed --i --expr=s/x/y/ backlog/a.md',
    'sed --in --expression s/x/y/ backlog/a.md',
    'sed --in --fil=x.sed backlog/a.md',
    'sed --in --file x.sed backlog/a.md',
    'sed --expr=s/x/y/w\\ backlog/a.md f',
    "sed --expr='w backlog/x.md' f",
    'sed --l 80 --in s/x/y/ backlog/a.md',
    'sed --line-length=80 --i s/x/y/ backlog/a.md',
    "sed --e 'w backlog/a.md' f",
    'sed --in --fi x.sed backlog/a.md',
    'sed $OPTS s/x/y/ backlog/a.md',
    'sed ${I} s/x/y/ backlog/a.md',
    'sed "$OPTS" s/x/y/ backlog/a.md',
    'sed -$X s/x/y/ backlog/a.md',
    "perl $OPTS -e 's/x/y/' backlog/a.md",
    'sed --$L s/x/y/ backlog/a.md',
    'sed --in-$Y s/x/y/ backlog/a.md',
    'sed -n$X s/x/y/ backlog/a.md',
    'sed "${I}" s/x/y/ backlog/a.md',
    'sed "$(flags)" s/x/y/ backlog/a.md',
    'sed `flags` s/x/y/ backlog/a.md',
    "perl -n$X -e 's/x/y/' reports/a.md",
  ])('denies hidden editor flags or abbreviated writes: %s', denied);
  it.each([
    'sed --follow-symlinks -n p backlog/a.md',
    'sed --fo -n p backlog/a.md',
    'sed --quiet --expr=p backlog/a.md',
    'sed --in s/x/y/ /tmp/x.md',
    'sed $OPTS s/x/y/ /tmp/x.md',
    "sed -n '$p' backlog/a.md",
    "sed -n 's/x$/y/' backlog/a.md",
    "sed -n -e '$p' backlog/a.md",
    "perl -ne 'print $x' backlog/a.md",
    "perl -e'print $x' backlog/a.md",
    "sed -n '${START}p' backlog/a.md",
    'sed --f -n p backlog/a.md',
    'sed --unknown -n p backlog/a.md',
    'sed --in --f s/x/y/ /tmp/x.md',
    "sed -ne'$p' backlog/a.md",
    "sed --expr='$p' backlog/a.md",
    'sed -f $SCRIPT backlog/a.md',
    "perl -I $LIB -e 'print' backlog/a.md",
    "perl -Mfeature=say -e 'say' backlog/a.md",
  ])('allows read-only and scratch twins: %s', allowed);
});

describe('guard-bash — a perl script naming a corpus path must be provably read-only (#2108 review r6)', () => {
  const denied = (c) => expect(reason(c), c).toMatch(/locus-prefix/);
  const allowed = (c) => expect(reason(c), c).toBeNull();
  it.each([
    ...[
      'sed -i s/x/y/ backlog/a.md', 'perl -pi -e s/x/y/ backlog/a.md',
      'git checkout -- backlog/a.md', 'patch backlog/a.md < x.diff', 'rm backlog/a.md',
    ].map((cmd) => `perl -e 'system("${cmd}")'`),
    `perl -e 'system("printf","x",">","backlog/a.md")'`,
    ...['append', 'edit', 'edit_lines', 'touch', 'remove', 'spew_utf8'].map((method) =>
      `perl -e 'path("backlog/a.md")->${method}("x")'`),
    `perl -e 'File::Slurper::write_text("backlog/a.md","x")'`,
    `perl -e 'IO::File->new("backlog/a.md","w")'`,
    `perl -e 'File::Path::remove_tree("backlog/a.md")'`,
    `perl -MFile::Slurper=write_text -e 'write_text("backlog/a.md","x")'`,
    `perl -e 'eval "unlink q(backlog/a.md)"'`,
    `perl -e '&system("rm backlog/a.md")'`,
    ...['exec', 'qx', 'require', 'use', 'do', 'unlink'].map((name) => `perl -e '${name} "backlog/a.md"'`),
    ...['s', 'm', 'y', 'tr', 'q', 'qq', 'qw', 'qr'].map((op) => `perl -e '${op}/backlog\/a.md/'`),
    `perl -e 'print "@{[system(q(rm backlog/a.md))]}"'`,
    'perl -e \'print "${\\system(q(rm backlog/a.md))}"\'',
    `perl -e 'print "$(system(q(rm backlog/a.md)))"'`,
    "perl - backlog/a.md <<'X'\nopen(F,\">\",shift)\nX",
  ])('denies corpus code outside the read-only vocabulary: %s', denied);
  it.each([
    `perl -e 'open(F,"<","backlog/x.md"); while(<F>){print}'`,
    `perl -e 'print "see backlog/x.md\\n"'`,
    `perl -e 'open(IN, "<", "reports/a.md"); my @l = <IN>; print scalar(@l)'`,
    `perl -e 'open(F,"<","backlog/x.md"); print <F>'`,
    `perl -e 'print "see backlog/x.md"'`,
    `perl -e 'open(F,">","/tmp/x.txt")'`,
    `perl -e 'my $system = "backlog/a.md"; print $system'`,
    `perl -e 'print "system backlog/a.md"'`,
    `perl -e 'print "backlog/a.md", "escaped \\"quote\\""'`,
    'perl - /tmp/x.md',
    "perl - /tmp/x.md <<'X'\nopen(F,\">\",shift)\nX",
  ])('allows provably read-only corpus code and scratch stdin: %s', allowed);
});

describe('rawHeavyCommandReason — a direct vitest/playwright/eleventy run skips the #3461 admission queue (xxna58l, #3383)', () => {
  it('vitestRunFileTargetCount counts non-flag tokens only', () => {
    expect(vitestRunFileTargetCount('')).toBe(0);
    expect(vitestRunFileTargetCount(' --coverage')).toBe(0);
    expect(vitestRunFileTargetCount(' a.test.mjs')).toBe(1);
    expect(vitestRunFileTargetCount(' a.test.mjs b.test.mjs')).toBe(2);
    expect(vitestRunFileTargetCount(' --coverage a.test.mjs b.test.mjs')).toBe(2);
    expect(vitestRunFileTargetCount(' a.test.mjs b.test.mjs c.test.mjs')).toBe(3);
  });

  it('does not count redirections or a flag value as file targets (#3383, the live miscounts of 2026-09-23)', () => {
    expect(vitestRunFileTargetCount(' a.test.mjs 2>&1')).toBe(1);
    expect(vitestRunFileTargetCount(' a.test.mjs > ../out.log 2>&1')).toBe(1);
    expect(vitestRunFileTargetCount(' a.test.mjs >../out.log')).toBe(1);
    expect(vitestRunFileTargetCount(' --root /w/lane-2 a.test.mjs')).toBe(1);
    expect(vitestRunFileTargetCount(' a.test.mjs -t "start edge"')).toBe(1);
    expect(vitestRunFileTargetCount(' a.test.mjs --testNamePattern=x')).toBe(1);
    // a whole-suite run with only a redirection is still the whole suite
    expect(vitestRunFileTargetCount(' > out.log 2>&1')).toBe(0);
    expect(rawHeavyCommandReason('npx vitest run a.test.mjs 2>&1')).toMatch(/heavy-enforce/);
    expect(rawHeavyCommandReason('npx vitest run > out.log 2>&1')).toMatch(/heavy-enforce/);
  });

  it('denies a raw whole-suite `vitest run` (no files named), bare or via npx', () => {
    expect(rawHeavyCommandReason('vitest run')).toMatch(/heavy-enforce/);
    expect(rawHeavyCommandReason('npx vitest run')).toMatch(/heavy-enforce/); // xpnhz4o — never steers to the (denied) bare test:unit
    expect(rawHeavyCommandReason('npx vitest run --coverage')).toMatch(/heavy-enforce/); // a flag alone names no file
  });

  it('denies a targeted run of 1 or 2 explicit test files, bare or via npx, flags or not', () => {
    expect(rawHeavyCommandReason('npx vitest run scripts/foo.test.mjs')).toMatch(/heavy-enforce/);
    expect(rawHeavyCommandReason('vitest run scripts/foo.test.mjs scripts/bar.test.mjs')).toMatch(/heavy-enforce/);
    expect(rawHeavyCommandReason('npx vitest run --coverage scripts/foo.test.mjs')).toMatch(/heavy-enforce/);
  });

  it('denies a run naming three files', () => {
    expect(rawHeavyCommandReason('npx vitest run a.test.mjs b.test.mjs c.test.mjs')).toMatch(/heavy-enforce/);
  });

  it('never flags the WRAPPED form — `vitest run` appearing only as the heavy-admission wrapper\'s own argument, not as the command', () => {
    expect(rawHeavyCommandReason('node scripts/readiness/heavy-admission.mjs run -- vitest run')).toBeNull();
    expect(rawHeavyCommandReason('node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/foo.test.mjs')).toBeNull();
    expect(rawHeavyCommandReason('npm run test:unit')).toBeNull();
  });

  it('denies a direct `playwright test` run with no targeted-run exception', () => {
    expect(rawHeavyCommandReason('playwright test')).toMatch(/test:integration.*test:e2e.*test:smoke.*test:a11y.*test:interaction/s);
    expect(rawHeavyCommandReason('npx playwright test --project=chromium')).toMatch(/heavy-admission\.mjs run/);
    expect(rawHeavyCommandReason('npx playwright test --project=chromium tests/smoke/one.spec.ts')).not.toBeNull(); // no file-count exception
    expect(rawHeavyCommandReason('npm run test:smoke')).toBeNull(); // the wrapped script itself is unaffected
  });

  it('denies a direct `eleventy` site-build run, bare or via npx', () => {
    expect(rawHeavyCommandReason('eleventy')).toMatch(/npm run build/);
    expect(rawHeavyCommandReason('npx @11ty/eleventy')).toMatch(/npm run build/);
    expect(rawHeavyCommandReason('npm run build')).toBeNull(); // the wrapped script itself is unaffected
  });

  it('exempts eleventy flags that write nothing (--version/--help/--dryrun) — reuses the existing tree-write arm\'s own no-write allowlist', () => {
    expect(rawHeavyCommandReason('eleventy --version')).toBeNull();
    expect(rawHeavyCommandReason('eleventy --help')).toBeNull();
    expect(rawHeavyCommandReason('eleventy --dryrun')).toBeNull();
  });

  it('exempts eleventy --serve/--watch — a long-running dev server with no wrapped equivalent (wrapping it would hold an admission slot for the whole session, like vitest watch mode)', () => {
    expect(rawHeavyCommandReason('eleventy --serve --port=8080')).toBeNull();
    expect(rawHeavyCommandReason('eleventy --watch')).toBeNull();
  });

  it('is null for an unrelated command, and for a mere MENTION rather than an invocation', () => {
    expect(rawHeavyCommandReason('git status')).toBeNull();
    expect(rawHeavyCommandReason('echo "run vitest run later"')).toBeNull();
    expect(rawHeavyCommandReason('grep -r "playwright test" docs/')).toBeNull();
  });

  it('reaches decide() and reason() — the real enforcement points', () => {
    expect(String(decide('npx vitest run'))).toMatch(/bare FULL-SUITE.*verify-lane\.mjs run/s); // xpnhz4o arm runs first
    expect(String(reason('npx playwright test'))).toMatch(/heavy-admission\.mjs run/);
    expect(decide('npx vitest run scripts/foo.test.mjs')).toMatch(/heavy-enforce/);
    // chained: the deny fires even alongside an otherwise-benign command
    expect(String(decide('git status && npx vitest run'))).toMatch(/bare FULL-SUITE/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// #xu2pp2m — THE DELIVERY LIFECYCLE TABLE MUST NOT BE "GENERALIZED TO EVERY DISPATCHED AGENT".
//
// WHY THIS BLOCK EXISTS. That generalization has now been proposed once, on a reading that is superficially
// very plausible: `deliver-item-wrapper.mjs` is still unwired, so nothing stamps `'delivery'` in production
// and the table above is, today, dead code. The conclusion drawn from that — "so widen the gate to the kinds
// that ARE stamped (build/prepare/prepare-decision/investigate/fix/ci-heal) and it will finally fire" — is
// wrong, and wrong in a way that would break every dispatched agent's FIRST STEP.
//
// The table is not "what a dispatched agent may not do". It is "what the delivery WRAPPER does on the agent's
// behalf" — and the other six launch kinds have no wrapper owning their lifecycle; their briefs tell the agent
// to do these things itself. Each command below is therefore asserted ALLOWED under the live kinds, with the
// brief and step that requires it named, so a future widening goes RED here with the reason attached rather
// than shipping and denying step 1 of every dispatch.
//
// (The complementary half — `npm run check:standards` IS already denied for all these kinds, by the #3105 arm
// — is asserted at the top of this file and is why `we:skills-src/conveyor/*-brief.md` all use
// `verify-lane request` + poll instead.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('#xu2pp2m — the lifecycle denylist stays delivery-scoped because the live briefs need those commands', () => {
  /** `we:scripts/operations/dispatch-lane.mjs#LAUNCH_KINDS` — the kinds `dispatch-lane-io.mjs` actually stamps. */
  const LIVE_LAUNCH_KINDS = ['build', 'prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal'];

  /** command → the brief step that requires it, so a red test says WHY rather than only WHAT. */
  const REQUIRED_BY_LIVE_BRIEFS = [
    ['node scripts/lane-pool.mjs acquire --lane=3 --purpose=conveyor-delivery', 'step 1 of ALL SIX briefs — acquire the lane clone'],
    ['node scripts/verify-lane.mjs request', 'the SANCTIONED gate path (#3105) every brief now uses'],
    ['node scripts/verify-lane.mjs check --json', 'the poll half of that same sanctioned gate path'],
    ['node scripts/conveyor/learnings-drop.mjs --kind=friction --summary=x', 'the learnings step in five of the six briefs'],
    ['gh pr view 1234 --json title,body,comments', 'fix-agent-brief.md step 2 — read the finding being repaired'],
    ['gh pr checks 1234', 'fix-agent-ci-brief.md step 2 — find which required check is red'],
    ['node scripts/operations/run.mjs open-pr --ref=lane/1234-x --sha=HEAD --base=main', 'how build/prepare/investigate open their PR at all'],
  ];

  for (const kind of LIVE_LAUNCH_KINDS) {
    it(`allows every command a \`${kind}\` brief requires of the agent itself`, () => {
      for (const [cmd, why] of REQUIRED_BY_LIVE_BRIEFS) {
        expect(decide(cmd, { dispatchKind: kind }), `${cmd} — ${why}`).toBeNull();
      }
    });
  }

  it('and the SAME commands are still denied for `delivery`, where a wrapper genuinely owns them', () => {
    // The scoping is the ruling, so both directions are asserted together: widening the gate and narrowing it
    // are each a real change, and neither should be possible without one of these two going red.
    for (const [cmd] of REQUIRED_BY_LIVE_BRIEFS) {
      expect(decide(cmd, { dispatchKind: 'delivery' }), cmd).not.toBeNull();
    }
  });

  it('…and for `decision-authoring`, the SECOND wrapper-owned kind (#3644) — same move, same reason', () => {
    // `prepare-decision-wrapper.mjs` stamps `decision-authoring`, NOT the launch kind `prepare-decision`, for
    // exactly the reason the loop above exists: the launch kind is still stamped on the FALLBACK path
    // (`WE_PREPARE_DECISION_DISPATCH_MODE=agent`), whose agent runs the full prose brief and needs every one
    // of these. Two kind values, two contracts, both correct at once.
    for (const [cmd] of REQUIRED_BY_LIVE_BRIEFS) {
      expect(decide(cmd, { dispatchKind: 'decision-authoring' }), cmd).not.toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// #3644 — the DECISION-AUTHORING agent's own Bash session (`--restricted`, spawned by
// `we:scripts/operations/prepare-decision-wrapper.mjs`'s `CLAUDE_RESTRICTED_PREPARE_PROVIDER`) may never run
// any of the mechanical lifecycle commands its own wrapper drives end to end — the same table the `'delivery'`
// block above carries, plus this kind's own four backlog verbs.
//
// WHY THIS IS A SEPARATE KIND VALUE AND NOT `'prepare-decision'` is the load-bearing design point, and both
// halves are asserted here: denied under `decision-authoring`, ALLOWED under `prepare-decision` (which the
// `#xu2pp2m` block above also holds, from the other direction).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('guard-bash — a decision-authoring agent may never run the mechanical lifecycle commands itself (#3644)', () => {
  const K = { dispatchKind: 'decision-authoring' };

  it('denies `lane-pool.mjs` (any subcommand)', () => {
    expect(reason('node scripts/lane-pool.mjs acquire --lane=6 --purpose=conveyor-prepare-decision', K)).toMatch(/lane-pool\.mjs/);
    expect(reason('node scripts/lane-pool.mjs status --json', K)).toMatch(/lane-pool\.mjs/);
    expect(reason('node scripts/lane-pool.mjs release --lane=6', K)).toMatch(/lane-pool\.mjs/);
  });

  it('denies `prepare-stamp` — the flag that makes readiness call a decision `✓ ready to ratify`', () => {
    // THE most important arm on this page: the wrapper stamps only after reading a `done` report, so an agent
    // stamping its own in-progress authoring is a false "ready" the next ratify turn would trust.
    expect(reason('node scripts/backlog.mjs prepare-stamp 2568', K)).toMatch(/prepare-stamp/);
    expect(reason('node scripts/backlog.mjs prepare-stamp 2568', K)).toMatch(/ready to ratify/);
  });

  it('denies `prepare-hold` and `prepare-release` — the wrapper takes and drops the hold', () => {
    expect(reason('node scripts/backlog.mjs prepare-hold 2568 --session=x', K)).toMatch(/prepare-hold/);
    expect(reason('node scripts/backlog.mjs prepare-release 2568 --session=x', K)).toMatch(/prepare-release/);
  });

  it('denies `backlog.mjs resolve` — a PREPARED decision is still OPEN, and resolving is the ratify turn\'s job', () => {
    const why = reason('node scripts/backlog.mjs resolve 2568', K);
    expect(why).toMatch(/resolve/);
    expect(why).toMatch(/still OPEN/);
  });

  it('denies `backlog.mjs claim` and `release` — this arc HOLDS its decision, it never CLAIMS it', () => {
    expect(reason('node scripts/backlog.mjs claim 2568 --session=x', K)).toMatch(/backlog\.mjs claim/);
    expect(reason('node scripts/backlog.mjs release 2568 --session=x', K)).toMatch(/backlog\.mjs release/);
  });

  it('denies `gh pr`, `run.mjs open-pr`/`open-pr.mjs` and `pr-land.mjs`', () => {
    expect(reason('gh pr view 2140', K)).toMatch(/gh pr/);
    expect(reason('gh pr create --title=x --body=y', K)).toMatch(/gh pr/);
    expect(reason('node scripts/operations/run.mjs open-pr --ref=lane/2568-prepare-x --sha=HEAD --base=main', K)).toMatch(/open-pr/);
    expect(reason('node scripts/operations/open-pr.mjs', K)).toMatch(/open-pr/);
    // The flag is spelled out for #3321's caller sweep, exactly as the delivery block above explains: this
    // string is INPUT TO A DENY PREDICATE and is never executed, so no verification is skipped by it.
    expect(reason('node scripts/pr-land.mjs --no-require-verified --pr=2140', K)).toMatch(/pr-land\.mjs/);
  });

  it('denies `learnings-drop.mjs`, `converge-cli.mjs`, `review-core-cli.mjs` and `verify-lane.mjs` in EVERY mode', () => {
    expect(reason('node scripts/conveyor/learnings-drop.mjs --kind=friction --summary=x --area=y --suggestion=z', K)).toMatch(/learnings-drop\.mjs/);
    expect(reason('node scripts/converge-cli.mjs init --lane=/lane-6 --state=/lane-6/.converge-state.json', K)).toMatch(/converge-cli\.mjs/);
    expect(reason('node scripts/review-core-cli.mjs invite --file=x.json --json', K)).toMatch(/review-core-cli\.mjs/);
    // Including `request`/`check` — unlike the #3105 build/fix/ci-heal carve-out, this agent never runs the
    // gate at all, in any form; the wrapper runs it outside the agent's own turn.
    expect(reason('node scripts/verify-lane.mjs --json', K)).toMatch(/verify-lane\.mjs/);
    expect(reason('node scripts/verify-lane.mjs request', K)).toMatch(/verify-lane\.mjs/);
    expect(reason('node scripts/verify-lane.mjs check --json', K)).toMatch(/verify-lane\.mjs/);
  });

  it('touches NOTHING for any other session — interactive, or any other dispatch kind', () => {
    const commands = [
      'node scripts/lane-pool.mjs acquire --lane=6',
      'node scripts/backlog.mjs prepare-hold 2568',
      'node scripts/backlog.mjs prepare-stamp 2568',
      'node scripts/backlog.mjs prepare-release 2568',
      'node scripts/backlog.mjs resolve 2568',
      'gh pr view 2140',
      'node scripts/operations/run.mjs open-pr --ref=lane/2568-prepare-x',
      'node scripts/converge-cli.mjs init --lane=/lane-6',
      'node scripts/verify-lane.mjs request',
    ];
    for (const cmd of commands) {
      expect(reason(cmd, {}), cmd).toBeNull();
      expect(reason(cmd), cmd).toBeNull();
      expect(reason(cmd, { dispatchKind: null }), cmd).toBeNull();
      // The FALLBACK-path agent, which runs the prose brief and does its own lifecycle.
      expect(reason(cmd, { dispatchKind: 'prepare-decision' }), cmd).toBeNull();
      expect(reason(cmd, { dispatchKind: 'build' }), cmd).toBeNull();
    }
  });

  it('does NOT over-block the ordinary authoring work this agent exists to do', () => {
    const ordinary = [
      'git status',
      'git diff',
      'git add backlog/2568-a-decision.md src/_data/researchTopics.json',
      'git commit -F /lane-6/.msg.txt -- backlog/2568-a-decision.md',
      'node scripts/operations/delivery-report-cli.mjs report --session=$PREPARE_SESSION --item=$PREPARE_ITEM --status=started',
      'printenv LANE',
      'cat src/_data/researchTopics.json',
    ];
    for (const cmd of ordinary) {
      expect(reason(cmd, K), cmd).toBeNull();
    }
  });

  it('reaches decide() — the real enforcement point, not just the pure per-segment predicate', () => {
    expect(String(decide('node scripts/backlog.mjs prepare-stamp 2568', K))).toMatch(/prepare-stamp/);
    // chained: the deny fires even alongside an otherwise-benign command
    expect(String(decide('git status && node scripts/backlog.mjs resolve 2568', K))).toMatch(/resolve/);
    // an ordinary, undenied chain still passes clean under the same dispatchKind
    expect(decide('git status && git add -- backlog/2568-a.md && git commit -F /lane-6/.msg.txt -- backlog/2568-a.md', K)).toBeNull();
    // the identical command with no dispatchKind at all (interactive) — untouched
    expect(decide('node scripts/backlog.mjs prepare-stamp 2568')).toBeNull();
  });
});

// #xpt9fvd — a resident daemon's OWN dedicated clone (wev-review-daemon, wev-merge-daemon, wev-health-watch,
// the drain's clone(s)) gets the SAME shell-write protection the #2749/#2788 primary-tree arm already gives a
// constellation checkout. Three times on 2026-09-26 a worker hand-edited/copied files INSIDE the daemon's OWN
// clone — caught + reverted each time, but a dirty clone BLOCKS that daemon's own rebuild until a person
// notices. The proof matrix below is the literal deny/allow set the card asks for.
describe('guard-bash — DAEMON CLONE write protection (#xpt9fvd)', () => {
  const CLONE = '/ws/wev-review-daemon';
  const LANE = '/ws/.lanes/web-everything/lane-53';
  const roots = [CLONE];

  it('DENIES an Edit-equivalent shell write with cwd already inside the clone', () => {
    expect(daemonCloneWriteReason('echo hi > notes.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('sed -i s/a/b/ notes.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('tee notes.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
  });

  it('DENIES cp/mv/rm with cwd already inside the clone', () => {
    expect(daemonCloneWriteReason('cp fix.md notes.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('mv a.md b.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('rm old.md', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
  });

  it('DENIES cp/rm run from OUTSIDE the clone with an explicit operand path INTO it', () => {
    expect(daemonCloneWriteReason(`cp fix.md ${CLONE}/fix.md`, { cwd: LANE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason(`rm ${CLONE}/old.md`, { cwd: LANE, roots })).toMatch(/DAEMON CLONE/);
  });

  it('DENIES git reset/checkout/commit — cwd inside the clone, or via `-C <clone>` from elsewhere', () => {
    expect(daemonCloneWriteReason('git reset --hard origin/main', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('git checkout -- .', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason('git commit -am wip', { cwd: CLONE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason(`git -C ${CLONE} reset --hard origin/main`, { cwd: LANE, roots })).toMatch(/DAEMON CLONE/);
    expect(daemonCloneWriteReason(`git -C ${CLONE} commit -am wip`, { cwd: LANE, roots })).toMatch(/DAEMON CLONE/);
  });

  it('ALLOWS git fetch — diagnosis only, never touches the working tree (the explicit card decision)', () => {
    expect(daemonCloneWriteReason('git fetch origin', { cwd: CLONE, roots })).toBeNull();
    expect(daemonCloneWriteReason(`git -C ${CLONE} fetch origin`, { cwd: LANE, roots })).toBeNull();
  });

  it('ALLOWS read-only commands targeting the clone — `git -C <clone> log`, `cat`, `git status`', () => {
    expect(daemonCloneWriteReason(`git -C ${CLONE} log`, { cwd: LANE, roots })).toBeNull();
    expect(daemonCloneWriteReason('cat notes.md', { cwd: CLONE, roots })).toBeNull();
    expect(daemonCloneWriteReason('git status', { cwd: CLONE, roots })).toBeNull();
    expect(daemonCloneWriteReason('git diff', { cwd: CLONE, roots })).toBeNull();
  });

  it('ALLOWS the sanctioned overlay/rebuild CLIs invoked with --clone=<path> from a lane', () => {
    expect(daemonCloneWriteReason(`node scripts/daemon-overlay.mjs add --clone=${CLONE} --ref=lane/fix --pr=1`, { cwd: LANE, roots })).toBeNull();
    expect(daemonCloneWriteReason(`node scripts/lib/daemon-rebuild.mjs --clone=${CLONE}`, { cwd: LANE, roots })).toBeNull();
    expect(daemonCloneWriteReason(`node scripts/lib/daemon-load-overlay.mjs --clone=${CLONE} --ref=lane/fix`, { cwd: LANE, roots })).toBeNull();
  });

  it('ALLOWS a write elsewhere entirely — an ordinary lane write is untouched', () => {
    expect(daemonCloneWriteReason('echo hi > notes.md', { cwd: LANE, roots })).toBeNull();
    expect(daemonCloneWriteReason('cp fix.md /tmp/fix.md', { cwd: LANE, roots })).toBeNull();
    expect(daemonCloneWriteReason('git reset --hard origin/main', { cwd: LANE, roots })).toBeNull();
  });

  it('ALLOWS everything when the registry is empty — never blocks on an unconfigured/fault-read registry', () => {
    expect(daemonCloneWriteReason('git reset --hard origin/main', { cwd: CLONE, roots: [] })).toBeNull();
    expect(daemonCloneWriteReason('cp fix.md notes.md', { cwd: CLONE, roots: [] })).toBeNull();
  });

  it('reaches reason()/decide() — the real enforcement points, not just the pure predicate', () => {
    const ctx = { cwd: CLONE, daemonCloneRoots: roots };
    expect(reason('git reset --hard origin/main', ctx)).toMatch(/DAEMON CLONE/);
    expect(decide('git status && git reset --hard origin/main', ctx)).toMatch(/DAEMON CLONE/);
    expect(decide('git status', ctx)).toBeNull();
    // untouched with NO daemon context at all (every other describe block in this file relies on this)
    expect(decide('git reset --hard origin/main')).toBeNull();
  });

  it('daemonCloneRoots derives the real seed + registry union (sanity check, not a CLI test)', () => {
    const real = daemonCloneRoots('/ws');
    expect(real).toContain('/ws/wev-review-daemon');
    expect(real).toContain('/ws/wev-merge-daemon');
    expect(real).toContain('/ws/wev-health-watch');
    expect(real).toContain('/ws/.lanes/we-drain-daemon/lane-1');
  });
});

// The impure half, through the REAL CLI: a clone registered ONLY via the overlay-state directory (no seed
// entry needed) is protected too — proof that "derive from the registry, don't hard-code only" actually
// reaches the hook. Also the live end-to-end proof the card's PROOF section asks for.
describe('#xpt9fvd — the guard-bash CLI protects a clone discovered via the daemon-overlay registry', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'guard-bash-daemon-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const overlayDir = join(root, 'overlay-state');
  const fakeClone = join(root, 'some-new-daemon-clone'); // deliberately NOT in DAEMON_CLONE_SEED
  const lane = join(root, 'lane');
  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(fakeClone, { recursive: true });
  mkdirSync(lane, { recursive: true });
  writeFileSync(join(overlayDir, 'def456.json'), JSON.stringify({ clone: fakeClone, overlays: [] }));

  // The house idiom (see the #3311 CLI-boundary block above): vitest rewrites `import.meta.url` to a
  // non-file base, so `new URL(…, import.meta.url)` + `fileURLToPath` is NOT used here.
  const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard-bash.mjs');
  const runHook = (command, cwd) => {
    const res = execFileSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_input: { command }, cwd }),
      env: { ...process.env, WE_DAEMON_OVERLAY_DIR: overlayDir },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return res ? JSON.parse(res) : null;
  };

  it('DENIES `cp` into the registry-discovered clone, run from a lane', () => {
    const out = runHook(`cp fix.md ${join(fakeClone, 'fix.md')}`, lane);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toMatch(/DAEMON CLONE/);
  });

  it('DENIES `git reset --hard` with cwd inside the registry-discovered clone', () => {
    const out = runHook('git reset --hard origin/main', fakeClone);
    expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('ALLOWS `git -C <clone> log` and `cat` — read-only, unaffected', () => {
    expect(runHook(`git -C ${fakeClone} log`, lane)).toBeNull();
    expect(runHook(`cat ${join(fakeClone, 'x.md')}`, lane)).toBeNull();
  });

  it('ALLOWS the sanctioned overlay CLI invoked with --clone=<path> from a lane', () => {
    expect(runHook(`node scripts/daemon-overlay.mjs add --clone=${fakeClone} --ref=lane/fix`, lane)).toBeNull();
  });
});

// #4368 — the briefs' documented gate/mid-work commands are parsed out of the markdown and run through the
// guard, so an edit that makes a brief document a shape the guard denies (or renames the test it cites) reddens
// here instead of drifting silently. Fail-loud by design: a missing marker/fence/body throws, never skips.
describe('briefs document commands the guard does not deny (#4368)', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const KINDS = ['build', 'fix', 'ci-heal'];
  const readBrief = (name) => readFileSync(join(ROOT, 'skills-src', 'conveyor', name), 'utf8');

  /** First ```bash fence after `marker` (a line prefix), as one command with `\` continuations joined. */
  function extractFenceAfter(markdown, marker, label) {
    const lines = markdown.split('\n');
    const at = lines.findIndex((l) => l.startsWith(marker));
    if (at < 0) throw new Error(`${label}: marker "${marker}" not found in the brief`);
    const open = lines.findIndex((l, i) => i > at && l.trim() === '```bash');
    if (open < 0) throw new Error(`${label}: no bash fence follows "${marker}"`);
    const close = lines.findIndex((l, i) => i > open && l.trim() === '```');
    if (close < 0) throw new Error(`${label}: bash fence after "${marker}" is unclosed`);
    const body = lines.slice(open + 1, close).join('\n').replace(/\\\n\s*/g, ' ').trim();
    if (!body) throw new Error(`${label}: bash fence after "${marker}" is empty`);
    return body;
  }

  const MARKER = '**Mid-work check';
  const extractMidWorkCommand = (md) => extractFenceAfter(md, MARKER, 'mid-work check')
    .replace(/<touched-file-1>/, 'scripts/guard-bash.mjs')
    .replace(/<touched-file-2>\s*…/, 'scripts/lib/verify-lane-gate.mjs');

  const brief = readBrief('delivery-agent-brief.md');
  const cmd = extractMidWorkCommand(brief);

  it("the delivery brief's mid-work command is the admitted wrapper form, not denied for any dispatch kind", () => {
    expect(cmd.startsWith('node scripts/readiness/heavy-admission.mjs run --')).toBe(true);
    expect(isAdmittedWrapperRun(cmd)).toBe(true);
    for (const kind of KINDS) expect(dispatchedAgentVerificationReason(cmd, kind)).toBeNull();
  });
  it('the extracted command keeps --run and --passWithNoTests (the guard ignores them)', () => {
    expect(cmd).toContain('--run');
    expect(cmd).toContain('--passWithNoTests');
  });
  it('dropping the wrapper from the documented command IS denied (mutation proof)', () => {
    const mutated = cmd.replace('node scripts/readiness/heavy-admission.mjs run -- ', '');
    for (const kind of KINDS) expect(dispatchedAgentVerificationReason(mutated, kind)).not.toBeNull();
  });
  it('the guard test the brief cites by title exists in this file', () => {
    const flat = brief.replace(/\s+/g, ' ');
    const m = flat.match(/\*"(.+?)"\*/);
    expect(m, 'brief no longer cites a guard test title as *"…"*').not.toBeNull();
    const title = m[1].replace(/`/g, '');
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(/`/g, '');
    expect(self).toContain(`it('${title}'`);
  });
  it('extractMidWorkCommand fails loud on a missing marker, missing fence, unclosed fence, or empty fence', () => {
    expect(() => extractMidWorkCommand('# nothing here')).toThrow(/not found/);
    expect(() => extractMidWorkCommand(`${MARKER} x\n\nprose only`)).toThrow(/no bash fence/);
    expect(() => extractMidWorkCommand(`${MARKER} x\n\`\`\`bash\nnode a`)).toThrow(/unclosed/);
    expect(() => extractMidWorkCommand(`${MARKER} x\n\`\`\`bash\n\n\`\`\``)).toThrow(/empty/);
  });

  // #4369 has landed: the fix briefs' step-4 gate fence (request/check) must also pass the guard.
  for (const name of ['fix-agent-brief.md', 'fix-agent-ci-brief.md']) {
    it(`${name}'s step-4 gate commands are not denied for any dispatch kind`, () => {
      const fence = extractFenceAfter(readBrief(name), '### 4. Run the gate GREEN', name)
        .replaceAll('{{WE_ROOT}}', ROOT);
      const cmds = fence.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter(Boolean);
      expect(cmds.length).toBeGreaterThan(0);
      for (const c of cmds) for (const kind of KINDS) expect(dispatchedAgentVerificationReason(c, kind)).toBeNull();
    });
  }
});

describe('admitted vitest must be one-shot (#4449)', () => {
  const W = 'node scripts/readiness/heavy-admission.mjs run --';
  const KINDS = ['build', 'fix', 'ci-heal'];
  const related = `${W} npx vitest related scripts/foo.mjs --passWithNoTests`;
  it('related without --run is denied for every kind', () => {
    for (const k of KINDS) expect(dispatchedAgentVerificationReason(related, k)).toMatch(/--run/);
  });
  it('--run, --watch=false or --no-watch allows it', () => {
    for (const f of ['--run', '--watch=false', '--no-watch']) {
      for (const k of KINDS) expect(dispatchedAgentVerificationReason(`${related} ${f}`, k)).toBeNull();
    }
  });
  it('vitest run <file> stays allowed without extra flags', () => {
    for (const k of KINDS) expect(dispatchedAgentVerificationReason(`${W} npx vitest run scripts/foo.test.mjs`, k)).toBeNull();
  });
  it('interactive session is unaffected', () => {
    expect(dispatchedAgentVerificationReason(related, null)).toBeNull();
    expect(admittedVitestWatchReason(related)).not.toBeNull();
  });
  it('stripping --run from the brief-extracted command is denied for every kind', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills-src', 'conveyor', 'delivery-agent-brief.md'), 'utf8');
    const line = md.split('\n').find((l) => l.startsWith('node scripts/readiness/heavy-admission.mjs run -- npx vitest related'));
    expect(line).toBeTruthy();
    const mutated = line.replace(' --run', '');
    for (const k of KINDS) expect(dispatchedAgentVerificationReason(mutated, k)).not.toBeNull();
  });
});
