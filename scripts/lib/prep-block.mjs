import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HEADINGS = ['Acceptance', 'Pre-mortem', 'Files', 'Tests'];
const FORMAT = 'PREP:\nAcceptance: <criteria>\nPre-mortem: <risks>\nFiles: <paths>\nTests: <checks>\nOr: prep: waived — <reason>';
export const PREP_BUILD_VERB = /\b(?:implement|build|add|fix|refactor|write)\b/i;
// Only explicit leading tasks exempt work. Bare topic labels never grant an exemption.
const EXEMPT_TASK = /^\s*(?:fix (?:the )?merge conflict(?=\s*(?:$|[.!?,;:])|\s+(?:and|then)\b)|resolve (?:the )?(?:merge )?conflict|rebase onto|(?:re-?run|retrigger) CI|file (?:a |the )?(?:backlog )?(?:card|item)|card-only(?=\s*(?:$|[.!?,;:]))|review (?:the|this) PR|code review(?=\s*(?:$|[.!?,;:]))|red-?team (?:the|this) PR)\b/i;

export function isPrepExempt(text) {
  const statement = typeof text === 'string' ? text : '';
  return EXEMPT_TASK.test(statement);
}

function nonTrivial(line) {
  const item = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s*)/, '').replace(/\*\*/g, '').trim();
  return item.replace(/\s/g, '').length >= 8
    && !/^(?:<[^<>]*>\s*)+$/.test(item)
    && !/^(?:tbd|todo|n\/a|none|[-.…]+)[.!]?$/i.test(item);
}

function stripMarkdown(line) {
  return line.trim().replace(/^(?:(?:[-+]\s+)|(?:\*\s+)|(?:#+\s*)|\*\*)+/, '').replace(/\*\*/g, '');
}

/** Parse only sections following PREP, without IO or mutation of caller data. */
export function parsePrep(text) {
  const lines = (typeof text === 'string' ? text : '').split(/\r?\n/);
  const waiver = lines.map((line) => line.match(/^\s*prep:\s*waived\s*[—–-]\s*(\S.{3,})/i))
    .find((match) => match && nonTrivial(match[1]));
  const start = lines.findIndex((line) => /^PREP:/i.test(stripMarkdown(line)));
  const sections = new Map();
  let current;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const clean = stripMarkdown(line);
    const heading = clean.match(/^(Acceptance|Pre-mortem|Files|Tests):\s*(.*)$/i);
    if (heading) {
      current = HEADINGS.find((name) => name.toLowerCase() === heading[1].toLowerCase());
      if (!sections.has(current)) sections.set(current, []);
      sections.get(current).push(heading[2]);
    } else if (/^PREP:/i.test(clean) || /^\s*#{1,6}\s/.test(line)) {
      current = undefined;
    } else if (current) sections.get(current).push(line);
  }
  return {
    present: start >= 0 || Boolean(waiver), waived: Boolean(waiver), waiverReason: waiver?.[1].trim() || '',
    missing: HEADINGS.filter((name) => !sections.has(name)),
    empty: HEADINGS.filter((name) => sections.has(name) && !sections.get(name).some(nonTrivial)),
  };
}

export function prepVerdict(text) {
  const prep = parsePrep(text);
  if (prep.waived) return { ok: true, reason: prep.waiverReason, waived: true };
  if (prep.present && !prep.missing.length && !prep.empty.length) return { ok: true, reason: '', waived: false };
  const problems = [!prep.present && 'PREP block absent', prep.missing.length && `missing: ${prep.missing.join(', ')}`,
    prep.empty.length && `empty or placeholder: ${prep.empty.join(', ')}`].filter(Boolean);
  return { ok: false, reason: `Prep required (${problems.join('; ')}). Each heading needs a non-placeholder item of at least 8 non-whitespace characters.\n${FORMAT}`, waived: false };
}

/** Best-effort local audit: logging can never block an operator. */
export function logPrepEvent(entry, { logPath = join(homedir(), 'workspace', '.operations', 'prep-gate.log') } = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), kind: entry.kind, detail: entry.detail }) + '\n');
  } catch (error) {
    const detail = String(error?.message || error).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
    try { process.stderr.write(`prep-gate: WARNING — ${entry.kind} audit write failed: ${detail}\n`); } catch { /* fail open even if stderr is unavailable */ }
  }
}
