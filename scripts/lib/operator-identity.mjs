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
import yaml from 'js-yaml';
import { OPERATOR_LOGINS, JUDGE_ACTOR, JUDGE_ATTRIBUTION, JUDGE_RESERVED_TOKEN_RE, isJudgeAuthored, readJudgeActorPolicy, isSecurityClass } from './marker-authorship.mjs';
import { classAction } from './finding-class-policy.mjs';
import { CARD_REF_RE } from './referral-card-readable.mjs';
import { parseRedTeamGateMarker, gateActionLines, judgeCardReaderContext } from './red-team-gate.mjs';

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

/** Filter operator records by authorship and the same live evidence used by the gate. */
export function operatorBoundComments(comments, { policy = judgePolicyOnce(), ...evidence } = {}) {
  const contexts = new Map();
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    const m = parseRedTeamGateMarker(typeof c === 'string' ? c : c?.body);
    if (m?.actor !== undefined) {
      if (m.outcome !== 'operator-card' || evidence.head) return isRulingComment(c, policy, evidence);
      const key = `${m.pr}/${m.rev}`;
      if (!contexts.has(key)) contexts.set(key, judgeCardReaderContext(comments, m.pr, m.rev, { policy, ...evidence }));
      return isRulingComment(c, policy, contexts.get(key));
    }
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
/** One pass's evidence. Never consult the checkout or a cached tracking tip; failures remain failures for this pass. */
export function defaultJudgeCardEvidence({ run = spawnSync, cwd = process.cwd() } = {}) {
  const git = args => {
    const r = run('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20,
      stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0 || Buffer.byteLength(String(r.stdout ?? '')) > (1 << 20)) throw new Error('judge card evidence unreadable; restore main/card evidence or ask the operator');
    return String(r.stdout ?? '');
  };
  let attempted = false, tip;
  const freshTip = () => {
    if (!attempted) {
      attempted = true;
      try {
        git(['fetch', 'origin', 'main']);
        const sha = git(['rev-parse', 'FETCH_HEAD']).trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) tip = sha;
      } catch { /* No stale fallback. */ }
    }
    return tip;
  };
  const ancestors = new Map(), cards = new Map();
  return {
    isAncestorOfMain(sha) {
      if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) return false;
      if (!ancestors.has(sha)) {
        let valid = false;
        try { if (freshTip()) { git(['merge-base', '--is-ancestor', sha, tip]); valid = true; } } catch { /* refuse */ }
        ancestors.set(sha, valid);
      }
      return ancestors.get(sha);
    },
    cardReadable(ref, indices, marker) {
      if (!CARD_REF_RE.test(ref ?? '') || ref.includes('@') || !Array.isArray(indices) || !marker?.result) return false;
      if (!cards.has(ref)) {
        let text = '';
        try { if (freshTip()) text = git(['show', `${tip}:${ref.slice(3)}`]); } catch { /* refuse */ }
        cards.set(ref, text);
      }
      const text = cards.get(ref);
      const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(text)?.[1];
      let status;
      try { status = frontmatter ? yaml.safeLoad(frontmatter)?.status : null; } catch { return false; }
      // Only an explicitly open card is actionable. Bind each break to its result, not an unrelated '#1'.
      return Boolean(status === 'open'
        && indices.every(index => new RegExp(`(?:^|[^a-zA-Z0-9])${marker.result}#${index}(?![0-9])`).test(text)));
    },
  };
}

/** Standalone checks are separate passes, so each one refreshes main. */
export function isAncestorOfMain(sha, options) {
  return defaultJudgeCardEvidence(options).isAncestorOfMain(sha);
}

/** Security is never judge-card eligible, even when policy explicitly permits security deferral. */
export function isJudgeCardSecurityFinding(f) {
  return Boolean(f && (isSecurityClass(f.category) || f.security === true || f.securityReachableToday === true
    || [f.class, f.findingClass, ...(Array.isArray(f.alsoClasses) ? f.alsoClasses : [])].some(isSecurityClass)));
}
export function judgeCardFindingAllowed(f, findingClasses) {
  return Boolean(f && findingClasses && typeof findingClasses === 'object' && !Array.isArray(findingClasses) && !isJudgeCardSecurityFinding(f)
    && classAction(f, findingClasses) === 'defer-card');
}

/** Complete live evidence is mandatory, from the default provider or its test seam. */
function preExistingRefusal(c, marker, { head, resultId, findings, findingClasses, isAncestorOfMain: ancestor, cardReadable, securityHold, blockedIndices, humanHold } = {}) {
  if (marker.rev !== head || (resultId !== undefined && marker.result !== resultId) || !Array.isArray(findings) || !findingClasses
    || typeof ancestor !== 'function' || typeof cardReadable !== 'function') return 'judge card evidence context missing';
  const body = String(c?.body ?? '');
  const lines = body.split(/\r?\n/).filter(line => line.startsWith('Pre-existing on main'));
  if (lines.length !== 1) return 'pre-existing evidence is malformed';
  const m = /^Pre-existing on main \(([0-9a-f]{40})\): probe (.+); main=(.+) pr=(.+)$/i.exec(lines[0]);
  if (!m || !m[2].trim() || !m[3].trim() || !m[4].trim() || m[3] !== m[4]) return 'pre-existing evidence is malformed';
  const actions = gateActionLines(body);
  if (!actions.length || actions.some(a => a.action !== 'operator-card' || !a.indices.length || !CARD_REF_RE.test(a.cardRef ?? '')))
    return 'judge card action malformed';
  if (securityHold || humanHold || actions.some(a => a.indices.some(index => blockedIndices?.has(index)))) return 'judge card cannot override a security or human hold';
  try {
    if (!actions.every(a => a.indices.every(index => judgeCardFindingAllowed(findings.find(f => f.index === index), findingClasses)))) return 'judge card finding is not eligible';
    return ancestor(m[1]) === true && actions.every(a => cardReadable(a.cardRef, a.indices, marker) === true)
      ? null : 'judge card main or backing card evidence refused';
  } catch { return 'judge card main or backing card evidence refused'; }
}

/** Judge holds and evidenced card releases require attribution, trusted authorship and live policy. */
export function isRulingComment(c, policy = judgePolicyOnce(), evidence = {}) {
  return rulingCommentRefusal(c, policy, evidence) === null;
}

/** Named refusals keep negative tests specific instead of passing on missing mandatory context. */
export function rulingCommentRefusal(c, policy = judgePolicyOnce(), evidence = {}) {
  const m = parseRedTeamGateMarker(c?.body);
  if (m?.actor === undefined) return isHumanOperatorComment(c) ? null : 'not a human operator';
  if (m.actor !== JUDGE_ACTOR || !['operator-block', 'operator-card'].includes(m.outcome)) return 'judge outcome refused';
  if (!isJudgeAuthored(c)) return 'not the designated judge author';
  if (JUDGE_RESERVED_TOKEN_RE.test(String(c?.body ?? ''))) return 'judge reserved token';
  if (!String(c?.body ?? '').split(/\r?\n/).some(line => line === JUDGE_ATTRIBUTION || line === `${JUDGE_ATTRIBUTION} (${JUDGE_ACTOR})`)) return 'judge attribution missing';
  try { const p = policy(); if (p.enabled !== true || p.actor !== JUDGE_ACTOR) return 'judge actor disabled'; }
  catch { return 'judge policy unreadable'; }
  return m.outcome === 'operator-card' ? preExistingRefusal(c, m, evidence) : null;
}
