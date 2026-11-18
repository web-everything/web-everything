#!/usr/bin/env node
/**
 * Backlog write-time guard (AI-optimisation program). Shift-left for two summary footguns the
 * `check:standards` gate only catches LATE, plus a double-count it misses entirely.
 *
 *   --pre  (PreToolUse Edit|Write, DENY via exit 2): predict the gate's "missing required field
 *          summary" BEFORE the edit lands. An item's summary is derived from its body's first real
 *          paragraph (mirrors firstParagraph in src/_data/backlog.js, #745) — a body that leads with
 *          `**Label:**`, a heading, or a list derives an EMPTY summary; so does a stray body added to
 *          a frontmatter-only `relatedReport` pointer. Both hard-error the gate. Also denies the
 *          retired `childlessReason/unsplittableReason: undecided` sentinels, AND a `Write` that
 *          hand-creates a brand-new backlog file — new items must be minted via `scaffold` (or the
 *          `file-item`/`scaffold` declared operations, `we:scripts/operations/run.mjs`), never
 *          hand-authored with the `Write` tool.
 *
 *          WIDENED 2026-09-06 (#3383) from NUMERIC-only to ANY new id shape, including a hand-typed
 *          `xNNNNNN` hash. The original rule only covered a hand-picked NNN (races concurrent sessions
 *          into a duplicate id, #2288/#2323); a hand-typed hash cannot collide the same way, but it is
 *          the OTHER real failure mode named live 2026-09-06: every item filed that session went
 *          through a hand-dispatched subagent with a bespoke prompt rather than a declared operation —
 *          and `scaffold`'s own write path (`we:scripts/backlog/guarded-write.mjs`) always writes via
 *          `fs` directly, never via the `Write` tool. So a `Write` tool call CREATING a new backlog
 *          file, of ANY id shape, is by construction not that path — it is either a hand-typed hash or
 *          a bypass of the scan/queue-clear a declared operation would have applied. Editing an
 *          EXISTING file (any id shape, already on disk) is unaffected — only file CREATION is denied.
 *   default (PostToolUse Edit|Write, WARN via exit 2): a `kind: story` carrying a `size` that also
 *          has children (some other item's `parent:`) double-counts in the burndown — a case the gate
 *          only flags for sized epics, not stories.
 *
 * Fails open on unparseable input / non-backlog paths.
 */
import { hookRoot } from './lib/hook-root.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { idFromName } from './backlog/id.mjs';
import { scrubPublish } from './lib/secret-scrub.mjs';

const ROOT = hookRoot(import.meta.url);
// two-form id (#2288): a landed NNN or a provisional `xNNNNNN` hash — keep in sync with id.mjs ID_TOKEN_RE.
const BACKLOG_RE = /(?:^|\/)backlog\/(\d{1,5}|x[0-9a-z]{6})-[^/]+\.md$/;

/** Split a markdown doc into { fm, body } on a leading --- … --- frontmatter block. */
function split(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: '', body: text };
}

/** Read a top-level scalar frontmatter field (quotes stripped); '' if absent/empty. */
const fmField = (fm, k) => {
  const m = fm.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
};

/**
 * First real paragraph — mirrors src/_data/backlog.js firstParagraph (#745): skips headings, rules,
 * quotes, lists, code-fences AND a `**Label:**` lead (exactly the digest footgun). '' if none.
 */
