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
    || /^ {3}- (?:Scenario|Re-check): [^\n]*$/.test(line)
    // Card 6212 — the renderer's raw-field break identity (a fixed-shape digest, no model text).
    || /^ {3}- Identity: [0-9a-f]{32}$/.test(line));
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
  // A post-accept red team may still be running on the old head. Until it has
  // posted a record, moving the accept would strand any later old-head break.
  if (!gates.length && !advisory) return null;
  // Only this carry path treats trusted, same-sha provenance as informational.
  // Keep every other comment for the shared approval guard, including untrusted holds.
  const verdictComments = (Array.isArray(comments) ? comments : []).filter(c => {
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
