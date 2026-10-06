import { stripVTControlCharacters } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { isAbsolute, relative } from 'node:path';

/** Bounded failure identities and a diagnostic tail; truncated evidence cannot authorize a retry. */
export function boundFailureDetails(value) {
  if (!value || !Array.isArray(value.tests) || typeof value.summary !== 'string') return undefined;
  let truncated = !!value.truncated;
  const clip = (s, limit) => {
    const chars = Array.from(s);
    if (chars.length > limit) truncated = true;
    return chars.slice(0, limit).join('');
  };
  const tests = [];
  for (const entry of value.tests) {
    if (!entry || typeof entry.file !== 'string' || !(entry.name === null || typeof entry.name === 'string')) { truncated = true; continue; }
    if (tests.length === 20) { truncated = true; break; }
    tests.push({ file: clip(entry.file, 512), name: entry.name === null ? null : clip(entry.name, 512) });
  }
  let summary = clip(value.summary, 2048);
  while (Buffer.byteLength(summary) > 2048) { summary = Array.from(summary).slice(1).join(''); truncated = true; }
  const result = { tests, summary, truncated };
  while (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) { result.tests.pop(); result.truncated = true; }
  return result;
}

/** Separate bounded line state per stream; neither a huge line nor a long run retains its log. */
export function createFailureCollector({ cwd = process.cwd() } = {}) {
  const streams = new Map();
  const tests = [];
  let summary = '';
  let truncated = false;
  function line(text, dropped) {
    if (dropped) truncated = true;
    const clean = stripVTControlCharacters(text).trim();
    if (!clean) return;
    summary += `${clean}\n`;
    // Summary is always a rolling tail. Normal progress scrolling out does not lose failure identities;
    // reserve `truncated` for dropped/clipped evidence, so a long successful prefix cannot mask completeness.
    if (summary.length > 2048) summary = Array.from(summary).slice(-1024).join('');
    if (dropped) { truncated = true; return; }
    const match = /^FAIL\s+(?:\[[^\]]+\]\s+)?(.+?\.(?:[cm]?[jt]sx?))(?:\s+>\s+(.+))?$/.exec(clean);
    if (!match) return;
    const file = isAbsolute(match[1]) ? relative(cwd, match[1]) : match[1].replace(/^\.\//, '');
    if (file.startsWith('../') || isAbsolute(file)) return;
    const entry = { file, name: match[2] ?? null };
    if (tests.some(t => t.file === file && t.name === entry.name)) return;
    if (tests.length >= 20) { truncated = true; return; }
    tests.push(entry);
  }
  return {
    push(chunk, stream = 'stdout') {
      if (!streams.has(stream)) streams.set(stream, { decoder: new StringDecoder('utf8'), pending: '', dropped: false });
      const state = streams.get(stream);
      const text = typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
      for (const char of text) {
        if (char === '\n') { line(state.pending, state.dropped); state.pending = ''; state.dropped = false; }
        else if (state.pending.length < 4096) state.pending += char;
        else state.dropped = true;
      }
    },
    finish() {
      for (const state of streams.values()) line(state.pending + state.decoder.end(), state.dropped);
      return boundFailureDetails({ tests, summary: summary.trim(), truncated });
    },
  };
}

/**
 * 75b — fold the failure details of several red gate phases into one bounded record, so the agent sees a scan or
 * standards failure next to the test failure. Each phase keeps an equal share of the summary (its own tail, labelled
 * with the phase), and identities keep phase order. A single part is returned unchanged.
 * @param {{phase: string, details: object|undefined}[]} parts
 */
export function mergeFailureDetails(parts) {
  const present = parts.filter(p => p.details && Array.isArray(p.details.tests) && typeof p.details.summary === 'string');
  if (present.length <= 1) return present[0]?.details;
  const share = Math.floor(2000 / present.length) - 16;
  const tail = (s) => { const chars = Array.from(s); return chars.length > share ? chars.slice(-share).join('') : s; };
  const tests = [];
  for (const { details } of present) for (const t of details.tests) if (!tests.some(e => e.file === t.file && e.name === t.name)) tests.push(t);
  return boundFailureDetails({
    tests,
    summary: present.map(({ phase, details }) => `[${phase}] ${tail(details.summary)}`).join('\n'),
    // The summary is a rolling tail by design (see the collector); only dropped identities count as truncated.
    truncated: present.some(p => p.details.truncated),
  });
}
