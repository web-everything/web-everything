const { isTerminalStatus } = require('../../scripts/lib/backlog-status.cjs');
// Stable-route redirect rows — one per UNIQUE num — for src/backlog-redirects.njk.
//
// #075 shipped the number-only stable URL (/backlog/<NNN>/ → canonical /backlog/<NNN>-<slug>/) by
// paginating the raw `backlog` data directly. That works only while `num` is unique. A merge-time
// id collision across parallel batches (#2071) can leave two files sharing an NNN prefix — and two
// pagination rows writing the SAME `/backlog/<NNN>/index.html` is a hard Eleventy
// DuplicatePermalinkOutputError that fails the whole build (the docs server never boots). This
// loader dedupes by num BEFORE pagination so a stray collision can never take the build down.
//
// Dedup precedence when two items share a num: prefer the live item (status !== 'resolved') so the
// stable route points at the item still being worked; ties break on the lexicographically-smaller
// id for determinism. The loser stays on-disk as its own slug-bearing page and record — it just
// loses the bare /<NNN>/ redirect, which by definition it was never the sole owner of.
//
// Single source: re-uses the same backlog loader the rest of the site reads (cf. backlogAliases.js).
const loadBacklog = require('./backlog.js');

module.exports = function backlogRedirects() {
  const byNum = new Map();
  for (const item of loadBacklog()) {
    const prev = byNum.get(item.num);
    if (!prev) {
      byNum.set(item.num, item);
      continue;
    }
    const prevResolved = isTerminalStatus(prev.status);
    const itemResolved = isTerminalStatus(item.status);
    // Prefer the live (non-resolved) item; on a tie prefer the smaller id for stable output.
    if (prevResolved && !itemResolved) byNum.set(item.num, item);
    else if (prevResolved === itemResolved && item.id < prev.id) byNum.set(item.num, item);
  }
  return [...byNum.values()].map((item) => ({ num: item.num, id: item.id, title: item.title }));
};
