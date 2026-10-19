/**
 * @file scripts/lib/lane-transcript-attribution.mjs
 * @description EXACT ATTRIBUTION FROM CLAUDE SESSION TRANSCRIPTS (#3383). The lane-history ledger
 *   (`lane-history.mjs`) only knows what happened AFTER it was wired in - every lane already carries months of
 *   prior work no lease marker or ledger line ever recorded. Claude session transcripts
 *   (`~/.claude/projects/PROJECT/*.jsonl`, including `.../subagents/*.jsonl`) already record every Edit/Write/
 *   NotebookEdit tool call with its absolute `file_path`, and every Bash call with its `command` text - so a
 *   session that wrote exactly the files sitting uncommitted in a lane is strong, checkable evidence of who
 *   last worked there, independent of (and often finer-grained than) a commit message or branch name guess.
 *
 * PURE / IO SPLIT:
 *   - {@link laneTouchFromLine} - pure, one already-matched JSONL line -> a touch record or `null`.
 *   - {@link summarizeLaneTouches} - pure, touches -> per-session ranking (coverage against the lane's ACTUAL
 *     dirty paths beats a bare "did this session ever cd here" guess - a session that merely passed through a
 *     lane proves far less than one whose edited-file set matches what's sitting uncommitted).
 *   - {@link scanLaneTranscripts} - the IO shell. ONE pass across the WHOLE transcript tree for every lane's
 *     path pattern at once (never one grep per lane - #3383's own performance note).
 *
 * #3383-perf (follow-up): this used to be TWO steps — list matching FILES (`grep -rlE .../ rg -l`), then read
 * each one's FULL content into Node and re-split/re-scan every line there. Measured live against the real
 * `~/.claude/projects` tree (3.4GB): the file listing itself is fast (well under a second, ripgrep/grep's own
 * job), but the matching files still total gigabytes of mostly-IRRELEVANT lines (a transcript's tool-use lines
 * for everything else it ever touched) — reading and JS-side re-scanning all of that cost 45s of a ~100s whole
 * run, the single largest remaining piece after the `gh`-call and per-commit git-spawn fixes. The fix: have
 * `rg`/`grep` emit the MATCHING LINES directly (one call, whole tree, same alternation) — the actual work of
 * finding "does this byte range match" already belongs to a tool built for exactly that, and Node then only
 * ever sees the (tiny, by comparison) handful of lines that could possibly matter, never the surrounding bulk.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** `~/.claude/projects` - the root every session (and subagent) transcript lives under. */
export function claudeProjectsRoot(env = process.env) {
  return join(env.HOME || homedir(), '.claude', 'projects');
}

/**
 * PURE: does this ONE JSONL line (already string-matched to contain `lanePath`, so this never runs
 * `JSON.parse` over lines that can't possibly match) record a tool call that touches the lane? Recognizes:
 *   - Edit/Write/NotebookEdit whose `file_path` sits UNDER `lanePath` (a write attributable to an exact file);
 *   - Bash whose `command` text mentions `lanePath` at all (a `cd` into it, or an absolute-path git/file op run
 *     from elsewhere - weaker evidence, carries no `path`, kept only for the "session touched this lane at
 *     all" signal `summarizeLaneTouches` still ranks below a real file match).
 * Returns `null` for anything else, or on a parse failure - never throws.
 */
export function laneTouchFromLine(line, lanePath) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || entry.type !== 'assistant') return null;
  const content = entry.message?.content;
  if (!Array.isArray(content)) return null;
  const sessionId = entry.sessionId || null;
  const ts = entry.timestamp || null;
  if (!sessionId) return null;
  const withSlash = lanePath.endsWith('/') ? lanePath : `${lanePath}/`;
  for (const item of content) {
    if (!item || item.type !== 'tool_use') continue;
    const input = item.input || {};
    if (
      (item.name === 'Edit' || item.name === 'Write' || item.name === 'NotebookEdit')
      && typeof input.file_path === 'string' && input.file_path.startsWith(withSlash)
    ) {
      return { ts, sessionId, tool: item.name, path: input.file_path };
    }
    if (item.name === 'Bash' && typeof input.command === 'string' && input.command.includes(lanePath)) {
      return { ts, sessionId, tool: 'Bash', path: null, command: input.command.slice(0, 200) };
    }
  }
  return null;
}

/**
 * PURE: reduce a flat list of {@link laneTouchFromLine} touches for ONE lane into a per-session ranking.
 * `coverage` - the fraction of the lane's ACTUAL dirty relative paths this session is seen editing - is the
 * primary sort key (the real evidence #3383 asked for: "a session that wrote exactly those files is the
 * owner"); last-write recency is the tiebreak.
 *
 * @param {Array<{ts:?string, sessionId:string, tool:string, path:?string}>} touches
 * @param {string} lanePath - absolute lane dir, so a touch's absolute `path` can be made lane-relative.
 * @param {string[]} [dirtyRelPaths] - the lane's actual uncommitted/untracked relative paths.
 * @returns {Array<{sessionId:string, lastWriteTs:?string, matchedFiles:string[], touches:number, coverage:number}>}
 *   sorted best-attribution-first.
 */
