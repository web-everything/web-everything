/** Exit-ruling presence selects PR detail; unreadable history never widens selection. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readExitRulingPrs({ path, readFile = readFileSync } = {}) {
  if (path === undefined) {
    try {
      const settings = JSON.parse(String(readFile(new URL('../settings/judge-sweep-stall.json', import.meta.url), 'utf8')));
      const configured = settings?.judgeSweepStall?.exitRulingsPath;
      if (typeof configured === 'string' && configured.trim()) path = configured;
    } catch { /* Optional tool settings may be absent. */ }
    path ??= join(homedir(), 'workspace/.operations/handoff/rulings-history.jsonl');
  }
  let text;
  try { text = String(readFile(path, 'utf8')); }
  catch { return { prs: new Set(), errors: ['exit rulings unreadable'] }; }
  const prs = new Set();
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    for (const key of [row?.key, row?.ruling?.key]) {
      const match = typeof key === 'string' && /^review\.loop\.exit\.pr(\d+)/.exec(key);
      const pr = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(pr) && pr > 0) prs.add(pr);
    }
  }
  return { prs, errors: malformed ? [`exit rulings malformed lines: ${malformed}`] : [] };
}
