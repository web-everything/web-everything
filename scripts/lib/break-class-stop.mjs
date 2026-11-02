/** R115/R392 shadow recommendation. Pure: no IO, clock, PR mutations or dispatches. */
import { extractRounds, isGuardPath } from './round-judge.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

/** Conservative scope: all conveyor/guard paths, plus daemon or Forge anywhere in a path. */
export function isDaemonOrForgePath(path) {
  if (typeof path !== 'string') return false;
  const p = path.replace(/^we:/, '').replaceAll('\\', '/').replace(/^\.\//, '');
  return /^scripts\/conveyor\//i.test(p) || /daemon|forge/i.test(p) || isGuardPath(p);
}

/** Unknown/oversized evidence never recommends a stop; a human must review the full thread/diff. */
export function breakClassStop(input) {
  const closed = (reason) => ({ applies: false, wouldStop: false, consecutive: 0, rounds: [],
    enumerateFirst: { required: false, recorded: false }, reason: `${reason}; human review of the full thread and diff required` });
  try {
    const { pr, comments, files, setting = {} } = input ?? {};
    const { mode = 'shadow', consecutive: threshold = 3, enumerateFirst = false } = setting;
    if (!Number.isSafeInteger(Number(pr)) || Number(pr) < 1 || !Array.isArray(comments) || !Array.isArray(files)
      || !['off', 'shadow', 'on'].includes(mode) || !Number.isInteger(threshold) || threshold < 1 || threshold > 100
      || typeof enumerateFirst !== 'boolean') return closed('unreadable or invalid input');
    // Bound parsing cost without treating a truncated history as complete evidence.
    if (comments.length > 10000 || files.length > 10000) return closed('oversized evidence');
    let bytes = 0;
    for (const comment of comments) {
      if (!comment || typeof comment !== 'object' || typeof comment.body !== 'string') return closed('unreadable comment');
      bytes += comment.body.length;
      if (bytes > 8 * 1024 * 1024) return closed('oversized thread');
    }
    const paths = files.map(f => typeof f === 'string' ? f : f?.path);
    if (paths.some(p => typeof p !== 'string' || !p.trim())) return closed('unreadable file path');
    const applies = paths.some(isDaemonOrForgePath);
    const seen = new Set();
    let consecutive = 0;
    const rounds = extractRounds(comments, pr).filter(r => r.source === 'red-team' || r.source === 'review').map(r => {
      // A break class is its finding category at the code surface it hits (full path): the category vocabulary alone is
      // too coarse (#6033 raised "edge-case" in 6 of 9 rounds), while a new file is a new mechanism surface.
      const classes = [...new Set(r.findings.filter(f => f.confirmed === true).map(f =>
        `${(typeof f.category === 'string' ? f.category.trim().toLowerCase().replace(/\s+/g, ' ') : '') || 'uncategorized'}@${
          (typeof f.file === 'string' ? f.file.replace(/^we:/, '').trim().toLowerCase() : '') || 'unknown'}`))].sort();
      const newClasses = classes.filter(c => !seen.has(c));
      for (const c of classes) seen.add(c);
      consecutive = newClasses.length ? consecutive + 1 : 0;
      return { source: r.source, at: r.at, classes, newClasses };
    });
    // The marker must LEAD a trusted comment (not a quote or later mention) and predate round 1's findings.
    const first = rounds.length ? Math.min(...rounds.map(r => r.at)) : Infinity;
    const recorded = comments.some(c => isTrustedMarkerAuthor(c) && /^\s*<!-- we:enumerate-first -->/.test(c.body)
      && Date.parse(c.createdAt ?? c.created_at) < first);
    if (rounds.some(r => !r.at)) return closed('unreadable round timestamp');
    return { applies, wouldStop: applies && mode !== 'off' && consecutive >= threshold, consecutive, rounds,
      enumerateFirst: { required: applies && mode !== 'off' && enumerateFirst, recorded } };
  } catch { return closed('unreadable input'); }
}
