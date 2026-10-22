/** Bounded pre-review check. No publication and no GitHub calls. */
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';
import { laneGitConfigArgs, hardenLaneGitArgs, laneFilterDrivers, LANE_CONFIG_LIST_ARGS } from './lane-git-hardening.mjs';

export const SELF_REVIEW_MAX_DIFF_BYTES = 512 * 1024;
const TOO_LARGE = 'Self-review incomplete: net diff exceeds the 512 KiB limit. No review verdict was obtained for this diff; human review of the full diff is required.';
class SelfReviewDiffTooLargeError extends Error {}

/**
 * git argv for reading a builder's diff in the caller's own process (run it with `laneGitHardeningEnv()`). The builder
 * can write the lane's `.git/config` and attributes, so the shared lane pins apply, external diff drivers and textconv
 * stay off, and `--text` keeps a path marked binary in the review. A clean filter still runs on worktree content:
 * a worktree read checks {@link assertNoLaneFilterDrivers} first.
 */
export const selfReviewDiffArgs = (...revs) => [...laneGitConfigArgs(), '--no-replace-objects',
  ...hardenLaneGitArgs(['diff', '--no-color', '--text', ...revs, '--'])];

/** Refuse a checkout whose own config defines a filter driver; `git diff`/`git status` would run it on worktree content. */
export function assertNoLaneFilterDrivers(listConfig) {
  const drivers = laneFilterDrivers(listConfig(LANE_CONFIG_LIST_ARGS));
  if (drivers.length) throw new Error(`refusing to read a checkout that defines a filter driver: ${drivers.join(', ')}`);
}

/** Run a diff read; an overflowing read buffer is the known size bound, not an unavailable review. */
export function boundedSelfReviewDiff(read) {
  try { return read(); }
  catch (error) {
    if (error?.code === 'ENOBUFS') throw new SelfReviewDiffTooLargeError(TOO_LARGE);
    throw error;
  }
}

export async function selfReviewPrompt(diff) {
  const { buildMandate } = await import('./review-core.mjs');
  return ['Review the net diff once for correctness and security. Report only concrete blocking defects.',
    buildMandate({ mandate: 'correctness', fenced: true }), buildMandate({ mandate: 'security', fenced: true }),
    'Return ONLY JSON: {"findings":["file:line — defect, evidence and required correction"]}. Use an empty array when clear.',
    FENCED_DATA_RULE, fenceUntrusted('material', diff)].join('\n\n');
}

// Prose outside the verdict that still states findings, in any notation: JSON (escaped or not), YAML, a bare key.
// Matched after NFKC, with format characters and all whitespace removed, so look-alike, zero-width or spaced-out
// spellings (JSON allows any whitespace, newlines included, before the colon) count too.
const STRAY_FINDINGS_KEY = /findings[^\p{L}\p{N}]{0,6}:/iu;

/** The top-level keys of valid JSON object text, in order, duplicates kept (`JSON.parse` keeps only the last). */
function topLevelKeys(json) {
  const keys = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      if (depth === 1 && expectKey) keys.push(JSON.parse(json.slice(i, j + 1)));
      i = j;
    } else if (c === '{' || c === '[') { depth++; expectKey = c === '{' && depth === 1; }
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1 && c === ',') expectKey = true;
    else if (depth === 1 && c === ':') expectKey = false;
  }
  return keys;
}

/**
 * One verdict object: bare, or inside exactly one fenced block, either with prose around it. Without a fence the
 * object runs from the first `{` to the last `}`. Anything else is invalid: two blocks, two objects, a second
 * verdict in the prose outside the object, a repeated or extra key.
 */
export function parseSelfReviewVerdict(message) {
  const text = String(message ?? '').replace(/\r\n?/g, '\n').trim();
  const fences = [...text.matchAll(/^```[ \t]*(?:json)?[ \t]*\n([\s\S]*?)\n```[ \t]*$/gim)];
  if (fences.length > 1) throw new Error('invalid self-review verdict: more than one fenced block');
  const [start, end] = fences.length ? [fences[0].index, fences[0].index + fences[0][0].length]
    : [text.indexOf('{'), text.lastIndexOf('}') + 1];
  const body = fences.length ? fences[0][1] : text.slice(start, end);
  const outside = (text.slice(0, Math.max(start, 0)) + '\n' + text.slice(end))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).normalize('NFKC').replace(/[\p{Cf}\s]/gu, '');
  if (STRAY_FINDINGS_KEY.test(outside)) throw new Error('invalid self-review verdict: findings outside the verdict object');
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || topLevelKeys(body.trim()).join() !== 'findings') {
    throw new Error('invalid self-review verdict');
  }
  return parsed;
}

