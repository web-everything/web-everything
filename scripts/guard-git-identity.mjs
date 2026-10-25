#!/usr/bin/env node
/**
 * @file scripts/guard-git-identity.mjs
 * @description Lane pre-commit guard: refuse a commit whose author or committer is a PLACEHOLDER identity
 *   (`test` / `test@test.com` / `*@example.com` / …, see `we:scripts/lib/git-identity.mjs`).
 *
 *   From 2026-10-05 to 2026-10-20 every lane commit was authored "test" because the global git config said so,
 *   and nothing noticed. Wired via `.githooks/pre-commit` (`core.hooksPath .githooks`, set by the `prepare` npm
 *   script and carried into every lane clone), so it covers an agent's `git commit` in a lane however it is typed.
 *
 *   SCOPE: lane clones (a checkout under `/.lanes/` or named `lane-N`, including custom pool roots), which is
 *   where agent commits land. A real identity passes;
 *   a placeholder / missing identity is refused, and so is ANY unexpected error in the guard (FAIL CLOSED, operator
 *   ruling 2026-10-20) — with a message saying the identity could not be verified.
 *
 *   Exit 1 = refuse (message on stderr), 0 = allow.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { readGitIdentity, identityVerdict, resolveGitIdentityPlaceholders, GIT_IDENTITY_FIX_HINT, invokedAsScript } from './lib/git-identity.mjs';

/** PURE: recognize the default pool and lane-pool's `lane-N` checkout names under arbitrary pool roots.
 * Do not depend on LANE_POOL_ROOT: the shell running a later commit need not inherit the provisioner's env.
 * A checkout named lane-N is conservatively guarded even outside a configured pool.
 */
export function isLaneRoot(root, sepChar = sep) {
  const p = String(root || '');
  return p !== '' && (p.includes(`${sepChar}.lanes${sepChar}`) || /^lane-[0-9]+$/.test(p.split(sepChar).at(-1)));
}

/**
 * PURE decision over an injected root + identity + lists.
 * @returns {{allow:boolean, message?:string}}
 */
export function guardDecision({ root, identity, lists }) {
  if (!isLaneRoot(root)) return { allow: true };
  const v = identityVerdict(identity, lists);
  if (v.status === 'ok') return { allow: true };
  // FAIL CLOSED (operator ruling 2026-10-20): a check that could not run (git timed out, EMFILE, …) refuses too —
  // an unverified identity is exactly how the "test" author went unnoticed.
  if (v.status === 'error') return { allow: false, message: failClosedMessage(v.detail) };
  return {
    allow: false,
    message: [
      `✗ commit refused: the git ${v.status === 'missing' ? 'identity is MISSING' : 'author/committer is a PLACEHOLDER'} in this lane.`,
      `  ${v.detail}`,
      `  Every lane commit would be authored by that identity (the 2026-10-05..20 "test" incident).`,
      `  ${GIT_IDENTITY_FIX_HINT}`,
      '  Extend the placeholder list via the `gitIdentityPlaceholders` setting (scripts/settings/*.json).',
    ].join('\n'),
  };
}

/** The refusal for "the guard could not decide" — never a silent pass. */
export function failClosedMessage(detail) {
  return [
    '✗ commit refused: the placeholder-author guard could not verify the git identity (fail-closed).',
    `  ${detail}`,
    '  Re-run the commit; if it persists, check `git var GIT_AUTHOR_IDENT` / `git var GIT_COMMITTER_IDENT` in this lane.',
    `  ${GIT_IDENTITY_FIX_HINT}`,
  ].join('\n');
}

/**
 * The hook entry. ANY unexpected error refuses the commit with a clear message (fail closed). `deps` is a test seam.
 */
export function main({ cwd = process.cwd(), env = process.env, err = (s) => process.stderr.write(s + '\n'), deps = {} } = {}) {
  const { exec = execFileSync, readIdentity = readGitIdentity, resolveLists = resolveGitIdentityPlaceholders } = deps;
  let decision;
  try {
    const top = String(exec('git', ['rev-parse', '--show-toplevel'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 })).replace(/\n$/, '');
    let root = top;
    try { root = realpathSync(top); } catch { /* keep the git answer */ }
    if (!isLaneRoot(root) && !isLaneRoot(top)) return 0;
    decision = guardDecision({ root: isLaneRoot(root) ? root : top, identity: readIdentity(cwd, { env }), lists: resolveLists({ env }) });
  } catch (e) {
    decision = { allow: false, message: failClosedMessage(`unexpected error: ${String(e?.message ?? e).split('\n')[0]}`) };
  }
  if (decision.allow) return 0;
  err(decision.message);
  return 1;
}

// Never a raw URL comparison: a percent-encoded space (audit finding) or a symlinked checkout under
// --preserve-symlinks-main (red-team finding) made the guard silently skip itself. Both sides canonicalized alike.
if (invokedAsScript(process.argv[1], import.meta.url)) process.exitCode = main();
