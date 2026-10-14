import { isTerminalStatus } from '../lib/backlog-status.cjs';
/**
 * @file scripts/operations/priority-sync-io.mjs
 * @description THE IO SHELL of {@link ./priority-sync.mjs} — the reader its `read` step is injected with, and the
 *   sink that applies its one declared effect. `priority-sync.mjs` reaches none of this.
 *
 * WHAT THE READER GATHERS (all read-only; it never fetches, so fetch `origin/main` first when freshness matters):
 *   - the tracker card of the CHECKOUT IT IS RUN FROM (the git top level of the working directory) and its
 *     `## Priority order` section;
 *   - the cards, from `<ref>` (default `origin/main`) merged with that checkout's own `backlog/`, resolved-wins,
 *     through the SAME functions `check-priority` uses (`parseCard`, `mergeCards`, `liveTree`), reading the raw files too;
 *   - the loader's own tier, leverage and human-gate for each card. `we:src/_data/backlog.js` is run in a CHILD
 *     process over a temporary directory holding the merged cards (it reads its directory once, at call time, from
 *     `WE_BACKLOG_DIR`), so the ranker is never recomputed here. If the loader cannot run, the read says
 *     `ranker: 'fields'` and the plan derives what it can from the card's own fields (leverage reads as 0);
 *   - which cards a merged PR or commit on the ref mentions ({@link landedFromLog}).
 *
 * THE FINDING IS KEPT SMALL: only the cards the plan can need (the live tree, every card a line names, and their
 * blockers) go into it, because the finding is written to the run record.
 *
 * THE SINK rewrites the section IN PLACE, and only if the section on disk is still the one the plan was made from.
 * It never commits and never pushes. It writes with `writeFileSync`, like `prototype-tracker.mjs append-note`
 * does for the same file, and not through `guarded-write.mjs`: that writer's locus-prefix scan is for prose a
 * worker wrote, and this file is a 4,000-line log this operation only re-numbers.
 *
 * IMPURE by construction: `fs`, `git`, a child `node`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { notApplied } from './effect-executor.mjs';
import {
  PRIORITY_SYNC_EFFECT, extractSectionText, replaceSectionText, sectionEntryIds,
} from './priority-sync.mjs';
import {
  defaultGit, liveTree, mergeCards, parseCard, parseCatFileBatch,
} from '../lib/priority-order.mjs';
import { findTrackerPath } from '../lib/prototype-tracker-data.mjs';
import { localToday } from '../lib/local-date.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo the OPERATION lives in (script location, never the cwd): where the loader is. */
export const REPO_ROOT = resolve(HERE, '..', '..');
const LOADER_PATH = join(REPO_ROOT, 'src', '_data', 'backlog.js');

const idFromName = (name) => name.replace(/\.md$/, '').split('-')[0];

/** A card states a design to settle or carries an open-fork heading: rule 2's "design first" signal. PURE. */
export function hasDesignSignal(text) {
  const t = String(text ?? '');
  return /DESIGN TO SETTLE/.test(t) || /^#{2,4}\s+Open fork/im.test(t);
}

