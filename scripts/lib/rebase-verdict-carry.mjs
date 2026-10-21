import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ensureCommitReadable } from './carry-equivalence.mjs';
import { parseReviewedSha, findAcceptVerdictComment } from './review-escalation.mjs';
import { latestAcceptRecord, isLaterVerdictBody } from './accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { gateOutcomesForHead, parseRedTeamGateMarker, parseRedTeamComment, breakClass, RED_TEAM_COMMENT_MARKER,
  liveResultGateState, redTeamGateMarker, redTeamMarker, redTeamResultId, redTeamCarryLinesMarker, parseRedTeamCarryLinesMarker, unchangedCitedLines } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker, buildVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';
const HEX = /^[0-9a-f]{40}$/;

// Only consume complete, known provenance shapes. A marker proves where a
// record belongs; it does not make arbitrary surrounding text informational.
/** The cited-line record's whole body (marker + one prose line). PURE; the carry recognizes exactly this shape. */
export function carryLinesBody({ pr, from, to, result, unchanged }) {
  const marker = redTeamCarryLinesMarker({ pr, from, to, result, unchanged });
  const listed = parseRedTeamCarryLinesMarker(marker).unchanged;
  return `${marker}\nRed-team cited lines unchanged across the carry: ${listed.length ? listed.map(i => `#${i}`).join(', ') : 'none'} (operator rulings on these breaks carry; the others are re-ruled).`;
}

