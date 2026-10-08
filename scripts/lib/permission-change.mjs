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
 *      in `scripts/` code or Codex config. Tests, docs and comment-only edits do not count.
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
const PERMISSIONS_KEY_RE = /^\s*permissions\s*:/;
const SCOPE_GRANT_RE = new RegExp(`^\\s*(${SCOPES})\\s*:\\s*(read|write|none)\\b`);
const ALL_GRANT_RE = /^\s*permissions\s*:\s*(read-all|write-all)\b/;

/** The changed lines (`+`/`-` content, markers stripped) of one file's diff section. */
function changedLines(hunks) {
  const out = [];
  for (const line of String(hunks).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line[0] === '+' || line[0] === '-') out.push(line.slice(1));
  }
  return out;
}

const isComment = (l) => /^\s*(#|\/\/|\*|\/\*)/.test(l);

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
    return changedLines(hunks).some((l) => !isComment(l) && SANDBOX_TOKEN_RE.test(l)) ? 'sandbox-widening' : null;
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
