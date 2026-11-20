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
import { OPERATOR_LOGINS, JUDGE_ACTOR, JUDGE_ATTRIBUTION, JUDGE_RESERVED_TOKEN_RE, isJudgeAuthored, readJudgeActorPolicy, isSecurityClass } from './marker-authorship.mjs';
import { classAction } from './finding-class-policy.mjs';
import { CARD_REF_RE } from './referral-card-readable.mjs';
import { parseRedTeamGateMarker, gateActionLines } from './red-team-gate.mjs';

/** Gate-record outcomes only an operator may write. */
export const OPERATOR_GATE_OUTCOMES = Object.freeze(['operator-card', 'operator-not-real', 'operator-block']);

export function operatorGhEnv(env = process.env) {
  const out = { ...env };
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  return out;
}

/** The authenticated `gh` identity under the operator channel. Throws when it cannot be read. */
export function resolveOperatorIdentity({ env = process.env, run = spawnSync, automation = false } = {}) {
  const r = run('gh', ['api', 'user'], { env: automation ? env : operatorGhEnv(env), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
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
  if (parseRedTeamGateMarker(c?.body)?.actor !== undefined
    || /^Cleared by judge:r10\b/m.test(String(c?.body ?? ''))) return false;
  const login = String((typeof c === 'string' ? '' : (c?.author?.login ?? c?.user?.login)) ?? '').toLowerCase();
  const a = typeof c === 'string' ? null : (c?.author ?? c?.user);
  return isHuman(login, String(a?.type ?? '')) && a?.is_bot !== true && OPERATOR_LOGINS.includes(login);
}

/** Filter operator records by authorship; judge cards additionally require injected live evidence. */
export function operatorBoundComments(comments, { policy = judgePolicyOnce(), ...evidence } = {}) {
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    if (m?.actor !== undefined) return isRulingComment(c, policy, evidence);
    return !(m && OPERATOR_GATE_OUTCOMES.includes(m.outcome)) || isRulingComment(c, policy, evidence);
  });
}

/**
 * One judge-policy read per reader pass (#6494 F2): resolved lazily on the first judge-marked comment, then reused —
 * a failed read included, so an unreadable policy refuses every judge comment of the pass without re-reading.
 * @param {() => {value: object}} [resolve] the resolver; a writer passes its own env-bound one for its read-back.
 */
export function judgePolicyOnce(resolve = () => readJudgeActorPolicy()) {
  let r;
  return () => {
    if (!r) { try { r = { value: resolve().value }; } catch (error) { r = { error }; } }
    if (r.error) throw r.error;
    return r.value;
  };
}

export function assertRulingIdentity(identity, actor) {
  if (actor !== JUDGE_ACTOR) return assertHumanOperator(identity, actor);
  if (!isJudgeAuthored({ author: identity })) throw new Error('judge posting identity must be trusted automation');
  return identity.login;
}
/** Default ancestry dependency for IO callers; missing refs or git failures refuse. No fetch. */
export function isAncestorOfMain(sha, { run = spawnSync, cwd = process.cwd() } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) return false;
  try {
    const r = run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], {
      cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !r.error && r.status === 0;
  } catch { return false; }
}

/** Security is never judge-card eligible, even when policy explicitly permits security deferral. */
export function judgeCardFindingAllowed(f, findingClasses) {
  return Boolean(f && findingClasses && typeof findingClasses === 'object' && !Array.isArray(findingClasses) && f.security !== true && f.securityReachableToday !== true
    && ![f.class, f.findingClass, ...(Array.isArray(f.alsoClasses) ? f.alsoClasses : [])].some(isSecurityClass)
    && classAction(f, findingClasses) === 'defer-card');
}

/** Complete live evidence is mandatory. No injected ancestry/card reader means no release. */
function hasPreExistingEvidence(c, marker, { head, resultId, findings, findingClasses, isAncestorOfMain: ancestor, cardReadable } = {}) {
  if (marker.rev !== head || (resultId !== undefined && marker.result !== resultId) || !Array.isArray(findings) || !findingClasses
    || typeof ancestor !== 'function' || typeof cardReadable !== 'function') return false;
  const body = String(c?.body ?? '');
  const lines = body.split(/\r?\n/).filter(line => line.startsWith('Pre-existing on main'));
  if (lines.length !== 1) return false;
  const m = /^Pre-existing on main \(([0-9a-f]{40})\): probe (.+); main=(.+) pr=(.+)$/i.exec(lines[0]);
  if (!m || !m[2].trim() || !m[3].trim() || !m[4].trim() || m[3] !== m[4]) return false;
  const actions = gateActionLines(body);
  if (!actions.length || actions.some(a => a.action !== 'operator-card' || !a.indices.length || !CARD_REF_RE.test(a.cardRef ?? '')))
    return false;
  try {
    return ancestor(m[1]) === true && actions.every(a => cardReadable(a.cardRef) === true
      && a.indices.every(index => judgeCardFindingAllowed(findings.find(f => f.index === index), findingClasses)));
  } catch { return false; }
}

/** Judge holds and evidenced card releases require attribution, trusted authorship and live policy. */
export function isRulingComment(c, policy = judgePolicyOnce(), evidence = {}) {
  const m = parseRedTeamGateMarker(c?.body);
  if (m?.actor === undefined) return isHumanOperatorComment(c);
  if (m.actor !== JUDGE_ACTOR || !(m.outcome === 'operator-block' || (m.outcome === 'operator-card' && hasPreExistingEvidence(c, m, evidence))) || !isJudgeAuthored(c)
    || JUDGE_RESERVED_TOKEN_RE.test(String(c?.body ?? ''))
    || !String(c?.body ?? '').split(/\r?\n/).some(line => line === JUDGE_ATTRIBUTION || line === `${JUDGE_ATTRIBUTION} (${JUDGE_ACTOR})`)) return false;
  try { const p = policy(); return p.enabled === true && p.actor === JUDGE_ACTOR; }
  catch { return false; }
}
