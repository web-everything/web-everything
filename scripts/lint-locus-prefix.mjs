#!/usr/bin/env node
/**
 * @file lint-locus-prefix.mjs — write-time + pre-commit locus-prefix check (#883/#884/#885, shift-left).
 *
 * Runs the SAME pure detector the gate uses (`scanRepoLocusPrefixes`,
 * check-standards-rules.mjs) so a bare code-path token (`foo.ts`, `02-bar.html`, …)
 * in backlog/*.md or reports/*.md is caught BEFORE `check:standards` commit/close-out time.
 *
 * Four modes (#1389):
 *   • `--pre` — the PreToolUse(Edit|Write) GATE (load-bearing): scan the PROPOSED post-edit
 *     content from the hook event JSON on stdin BEFORE it is written to disk, and exit 2 (deny
 *     the tool call) if the edit would introduce a bare ref. Keeps a bare ref from EVER landing
 *     on disk, so a concurrent agent's whole-repo `check:standards` never goes red because of an
 *     in-work item mid-edit. Write → scans `tool_input.content`; Edit → applies
 *     `old_string`→`new_string` to the on-disk file and scans the result.
 *   • single-file (default) — the PostToolUse(Edit|Write) backstop: lint ONE just-edited file
 *     from disk. Target from the hook event JSON (`{ tool_input: { file_path } }`) or argv
 *     (`node scripts/lint-locus-prefix.mjs backlog/123-foo.md`).
 *   • `--staged` — the staged SWEEP: lint every git-staged backlog/reports md file. Catches refs
 *     introduced by `cat >>` / heredoc body-appends that bypass the Edit/Write hooks entirely.
 *     `npm run lint:locus`.
 *   • `--all` — lint the whole backlog/ + reports/ corpus (CI / one-shot audit).
 *   • `--range=<gitrange>` — the #2331 producer sweep (pr-land), see below.
 *
 * `--root=<path>` (#3342) picks the CLONE every sweep reads — git enumeration and the file reads both.
 * Default: the clone this script lives in. `pr-land` must pass it, because it runs from the primary
 * checkout while the commits it is landing exist only in a lane clone.
 *
 * Path match accepts BOTH absolute (hook) and relative (manual / staged) paths (#1389 — the
 * old `/(backlog|reports)/` required a leading slash, so a relative `backlog/x.md` no-op'd).
 * Exit 2 + stderr on findings (fed back to the agent); exit 0 when clean or N/A.
 */
import { hookRoot } from './lib/hook-root.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { scanRepoLocusPrefixes } from './check-standards-rules.mjs';

const SCRIPT_ROOT = hookRoot(import.meta.url);
// Absolute OR relative: anchor the corpus dir to a path start or a slash (#1389).
const CORPUS_RE = /(?:^|\/)(?:backlog|reports)\/[^/]+\.md$/;

// #3342 — WHICH CLONE THE SWEEP READS. Every sweep mode (git enumeration + the file reads) is anchored to
// ONE root. It used to be `SCRIPT_ROOT` unconditionally — the clone this file happens to live in — which is
// wrong for the only caller that matters: `pr-land` runs out of the PRIMARY checkout and lands a commit that
// exists only in a LANE clone, so `--range=origin/main..<lane sha>` named a revision the primary had never
// fetched, git exited 128, and the producer sweep was skipped on essentially every lane-opened PR. `--root=`
// makes the target clone explicit and caller-chosen; with no flag the old script-relative default stands, so
// the hook / `--staged` / `--all` call sites are unchanged.
const argv = process.argv.slice(2);
const rootFlag = argv.find((a) => a === '--root' || a.startsWith('--root='));
const ROOT = rootFlag
  ? resolve((rootFlag.includes('=') ? rootFlag.slice('--root='.length) : argv[argv.indexOf('--root') + 1]) || SCRIPT_ROOT)
  : SCRIPT_ROOT;

/** Read a repo file (path relative to root); null if unreadable (deleted/renamed away). */
function readDoc(file) {
  try {
    return { file, content: readFileSync(join(ROOT, file), 'utf8') };
  } catch {
    return null;
  }
}

/** Print findings + exit: 2 if any bare ref, else 0. */
function report(findings) {
  if (!findings.length) process.exit(0);
  for (const { file, count, sample } of findings) {
    process.stderr.write(
      `locus-prefix: ${count} bare code-path ref(s) in ${file} lack a <repo>: prefix ` +
        `(#883; e.g. "${sample}" → "we:${sample}"). Prefix them now — don't leave it for the gate.\n`,
    );
  }
  process.exit(2);
}

/** Git-staged (added/copied/modified/renamed) corpus files, relative to repo root. */
function stagedCorpusFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter((f) => f && CORPUS_RE.test(f));
}

