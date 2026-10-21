import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureCommitReadable } from './carry-equivalence.mjs';
import { parseReviewedSha, findAcceptVerdictComment } from './review-escalation.mjs';
import { latestAcceptRecord, isLaterVerdictBody } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { gateOutcomesForHead, parseRedTeamGateMarker, parseRedTeamComment, breakClass, RED_TEAM_COMMENT_MARKER,
  liveResultGateState, redTeamGateMarker, redTeamMarker, redTeamResultId } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker, buildVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
const HEX = /^[0-9a-f]{40}$/;

// Only consume complete, known provenance shapes. A marker proves where a
// record belongs; it does not make arbitrary surrounding text informational.
function informationalProvenance(body, sha, pr) {
  let rest = String(body ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n').trim();
  const sameRecord = record => record?.rev === sha && record.pr === Number(pr);
  const gate = parseRedTeamGateMarker(rest);
  if (gate) {
    if (!sameRecord(gate) || gate.outcome !== 'card-queued') return false;
    rest = rest.slice(rest.indexOf('-->') + 3).trim();
    const heading = `**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${sha.slice(0, 12)}\`:`;
    if (rest.split('\n')[0] === heading) {
      const lines = rest.split('\n');
      lines.shift();
      // buildGateComment's card/advisory records; a send-back never carries.
      while (/^- \d+ finding\(s\) (?:filed as a follow-up card \(#[\d, #]+\) — landing job [^\n]+\.|left advisory \(#[\d, #]+\)\.)$/.test(lines[0] ?? '')) lines.shift();
      rest = lines.join('\n').trim();
    }
  }
  const carried = parseVerdictCarriedMarker(rest);
  if (carried) {
    if (carried.toSha !== sha || !rest.startsWith('<!-- review-verdict-carried ')) return false;
    rest = rest.slice(rest.indexOf('-->') + 3).trim();
    rest = rest.replace(/^Review verdict carried across an identical contribution\.(?:\n|$)/, '').trim();
  }
  if (!rest) return !!gate || !!carried;
  const advisory = parseRedTeamComment(rest);
  if (!sameRecord(advisory) || advisory.findings.some(f => breakClass(f) === 'broken')) return false;
  // parseRedTeamComment deliberately ignores prose. Here every nonblank line
  // must belong to the producer's format so an appended hold cannot disappear.
  const lines = rest.slice(rest.indexOf('-->') + 3).split('\n');
  return lines.every(line => !line.trim()
    || line === 'No confirmed breaks.'
    || /^### Post-accept red team — (?:no break found|\d+ possible break\(s\), \d+ confirmed by Claude's re-check)$/.test(line)
    || /^Advisory only: this comment changes no label itself; the red-team gate \(setting `redTeam.confirmedBreaks`\) sends a confirmed broken break back to the fixer\. Head `[0-9a-f]{12}` · red team [^\n]+ · recorded verdict `[^`\n]+`\.$/.test(line)
    || line === 'The red team tried to break this change and reported nothing.'
    || line === "A confirmed break is recorded as a miss for the accepting review and for the builder's model."
    || parseRedTeamComment(`${rest.slice(0, rest.indexOf('-->') + 3)}\n${line}`)?.findings.length === 1
    || /^ {3}- (?:Scenario|Re-check): [^\n]*$/.test(line));
}

/** IO: compare whitespace-sensitive net patches; missing objects get one fetch. Never throws. */
export function contributionPatchId({ exec, sha, base = 'origin/main' } = {}) {
  try {
    if (!ensureCommitReadable({ exec, sha }).ok || !ensureCommitReadable({ exec, sha: base }).ok) return null;
    const git = (args, input) => String(exec('git', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }));
    const mb = git(['merge-base', base, sha]).trim();
    if (!HEX.test(mb)) return null;
    const diff = git(['diff', '--no-ext-diff', '--no-textconv', '--binary', mb, sha, '--', '.', ':(exclude).lane-manifest.json']);
    const id = git(['patch-id', '--verbatim'], diff).trim().split(/\s+/)[0];
    return HEX.test(id) ? id : null;
  } catch { return null; }
}

/**
 * The exact re-arm `rearm-review.mjs#buildRearmComment` renders when an ACCEPTED PR's head was re-pushed (no bounce,
 * no human hold). It records only "the head moved, so a re-review is owed" — the very debt an identical-net-patch carry
 * answers — so the carry does not treat it as a superseding verdict. Any other re-arm (a repaired `review:changes`
 * bounce, a human-hold re-arm, a conflict round) still supersedes. Whole-body match: appended prose is never neutral.
 */
const ACCEPTED_REARM_RE = /^🔧 conveyor fix — re-armed for re-review\n\nThe previously accepted PR was re-pushed and its acceptance is being re-armed for review by [^\n;]{1,120}; the PR is re-armed `review:pending` \(an independent re-review is owed\)\.\n\nThe fix agent did NOT clear the review — a human `\/review` \(or the drain AI-review convergence pass\) re-verdicts\.$/;
export function isAcceptedRearmBody(body) {
  return ACCEPTED_REARM_RE.test(String(body ?? '').replace(/\r\n?/g, '\n').trim());
}
const reviewedShasIn = body => [...String(body ?? '').matchAll(/<!--\s*reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi)].map(m => m[1].toLowerCase());

/**
 * PURE: the trusted reviewed heads a carry may start from, newest first, distinct, at most `limit`. The newest is
 * today's only candidate. An older one matters when the drain re-stamped its accept onto a head with DIFFERENT content
 * (e.g. its JIT-numbering commit) and a repair then restored the accepted content (live #5779, 2026-10-21): the live head
 * equals what was reviewed, not what was re-stamped. {@link findCarriableVerdict} still decides each one.
 */
export function carryCandidateShas(comments, { limit = 4 } = {}) {
  const out = [];
  for (const c of (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor).reverse()) {
    for (const sha of reviewedShasIn(c?.body).reverse()) if (!out.includes(sha)) out.push(sha);
  }
  return out.slice(0, limit);
}

/** PURE: a trusted accept survives only without a superseding verdict or unknown hold. */
export function findCarriableVerdict({ comments, headSha, pr, sha: candidate } = {}) {
  if (!HEX.test(headSha ?? '')) return null;
  const all = Array.isArray(comments) ? comments : [];
  const trusted = all.filter(isTrustedMarkerAuthor);
  const latest = parseReviewedSha(trusted);
  const sha = candidate === undefined ? latest : candidate;
  if (!HEX.test(sha ?? '')) return null;
  // An older candidate is judged as if it were the latest record: every later reviewed-sha record (a re-stamp or a
  // later accept) is set aside, so the inverted hold rule below reads EVERY comment after the candidate's own record.
  // Anything there that is not a known machine shape — a red-team record on a later head included — refuses the carry.
  let lastOwn = -1;
  if (sha !== latest) {
    all.forEach((c, i) => { if (isTrustedMarkerAuthor(c) && reviewedShasIn(c?.body).at(-1) === sha) lastOwn = i; });
    if (lastOwn < 0) return null;
  }
  const scoped = sha === latest ? all
    : all.filter((c, i) => i <= lastOwn || !(isTrustedMarkerAuthor(c) && reviewedShasIn(c?.body).length));
  return findCarriableVerdictFor({ comments: scoped, trusted: scoped.filter(isTrustedMarkerAuthor), sha, headSha, pr });
}

function findCarriableVerdictFor({ comments, trusted, sha, headSha, pr }) {
  const gates = trusted.map(c => parseRedTeamGateMarker(c.body)).filter(m => m && m.rev === sha && (pr == null || m.pr === Number(pr)));
  const advisories = trusted.map(c => {
    const carried = parseVerdictCarriedMarker(c.body);
    const body = carried?.toSha === sha && c.body.includes(RED_TEAM_COMMENT_MARKER)
      ? c.body.slice(c.body.indexOf(RED_TEAM_COMMENT_MARKER)) : c.body;
    return { body, parsed: parseRedTeamComment(body) };
  });
  const number = pr ?? gates.at(-1)?.pr ?? advisories.find(x => x.parsed?.rev === sha)?.parsed.pr;
  const advisory = advisories.filter(x => x.parsed?.pr === Number(number) && x.parsed.rev === sha).at(-1);
  // A post-accept red team may still be running on the old head. Until it has
  // posted a record, moving the accept would strand any later old-head break.
  if (!gates.length && !advisory) return null;
  // Only this carry path treats trusted, same-sha provenance as informational.
  // Keep every other comment for the shared approval guard, including untrusted holds.
  const verdictComments = (Array.isArray(comments) ? comments : []).filter(c => {
    // The proof below (identical net patch) is exactly what this re-arm asked for; see ACCEPTED_REARM_RE.
    if (isTrustedMarkerAuthor(c) && isAcceptedRearmBody(c?.body)) return false;
    if (!isTrustedMarkerAuthor(c) || String(c?.body ?? '').split('\n').some(isLaterVerdictBody)) return true;
    return !informationalProvenance(c?.body, sha, number);
  });
  const record = latestAcceptRecord(verdictComments);
  if (!HEX.test(sha ?? '') || sha === headSha || !record || record.laterVerdict || record.laterBodyDerivedHold) return null;
  return { ...record, ...findAcceptVerdictComment(trusted, sha), sha,
    gateOutcomes: [...gateOutcomesForHead(trusted, number, sha)], advisory: advisory?.parsed ?? null, advisoryBody: advisory?.body ?? null };
}

/** PURE: no readable equal patch IDs means the original review path. */
export function decideRebaseVerdictCarry({ setting, prior, priorPatchId, headPatchId } = {}) {
  const carry = setting === 'on' && !!prior && HEX.test(priorPatchId ?? '') && HEX.test(headPatchId ?? '') && priorPatchId === headPatchId;
  return { carry, reason: carry ? 'identical whitespace-sensitive contribution patch' : 'no proven identical contribution to carry' };
}

export { buildVerdictCarriedMarker, parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';

/**
 * IO SHELL (injected): carry a trusted accept onto the live head when its net change is provably identical, writing
 * the existing restamp (`review-set-label --to=restamp`) and the existing `review-verdict-carried` comment. Shared by
 * the review job (before it spends a round) and the fix launcher (before it re-arms an accepted PR, so a repair that
 * only restored reviewed content consumes no round). Proof = BOTH the whitespace-sensitive contribution patch-id
 * (`contributionPatchId`) AND `identical-net-patch.mjs#proveIdenticalNetPatch` (patch-id --stable + changed bytes +
 * paths/modes/positions); a missing proof reader refuses. Red-team records stay tied to a head: only the carried
 * head's posted gate outcomes are re-keyed, exactly as before. Never throws; anything unproven returns carried:false.
 * io: { carryAcrossRebaseSetting, readCarryEvidence, contributionPatchId, proveIdenticalNetPatch, readSavedResult?,
 *       restampVerdict, postCarryComment, log? }
 * @returns {{carried:boolean, reason:string, fromSha?:string, headSha?:string, patchId?:string}}
 */
export function attemptVerdictCarry(io, { pr, repo, expectHead = null } = {}) {
  const log = line => { try { io?.log?.(line); } catch { /* best effort */ } };
  try {
    const setting = io.carryAcrossRebaseSetting();
    log(`verdict-carry: carryAcrossRebase=${setting.value} (${setting.source})`);
    if (setting.value !== 'on') return { carried: false, reason: 'carryAcrossRebase is off' };
    if (typeof io.proveIdenticalNetPatch !== 'function') return { carried: false, reason: 'no net-patch proof reader' };
    const evidence = io.readCarryEvidence({ pr, repo });
    if (!HEX.test(evidence?.headSha ?? '') || !Array.isArray(evidence?.comments)) throw Error('carry evidence unreadable');
    if (expectHead && evidence.headSha !== expectHead) return { carried: false, reason: `live head ${evidence.headSha.slice(0, 9)} is not the pushed head` };
    let why = 'no carriable trusted accept';
    for (const sha of carryCandidateShas(evidence.comments)) {
      const prior = findCarriableVerdict({ ...evidence, pr, sha });
      if (!prior) continue;
      // A gate decision made on SAVED evidence has no posted result to re-key onto the new head (PR #5551 red team).
      if (!prior.advisory && prior.gateOutcomes.length && (!io.readSavedResult || io.readSavedResult({ pr, repo, head: prior.sha }))) {
        why = `the red-team result on ${sha.slice(0, 9)} is saved, not posted`; continue;
      }
      const priorPatchId = io.contributionPatchId({ sha: prior.sha, repo });
      const headPatchId = io.contributionPatchId({ sha: evidence.headSha, repo });
      const decision = decideRebaseVerdictCarry({ setting: setting.value, prior, priorPatchId, headPatchId });
      if (!decision.carry) { why = `${decision.reason} (from ${sha.slice(0, 9)})`; continue; }
      const proof = io.proveIdenticalNetPatch({ fromSha: prior.sha, toSha: evidence.headSha, repo });
      if (!proof?.ok) { why = `net patch not proven identical from ${sha.slice(0, 9)}: ${proof?.reason ?? 'unreadable'}`; continue; }
      const stamped = io.restampVerdict({ pr, repo, newHead: evidence.headSha,
        reason: `${decision.reason}; ${proof.reason}; from ${prior.sha}; patch-id ${headPatchId}` });
      if (!stamped?.ok) return { carried: false, reason: `restamp refused: ${stamped?.reason ?? 'unknown error'}` };
      // Carry only the gate decisions made on the result being carried, named by that result (PR #5482).
      const decided = prior.advisory ? liveResultGateState(evidence.comments, pr, prior.sha) : null;
      const gate = !decided ? prior.gateOutcomes.map(outcome => redTeamGateMarker(pr, evidence.headSha, outcome))
        : decided.resultId !== redTeamResultId(prior.advisory) ? []
          : [...decided.outcomes].map(outcome => redTeamGateMarker(pr, evidence.headSha, outcome, decided.resultId));
      const body = [...gate, buildVerdictCarriedMarker({ fromSha: prior.sha, toSha: evidence.headSha, patchId: headPatchId }),
        'Review verdict carried across an identical contribution.',
        ...(prior.advisoryBody ? [prior.advisoryBody.replace(redTeamMarker(pr, prior.sha), redTeamMarker(pr, evidence.headSha))] : [])].join('\n');
      io.postCarryComment({ pr, repo, body });
      log(`verdict-carry: PR #${pr} carried ${prior.sha} → ${evidence.headSha} (patch-id ${headPatchId}); no round consumed`);
      return { carried: true, reason: decision.reason, fromSha: prior.sha, headSha: evidence.headSha, patchId: headPatchId };
    }
    return { carried: false, reason: why };
  } catch (e) {
    return { carried: false, reason: String(e?.message ?? e).split('\n')[0].slice(0, 300) };
  }
}

/** IO: env > review settings > off; invalid values fall through. */
export function resolveCarryAcrossRebase({ env = process.env, readFile = readFileSync } = {}) {
  const value = env?.WE_REVIEW_CARRY_ACROSS_REBASE;
  if (['on', 'off'].includes(value)) return { value, source: 'env' };
  try {
    const value = JSON.parse(readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json'), 'utf8'))?.carryAcrossRebase;
    if (['on', 'off'].includes(value)) return { value, source: 'settings' };
  } catch { /* default */ }
  return { value: 'off', source: 'default' };
}
