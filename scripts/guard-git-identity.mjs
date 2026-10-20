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
 *   SCOPE: lane clones only (a checkout under `/.lanes/`), which is where agent commits land. FAIL-CLOSED only for
 *   the placeholder / missing verdict — a real identity passes, and an internal error in the check itself passes
 *   (the guard never wedges a commit over its own bug; `git` itself still refuses a truly missing identity).
 *
 *   Exit 1 = refuse (message on stderr), 0 = allow.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { readGitIdentity, identityVerdict, resolveGitIdentityPlaceholders, GIT_IDENTITY_FIX_HINT } from './lib/git-identity.mjs';

/** PURE: is this checkout root a lane clone? Same locus test as `guard-lane.mjs#isLaneLocus`. */
export function isLaneRoot(root, sepChar = sep) {
  const p = String(root || '');
  return p !== '' && p.includes(`${sepChar}.lanes${sepChar}`);
}

/**
 * PURE decision over an injected root + identity + lists.
 * @returns {{allow:boolean, message?:string}}
 */
export function guardDecision({ root, identity, lists }) {
  if (!isLaneRoot(root)) return { allow: true };
  const v = identityVerdict(identity, lists);
  if (v.status === 'ok') return { allow: true };
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

export function main({ cwd = process.cwd(), env = process.env, err = (s) => process.stderr.write(s + '\n') } = {}) {
  let decision;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let root = top;
    try { root = realpathSync(top); } catch { /* keep the git answer */ }
    if (!isLaneRoot(root) && !isLaneRoot(top)) return 0;
    decision = guardDecision({ root: isLaneRoot(root) ? root : top, identity: readGitIdentity(cwd, { env }), lists: resolveGitIdentityPlaceholders({ env }) });
  } catch {
    return 0; // the guard's own fault never blocks a commit
  }
  if (decision.allow) return 0;
  err(decision.message);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