/** Corpus files changed across a git commit RANGE (e.g. `origin/main..HEAD`), read from disk at the current
 *  tip. The #2331 producer path: the #2170 pre-PR review can edit an item body AFTER the author's write-time
 *  gate ran, via a route the PostToolUse hook does not see — so the producer (pr-land) re-lints the lane's OWN
 *  committed corpus changes before opening the PR, catching a bare ref that would otherwise only go red in CI. */
function rangeCorpusFiles(range) {
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', range], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // #3342 — a range git cannot resolve IN THIS ROOT is the exact shape of the old bug (the commit lives in
    // another clone). Exit 3, distinct from the 2 that means "found a bare ref", and NAME the root that was
    // swept — the missing fact that let the failure read as noise for months.
    process.stderr.write(
      `locus-prefix: could not enumerate range "${range}" in ${ROOT} — nothing was linted (#3342; ` +
        `pass --root=<the clone holding the commits>). git said: ${String(e?.stderr || e?.message || e).split('\n')[0]}\n`,
    );
    process.exit(3);
  }
  return out.split('\n').map((s) => s.trim()).filter((f) => f && CORPUS_RE.test(f));
}

/** Whole backlog/ + reports/ corpus, relative to repo root. */
function allCorpusFiles() {
  return ['backlog', 'reports']
    .filter((d) => existsSync(join(ROOT, d)))
    .flatMap((d) => readdirSync(join(ROOT, d)).filter((n) => n.endsWith('.md')).map((n) => `${d}/${n}`));
}

// ── Pre-write GATE — the PreToolUse(Edit|Write) path: scan the PROPOSED content, deny on a bare ref ──
if (argv.includes('--pre')) {
  let ev;
  try {
    ev = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0); // unparseable event — fail open (the PostToolUse + staged layers still cover it)
  }
  const file = ev?.tool_input?.file_path;
  if (!file || !CORPUS_RE.test(file)) process.exit(0); // not a locus-governed corpus file

  // Compute the post-edit content WITHOUT writing it.
  const ti = ev.tool_input ?? {};
  const onDisk = (() => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return ''; // new file (Write, or Edit creating one)
    }
  })();
  let proposed;
  if (ev.tool_name === 'Write') {
    proposed = ti.content ?? '';
  } else if (ev.tool_name === 'Edit' && typeof ti.old_string === 'string') {
    // Apply old→new the way Edit does; if old_string isn't present, scan just the insertion.
    proposed = onDisk.includes(ti.old_string)
      ? (ti.replace_all ? onDisk.split(ti.old_string).join(ti.new_string ?? '') : onDisk.replace(ti.old_string, ti.new_string ?? ''))
      : (ti.new_string ?? '');
  } else {
    proposed = ti.content ?? ti.new_string ?? onDisk; // unknown shape — best effort, fail open if empty
  }
  report(scanRepoLocusPrefixes([{ file, content: proposed }]));
}

// ── Sweep modes — the staged / CI path (#1389) ──────────────────────────────────
if (argv.includes('--staged') || argv.includes('--all')) {
  const files = argv.includes('--staged') ? stagedCorpusFiles() : allCorpusFiles();
  report(scanRepoLocusPrefixes(files.map(readDoc).filter(Boolean)));
}

// ── Range mode — the #2331 producer sweep: lint the corpus files a commit range changed ──────────
// `--range=<gitrange>` (e.g. `--range=origin/main..HEAD`). pr-land runs this before opening the PR so the
// #2170 review-append leak is caught by the producer, not CI. Clean range (no corpus change) → exit 0.
// The range is read in `--root` (#3342) — the clone that HOLDS those commits — not in this script's clone.
const rangeFlag = argv.find((a) => a === '--range' || a.startsWith('--range='));
if (rangeFlag) {
  const range = rangeFlag.includes('=') ? rangeFlag.slice('--range='.length) : argv[argv.indexOf('--range') + 1];
  if (!range) process.exit(0); // no range given — nothing to lint (fail open)
  report(scanRepoLocusPrefixes(rangeCorpusFiles(range).map(readDoc).filter(Boolean)));
}

// ── Single-file mode — the PostToolUse hook + manual run ─────────────────────────
function resolveTarget() {
  const arg = argv[0];
  if (arg && !arg.startsWith('--')) return arg;
  try {
    const raw = readFileSync(0, 'utf8'); // stdin (hook event JSON)
    if (!raw.trim()) return null;
    const ev = JSON.parse(raw);
    return ev?.tool_input?.file_path ?? null;
  } catch {
    return null;
  }
}

const file = resolveTarget();
// Only the two locus-governed corpora; bail fast (and silently) on everything else.
if (!file || !CORPUS_RE.test(file)) process.exit(0);

let content;
try {
  content = readFileSync(file, 'utf8');
} catch {
  process.exit(0); // deleted/unreadable — nothing to lint
}

report(scanRepoLocusPrefixes([{ file, content }]));
