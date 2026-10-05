/** Is a `card` referral ruling's deferral backed by a real card? One definition for every reader of that gate. */
import { readFileSync, readdirSync } from 'node:fs';

/** A deferral is discharged only by an existing readable backlog card, never an intention to file. */
export function referralCardReadable(ref, root = process.cwd()) {
  if (!/^we:backlog\/[^/]+\.md$/.test(ref ?? '')) return false;
  const card = text => /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text);
  try { return card(readFileSync(`${root}/${ref.slice(3)}`, 'utf8')); }
  catch {
    // #4979 — a provisional card (`x…`) is renumbered when it lands (#2288 JIT numbering); a ruling that cited
    // it by its birth name still names that card through the landed file's `bornAs:`.
    const born = /^we:backlog\/(x[a-z0-9]{6})-/.exec(ref)?.[1];
    if (!born) return false;
    try {
      return readdirSync(`${root}/backlog`).some(name => name.endsWith('.md') && /^\d+-/.test(name) && (() => {
        const text = readFileSync(`${root}/backlog/${name}`, 'utf8');
        return card(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);
      })());
    } catch { return false; }
  }
}
