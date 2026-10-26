/** Shared dispatch-only referral filter; the hold writer re-exports this API. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { sameRepo, parseOperatorRulingComment, readReferralRecords } from '../lib/jury-core.mjs';
import { resolveReferralSafetySettings } from '../lib/review-settings.mjs';
import { parseLatestHumanClearedSha } from '../lib/review-escalation.mjs';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function filterFixerReferrals(pr, findings, { repo,
  cardReadable = ref => referralCardReadable(ref, REPO_ROOT),
  safety = resolveReferralSafetySettings(), log = line => console.error(line),
} = {}) {
  if (safety.value.noFixerOnClearedRuled !== true || !findings?.length) return findings;
  try {
    const read = readReferralRecords(pr.comments, { head: pr.headRefOid });
    if (read.malformed || !repo || !sha(pr.headRefOid)) return findings;
    const operators = [];
    for (const comment of pr.comments ?? []) {
      const parsed = parseOperatorRulingComment(comment);
      if (parsed?.malformed) return findings;
      const r = parsed?.record;
      if (!r || r.actor.toLowerCase() === 'auto-policy') continue;
      for (const x of r.rulings) operators.push({ ...x, repo: r.repo, pr: r.pr, at: r.at });
    }
    const cleared = parseLatestHumanClearedSha(pr.comments) === pr.headRefOid;
    const kept = findings.filter(f => {
      const records = read.records.filter(r => r.repo === repo && r.pr === Number(pr.number)
        && r.head === pr.headRefOid && (!f.runId || f.runId === r.runId)
        && r.referrals.some(x => x.key === f.key));
      if (!records.length) return true;
      return !records.every(r => {
        const latest = operators.filter(o => sameRepo(o.repo, repo) && o.pr === Number(pr.number)
          && o.runId === r.runId && o.key === f.key)
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
        if (latest) return cleared && (latest.result === 'not-real' || (latest.result === 'card' && cardReadable(latest.card)));
        // Open reviewer/policy blocks and unruled findings still need a fixer, even on a cleared head.
        return false;
      });
    });
    if (kept.length < findings.length) log(`review.noFixerOnClearedRuled=true (source: ${safety.sources.noFixerOnClearedRuled}) — ${repo}#${pr.number}: suppressed ${findings.length - kept.length} fixer referral(s)`);
    return kept;
  } catch { return findings; }
}