/** Read every `backlog/*.md` of a directory as `{id -> {name, text}}`. */
export function readRawFromDir(dir, { readdir = readdirSync, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const out = new Map();
  for (const name of readdir(dir)) {
    if (!name.endsWith('.md')) continue;
    try { out.set(idFromName(name), { name, text: read(join(dir, name)) }); } catch { /* unreadable card: skipped, as the check does */ }
  }
  return out;
}

/** Read every `backlog/*.md` blob at a git ref as `{id -> {name, text}}`, in ONE `cat-file --batch` call. */
export function readRawFromRef(ref, { git = defaultGit, cwd } = {}) {
  const tree = git(['ls-tree', '-r', '--full-tree', ref, '--', 'backlog/'], { cwd }).toString('utf8');
  const blobs = [];
  for (const line of tree.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\tbacklog\/([^/]+\.md)$/.exec(line);
    if (m) blobs.push({ sha: m[1], name: m[2] });
  }
  const raw = git(['cat-file', '--batch'], { input: `${blobs.map((b) => b.sha).join('\n')}\n`, cwd });
  const textBySha = new Map(parseCatFileBatch(raw).map((r) => [r.sha, r.text]));
  const out = new Map();
  for (const b of blobs) out.set(idFromName(b.name), { name: b.name, text: textBySha.get(b.sha) ?? '' });
  return out;
}

/**
 * The raw file of each card under the SAME rule `mergeCards` applies to statuses: the checkout's own file wins,
 * except that a card resolved only on the ref is taken from the ref. PURE.
 *
 * @param {Map<string, {name: string, text: string}>} local
 * @param {Map<string, {name: string, text: string}>} fromRef
 * @param {Map<string, {status: string}>} localCards the checkout's parsed cards
 * @param {Map<string, {status: string}>} merged the merged parsed cards
 */
export function mergeRaw(local, fromRef, localCards, merged) {
  const out = new Map();
  for (const id of new Set([...local.keys(), ...fromRef.keys()])) {
    const l = local.get(id);
    const r = fromRef.get(id);
    const resolvedOnlyOnRef = isTerminalStatus(merged.get(id)?.status) && !isTerminalStatus(localCards.get(id)?.status);
    out.set(id, l && !(resolvedOnlyOnRef && r) ? l : (r ?? l));
  }
  return out;
}

const RANK_CHILD = `
const fs = require('node:fs');
const items = require(process.argv[1])();
fs.writeFileSync(process.argv[2], JSON.stringify(items.map((i) => ({
  num: String(i.num), tier: i.tier ?? null, leverage: i.leverageScore ?? 0, humanGated: !!i.humanGated, kind: i.kind ?? null, size: i.size ?? null,
}))));
`;

/**
 * THE RANKER FIELDS from the real loader, over a directory of cards. Runs `we:src/_data/backlog.js` in a child
 * process with `WE_BACKLOG_DIR` set. Returns `Map<num, {tier, leverage, humanGated}>`, or `null` when the loader
 * could not run (the caller then reports `ranker: 'fields'`).
 */
export function loadRankedFromDir(dir, { loaderPath = LOADER_PATH, spawn = spawnSync, tmp = mkdtempSync(join(tmpdir(), 'priority-sync-rank-')) } = {}) {
  const outPath = join(tmp, 'ranked.json');
  try {
    const r = spawn(process.execPath, ['-e', RANK_CHILD, loaderPath, outPath], {
      env: { ...process.env, WE_BACKLOG_DIR: dir }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) return null;
    return new Map(JSON.parse(readFileSync(outPath, 'utf8')).map((i) => [i.num, i]));
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Numbers a merged-PR branch name carries: `lane/prepare-3690` -> 3690, `lane/3441b-x` -> 3441. PURE. */
function branchCardIds(branch) {
  const last = String(branch).split('/').pop() ?? '';
  return [...last.matchAll(/(?<!\d)(\d{3,5})(?!\d)/g)].map((m) => m[1]);
}

/**
 * WHICH CARDS THE LOG OF A REF MENTIONS as landed work. PURE over `git log --format=%h<US>%s` output.
 *
 * A mention is (1) a `Merge pull request #P from <owner>/<branch>` whose branch carries the card number, or (2) a
 * non-merge subject that STARTS with `#<card>`. Commits whose subject starts `drain:`, `backlog:` or `prepare:`
 * (numbering, filing and preparing a card leave it open on purpose), and merges of a `lane/prepare-…` branch, do not
 * count. The first hit in log order (the newest) is kept per card. Only cards in `wanted` are reported.
 *
 * @param {string} logText
 * @param {Set<string>} wanted
 * @returns {Record<string, {sha: string, subject: string}>}
 */
export function landedFromLog(logText, wanted) {
  const out = {};
  for (const row of String(logText ?? '').split('\n')) {
    const [sha, subject = ''] = row.split('\u001f');
    if (!sha || !subject) continue;
    let ids = [];
    const merge = /^Merge pull request #\d+ from \S+?\/(\S+)$/.exec(subject);
    if (merge) {
      if (!/^(?:lane\/)?(prepare|drain|backlog)\b/.test(merge[1])) ids = branchCardIds(merge[1]);
    } else if (!/^(drain|backlog|prepare):/i.test(subject)) {
      const lead = /^((?:#[0-9a-z]+(?:,\s*)?)+)/.exec(subject);
      if (lead) ids = [...lead[1].matchAll(/#([0-9a-z]+)/g)].map((m) => m[1]);
    }
    for (const id of ids) if (wanted.has(id) && !out[id]) out[id] = { sha, subject };
  }
  return out;
}

/**
 * THE REAL `readFacts`. Every seam is injectable so a test drives it over a memory tree; the real-mechanism test
 * drives it over a real git repo.
 *
 * @param {object} [o]
 * @param {() => string} [o.cwd]
 * @param {Function} [o.git]
 * @param {(dir: string) => string[]} [o.readdir]
 * @param {(path: string) => string} [o.read]
 * @param {(dir: string) => (Map|null)} [o.loadRanked]
 * @param {() => string} [o.today]
 */
export function createPrioritySyncReader({
  cwd = () => process.cwd(),
  git = defaultGit,
  readdir = readdirSync,
  read = (p) => readFileSync(p, 'utf8'),
  loadRanked = (dir) => loadRankedFromDir(dir),
  today = localToday,
} = {}) {
  return ({ ref, date }) => {
    const here = cwd();
    let root;
    try { root = git(['rev-parse', '--show-toplevel'], { cwd: here }).toString('utf8').trim(); } catch { root = here; }
    const backlogDir = join(root, 'backlog');
    const trackerPath = findTrackerPath({ backlogDir, readdir });
    if (!trackerPath) throw new Error(`priority-sync: no backlog/3383-*.md in ${root} — run it from the prototype checkout`);
    const trackerText = read(trackerPath);
    const sectionText = extractSectionText(trackerText);
    if (!sectionText) throw new Error(`priority-sync: ${trackerPath} has no "## Priority order" section`);
    const stamp = String(date || '').trim() || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new Error(`priority-sync: --date=${JSON.stringify(stamp)} is not YYYY-MM-DD`);

    // Cards: the checkout's own backlog/ and the ref, resolved-wins.
    const localRaw = readRawFromDir(backlogDir, { readdir, read });
    const refRaw = readRawFromRef(ref, { git, cwd: root });
    const parsed = (m) => new Map([...m].map(([id, f]) => [id, parseCard(id, f.text)]).filter(([, c]) => c));
    const localCards = parsed(localRaw);
    const merged = mergeCards(localCards, parsed(refRaw));
    const live = liveTree(merged);
    const raw = mergeRaw(localRaw, refRaw, localCards, merged);

    // Ranker fields from the real loader, over a directory of the merged cards.
    let ranked = null;
    const dir = mkdtempSync(join(tmpdir(), 'priority-sync-cards-'));
    try {
      mkdirSync(dir, { recursive: true });
      for (const [id, f] of raw) writeFileSync(join(dir, f.name || `${id}.md`), f.text);
      ranked = loadRanked(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Only the cards the plan can need.
    const bornAs = new Map();
    for (const [id, f] of raw) {
      const b = matter(f.text).data?.bornAs;
      if (b) bornAs.set(String(b), id);
    }
    const listed = sectionEntryIds(sectionText);
    const wanted = new Set([...live, ...listed, ...listed.map((id) => bornAs.get(id)).filter(Boolean)]);
    for (const id of [...wanted]) for (const b of merged.get(id)?.blockedBy ?? []) wanted.add(b);
    const cards = [];
    for (const id of [...wanted].sort()) {
      const base = merged.get(id);
      const f = raw.get(id);
      if (!base || !f) continue;
      let data = {};
      try { data = matter(f.text).data ?? {}; } catch { /* the base card parsed, so this cannot differ */ }
      const rank = ranked?.get(id);
      cards.push({
        id, parent: base.parent, status: base.status, blockedBy: base.blockedBy,
        kind: data.kind ? String(data.kind) : null, size: data.size != null ? String(data.size) : null,
        tier: rank?.tier ?? null, leverage: rank?.leverage ?? 0, humanGated: rank ? rank.humanGated : Boolean(data.humanGate),
        designFirst: hasDesignSignal(f.text), bornAs: data.bornAs ? String(data.bornAs) : null,
      });
    }

    // Landed but still open: the log of the ref.
    let logText = '';
    try { logText = git(['log', ref, '--format=%h%x1f%s'], { cwd: root }).toString('utf8'); } catch { /* no log: nothing flagged */ }
    const landed = landedFromLog(logText, new Set(cards.filter((c) => c.status === 'open' || c.status === 'active').map((c) => c.id)));

    return {
      trackerPath, sectionText, ref, today: stamp, ranker: ranked ? 'loader' : 'fields',
      cards, live: [...live], landed,
    };
  };
}

/**
 * BUILD THE SINK MAP for the one effect. Rewrites the section in place; refuses when the section on disk is no
 * longer the one the plan was made from (a person or another worker edited it in between).
 */
export function createPrioritySyncSinks({ read = (p) => readFileSync(p, 'utf8'), write = (p, s) => writeFileSync(p, s, 'utf8') } = {}) {
  return {
    [PRIORITY_SYNC_EFFECT]: async (payload) => {
      const text = read(payload.trackerPath);
      const now = extractSectionText(text);
      if (now === payload.newSection) return { path: payload.trackerPath, alreadyApplied: true };
      if (now !== payload.expectedSection) {
        throw notApplied(`priority-sync: the "## Priority order" section of ${payload.trackerPath} changed since the plan was made; re-run the dry run`);
      }
      write(payload.trackerPath, replaceSectionText(text, payload.newSection));
      return { path: payload.trackerPath };
    },
  };
}
