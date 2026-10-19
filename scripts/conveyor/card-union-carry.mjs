#!/usr/bin/env node
/** One-time relaxation #10 audit. Pending acceptance restoration is intentionally blocked by the writer. */
import { pathToFileURL } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { latestAcceptRecord, resolveAcceptCarryForward } from '../lib/accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs';
import { proveCardUnionOnly, resolveCardUnionCarrySetting } from '../lib/card-union-carry.mjs';

export const PENDING_RESTAMP_REFUSAL = 'no review:accepted label — there is no acceptance to carry across the rebase';
const rearmed = comment => isTrustedMarkerAuthor(comment) && /^\s*🔧 conveyor fix — re-armed for re-review/.test(comment.body ?? '');

/** Audit only: never adds review:accepted to a pending PR. --apply cannot bypass the writer's refusal. */
export function auditCardUnionCarry({ repo, prs, provider, prove = proveCardUnionOnly,
  setting = resolveCardUnionCarrySetting(), acceptCarryForward = resolveAcceptCarryForward(), write = line => process.stdout.write(`${line}\n`), cwd, apply = false } = {}) {
  let candidates = 0;
  let pending = 0;
  for (const pr of prs) {
    const labels = pr.labels.map(label => label.name ?? label);
    if (!labels.includes('review:pending')) continue;
    pending++;
    let reason;
    try {
      if (!isCardOnlyDiff(provider.readPrFiles(repo, pr.number))) {
        reason = 'not card-only (relaxation #10 covers card-only PRs)';
      } else {
        candidates++;
        if (pr.mergeable !== 'MERGEABLE') reason = `not currently mergeable (${pr.mergeable})`;
        else {
          const comments = provider.readComments(repo, pr.number);
          const reviews = provider.readPrReviews(repo, pr.number);
          if (!Array.isArray(comments) || !Array.isArray(reviews)) throw Error('thread or reviews unreadable');
          const record = latestAcceptRecord(comments, reviews);
          const later = record && comments.slice(record.index + 1);
          const rearm = later?.find(rearmed);
          // Exclude only the re-arm being audited; every other standing objection still wins.
          const standing = latestAcceptRecord(comments.filter(c => !rearmed(c)), reviews);
          if (!record || !rearm || !Number.isFinite(Date.parse(record.at)) || !Number.isFinite(Date.parse(rearm.createdAt)) || Date.parse(record.at) >= Date.parse(rearm.createdAt)) reason = 'no trusted acceptance older than re-arm';
          else if (labels.some(l => ['review:human', 'review:changes', 'review:held-mechanical'].includes(l))
            || standing?.laterVerdict || standing?.laterBodyDerivedHold || standing?.reviewsUnreadable) reason = 'later verdict or hold; acceptance cannot carry';
          else if (!setting.value || acceptCarryForward.value !== 'on') reason = `carry requires carryAcceptanceOnUnion=true and acceptCarryForward=on (carryAcceptanceOnUnion=${setting.value}; acceptCarryForward=${acceptCarryForward.value})`;
          else {
            const proof = prove({ acceptedHead: record.sha, newHead: pr.headRefOid, mainRef: 'origin/main', cwd });
            reason = proof.ok ? `${PENDING_RESTAMP_REFUSAL}; proof passes; ${apply ? '--apply blocked' : 'dry-run'}` : proof.reason;
          }
        }
      }
    } catch (error) { reason = `unreadable candidate: ${error.message}`; }
    write(`PR #${pr.number} REREVIEW ${String(reason).replace(/[\r\n]+/g, ' ')}`);
  }
  write(`TOTAL candidates=${candidates} pending=${pending} RESTAMP=0 REREVIEW=${candidates}`);
  return { candidates, restamp: 0, rereview: candidates };
}

export function main(argv = process.argv.slice(2)) {
  const repoFlag = argv.indexOf('--repo');
  const repo = argv.find(arg => arg.startsWith('--repo='))?.slice(7) ?? (repoFlag >= 0 ? argv[repoFlag + 1] : undefined);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw Error('requires --repo=owner/name');
  if (argv.some((arg, index) => !(repoFlag >= 0 && index === repoFlag + 1) && arg !== '--repo' && !arg.startsWith('--repo=') && !['--apply', '--dry-run', 'dry-run'].includes(arg))) throw Error('unknown argument');
  const prs = JSON.parse(execFileSyncThrottled('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '10000',
    '--json', 'number,labels,mergeable,headRefOid'], { encoding: 'utf8' }));
  if (prs.length >= 10000) throw Error('open PR list may be truncated');
  const setting = resolveCardUnionCarrySetting();
  console.error(`card-union-carry · cardConflicts.carryAcceptanceOnUnion=${setting.value} (source: ${setting.source}); pending restoration blocked: ${PENDING_RESTAMP_REFUSAL}`);
  return auditCardUnionCarry({ repo, prs, provider: createGhProvider(), setting, apply: argv.includes('--apply') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