export function informationalProvenance(body, sha, pr) {
  let rest = String(body ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n').trim();
  // The carry's own cited-line record for a carry ONTO this head: informational only in its exact rendered shape.
  const citedRecord = parseRedTeamCarryLinesMarker(rest);
  if (citedRecord) return citedRecord.to === sha && citedRecord.pr === Number(pr) && rest === carryLinesBody(citedRecord);
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
  return advisoryLinesValid(rest);
}

/** Gate outcomes a verdict carry re-keys onto the new head (bare markers, no action lines). */
const CARRIED_GATE_OUTCOMES = new Set(['sent-back', 'round-cap', 'card-queued', 'card-pending', 'operator-card', 'operator-not-real', 'operator-block']);

/**
 * THIS carry's own comment for a carry ONTO `sha`, in exactly the shape attemptVerdictCarry renders: bare gate markers
 * (rev=sha, this PR, named by the carried result), the carried marker (to=sha), the fixed prose line, and the re-keyed
 * advisory (rev=sha) whose every line is the producer's format. It restates records that already preceded the accept on
 * the carried-from head, so a SECOND identical rebase must not read it as a later verdict. A confirmed broken finding
 * in it is allowed here only because its hold is enforced by the red-team disposition (the gate records it carries),
 * never by the accept; anything appended, any other marker, or another head makes it a later verdict as before. PURE.
 */
export function isOwnVerdictCarryComment(body, sha, pr) {
  const text = String(body ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n').trim();
  const lines = text.split('\n');
  const k = lines.findIndex(l => l.startsWith('<!-- review-verdict-carried '));
  if (k < 0) return false;
  const carried = parseVerdictCarriedMarker(lines[k]);
  if (!carried || carried.toSha !== sha || lines[k] !== buildVerdictCarriedMarker(carried)) return false;
  if (lines[k + 1] !== 'Review verdict carried across an identical contribution.') return false;
  const advisoryText = lines.slice(k + 2).join('\n').trim();
  const advisory = advisoryText ? parseRedTeamComment(advisoryText) : null;
  if (advisoryText && (advisory?.rev !== sha || advisory.pr !== Number(pr) || !advisoryLinesValid(advisoryText))) return false;
  const result = advisory ? redTeamResultId(advisory) : null;
  return lines.slice(0, k).every(l => {
    const g = parseRedTeamGateMarker(l);
    return g && g.pr === Number(pr) && g.rev === sha && CARRIED_GATE_OUTCOMES.has(g.outcome) && !g.grantIds
      && (g.result ?? null) === (g.result ? result : null) && l === redTeamGateMarker(pr, sha, g.outcome, g.result ?? null);
  });
}

/** parseRedTeamComment deliberately ignores prose: here every nonblank line must belong to the producer's format, so an
 *  appended hold cannot disappear. PURE. */
function advisoryLinesValid(rest) {
  const lines = rest.slice(rest.indexOf('-->') + 3).split('\n');
  return lines.every(line => !line.trim()
    || line === 'No confirmed breaks.'
    || /^### Post-accept red team — (?:no break found|\d+ possible break\(s\), \d+ confirmed by Claude's re-check)$/.test(line)
    || /^Advisory only: this comment changes no label itself; the red-team gate \(setting `redTeam.confirmedBreaks`\) sends a confirmed broken break back to the fixer\. Head `[0-9a-f]{12}` · red team [^\n]+ · recorded verdict `[^`\n]+`\.$/.test(line)
    || line === 'The red team tried to break this change and reported nothing.'
    || line === "A confirmed break is recorded as a miss for the accepting review and for the builder's model."
    || parseRedTeamComment(`${rest.slice(0, rest.indexOf('-->') + 3)}\n${line}`)?.findings.length === 1
    // review-extra-seats.mjs#renderRedTeamComment's three sub-lines; `Files read` was missing, so every real advisory
    // read as a hold and no carry could ever fire after a red team (live #5779, 2026-10-21).
    || /^ {3}- (?:Scenario|Re-check|Files read): [^\n]*$/.test(line));
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
/** PURE: a trusted accept survives only without a superseding verdict or unknown hold. */
// Only the LATEST reviewed head is a candidate. An older-candidate path (carry from the reviewed head when the drain
// re-stamped onto different content, live #5779) was built and withdrawn on 2026-10-21: three Codex audits showed a
// trusted comment shaped like an accept or a restamp could reset the hold boundary. Not worth the residual.
export function findCarriableVerdict({ comments, headSha, pr } = {}) {
  if (!HEX.test(headSha ?? '')) return null;
  const all = Array.isArray(comments) ? comments : [];
  const trusted = all.filter(isTrustedMarkerAuthor);
  const sha = parseReviewedSha(trusted);
  if (!HEX.test(sha ?? '')) return null;
  return findCarriableVerdictFor({ comments: all, trusted, sha, headSha, pr });
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
    return !informationalProvenance(c?.body, sha, number) && !isOwnVerdictCarryComment(c?.body, sha, number);
  });
  const record = latestAcceptRecord(verdictComments);
  // A body-derived hold anywhere after the accept counts on the UNFILTERED thread: neutral shapes are never a way to
  // hide one (Codex re-audit #3, finding 1).
  if (latestAcceptRecord(comments)?.laterBodyDerivedHold) return null;
  // The record judged must be the candidate's own: a later record left in place means holds after the candidate were not read.
  if (!HEX.test(sha ?? '') || sha === headSha || !record || record.sha !== sha || record.laterVerdict || record.laterBodyDerivedHold) return null;
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
    for (const prior of [findCarriableVerdict({ ...evidence, pr })].filter(Boolean)) {
      const sha = prior.sha;
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
      // Operator red-team rulings follow the carry only for breaks whose cited line is byte-identical on both heads
      // (red-team-gate.mjs#redTeamCarryLinesMarker). No reader, or any failure: no record, so no operator release carries.
      if (decided && decided.resultId === redTeamResultId(prior.advisory) && typeof io.readCitedLine === 'function') {
        try {
          const unchanged = unchangedCitedLines((prior.advisory.findings ?? []).filter(f => f.confirmed), { fromSha: prior.sha, toSha: evidence.headSha,
            readLine: (sha, file, line) => io.readCitedLine({ sha, file, line, repo }) });
          io.postCarryComment({ pr, repo, body: carryLinesBody({ pr, from: prior.sha, to: evidence.headSha, result: decided.resultId, unchanged }) });
        } catch (e) { log(`verdict-carry: PR #${pr} cited-line record not posted (${String(e?.message ?? e).slice(0, 200)}); operator red-team rulings will not carry`); }
      }
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

/** `readCitedLine` for the carry: the RAW BYTES (hex) of line `line` (1-based) of the BLOB `file` at `sha`, or null.
 *  The object must be a blob (never a tree), the line must exist (a trailing newline adds no line), and bytes are
 *  compared undecoded, so different bytes never compare equal. The path must be a plain repo-relative path (no `..`,
 *  no leading `/`, no `:`). It runs git ITSELF (`execFileSync`, Buffer output) in `cwd`: a caller's string-decoding
 *  exec wrapper would collapse distinct bytes, so only a Buffer is accepted; anything else is unreadable (null). */
export function gitCitedLineReader({ cwd, env = process.env, exec = execFileSync } = {}) {
  return ({ sha, file, line }) => {
    if (!HEX.test(String(sha ?? '')) || typeof file !== 'string' || !file || file.startsWith('/') || file.includes(':')
      || file.split('/').includes('..') || !Number.isInteger(line) || line < 1) return null;
    const spec = `${sha}:${file}`;
    try { if (String(exec('git', ['cat-file', '-t', spec], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() !== 'blob') return null; } catch { return null; }
    let buf;
    try { buf = exec('git', ['cat-file', 'blob', spec], { cwd, env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
    if (!Buffer.isBuffer(buf)) return null;
    const lines = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) { lines.push(buf.subarray(start, i)); start = i + 1; }
    if (start < buf.length) lines.push(buf.subarray(start));
    return line <= lines.length ? lines[line - 1].toString('hex') : null;
  };
}
