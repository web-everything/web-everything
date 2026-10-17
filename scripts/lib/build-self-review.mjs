/** Bounded pre-review check. No publication and no GitHub calls. */
import { fenceUntrusted, FENCED_DATA_RULE } from './mandate-fence.mjs';

export async function selfReviewPrompt(diff) {
  const { buildMandate } = await import('./review-core.mjs');
  return ['Review the net diff once for correctness and security. Report only concrete blocking defects.',
    buildMandate({ mandate: 'correctness', fenced: true }), buildMandate({ mandate: 'security', fenced: true }),
    'Return ONLY JSON: {"findings":["file:line — defect, evidence and required correction"]}. Use an empty array when clear.',
    FENCED_DATA_RULE, fenceUntrusted('material', diff)].join('\n\n');
}

export async function reviewBuildDiff({ dir, diff, env = process.env }) {
  if (typeof diff !== 'string' || Buffer.byteLength(diff) > 512 * 1024) throw new Error('self-review net diff is unavailable or too large');
  if (!diff.trim()) return [];
  const { codexDirectTask } = await import('../codex-direct-task.mjs');
  const report = await codexDirectTask({ dir, task: await selfReviewPrompt(diff), review: true, gate: 'none',
    taskKind: 'review', effort: 'low', ephemeral: true, stream: false, env });
  if (report.exitCode !== 0 || report.timedOut) throw new Error('self-review process failed');
  const parsed = JSON.parse(report.lastMessage);
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
    catch { throw new Error('self-review unavailable: review failed or returned invalid findings'); }
    if (!Array.isArray(notes) || notes.some(n => typeof n !== 'string')) throw new Error('invalid self-review notes');
    if (!notes.length || rounds === cap) return { rounds, notes, capped: notes.length > 0 };
    await fix(selfReviewRepairPrompt(notes), rounds + 1);
    if (!await gate()) throw new Error('self-review repair gate is red');
  }
}

/** Quote model notes for PR prose; no model-authored markers, terminal controls or mentions. */
export function renderSelfReviewNotes(result) {
  if (!result?.notes?.length) return '';
  const safe = result.notes.join('\n').slice(0, 16000).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/[<>&@`]/g, c => `&#${c.charCodeAt(0)};`);
  return `\n\nPre-review notes remaining after ${result.rounds} repair round(s):\n\n> ${safe}\n`;
}
