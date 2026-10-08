/**
 * @file scripts/lib/permission-change.mjs
 * @description THE PERMISSION-CHANGE HOLD: which diffs widen (or just change) what an automated actor may do, so
 *   they must ALWAYS get `review:human` and can never merge on an automatic accept.
 *
 * WHY. PR #4318 flipped `permissions: contents: read` to `write` on `apply-review-request.yml` and merged on the
 * automatic accept: the diff scored only `blast-radius` (agent-clearable). A widened token is the one change
 * whose cost the reviewer cannot bound by reading the diff, so it is a human call (operator decision 2026-10-08).
 * #4359 widened a Codex sandbox the same way (an extra `writableRoots` entry).
 *
 * THREE SURFACES, each read from the file's OWN hunks (`fileHunksResolver`, the same lookup the statute gate uses):
 *   1. WORKFLOW PERMISSIONS - a changed `permissions:` line, a changed scope grant (`contents: write`, ...), or
 *      `write-all`/`read-all`, in `.github/workflows/*.yml`. A workflow file whose hunks cannot be read FAILS
 *      CLOSED (any touch counts), exactly like `isStatuteAnchorEdit`.
 *   2. SANDBOX WIDENING - a changed (non-comment) code line naming a sandbox grant: `writableRoots`,
 *      `writable_roots`, `--add-dir`, `sandbox_mode`, `danger-full-access`, `approval_policy`, `network_access`,
 *      in `scripts/` code or Codex config. Tests, docs and comment-only edits do not count. An entry added inside an
 *      existing multi-line list counts too: the list's owning key is read from the hunk's unchanged context lines
 *      (and a Codex config entry whose key is out of the context's reach fails closed).
 *   3. BRANCH-PROTECTION-ADJACENT CONFIG - CODEOWNERS, rulesets, branch-protection files and the required-checks
 *      roster. Path-based: any touch counts.
 *
 * Narrowing is held too: from a diff we cannot tell a safe tightening from a swapped grant, and "changes
 * `permissions:`" is the rule. PURE: no fs, no clock.
 */

const WORKFLOW_RE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

/** Branch-protection-adjacent config: any touch holds. */
const PROTECTION_PATH_RES = [
  /(^|\/)\.github\/CODEOWNERS$/,
  /(^|\/)CODEOWNERS$/,
  /(^|\/)\.github\/rulesets?\//,
  /(^|\/)\.github\/(settings|branch-protection[^/]*)\.ya?ml$/,
  /(^|\/)\.github\/branch-protection[^/]*\.json$/,
  /(^|\/)scripts\/lib\/required-status-checks\.mjs$/,
  /(^|\/)scripts\/lib\/we-only-checks\.json$/,
];

const SANDBOX_FILE_RE = /(^|\/)(scripts\/.+\.mjs|\.codex\/[^/]+\.(toml|json|ya?ml))$/;
const TEST_OR_DOC_RE = /(^|\/)(__tests__|__fixtures__)\/|\.test\.mjs$|\.md$/;
const SANDBOX_TOKEN_RE = /writableRoots|writable_roots|--add-dir|\badd-dir\b|sandbox_mode|danger-full-access|approval_policy|network_access/;

const SCOPES = 'actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses';
// YAML spells the same grant many ways, so each key/value may be quoted (`"contents": "write"`) and may sit
// anywhere in a flow mapping (`permissions: { contents: write }`, a `{`/`,` before it), not only at the line start.
// A scope granted from an expression (`contents: ${{ inputs.level }}`) cannot be read as narrowing, so it holds too.
const KEY_START = '(?:^|[{,])\\s*';
const PERMISSIONS_KEY_RE = new RegExp(`${KEY_START}["']?permissions["']?\\s*:`);
const SCOPE_GRANT_RE = new RegExp(`${KEY_START}["']?(${SCOPES})["']?\\s*:\\s*(?:["']?(?:read|write|none)\\b|\\$\\{\\{)`);
const ALL_GRANT_RE = new RegExp(`${KEY_START}["']?permissions["']?\\s*:\\s*["']?(?:read-all|write-all)\\b`);

const DIFF_HEADER_RE = /^(diff --git |index |new file mode |deleted file mode |similarity index |rename (from|to) |(---|\+\+\+) (a\/|b\/|\/dev\/null))/;

/**
 * One file's diff section as `{ kind, text }` lines: `+`/`-` changes AND the unchanged context lines, markers stripped.
 * Context matters because a grant can widen on a line that does not name it (an entry added inside an existing
 * multi-line `writableRoots` list leaves the key as unchanged context). Returned PER HUNK (split at each `@@`): a
 * hunk's context says nothing about another hunk's lines, so an owner lookup must never read across the boundary
 * (an unrelated key in hunk 1 would hide a Codex list entry in hunk 2, a dangling `[` would adopt it). File headers
 * and `@@` lines are dropped; a removed line whose own text starts with `--` (`---add-dir` once the marker is on)
 * is kept, not mistaken for a header.
 * @returns {Array<Array<{kind:string, text:string}>>}
 */
function parseHunks(hunks) {
  const out = [[]];
  for (const line of String(hunks).split('\n')) {
    if (line.startsWith('@@')) { if (out[out.length - 1].length) out.push([]); continue; }
    if (DIFF_HEADER_RE.test(line) || line.startsWith('\\')) continue;
    const marker = line[0];
    const cur = out[out.length - 1];
    if (marker === '+' || marker === '-') cur.push({ kind: marker, text: line.slice(1) });
    else cur.push({ kind: ' ', text: marker === ' ' ? line.slice(1) : line });
  }
  return out;
}

