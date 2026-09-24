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
 *   - {@link scanLaneTranscripts} - the IO shell. ONE `grep -rlE` pass across the WHOLE transcript tree for
 *     every lane's path pattern at once (never one grep per lane - #3383's own performance note), then parses
 *     only the files that pass. `grep` (not `rg`) is used deliberately: it is POSIX-universal and this host has
 *     no ripgrep installed; `-E` extended-regex mode on a big alternation gives the same one-pass shape
 *     ripgrep would.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

/**
 * IO: one `grep -rlE` pass over `root` for EVERY lane path in `lanePaths` at once (an alternation over their
 * absolute paths), returning the list of `.jsonl` files that mention at least one of them. Best-effort: an
 * absent tree, an absent `grep`, or a "no matches" exit (status 1) all degrade to `[]` - a transcript-
 * attribution miss must never fail the `whois` report it feeds.
 * @param {string} root
 * @param {Record<string,string>} lanePaths - laneKey -> absolute lane dir.
 */
function grepMatchingFiles(root, lanePaths, { exec = execFileSync } = {}) {
  const needles = Object.values(lanePaths);
  if (!needles.length || !existsSync(root)) return [];
  const pattern = needles.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  try {
    const out = exec('grep', ['-rlE', '--include=*.jsonl', pattern, root], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    return e && e.status === 1 ? [] : []; // 1 = no matches, anything else = degrade the same way
  }
}

/**
 * IO shell: scan the WHOLE transcript tree ONCE for every lane in `lanePaths`, returning a
 * `Map<laneKey, touch[]>`. This is the single-pass entry point `lane-whois.mjs` calls - never one grep per
 * lane. Each matching file is read and scanned line-by-line with a cheap `String.includes` pre-filter before
 * `JSON.parse` (via {@link laneTouchFromLine}), so the (usually large) transcript files are parsed only for
 * the lines that could possibly match.
 * @param {string} root - `claudeProjectsRoot()`.
 * @param {Record<string,string>} lanePaths - laneKey -> absolute lane dir.
 * @returns {Map<string, Array<{ts:?string, sessionId:string, tool:string, path:?string}>>}
 */
export function scanLaneTranscripts(root, lanePaths, { exec = execFileSync, read = readFileSync } = {}) {
  const keys = Object.keys(lanePaths);
  const result = new Map(keys.map((k) => [k, []]));
  if (!keys.length) return result;
  const files = grepMatchingFiles(root, lanePaths, { exec });
  for (const file of files) {
    let text;
    try { text = read(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      for (const k of keys) {
        if (!line.includes(lanePaths[k])) continue;
        const touch = laneTouchFromLine(line, lanePaths[k]);
        if (touch) result.get(k).push(touch);
      }
    }
  }
  return result;
}
