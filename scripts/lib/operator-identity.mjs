/**
 * @file scripts/lib/operator-identity.mjs
 * @description Bind an operator ruling to the AUTHENTICATED GitHub poster, never to a typed `--actor`.
 *   Audit of 59bcf94 (2026-10-20): `--actor=chalbert` was only checked against the allowlist, so a process holding
 *   automation credentials could post a trusted gate record and release a break with no operator behind it.
 *
 *   - {@link operatorGhEnv}: `env` with `GH_TOKEN`/`GITHUB_TOKEN` removed, so `gh` falls through to the operator's own login.
 *   - {@link resolveOperatorIdentity}: `gh api user` under that env.
 *   - {@link assertHumanOperator}: the resolved identity must be a human (type !== 'Bot', no `[bot]`), on the
 *     operator allowlist, and equal the declared actor. Anything else refuses.
 *   - {@link operatorBoundComments}: the READ side. An `operator-*` gate record counts only when its GitHub comment
 *     author is a human operator; every other comment is untouched. The red-team gate reader should apply this filter
 *     itself (follow-up hook in `red-team-gate.mjs`); this module's callers apply it today.
 */
import { spawnSync } from 'node:child_process';
import { OPERATOR_LOGINS } from './marker-authorship.mjs';
import { parseRedTeamGateMarker } from './red-team-gate.mjs';

/** Gate-record outcomes only an operator may write. */
export const OPERATOR_GATE_OUTCOMES = Object.freeze(['operator-card', 'operator-not-real', 'operator-block']);

export function operatorGhEnv(env = process.env) {
  const out = { ...env };
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  return out;
}

/** The authenticated `gh` identity under the operator channel. Throws when it cannot be read. */
export function resolveOperatorIdentity({ env = process.env, run = spawnSync } = {}) {
  const r = run('gh', ['api', 'user'], { env: operatorGhEnv(env), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`could not resolve the posting identity (gh api user failed: ${String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 200)})`);
  const user = JSON.parse(String(r.stdout ?? '{}'));
  return { login: String(user.login ?? ''), type: String(user.type ?? '') };
}

const isHuman = (login, type) => login.length > 0 && type !== 'Bot' && !login.includes('[bot]');

/** Refuse unless the identity is a human operator on the allowlist and is the declared actor. PURE. */
export function assertHumanOperator(identity, actor) {
  const login = String(identity?.login ?? '').toLowerCase();
  if (!isHuman(login, String(identity?.type ?? ''))) {
    throw new Error(`the posting identity ${JSON.stringify(identity?.login ?? '')} (${identity?.type || 'unknown type'}) is not a human account; an operator ruling must be posted as the operator, not an App or bot`);
  }
  if (!OPERATOR_LOGINS.includes(login)) throw new Error(`the posting identity ${login} is not a registered operator login (${OPERATOR_LOGINS.join(', ')})`);
  if (login !== String(actor ?? '').toLowerCase()) throw new Error(`--actor=${actor} does not match the authenticated poster ${login}; the ruling is bound to who actually posts it`);
  return login;
}

/** Is this comment written by a human operator account? PURE. */
export function isHumanOperatorComment(c) {
  const login = String((typeof c === 'string' ? '' : (c?.author?.login ?? c?.user?.login)) ?? '').toLowerCase();
  const a = typeof c === 'string' ? null : (c?.author ?? c?.user);
  return isHuman(login, String(a?.type ?? '')) && a?.is_bot !== true && OPERATOR_LOGINS.includes(login);
}

/** Drop every `operator-*` gate record that a human operator did not author. All other comments pass. PURE. */
export function operatorBoundComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    return !(m && OPERATOR_GATE_OUTCOMES.includes(m.outcome)) || isHumanOperatorComment(c);
  });
}
