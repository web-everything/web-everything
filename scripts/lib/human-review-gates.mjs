/** Shared current-head evidence required before asking for or delegating human approval. */
import { parseRedTeamComment, RED_TEAM_COMMENT_MARKER, readRedTeamDisposition } from './red-team-gate.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export function redTeamClearAtCurrentHead(pr, head) {
  const d = readRedTeamDisposition({ comments: pr.comments, pr: pr.number, head, repo: pr.repo });
  return headlineAgrees(pr.comments, pr.number, head) && !!d.result && d.sendBack.length === 0 && d.held.length === 0
    && !d.result.findings.some(f => f.recheckOutcome === 'unverifiable');
}

/** Unknown, missing and asynchronous evidence cannot prove readiness. */
export function currentHeadHumanReviewGates(pr, { redTeamClearAtHead = redTeamClearAtCurrentHead } = {}) {
  const failed = [];
  const head = /^[a-f0-9]{40}$/i.test(pr?.headRefOid ?? '') ? pr.headRefOid : null;
  if (!head) failed.push('head not pinned');
  const labels = Array.isArray(pr?.labels) ? pr.labels.map(l => typeof l === 'string' ? l : l?.name) : [];
  if (labels.includes('ci:failed')) failed.push('ci:failed label');
  for (const hold of ['red-team:pending', 'red-team:blocked', 'review:changes', 'status:fixing', 'review-status:fixing', 'status:sent-back-red-team']) {
    if (labels.includes(hold)) failed.push(`approval held by ${hold}`);
  }
  let clear = false;
  try { clear = !!head && labels.includes('red-team:clear') && redTeamClearAtHead(pr, head) === true; } catch { /* closed */ }
  if (!clear) failed.push('red-team:clear not proven on the current head');
  const checks = pr?.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) failed.push('no check rollup');
  else for (const c of checks) {
    const name = c?.name || c?.context || '';
    if (/^(merge-gate|review-gate)$/i.test(name)) continue;
    const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
    if (!['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(verdict)
      || (c?.status && c.status !== 'COMPLETED')) failed.push(`check ${name || '?'} is ${verdict || 'pending'}`);
  }
  return { eligible: failed.length === 0, failed, head };
}

// The parser silently drops a finding line it cannot read; the comment's own headline counts them. Any result
// comment for the live head whose headline disagrees with what parsed is not a clean pass (fail closed).
function headlineAgrees(comments, pr, head) {
  const live = String(head ?? '').toLowerCase();
  return (Array.isArray(comments) ? comments : []).every(c => {
    if (!isTrustedMarkerAuthor(c)) return true; // untrusted text is data, never a veto
    const whole = typeof c === 'string' ? c : c?.body;
    const lines = typeof whole === 'string' ? whole.replace(/\r\n/g, '\n').split('\n') : [];
    // Every embedded result counts, carried wrappers included (liveResultGateState reads those too).
    return lines.every((line, at) => {
      if (!line.trimStart().toLowerCase().startsWith(RED_TEAM_COMMENT_MARKER)) return true; // same leniency as the shared parser
      const body = lines.slice(at).join('\n').trimStart(), parsed = parseRedTeamComment(body);
      if (!parsed) {
        // Repair only the delimiter to ask the shared parser which PR/head this marker names.
        // Malformed live or unscopable evidence still vetoes approval; unrelated history does not.
        const scope = parseRedTeamComment(`${line.split('-->', 1)[0].trimEnd()} -->`);
        return scope !== null && (scope.pr !== Number(pr) || scope.rev !== live);
      }
      return parsed.pr !== Number(pr) || parsed.rev !== live || resultAgrees(body, parsed);
    });
  });
}
function resultAgrees(body, parsed) {
  {
    const clean = /^### Post-accept red team — no break found$/m.test(body);
    const counted = /^### Post-accept red team — (\d+) possible break\(s\), (\d+) confirmed/m.exec(body);
    if (clean) return parsed.findings.length === 0;
    return !!counted && Number(counted[1]) === parsed.findings.length
      && Number(counted[2]) === parsed.findings.filter(f => f.confirmed).length;
  }
}
