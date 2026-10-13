/**
 * Seed smell 11 / #4066 — stood-down PRs piling up. A stand-down is the fix agent (or a watch) deliberately
 * stopping to ask a person: the PR is terminal for the reconciler until someone clears it. One or two is the
 * mechanism working; `minStoodDown` (5) open in one repo on 2026-09-24 was a queue of human decisions nobody was
 * reading, each holding a PR (and often a lane) indefinitely.
 *
 * "Stood down" is exactly what the operator queue's STOOD DOWN section counts (`standDownComments`, trusted-author
 * leading-line markers, concurrent-author pauses excluded — `we:scripts/conveyor/stand-down.mjs`), or the
 * `review-status:stood-down` label. Alert-only: the fix for each PR is a human judgment, and the aggregate fix
 * is someone reading the queue.
 */
import { standDownComments, standDownReason, STAND_DOWN_LABEL } from '../stand-down.mjs';
import { fmtAge } from '../health-watch-core.mjs';

const hasLabel = (pr, name) => (pr?.labels || []).some((l) => (typeof l === 'string' ? l : l?.name) === name);

/** PURE: `{standDownAt, reason}` for a stood-down PR, or null when it is not stood down. */
export function standDownOf(pr) {
  const matches = standDownComments(pr?.comments, { headRefOid: pr?.headRefOid });
  const raw = standDownComments(Array.isArray(pr?.comments)
    ? pr.comments.map((c) => c?.standDownLapsed ? { ...c, standDownLapsed: undefined } : c) : []);
  // All recorded holds lapsed; the remaining label is stale.
  if (!matches.length && raw.length) return null;
  if (!matches.length && !hasLabel(pr, STAND_DOWN_LABEL)) return null;
  const latest = matches.map((c) => ({ ...c, t: Date.parse(c.createdAt) || 0 })).sort((a, b) => b.t - a.t)[0];
  return { standDownAt: latest?.t || null, reason: latest ? standDownReason(latest.body) : null };
}

export default {
  id: 'stood-down-prs',
  scope: 'repo',
  cadence: 'gh',
  probes: ['prs'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'medium',
  action: 'alert',
  minStoodDown: 5,
  recommendationHint: 'Stood-down PRs are accumulating — each is waiting on a human decision.',
  evaluate({ prs }, { now }) {
    const byRepo = new Map();
    for (const pr of prs || []) {
      const sd = standDownOf(pr);
      if (!sd) continue;
      if (!byRepo.has(pr.repo)) byRepo.set(pr.repo, []);
      byRepo.get(pr.repo).push({ number: pr.number, ...sd });
    }
    const out = [];
    for (const [repo, list] of byRepo) {
      list.sort((a, b) => (a.standDownAt ?? Infinity) - (b.standDownAt ?? Infinity));
      const breach = list.length >= this.minStoodDown;
      const oldest = list[0];
      const rows = list.slice(0, 8).map((p) => `#${p.number}${p.standDownAt ? ` (${fmtAge(now - p.standDownAt)})` : ''}${p.reason ? ` — ${p.reason}` : ''}`);
      out.push({
        subject: repo,
        breach,
        measure: {
          repo, stoodDown: list.length, minStoodDown: this.minStoodDown,
          oldestAgeMs: oldest?.standDownAt ? now - oldest.standDownAt : null,
          prs: list.map((p) => ({ number: p.number, standDownAt: p.standDownAt ? new Date(p.standDownAt).toISOString() : null, reason: p.reason })),
        },
        summary: `${list.length} stood-down PR(s) open in ${repo}: ${rows.join('; ')}${list.length > rows.length ? '; …' : ''}.`,
        recommendation: breach
          ? `${list.length} PRs in ${repo} are waiting on a human decision, oldest first: ${rows.slice(0, 3).join('; ')}. `
            + 'Read the STOOD DOWN section of `node scripts/operations/operator-queue.mjs` and clear or close each one; '
            + 'if most share one reason, that reason is the product fix.'
          : 'ok',
      });
    }
    return out;
  },
};