function firstParagraph(body) {
  const buf = [];
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    const skip = !l || l === '---' || /^#{1,6}\s/.test(l) || /^>/.test(l)
      || /^```/.test(l) || /^[-*|]/.test(l) || /^\*\*[^*]+:\*\*/.test(l);
    if (skip) { if (buf.length) break; else continue; }
    buf.push(l);
  }
  return buf.length ? buf.join(' ') : '';
}

/** Compute the post-edit content without writing it (Write → content; Edit → apply old→new). */
function proposedContent(ev) {
  const ti = ev.tool_input || {};
  const onDisk = (() => { try { return readFileSync(ti.file_path, 'utf8'); } catch { return ''; } })();
  if (ev.tool_name === 'Write') return ti.content ?? '';
  if (ev.tool_name === 'Edit' && typeof ti.old_string === 'string')
    return onDisk.includes(ti.old_string)
      ? (ti.replace_all ? onDisk.split(ti.old_string).join(ti.new_string ?? '') : onDisk.replace(ti.old_string, ti.new_string ?? ''))
      : (ti.new_string ?? '');
  return ti.content ?? ti.new_string ?? onDisk;
}

function deny(msg) { process.stderr.write('backlog-guard: ' + msg + '\n'); process.exit(2); }

const argv = process.argv.slice(2);
let ev;
try { ev = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const file = ev?.tool_input?.file_path;
if (!file || !BACKLOG_RE.test(file)) process.exit(0);

// ── PreToolUse GATE: deny edits that would land an empty summary or a retired sentinel ──
if (argv.includes('--pre')) {
  // A brand-new backlog file must be minted by `scaffold` (collision-free hash id xNNNNNN), never
  // hand-authored with a numeric NNN- prefix (races concurrent sessions → duplicate ids, #2288/#2323).
  // Only a Write that CREATES a numeric-prefixed file not yet on disk is the footgun; editing a landed
  // NNN item, or writing a scaffold-minted xNNNNNN file, is fine.
  const text = proposedContent(ev);

  // #3015 — the PUBLISH-SEAM secret gate for the OTHER half of the write surface: a direct `Edit`/`Write`
  // to a card body, which never goes through `scripts/backlog.mjs`'s `writeBacklogMd` (that funnel carries
  // the same check for the CLI path). Deny BEFORE the tool call runs, so the leak never reaches disk — let
  // alone a commit. `scrubPublish` is corpus-calibrated and deliberately narrower than the learnings
  // append-seam scrub: it does NOT object to code, repo paths, or `we:`-prefixed citations.
  //
  // FIRST, ahead of the hand-numbering check below, deliberately: both can fire on the same `Write`, and a
  // leaked credential is the more severe of the two. Reporting the id-hygiene nit first would hide it.
  if (text.trim()) {
    const leaks = scrubPublish(text);
    if (leaks.length)
      deny(`this edit would write ${leaks.join('; ')} into a backlog card (#3015). Cards are COMMITTED and PUSHED, so a credential in one is a published credential. Remove the value (and rotate it if it was ever real) and describe it in words instead of pasting it.`);
  }

  const idTok = (file.match(BACKLOG_RE) || [])[1] || '';
  if (ev.tool_name === 'Write' && !existsSync(file)) {
    if (/^\d+$/.test(idTok))
      deny(`new backlog file "${basename(file)}" is hand-numbered — mint items with \`node scripts/backlog.mjs scaffold "<title>"\` (or \`node scripts/operations/run.mjs file-item ...\`), which assigns a collision-free hash id (xNNNNNN). Hand-picking an NNN races concurrent sessions and mints duplicate ids (#2288/#2323). Run scaffold/file-item, then edit the file it creates.`);
    // #3383 — ANY new backlog file created via the Write tool is a hand-authored bypass, not just a
    // hand-numbered one: `scaffold`'s own write path always writes via `fs` directly (the CLI, or the
    // `scaffold`/`file-item` declared operations), never via this tool, so a Write tool call landing here
    // — hash-prefixed or not — did not go through it. Found live 2026-09-06: a session filing an item
    // by hand can just as easily type a plausible-looking `xNNNNNN` as pick a numeric NNN.
    deny(`new backlog file "${basename(file)}" was hand-authored with the Write tool — file items with \`node scripts/backlog.mjs scaffold "<title>"\` (or \`node scripts/operations/run.mjs file-item ...\`, which also clears it for the conveyor). Those write via fs directly, never via this tool, so a Write tool call creating a new backlog file — whatever its id looks like — has skipped the #883 locus-prefix scan scaffold's own writer runs (this hook does not run it) and, if \`file-item\` was the intended path, the conveyor clearance too (#3383). Run scaffold/file-item, then edit the file it creates.`);
  }

  if (!text.trim()) process.exit(0); // empty proposal — nothing to judge
  const { fm, body } = split(text);

  if (/^(?:childlessReason|unsplittableReason):\s*undecided\s*$/m.test(fm))
    deny('`childlessReason/unsplittableReason: undecided` is retired — give a real reason or restructure (no-decision/epic-conflation). Don\'t leave it for the gate.');

  const ownBody = body.trim();
  const fmSummary = fmField(fm, 'summary');
  const relatedReport = fmField(fm, 'relatedReport');
  const summary = ownBody ? (firstParagraph(ownBody) || fmSummary) : (relatedReport ? 'report' : fmSummary);
  if (!summary)
    deny('this edit yields an EMPTY summary (the gate\'s "missing required field summary"). The summary is the body\'s first real paragraph — don\'t lead with `**Label:**`, a heading, or a list; lead with a plain prose sentence (or set a `summary:` field). For a frontmatter-only relatedReport pointer, keep it body-less.');

  process.exit(0);
}

// ── PostToolUse WARN: a sized story that also has children double-counts the burndown ──
const num = (file.match(BACKLOG_RE) || [])[1];
let text;
try { text = readFileSync(file, 'utf8'); } catch { process.exit(0); }
const { fm } = split(text);
if (fmField(fm, 'kind') === 'story' && fmField(fm, 'size')) {
  let hasChild = false;
  try {
    for (const f of readdirSync(join(ROOT, 'backlog'))) {
      if (!f.endsWith('.md') || idFromName(f) === num) continue;
      if (new RegExp(`^parent:\\s*["']?${num}\\b`, 'm').test(readFileSync(join(ROOT, 'backlog', f), 'utf8'))) {
        hasChild = true;
        break;
      }
    }
  } catch { /* dir unreadable — skip the warn */ }
  if (hasChild) {
    process.stderr.write(
      `backlog-guard: #${num} is a sized \`story\` that also has children (another item's \`parent: ${num}\`) — that double-counts in the burndown. Convert the parent to an \`epic\` (sized only while unsliced) or drop its size.\n`,
    );
    process.exit(2);
  }
}
process.exit(0);