export function summarizeLaneTouches(touches, lanePath, dirtyRelPaths = []) {
  const withSlash = lanePath.endsWith('/') ? lanePath : `${lanePath}/`;
  const dirty = new Set(dirtyRelPaths);
  const bySession = new Map();
  for (const t of touches) {
    if (!t.sessionId) continue;
    let s = bySession.get(t.sessionId);
    if (!s) { s = { sessionId: t.sessionId, lastWriteTs: null, matchedFiles: new Set(), touches: 0 }; bySession.set(t.sessionId, s); }
    s.touches += 1;
    if (t.path && t.path.startsWith(withSlash)) s.matchedFiles.add(t.path.slice(withSlash.length));
    if (t.ts && (!s.lastWriteTs || t.ts > s.lastWriteTs)) s.lastWriteTs = t.ts;
  }
  const rows = [...bySession.values()].map((s) => {
    const matchedFiles = [...s.matchedFiles];
    const overlap = matchedFiles.filter((p) => dirty.has(p));
    return {
      sessionId: s.sessionId,
      lastWriteTs: s.lastWriteTs,
      matchedFiles,
      touches: s.touches,
      coverage: dirty.size ? overlap.length / dirty.size : 0,
    };
  });
  rows.sort((a, b) => (b.coverage - a.coverage) || String(b.lastWriteTs || '').localeCompare(String(a.lastWriteTs || '')));
  return rows;
}

/** Hard ceiling on the one whole-tree scan below — `~/.claude/projects` only grows, and an unbounded scan is
 *  exactly the kind of single stuck call `we:scripts/lib/bounded-child.mjs`'s own header warns against.
 *  Env-overridable for a slower host. */
const SCAN_TIMEOUT_MS = Number(process.env.WE_LANE_WHOIS_TRANSCRIPT_TIMEOUT_MS) || 20_000;

/**
 * #3383-perf, r2 — BOUND THE DATA VOLUME, not just the call shape. `~/.claude/projects` only grows (measured
 * live: 3.4GB, 4000+ transcripts) and every session (this one included) keeps appending to its own file while
 * a scan is in flight. A lane's "last holder" is, definitionally, RECENT activity — the lane-history ledger
 * (checked FIRST, see this file's own header) already covers everything since #3383 wired it in; transcript
 * attribution is the weaker FALLBACK for whatever predates that, so bounding it to a recent window trades away
 * only very old, already-ledger-covered history, never a real lane's current state. Restricting to files
 * modified in the last {@link MAX_TRANSCRIPT_AGE_MS} cut the real tree from 3.4GB/4000+ files to well under a
 * GB/a few thousand on this host — directly controls the worst-case scan cost regardless of host load, cache
 * state, or which of `rg`/`grep` actually runs, rather than hoping a fixed timeout alone masks a slow tick.
 * {@link MAX_TRANSCRIPT_FILES} is a second, harder cap purely to keep one argv within the OS's `ARG_MAX`
 * regardless of how wide the age window is set.
 */
const MAX_TRANSCRIPT_AGE_MS = Number(process.env.WE_LANE_WHOIS_TRANSCRIPT_MAX_AGE_MS) || 3 * 24 * 60 * 60_000;
const MAX_TRANSCRIPT_FILES = Number(process.env.WE_LANE_WHOIS_TRANSCRIPT_MAX_FILES) || 1200;

/**
 * IO: every `.jsonl` transcript under `root` (recursing into `subagents/` etc.) modified within
 * {@link MAX_TRANSCRIPT_AGE_MS}, newest first, capped at {@link MAX_TRANSCRIPT_FILES}. Own directory walk
 * (`readdirSync`/`statSync`, no subprocess) — cheap relative to the scan it bounds, and lets the caller pass an
 * EXPLICIT file list to `rg`/`grep` instead of a recursive `-r`/`-g` walk over the whole tree. Best-effort: a
 * directory read failure anywhere just skips that subtree, never throws.
 * @param {string} root
 * @returns {string[]}
 */
export function recentTranscriptFiles(root, { maxAgeMs = MAX_TRANSCRIPT_AGE_MS, maxFiles = MAX_TRANSCRIPT_FILES, nowMs = Date.now(), strict = false } = {}) {
  if (!existsSync(root)) { if (strict) throw Error('transcript root unavailable'); return []; }
  const cutoff = nowMs - maxAgeMs;
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { if (strict) throw e; return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let mtimeMs;
      try { mtimeMs = statSync(full).mtimeMs; } catch (e) { if (strict) throw e; continue; }
      if (mtimeMs >= cutoff) found.push({ path: full, mtimeMs });
    }
  };
  walk(root);
  if (strict && found.length > maxFiles) throw Error('transcript file list truncated');
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxFiles).map((f) => f.path);
}

