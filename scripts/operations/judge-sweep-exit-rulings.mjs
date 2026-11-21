/** Exit-ruling presence selects PR detail; unreadable history never widens selection. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function readExitRulingPrs({ path, readFile = readFileSync } = {}) {
  if (path === undefined) {
    let settingsText;
    try {
      settingsText = String(readFile(new URL('../settings/judge-sweep-stall.json', import.meta.url), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') return { prs: new Set(), errors: ['exit rulings settings unreadable'] };
    }
    if (settingsText !== undefined) {
      let settings;
      try { settings = JSON.parse(settingsText); }
      catch { return { prs: new Set(), errors: ['exit rulings settings invalid'] }; }
      const configured = settings?.judgeSweepStall?.exitRulingsPath;
      if (typeof configured !== 'string' || !configured.trim()) {
        return { prs: new Set(), errors: ['exit rulings settings invalid'] };
      }
      path = configured;
    }
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
    if (!row || typeof row !== 'object' || Array.isArray(row)) { malformed++; continue; }
    const keys = [];
    if (Object.hasOwn(row, 'key')) keys.push(row.key);
    if (row.ruling && typeof row.ruling === 'object' && Object.hasOwn(row.ruling, 'key')) keys.push(row.ruling.key);
    let invalid = keys.length === 0;
    for (const key of keys) {
      if (typeof key !== 'string' || !key.trim()) { invalid = true; continue; }
      // History uses bare PR keys and the final exit-ruling suffix only.
      const match = /^review\.loop\.exit\.pr(\d+)(?:\.final)?$/.exec(key);
      if (!match || match[0] !== key) continue;
      const pr = Number(match[1]);
      if (Number.isSafeInteger(pr) && pr > 0) prs.add(pr);
      else invalid = true;
    }
    if (invalid) malformed++;
  }
  return { prs, errors: malformed ? [`exit rulings malformed lines: ${malformed}`] : [] };
}
