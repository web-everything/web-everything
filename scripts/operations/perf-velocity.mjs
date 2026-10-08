/**
 * @file scripts/operations/perf-velocity.mjs
 * @description PURE velocity maths for `perf-snapshot` (held card 129): story points resolved per day and per hour
 *   (America/New_York), PRs merged per hour split code vs card-only, and the estimated-from-brief points for merged
 *   PRs that carry no sized card. No fs, no git, no clock, no model: the git reads, the estimate store and the model
 *   call live in `./perf-velocity-io.mjs`.
 *
 * HOW A RESOLVE IS FOUND. A card is "resolved" at the first-parent commit on main whose diff turns its
 * `status:` line into `status: resolved` (or adds the card already resolved). A card's FILE is renamed at land
 * (`x<hash>-slug.md` -> `NNN-slug.md`, with `bornAs: x<hash>` stamped in), so identity is the canonical id: the
 * `bornAs` hash when there is one, else the hash in an `x<hash>` file name, else the number. A card that resolves as
 * `x<hash>` and is renamed to `NNN` later (even as a delete + add) is counted once, at its first resolve.
 *
 * REAL vs ESTIMATED. Real points are a sized card's `size`. Estimated points come only from
 * {@link ESTIMATED_SOURCE} rows, are keyed under their own metric names and carry that `source`; the two are never
 * summed together.
 */
import { isCardOnlyDiff } from '../ci-card-only.mjs';

export const TZ = 'America/New_York';
export const ESTIMATED_SOURCE = 'estimated-from-brief';
export const FIBONACCI = Object.freeze([1, 2, 3, 5, 8, 13]);
/** Midnight EDT on the first backfill day; the card asks for "at least 2026-10-05 -> now". */
export const BACKFILL_FROM = '2026-10-05T00:00:00-04:00';

const HASH_NAME = /^(x[a-z0-9]{6})-/;
const NUM_NAME = /^(\d{1,5})-/;

/** Nearest Fibonacci size to `n` (ties go to the smaller). */
export function snapFibonacci(n) {
  if (!Number.isFinite(n)) return null;
  return FIBONACCI.reduce((best, f) => (Math.abs(f - n) < Math.abs(best - n) ? f : best), FIBONACCI[0]);
}

/** The ET calendar date and hour of an ISO instant: `{ date: 'YYYY-MM-DD', hour: 0-23 }`. */
export function etParts(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const baseName = (path) => String(path ?? '').split('/').at(-1);
/** Frontmatter field of a card text (first `---` block only). */
export function frontField(text, field) {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''));
  if (!m) return null;
  const line = m[1].split('\n').find((l) => l.startsWith(`${field}:`));
  return line ? line.slice(field.length + 1).replace(/\s+#.*$/, '').trim().replace(/^"|"$/g, '') : null;
}

/**
 * The card index over the cards on disk: `byId` holds each card under BOTH its number and its `bornAs` hash.
 * @param {{name:string, text:string}[]} cards
 */
export function buildCardIndex(cards) {
  const byId = new Map();
  for (const c of cards) {
    const name = baseName(c.name);
    const num = NUM_NAME.exec(name)?.[1] ?? null;
    const hash = frontField(c.text, 'bornAs') ?? HASH_NAME.exec(name)?.[1] ?? null;
    const size = Number(frontField(c.text, 'size'));
    const entry = { canon: hash ?? num, size: Number.isFinite(size) && size > 0 ? size : null, status: frontField(c.text, 'status'), kind: frontField(c.text, 'kind') };
    if (!entry.canon) continue;
    if (num) byId.set(num, entry);
    if (hash) byId.set(hash, entry);
  }
  return { byId };
}

/** The canonical id of a card path (or the bornAs read from its diff), through the index. */
export function canonicalId(path, index, bornAs = null) {
  const name = baseName(path);
  const hash = HASH_NAME.exec(name)?.[1] ?? null;
  if (hash) return hash;
  if (bornAs) return bornAs;
  const num = NUM_NAME.exec(name)?.[1] ?? null;
  if (!num) return null;
  return index.byId.get(num)?.canon ?? num;
}

/**
 * Parse `git log --first-parent -m -M -U0 -p --format=%x01%H%x09%cI%x09%s -- backlog/` into commits with, per card
 * file, whether the diff added and/or removed a `status: resolved` line and any `bornAs` line.
 * @returns {{hash:string, at:string, subject:string, files:{path:string, oldPath:string, resolvedAdded:boolean, resolvedRemoved:boolean, bornAs:(string|null)}[]}[]}
 */
