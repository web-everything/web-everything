import { parseRedTeamGateMarker, parseRedTeamComment, breakClass } from './red-team-gate.mjs';
import { parseVerdictCarriedMarker } from './review-verdict-carried-marker.mjs';

// Only consume complete, known provenance shapes. A marker proves where a
// record belongs; it does not make arbitrary surrounding text informational.
export function informationalProvenance(body, sha, pr) {
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