/**
 * IO: one pass over an EXPLICIT file list for EVERY lane path in `lanePaths` at once, returning the MATCHING
 * LINES THEMSELVES (never a second file list) — see this module's own header for why: a matching file's
 * IRRELEVANT lines (everything else that session ever touched) can total gigabytes, and letting `rg`/`grep`
 * filter those out natively, rather than reading a whole file into Node to re-scan there, is a real win — but
 * only once the FILE LIST itself is bounded (see {@link recentTranscriptFiles}); an explicit list, never a
 * live `-r`/`-g` recursive walk of the whole (only-ever-growing) tree, is what actually makes the bound stick.
 *
 * #3383-perf, r2 — FIXED-STRING matching (`-F`, a pattern-PER-LINE FILE via `-f <path>`), never a regex
 * alternation (`-E '<esc1>|<esc2>|…'`): measured live against the real `~/.claude/projects` tree, an `-E`
 * alternation of 71 escaped literals cost far more of `grep`'s own native scan time than `-F` does for the
 * identical needle set — `grep`'s regex-NFA engine handles a big OR-alternation far worse than its dedicated
 * multi-literal path (`-F`, a Boyer-Moore/Commentz-Walter-shaped search built for exactly "many fixed needles
 * at once"). Absolute lane paths are already fixed strings with no wildcard need, so `-F` costs nothing in
 * capability. Patterns are staged to a real temp file (`-f <path>`), never piped over stdin — simpler to
 * reason about alongside a large stdout, and there is no reason to risk the pipe-interaction edge cases a
 * synchronous parent/child read-and-write-at-once shape can hit.
 *
 * Tries `rg` (ripgrep) FIRST, falling back to `grep -hF` only if that call itself fails (not installed on
 * `PATH` as a real executable — note this is NOT guaranteed even on a host where an interactive shell defines
 * an `rg` alias/function of its own, since a plain subprocess spawn never resolves shell functions — or any
 * other error). No separate "is rg installed" probe call — that would cost a second spawn on every run just to
 * decide, which defeats its own purpose; trying it directly costs nothing extra when it succeeds, and exactly
 * one fallback spawn on a host without a REAL standalone `rg` binary. Best-effort throughout: no candidate
 * files, an absent binary, a "no matches" exit, or a timeout all degrade to `[]` - a transcript-attribution
 * miss must never fail the `whois` report it feeds.
 * @param {string[]} files - explicit file list (from {@link recentTranscriptFiles}), never a directory to walk.
 * @param {string[]} needles - absolute lane paths, fed as literal (never regex) patterns.
 */
function grepMatchingLines(files, needles, { exec = execFileSync, strict = false } = {}) {
  if (!needles.length || !files.length) return [];
  let patternDir;
  let patternFile;
  try {
    patternDir = mkdtempSync(join(tmpdir(), 'lane-whois-patterns-'));
    patternFile = join(patternDir, 'lanes.txt');
    writeFileSync(patternFile, `${needles.join('\n')}\n`, 'utf8');
  } catch (e) {
    if (strict) throw e;
    return []; // can't even stage the pattern file (e.g. a read-only/full tmp) — degrade, never throw
  }
  try {
    const execOpts = {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024,
      timeout: SCAN_TIMEOUT_MS, killSignal: 'SIGKILL',
    };
    try {
      const out = exec('rg', ['--no-config', '--no-filename', '--no-line-number', '-F', '-f', patternFile, ...files], execOpts);
      return out.split('\n').filter(Boolean);
    } catch (e) {
      if (strict && e.status === 1 && !e.signal && !e.code) return [];
      if (strict && e.code !== 'ENOENT') throw e;
      try {
        const out = exec('grep', ['-hF', '-f', patternFile, ...files], execOpts);
        return out.split('\n').filter(Boolean);
      } catch (e) {
        if (strict && !(e.status === 1 && !e.signal && !e.code)) throw e;
        return []; // no matches, a timeout, or neither binary present — all degrade the same way
      }
    }
  } finally {
    try { rmSync(patternDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * IO shell: scan RECENT transcripts ONCE for every lane in `lanePaths`, returning a `Map<laneKey, touch[]>`.
 * This is the single-pass entry point `lane-whois.mjs` calls - never one grep per lane, never a full-file read
 * either ({@link grepMatchingLines} hands back only the lines that could possibly match, which
 * {@link laneTouchFromLine} then parses), and (#3383-perf, r2) never the WHOLE tree —
 * {@link recentTranscriptFiles} bounds the candidate set to a recent window first.
 * @param {string} root - `claudeProjectsRoot()`.
 * @param {Record<string,string>} lanePaths - laneKey -> absolute lane dir.
 * @returns {Map<string, Array<{ts:?string, sessionId:string, tool:string, path:?string}>>}
 */
export function scanLaneTranscripts(root, lanePaths, { exec = execFileSync, listFiles = recentTranscriptFiles, strict = false } = {}) {
  const keys = Object.keys(lanePaths);
  const result = new Map(keys.map((k) => [k, []]));
  if (!keys.length) return result;
  const files = listFiles(root, strict ? { strict: true, maxAgeMs: Infinity } : {});
  const lines = grepMatchingLines(files, Object.values(lanePaths), { exec, strict });
  for (const line of lines) {
    for (const k of keys) {
      if (!line.includes(lanePaths[k])) continue;
      const touch = laneTouchFromLine(line, lanePaths[k]);
      if (touch) result.get(k).push(touch);
    }
  }
  return result;
}
