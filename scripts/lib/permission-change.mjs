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
 *   1. WORKFLOW PERMISSIONS - a changed `permissions:` line, any changed line UNDER a `permissions:` key, or a grant
 *      word (`read`/`write`/`none`/`*-all`, quoted, anchored or tagged, on the line or the next) as the value of any
 *      non-free-text key, in `.github/workflows/*.yml`. The scope list is not closed. A workflow file whose hunks
 *      cannot be read, or whose section has no hunk at all (a pure rename, an empty new file), FAILS CLOSED (any
 *      touch counts), exactly like `isStatuteAnchorEdit`.
 *   2. SANDBOX WIDENING - a changed (non-comment) code line naming a sandbox grant: `writableRoots`,
 *      `writable_roots`, `--add-dir`, `sandbox_mode`, `danger-full-access`, `approval_policy`, `network_access`,
 *      in `scripts/` code (any script extension), Codex config or `.claude/settings*.json`. Tests, docs and
 *      comment-only edits do not count; a line that only STARTS with a block comment is still code. An entry added
 *      inside an existing multi-line list counts too: the list's owning key is read from the hunk's unchanged context
 *      lines (and a Codex config entry whose key is out of the context's reach fails closed). With NO readable
 *      hunks, the config files above and `SANDBOX_BEARING_FILES` fail closed.
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

// Every script-like extension, not just `.mjs`: a grant spelled in `.ts`/`.js`/`.sh` widens a sandbox the same way.
const SANDBOX_FILE_RE = /(^|\/)(scripts\/.+\.(mjs|cjs|js|mts|ts|sh|bash|py)|\.codex\/[^/]+\.(toml|json|ya?ml)|\.claude\/settings[^/]*\.json)$/;
const TEST_OR_DOC_RE = /(^|\/)(__tests__|__fixtures__)\/|\.(test|spec)\.(mjs|cjs|js|mts|ts)$|\.md$/;
/** Config files that are nothing BUT grants: with no readable hunks, any touch holds. */
const SANDBOX_CONFIG_RE = /(^|\/)(\.codex\/[^/]+|\.claude\/settings[^/]*\.json)$/;
// Case-insensitive, and every spelling of the same grant seen across Codex, Claude and Gemini configs and flags.
export const SANDBOX_TOKEN_RE = /writable[_-]?roots|--add-dir|\badd-dir\b|sandbox[_-]?mode|danger-full-access|workspace-write|sandbox_workspace_write|--sandbox\b|--full-auto|--yolo|dangerously-bypass-approvals-and-sandbox|dangerously-skip-permissions|bypassPermissions|ask-for-approval|approval[_-]?policy|network[_-]?access|additionalDirectories/i;

/** Resource bounds: how far back an owner lookup reads, and how large a hunk or line may be before we stop reading it. */
const SCAN_WINDOW = 200;
const MAX_WORKFLOW_HUNK_LINES = 5000;
const MAX_OWNER_HUNK_LINES = 20000;
const MAX_WORKFLOW_LINE_CHARS = 4000;

/**
 * Every non-test script that spells a sandbox token. When a PR's net diff was not scored (no local or sibling clone),
 * these fail closed on any touch instead of reading as "nothing to see". A repo-scanning test pins this list to the
 * tokens actually present in `scripts/`, so a new sandbox-bearing script forces an update here.
 */
export const SANDBOX_BEARING_FILES = [
  'scripts/bootstrap-session.mjs',
  'scripts/codex-direct-task.mjs',
  'scripts/conveyor/health-investigate-dispatch.mjs',
  'scripts/conveyor/health-smells/dispatch-permission-stall.mjs',
  'scripts/gemini-direct-task.mjs',
  'scripts/lib/agy-review-juror.mjs',
  'scripts/lib/antigravity-judge-spawn.mjs',
  'scripts/lib/gh-app-shim.mjs',
  'scripts/lib/isolation-provider.mjs',
  'scripts/lib/permission-change.mjs',
  'scripts/operations/codex-delivery-provider.mjs',
  'scripts/operations/deliver-item-wrapper.mjs',
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/minimal-context-provider.mjs',
  'scripts/operations/run.mjs',
  'scripts/operations/scheduled-sweep.mjs',
  'scripts/operator/converge.py',
  'scripts/operator/dispatch.mjs',
];

/**
 * Sandbox-bearing files that do NOT fail closed on unreadable hunks: ENGINE-tier files (the #2445 flip makes an engine
 * edit escalate but stay agent-reviewable, `gate-invariants.test.mjs`). A token on a readable changed line still holds.
 */
export const SANDBOX_NULL_HUNKS_FREE = ['scripts/operations/dispatch-lane-io.mjs'];

// The scope list is a FLOOR, not a gate: GitHub adds scopes (`copilot-requests`, `artifact-metadata`, ...) and a closed
// list misses each new one. It only decides the two value shapes that are NOT a plain grant word on their own - an
// expression (`contents: ${{ inputs.level }}`) and an alias (`contents: *w`) - which hold for a known scope. Everything
// else is read structurally: any changed line UNDER a `permissions:` key holds, and a grant word as a value holds for
// any key outside the small free-text list below (a gap in that list only ever over-holds).
const SCOPES = 'actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses';
const SCOPE_SET = new Set(SCOPES.split('|'));
const FREE_TEXT_KEYS = new Set(['name', 'run', 'description', 'default', 'shell', 'if', 'uses', 'id', 'title', 'label', 'body', 'message', 'summary', 'text']);
// YAML spells the same grant many ways, so each key/value may be quoted (`"contents": "write"`), anchored (`&w write`),
// tagged (`!!str write`) and may sit anywhere in a flow mapping (`permissions: { contents: write }`, a `{`/`,` before
// it), not only at the line start.
const KEY_START = '(?:^|[{,])\\s*';
const GRANT_WORDS = 'read-all|write-all|read|write|none';
const VALUE_DECOR = `(?:(?:&[^\\s,{}]+|![^\\s,{}]*)\\s+)*["']?`;
const PERMISSIONS_KEY_RE = new RegExp(`${KEY_START}["']?permissions["']?\\s*:`);
const ALL_GRANT_RE = new RegExp(`${KEY_START}["']?permissions["']?\\s*:\\s*${VALUE_DECOR}(?:read-all|write-all)\\b`);
/** `key: <value>` pairs on a line (also after a flow `{`/`,`): group 1 the key, group 2 a grant word, `*alias` or `${{`. */
const KEY_VALUE_G = new RegExp(`${KEY_START}(?:-\\s+)?["']?([\\w.-]+)["']?\\s*:\\s*(?:${VALUE_DECOR}(${GRANT_WORDS})["']?(?=[\\s,}#]|$)|(\\*\\S+|\\$\\{\\{))`, 'gi');
/** A bare grant scalar on a line of its own - the value of a `key:` on the line above (`contents:` newline `  write`). */
const BARE_GRANT_RE = new RegExp(`^\\s*${VALUE_DECOR}(?:${GRANT_WORDS})["']?\\s*(?:#.*)?$`, 'i');
/** A `key:` with no value yet (the value is on the next line). Group 1 is the key. */
// Decorations exclude `&`/`!` from their own body, so a run of them has exactly one way to split (no backtracking blowup).
const EMPTY_KEY_RE = /^\s*(?:-\s+)?["']?([\w.-]+)["']?\s*:\s*(?:(?:&[^\s&!]*|![^\s&!]*)\s*)*(?:#.*)?$/;

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

// A LEADING block comment is not the whole line: `/* note */ writableRoots: [a]` is code, `/* note */` alone is not.
const LEADING_BLOCK_COMMENTS_RE = /^\s*(?:\/\*.*?\*\/\s*)+/;
const isComment = (l) => {
  const rest = l.replace(LEADING_BLOCK_COMMENTS_RE, '');
  return rest !== l && !/\S/.test(rest) ? true : /^\s*(#|\/\/|\*|\/\*)/.test(rest);
};
const isBlank = (l) => !/\S/.test(l);
const indentOf = (l) => l.match(/^\s*/)[0].length;
const OPENERS = '[({';
const CLOSERS = '])}';
/** A bare list element: a YAML `- x` item or a lone quoted string (the `"/a",` shape of a TOML/JSON array). */
const LIST_ENTRY_RE = /^\s*(-\s+\S|["'`][^"'`]*["'`]\s*,?\s*$)/;
const BARE_ADD_DIR_RE = /^\s*["'`]?--add-dir["'`]?\s*,?\s*$/;

/** The nearest earlier line that is neither blank nor a comment, or `null`. */
function previousCodeLine(lines, i) {
  for (let j = i - 1; j >= Math.max(0, i - SCAN_WINDOW); j -= 1) {
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
  const floor = Math.max(0, i - SCAN_WINDOW);
  for (let j = i - 1; j >= floor; j -= 1) {
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
    for (let j = i - 1; j >= floor && indent > 0; j -= 1) {
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

/** The nearest later line that is neither blank nor a comment, or `null`. */
function nextCodeLine(lines, i) {
  for (let j = i + 1; j < Math.min(lines.length, i + 1 + SCAN_WINDOW); j += 1) {
    if (!isBlank(lines[j].text) && !isComment(lines[j].text)) return lines[j].text;
  }
  return null;
}

/** Is the changed line inside a `permissions:` mapping - a YAML ancestor in the hunk's context, or an open flow `{`? */
function underPermissionsKey(lines, i) {
  let indent = indentOf(lines[i].text);
  for (let j = i - 1; j >= Math.max(0, i - SCAN_WINDOW) && indent > 0; j -= 1) {
    const text = lines[j].text;
    if (isBlank(text) || isComment(text) || indentOf(text) >= indent) continue;
    if (PERMISSIONS_KEY_RE.test(text)) return true;
    indent = indentOf(text);
  }
  return owningKeyTexts(lines, i).some((t) => PERMISSIONS_KEY_RE.test(t));
}

/** Does one line carry a `key: grant` pair for a key that is not free text (also inside a flow mapping)? */
function lineGrantsPermission(text) {
  for (const m of text.matchAll(KEY_VALUE_G)) {
    const [, key, grantWord, aliasOrExpr] = m;
    if (grantWord && !FREE_TEXT_KEYS.has(key)) return true;
    // An alias is opaque on any non-free key; an expression only holds for a known scope (`env:` values use `${{` freely).
    if (aliasOrExpr && !FREE_TEXT_KEYS.has(key) && (aliasOrExpr.startsWith('*') || SCOPE_SET.has(key))) return true;
  }
  return false;
}

/** Does this changed workflow line widen (or merely edit) the token's permissions? Reads the line in its hunk's context. */
function workflowLineChangesPermissions(lines, i) {
  const { text } = lines[i];
  if (PERMISSIONS_KEY_RE.test(text) || ALL_GRANT_RE.test(text)) return true;
  if (underPermissionsKey(lines, i)) return true;
  if (lineGrantsPermission(text)) return true;
  // The value on a line of its own: `contents:` newline `  write`, in either order of which line changed.
  if (BARE_GRANT_RE.test(text)) {
    const key = EMPTY_KEY_RE.exec(previousCodeLine(lines, i) ?? '')?.[1];
    return !(key && FREE_TEXT_KEYS.has(key));
  }
  const key = EMPTY_KEY_RE.exec(text)?.[1];
  const below = nextCodeLine(lines, i);
  return Boolean(key && !FREE_TEXT_KEYS.has(key) && below !== null && BARE_GRANT_RE.test(below));
}

/** Does this workflow's diff change what its token may do? A section with no hunk (rename, empty new file) cannot say, so it does. */
function touchesWorkflowPermissions(hunks) {
  if (typeof hunks !== 'string' || !/^@@/m.test(hunks)) return true;
  // Too large to read within bounds: hold rather than skim. A sandbox grant spelled in a workflow (an agent action's
  // `sandbox: danger-full-access`, `--dangerously-skip-permissions`) widens an automated actor the same way.
  return parseHunks(hunks).some((lines) => lines.length > MAX_WORKFLOW_HUNK_LINES || lines.some(({ kind, text }, i) => kind !== ' '
    && !isBlank(text) && !isComment(text)
    && (text.length > MAX_WORKFLOW_LINE_CHARS || SANDBOX_TOKEN_RE.test(text) || workflowLineChangesPermissions(lines, i))));
}

/** Does this path name a file that, with unreadable hunks, must fail closed as a sandbox surface? */
const isSandboxBearingPath = (p) => SANDBOX_CONFIG_RE.test(p)
  || SANDBOX_BEARING_FILES.some((f) => !SANDBOX_NULL_HUNKS_FREE.includes(f) && (p === f || p.endsWith(`/${f}`)));

/** Does this file's change touch a sandbox grant - on the changed line itself, or by editing a list that one owns? */
function touchesSandboxGrant(file, hunks) {
  const codexConfig = /(^|\/)\.codex\//.test(file);
  for (const lines of parseHunks(hunks)) {
    for (let i = 0; i < lines.length; i += 1) {
      const { kind, text } = lines[i];
      if (kind === ' ' || isBlank(text) || isComment(text)) continue;
      if (SANDBOX_TOKEN_RE.test(text)) return true;
      if (lines.length > MAX_OWNER_HUNK_LINES) continue; // bounded read: the token test above still covers every changed line
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
  if (WORKFLOW_RE.test(p)) return touchesWorkflowPermissions(hunks) ? 'workflow-permissions' : null; // unreadable: fail closed
  if (SANDBOX_FILE_RE.test(p) && !TEST_OR_DOC_RE.test(p)) {
    // Unreadable hunks (the net diff was not scored, no clone, a pure rename): a file that is nothing but grants, or
    // one on the sandbox-bearing list, fails closed; any other code file says nothing by its path alone.
    if (typeof hunks !== 'string' || !/^@@/m.test(hunks)) return isSandboxBearingPath(p) ? 'sandbox-widening' : null;
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
