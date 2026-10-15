import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureCommitReadable } from './carry-equivalence.mjs';
import { parseReviewedSha, findAcceptVerdictComment } from './review-escalation.mjs';
import { latestAcceptRecord, isLaterVerdictBody } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { gateOutcomesForHead, parseRedTeamGateMarker, parseRedTeamComment, breakClass, RED_TEAM_COMMENT_MARKER } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
const HEX = /^[0-9a-f]{40}$/;

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

/** PURE: a trusted accept survives only without a superseding verdict or unknown hold. */
export function findCarriableVerdict({ comments, headSha, pr } = {}) {
  if (!HEX.test(headSha ?? '')) return null;
  const trusted = (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor);
  const sha = parseReviewedSha(trusted);
  const gates = trusted.map(c => parseRedTeamGateMarker(c.body)).filter(m => m && m.rev === sha && (pr == null || m.pr === Number(pr)));
  const advisories = trusted.map(c => {
    const carried = parseVerdictCarriedMarker(c.body);
    const body = carried?.toSha === sha && c.body.includes(RED_TEAM_COMMENT_MARKER)
      ? c.body.slice(c.body.indexOf(RED_TEAM_COMMENT_MARKER)) : c.body;
    return { body, parsed: parseRedTeamComment(body) };
  });
  const number = pr ?? gates.at(-1)?.pr ?? advisories.find(x => x.parsed?.rev === sha)?.parsed.pr;
  const advisory = advisories.filter(x => x.parsed?.pr === Number(number) && x.parsed.rev === sha).at(-1);
  // Only this carry path treats trusted, same-sha provenance as informational.
  // Keep every other comment for the shared approval guard, including untrusted holds.
  const verdictComments = (Array.isArray(comments) ? comments : []).filter(c => {
    if (!isTrustedMarkerAuthor(c) || String(c?.body ?? '').split('\n').some(isLaterVerdictBody)) return true;
    const carried = parseVerdictCarriedMarker(c?.body);
    const gate = parseRedTeamGateMarker(c?.body);
    const body = carried?.toSha === sha && c.body.includes(RED_TEAM_COMMENT_MARKER)
      ? c.body.slice(c.body.indexOf(RED_TEAM_COMMENT_MARKER)) : c?.body;
    const advisory = parseRedTeamComment(body);
    // A carry wrapper must never hide a send-back or a confirmed break.
    if (gate && (gate.rev !== sha || gate.outcome !== 'card-queued')) return true;
    if (advisory && (advisory.rev !== sha || advisory.findings.some(f => breakClass(f) === 'broken'))) return true;
    if (carried) {
      if (carried.toSha !== sha) return true;
      // The producer wraps an optional advisory in gate/carry markers and this fixed sentence.
      // Unknown text beside a carry marker remains a possible hold.
      let rest = String(c.body).trim();
      if (gate) rest = rest.slice(rest.indexOf('-->') + 3).trimStart();
      if (!rest.startsWith('<!-- review-verdict-carried ')) return true;
      rest = rest.slice(rest.indexOf('-->') + 3).trimStart();
      rest = rest.replace(/^Review verdict carried across an identical contribution\.(?:\n|$)/, '').trim();
      return rest !== '' && parseRedTeamComment(rest)?.rev !== sha;
    }
    return !(gate?.rev === sha && gate.outcome === 'card-queued') && advisory?.rev !== sha;
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
