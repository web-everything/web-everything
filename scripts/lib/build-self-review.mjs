/** Bounded pre-review check. No publication and no GitHub calls. */
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';

export const SELF_REVIEW_MAX_DIFF_BYTES = 512 * 1024;
const TOO_LARGE = 'Self-review incomplete: net diff exceeds the 512 KiB limit. No review verdict was obtained for this diff; human review of the full diff is required.';
class SelfReviewDiffTooLargeError extends Error {}

/**
 * git argv prefix for reading a builder's diff in the caller's own process. The builder can write the lane's
 * `.git/config` and `.gitattributes`, so external diff drivers, textconv filters and fsmonitor stay off.
 */
export const SELF_REVIEW_DIFF_ARGS = ['-c', 'core.fsmonitor=false', '--no-replace-objects', 'diff', '--no-ext-diff', '--no-textconv', '--no-color'];

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

/** One verdict object: bare, inside one fenced block, or after a lead-in sentence. Anything else is invalid. */
export function parseSelfReviewVerdict(message) {
  const text = String(message ?? '').trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(text);
  const body = fenced ? fenced[1].trim() : text.slice(text.indexOf('{'));
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'findings') {
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

/**
 * Quote model notes for PR prose as inert text: no model-authored markers, terminal controls, mentions,
 * issue references (closing keywords act on them), links or images. Every line stays inside the quote.
 */
export function renderSelfReviewNotes(result) {
  if (!result?.notes?.length) return '';
  const safe = result.notes.join('\n').slice(0, 16000)
    .replace(/[^\P{Cc}\n]|\p{Cf}/gu, ' ')
    // References and mentions first: the entities below contain `#`.
    .replace(/@/g, '＠').replace(/#/g, '＃').replace(/\b(GH)-(?=\d)/gi, '$1‐')
    .replace(/[<>&`[\]!\\*_|]/g, c => `&#${c.charCodeAt(0)};`);
  return `\n\nPre-review notes remaining after ${result.rounds} repair round(s):\n\n${safe.split('\n').map(line => `> ${line}`).join('\n')}\n`;
}