export function parsePatchLog(text) {
  const commits = [];
  for (const chunk of String(text ?? '').split('\x01')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const [hash, at, ...rest] = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\t');
    const files = [];
    let cur = null;
    for (const line of nl < 0 ? [] : chunk.slice(nl + 1).split('\n')) {
      const d = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (d) { cur = { path: d[2], oldPath: d[1], resolvedAdded: false, resolvedRemoved: false, bornAs: null }; files.push(cur); continue; }
      if (!cur) continue;
      if (line === '+status: resolved') cur.resolvedAdded = true;
      else if (line === '-status: resolved') cur.resolvedRemoved = true;
      else if (line.startsWith('+bornAs: ')) cur.bornAs = line.slice(9).trim();
    }
    commits.push({ hash, at, subject: rest.join('\t'), files: files.filter((f) => /^backlog\/[^/]+\.md$/.test(f.path) || /^backlog\/[^/]+\.md$/.test(f.oldPath)) });
  }
  return commits;
}

/**
 * Parse `git log --first-parent -m --no-renames --name-only --format=%x01%H%x09%cI%x09%s` into merges:
 * `{hash, at, pr, files}`; a commit with no PR number in its subject has `pr: null`.
 */
export function parseNameLog(text) {
  const out = [];
  for (const chunk of String(text ?? '').split('\x01')) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const [hash, at, ...rest] = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\t');
    const subject = rest.join('\t');
    // Only a merge commit names the PR it merged. A trailing "(#N)" is NOT a merge: drain commits end in "(#2288)", the
    // issue that defined JIT numbering, and would otherwise read as hundreds of merges of one PR.
    const pr = /^Merge pull request #(\d+)/.exec(subject)?.[1] ?? null;
    out.push({ hash, at, subject, pr: pr ? Number(pr) : null, files: nl < 0 ? [] : chunk.slice(nl + 1).split('\n').map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

/**
 * Resolve events, oldest first, each `{id, at, hash, size}` (`size` null when the card carries none). A card counts
 * once, at its first resolve; a commit that both removes and adds `status: resolved` for the same canonical id (a
 * rename git showed as delete + add) is not a resolve.
 */
export function resolveEvents(commits, index) {
  const done = new Set(), events = [];
  for (const c of [...commits].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const added = new Set(), removed = new Set();
    for (const f of c.files) {
      const newId = canonicalId(f.path, index, f.bornAs), oldId = canonicalId(f.oldPath, index);
      if (f.resolvedAdded && newId) added.add(newId);
      if (f.resolvedRemoved) for (const id of [oldId, newId]) if (id) removed.add(id);
    }
    for (const id of added) {
      if (removed.has(id) || done.has(id)) continue;
      done.add(id);
      events.push({ id, at: c.at, hash: c.hash, size: index.byId.get(id)?.size ?? null });
    }
    for (const id of removed) if (!added.has(id)) done.add(id);
  }
  return events;
}

/**
 * Merged PRs with their kind and whether they carry a sized card. A PR is `covered` when its diff touches a card
 * that has a size (its points are counted when that card resolves, so estimating it too would count it twice).
 * Card-only is `ci-card-only`'s own definition (`isCardOnlyDiff`).
 */
export function classifyMerges(merges, index) {
  const seen = new Set();
  return merges.filter((m) => m.pr !== null && !seen.has(m.pr) && seen.add(m.pr)).map((m) => {
    const cardFiles = m.files.filter((f) => /^backlog\/[^/]+\.md$/.test(f));
    const cardIds = [...new Set(cardFiles.map((f) => canonicalId(f, index)).filter((id) => index.byId.get(id)?.size))];
    return { pr: m.pr, at: m.at, hash: m.hash, kind: isCardOnlyDiff(m.files) ? 'card-only' : 'code', covered: cardIds.length > 0, cardIds };
  });
}

/**
 * The real size of each code PR that built resolved, sized cards: the sum of those cards' sizes, counting only a card
 * that exactly ONE code PR touched (a card touched by two code PRs cannot be split between them). `{pr -> points}`.
 */
export function prActualPoints(merges, events) {
  const size = new Map(events.filter((e) => e.size > 0).map((e) => [e.id, e.size]));
  const touchedBy = new Map();
  for (const m of merges) if (m.kind === 'code') for (const id of m.cardIds ?? []) touchedBy.set(id, (touchedBy.get(id) ?? 0) + 1);
  const out = new Map();
  for (const m of merges) {
    if (m.kind !== 'code') continue;
    const pts = (m.cardIds ?? []).filter((id) => size.has(id) && touchedBy.get(id) === 1).reduce((a, id) => a + size.get(id), 0);
    if (pts > 0) out.set(m.pr, pts);
  }
  return out;
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r2 = (x) => Math.round(x * 100) / 100;

/** Points by ET day and by ET `date HH` hour. */
export function bucketPoints(events) {
  const day = {}, hour = {};
  for (const e of events) {
    const p = etParts(e.at);
    if (!p || !(e.points > 0)) continue;
    day[p.date] = (day[p.date] ?? 0) + e.points;
    const k = `${p.date} ${String(p.hour).padStart(2, '0')}`;
    hour[k] = (hour[k] ?? 0) + e.points;
  }
  return { day, hour };
}

/** `[ {at, points} ]` of real points: resolve events that carry a size. */
export const realPointEvents = (events) => events.filter((e) => e.size > 0).map((e) => ({ at: e.at, points: e.size }));

/**
 * Estimated points: one event per uncovered code PR that has an estimate row, at its merge time.
 * @param {ReturnType<typeof classifyMerges>} merges
 * @param {Map<number, {size:number}>} estimates PR number -> estimate row
 */
export function estimatedPointEvents(merges, estimates) {
  return merges.filter((m) => m.kind === 'code' && !m.covered && estimates.has(m.pr)).map((m) => ({ at: m.at, points: estimates.get(m.pr).size }));
}

/**
 * The `velocity.*` metrics for a snapshot window. `now` decides "today" (ET). Real and estimated carry separate
 * keys and sources. PURE.
 * @returns {Record<string, {v:number, unit:string, source:string}>}
 */
export function velocityMetrics({ events, merges, estimates, window, now }) {
  const out = {};
  const put = (k, v, unit, source = 'computed') => { if (Number.isFinite(v)) out[k] = { v, unit, source }; };
  const hours = Math.max(1, (Date.parse(window.until) - Date.parse(window.since)) / 3600000);
  const inWin = (e) => Date.parse(e.at) >= Date.parse(window.since) && Date.parse(e.at) < Date.parse(window.until);
  const today = etParts(now)?.date, yesterday = etParts(new Date(Date.parse(now) - 24 * 3600000).toISOString())?.date;
  const sets = [['real', realPointEvents(events), 'computed'], ['estimated', estimatedPointEvents(merges, estimates), ESTIMATED_SOURCE]];
  for (const [label, evs, source] of sets) {
    const { day } = bucketPoints(evs);
    const win = sum(evs.filter(inWin).map((e) => e.points));
    put(`velocity.points.today.${label}`, day[today] ?? 0, 'pts', source);
    put(`velocity.points.yesterday.${label}`, day[yesterday] ?? 0, 'pts', source);
    put(`velocity.points.perDay.${label}`, r2((win * 24) / hours), 'pts/day', source);
    put(`velocity.points.perHour.${label}`, r2(win / hours), 'pts/h', source);
    const peak = Math.max(0, ...Object.values(bucketPoints(evs.filter(inWin)).hour));
    put(`velocity.points.peakHour.${label}`, peak, 'pts', source);
  }
  const win = merges.filter(inWin);
  for (const [kind, key] of [['code', 'code'], ['card-only', 'cardOnly']]) {
    const n = win.filter((m) => m.kind === kind).length;
    put(`velocity.prs.${key}.merged`, n, 'PRs');
    put(`velocity.prs.${key}.perHour`, r2(n / hours), 'PRs/h');
  }
  const unestimated = win.filter((m) => m.kind === 'code' && !m.covered && !estimates.has(m.pr)).length;
  put('velocity.estimate.missingPrs', unestimated, 'PRs');
  return out;
}

/** The label a velocity metric key wears in the diff, from its `source` ("real" or the estimate source). */
export function velocityLabel(key, source) {
  if (!/^velocity\.points\./.test(key)) return '';
  return source === ESTIMATED_SOURCE ? ' [estimated from brief]' : ' [real, sized cards]';
}

/** Calibration: mean absolute error and bias (estimate - actual) in points over `{actual, estimate}` pairs. */
export function calibrationStats(pairs) {
  const ps = pairs.filter((p) => Number.isFinite(p?.actual) && Number.isFinite(p?.estimate));
  if (!ps.length) return { n: 0, mae: null, bias: null };
  return { n: ps.length, mae: r2(sum(ps.map((p) => Math.abs(p.estimate - p.actual))) / ps.length), bias: r2(sum(ps.map((p) => p.estimate - p.actual)) / ps.length) };
}

/** An hour-by-hour ET table (lines) of real points over the given events, for the run output. */
export function hourlyLines(events, label) {
  const { hour } = bucketPoints(events);
  const keys = Object.keys(hour).sort();
  if (!keys.length) return [`  ${label}: no points`];
  return [`  ${label} by ET hour:`, ...keys.map((k) => `    ${k}h  ${hour[k]} pts`)];
}