export async function reviewBuildDiff({ dir, diff, env = process.env }) {
  if (typeof diff !== 'string') throw new Error('self-review net diff is unavailable');
  if (Buffer.byteLength(diff) > SELF_REVIEW_MAX_DIFF_BYTES) throw new SelfReviewDiffTooLargeError(TOO_LARGE);
  if (!diff.trim()) return [];
  const { codexDirectTask } = await import('../codex-direct-task.mjs');
  const report = await codexDirectTask({ dir, task: await selfReviewPrompt(diff), review: true, gate: 'none',
    taskKind: 'review', effort: 'low', ephemeral: true, stream: false, env });
  if (report.exitCode !== 0 || report.timedOut) throw new Error('self-review process failed');
  const parsed = parseSelfReviewVerdict(report.lastMessage);
  if (!Array.isArray(parsed.findings) || parsed.findings.some(f => typeof f !== 'string' || !f.trim()) || parsed.findings.length > 100) throw new Error('invalid self-review findings');
  return parsed.findings;
}

export function selfReviewRepairPrompt(notes) {
  return `Address the concrete pre-review findings in your existing change. Keep scope fixed, send the same completion report, and do not commit or push.\n${FENCED_DATA_RULE}\n${fenceUntrusted('findings', notes.join('\n'))}`;
}

export async function runBuildSelfReview({ policy, readDiff, review = reviewBuildDiff, fix, gate, dir, env }) {
  if (!policy.selfReview.enabled) return { rounds: 0, notes: [], skipped: true };
  const cap = policy.selfReview.maxRounds;
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 10) throw new Error('invalid self-review cap');
  for (let rounds = 0; rounds <= cap; rounds++) {
    let notes;
    try { notes = await review({ dir, diff: await readDiff(), env }); }
    catch (error) {
      // A known input bound hands the full diff to independent review with an explicit note.
      // Do not ask the builder to "repair" the size or silently treat a partial review as clear.
      if (error instanceof SelfReviewDiffTooLargeError) return { rounds, notes: [error.message], incomplete: true };
      throw new Error('self-review unavailable: review failed or returned invalid findings');
    }
    if (!Array.isArray(notes) || notes.some(n => typeof n !== 'string')) throw new Error('invalid self-review notes');
    if (!notes.length || rounds === cap) return { rounds, notes, capped: notes.length > 0 };
    await fix(selfReviewRepairPrompt(notes), rounds + 1);
    if (!await gate()) throw new Error('self-review repair gate is red');
  }
}

// One-for-one look-alikes for characters that act on the raw PR body even inside a code block.
const INERT = { '<': '＜', '>': '＞', '@': '＠', '#': '＃' };

/**
 * Model notes as inert PR prose: a fenced code block (no markdown, links, images or autolinks), longer than any
 * backtick run in the notes. `<`/`>` (machine markers), `@` (mentions), `#`, `GH-` and `://` (issue references a
 * closing keyword could act on) become look-alikes, one character each, so the 16,000-character cap holds after.
 */
export function renderSelfReviewNotes(result) {
  if (!result?.notes?.length) return '';
  const safe = result.notes.join('\n').slice(0, 16000)
    .replace(/[^\P{Cc}\n]|\p{Cf}|\p{Zl}|\p{Zp}/gu, ' ')
    .replace(/[<>@#]/g, c => INERT[c])
    .replace(/\b(GH)-(?=\d)/gi, '$1‐').replace(/:\/\//g, ':／／');
  const fence = '`'.repeat(Math.max(3, ...[...safe.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `\n\nPre-review notes remaining after ${result.rounds} repair round(s):\n\n${fence}text\n${safe}\n${fence}\n`;
}