/** The changed lines (`+`/`-` content, markers stripped) of one file's diff section. */
const changedLines = (hunks) => parseHunks(hunks).flat().filter((l) => l.kind !== ' ').map((l) => l.text);

const isComment = (l) => /^\s*(#|\/\/|\*|\/\*)/.test(l);
const isBlank = (l) => !/\S/.test(l);
const indentOf = (l) => l.match(/^\s*/)[0].length;
const OPENERS = '[({';
const CLOSERS = '])}';
/** A bare list element: a YAML `- x` item or a lone quoted string (the `"/a",` shape of a TOML/JSON array). */
const LIST_ENTRY_RE = /^\s*(-\s+\S|["'`][^"'`]*["'`]\s*,?\s*$)/;
const BARE_ADD_DIR_RE = /^\s*["'`]?--add-dir["'`]?\s*,?\s*$/;

/** The nearest earlier line that is neither blank nor a comment, or `null`. */
function previousCodeLine(lines, i) {
  for (let j = i - 1; j >= 0; j -= 1) {
    if (!isBlank(lines[j].text) && !isComment(lines[j].text)) return lines[j].text;
  }
  return null;
}

/**
 * The text that NAMES the list a changed line belongs to, nearest first, read from the hunk's context:
 *   - each unmatched opener to the left of the line (`writableRoots: [` ... ), the text before it, or, when the opener
 *     stands alone (`[` under `key:` / `key =`), the code line above it;
 *   - for a YAML `- item`, each strictly-less-indented line above (`writable_roots:`);
 *   - the bare `--add-dir` flag directly above a changed argument.
 * `keySeen` is false when the hunk showed no owner at all (the key is further up than the context reaches).
 */
function owningKeyTexts(lines, i) {
  const texts = [];
  let depth = 0;
  for (let j = i - 1; j >= 0; j -= 1) {
    const text = lines[j].text;
    if (isComment(text)) continue;
    for (let c = text.length - 1; c >= 0; c -= 1) {
      if (CLOSERS.includes(text[c])) depth += 1;
      else if (OPENERS.includes(text[c])) {
        if (depth > 0) depth -= 1;
        else {
          const before = text.slice(0, c);
          texts.push(/[\w-]/.test(before) ? before : (previousCodeLine(lines, j) ?? ''));
        }
      }
    }
  }
  const self = lines[i].text;
  if (/^\s*-\s/.test(self)) {
    let indent = indentOf(self);
    for (let j = i - 1; j >= 0 && indent > 0; j -= 1) {
      const text = lines[j].text;
      if (isBlank(text) || isComment(text) || indentOf(text) >= indent) continue;
      texts.push(text);
      indent = indentOf(text);
    }
  }
  const above = previousCodeLine(lines, i);
  if (above !== null && BARE_ADD_DIR_RE.test(above)) texts.push(above);
  return texts;
}

/** Does this file's change touch a sandbox grant - on the changed line itself, or by editing a list that one owns? */
function touchesSandboxGrant(file, hunks) {
  const codexConfig = /(^|\/)\.codex\//.test(file);
  for (const lines of parseHunks(hunks)) {
    for (let i = 0; i < lines.length; i += 1) {
      const { kind, text } = lines[i];
      if (kind === ' ' || isBlank(text) || isComment(text)) continue;
      if (SANDBOX_TOKEN_RE.test(text)) return true;
      const owners = owningKeyTexts(lines, i);
      if (owners.some((t) => !isComment(t) && SANDBOX_TOKEN_RE.test(t))) return true;
      // A Codex config is nothing BUT grants: a list entry whose key is out of the hunk's reach fails closed.
      if (codexConfig && !owners.length && LIST_ENTRY_RE.test(text)) return true;
    }
  }
  return false;
}

/**
 * Does this file's change touch a permission surface? Pure.
 * @param {string} file repo-relative path
 * @param {string|null} hunks that file's own diff section, or `null` when it could not be provided
 * @returns {string|null} what changed (`workflow-permissions` | `sandbox-widening` | `branch-protection-config`), else `null`
 */
export function permissionChangeKind(file, hunks) {
  const p = String(file || '');
  if (PROTECTION_PATH_RES.some((re) => re.test(p))) return 'branch-protection-config';
  if (WORKFLOW_RE.test(p)) {
    if (typeof hunks !== 'string') return 'workflow-permissions'; // unreadable: fail closed
    const hit = changedLines(hunks).some((l) => !isComment(l)
      && (PERMISSIONS_KEY_RE.test(l) || SCOPE_GRANT_RE.test(l) || ALL_GRANT_RE.test(l)));
    return hit ? 'workflow-permissions' : null;
  }
  if (SANDBOX_FILE_RE.test(p) && !TEST_OR_DOC_RE.test(p)) {
    if (typeof hunks !== 'string') return null; // code file with no readable hunks: the path alone says nothing
    return touchesSandboxGrant(p, hunks) ? 'sandbox-widening' : null;
  }
  return null;
}

/**
 * The files of a diff that trip the hold, with what tripped each. Pure.
 * @param {string[]} files basis file list
 * @param {(file:string) => string|null} hunksOf per-file hunk lookup (`fileHunksResolver`)
 * @returns {Array<{file:string, kind:string}>}
 */
export function permissionChangeFiles(files, hunksOf) {
  const out = [];
  for (const file of Array.isArray(files) ? files : []) {
    const kind = permissionChangeKind(file, typeof hunksOf === 'function' ? hunksOf(file) : null);
    if (kind) out.push({ file, kind });
  }
  return out;
}
