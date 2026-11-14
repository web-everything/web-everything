import { parseRedTeamComment, readRedTeamDisposition, redTeamResultCommentForHead, readRedTeamProbes } from './red-team-gate.mjs';
import { RED_TEAM_STATUS_LABEL_META, RED_TEAM_STATUS_LABELS } from './red-team-status-labels.mjs';
import { createGhProvider } from './review-label-provider.mjs';
import { readStoredRedTeamStatus } from './red-team-sealed-status.mjs';
import { publishStoredRedTeamResult } from './red-team-withheld-publish.mjs';
import { readRedTeamResult, strictPostedResult, SEAL_SCHEMA } from './red-team-result-schema.mjs';

/** Proof the head moved: a trusted red-team result of this PR for a different full head sha. */
function olderHeadResult(comments, pr, head) {
  const live = String(head).toLowerCase();
  return (Array.isArray(comments) ? comments : []).some(c => {
    const parsed = parseRedTeamComment(c?.body);
    const rev = String(parsed?.rev ?? '').toLowerCase();
    // Only a TRUSTED result record for that older head counts (the shared reader checks authorship).
    return parsed && Number(parsed.pr) === Number(pr) && /^[0-9a-f]{40}$/.test(rev) && rev !== live
      && redTeamResultCommentForHead(comments, pr, rev) !== null;
  });
}

/** Re-read the live head right before the write: a head that moved after the writer's own check must not be labelled. */
export function headGuardedProvider(provider, head, beforeWrite = () => {}) {
  return { ...provider,
    readPrState: (...a) => provider.readPrState(...a), readComments: (...a) => provider.readComments(...a),
    ensureLabel: (...a) => provider.ensureLabel(...a),
    setLabels: (repo, pr, change) => {
      beforeWrite();
      // The head is read LAST, with no other IO between it and the write.
      if (provider.readPrState(repo, pr)?.headRefOid !== head) throw Error('head moved before label write');
      return provider.setLabels(repo, pr, change);
    } };
}

/** Reconcile result labels from fresh, head-bound evidence. */
export function syncResultOnHeadLabels({ repo, rawPrs = [],
  env = process.env, log = () => {}, provider = null, sync, readStatus = readStoredRedTeamStatus,
  readResult = readRedTeamResult, sealStored = publishStoredRedTeamResult } = {}) {
  let updated = rawPrs;
  const applied = [], errors = [];
  const labelName = label => typeof label === 'string' ? label : label?.name;
  if (!readRedTeamProbes({ env, log }).value.statusLabels) return { rawPrs: updated, applied, errors };
  let writes = 0;
  for (const [index, row] of rawPrs.entries()) {
    const pr = Number(row?.number), head = row?.headRefOid;
    if (!Number.isSafeInteger(pr) || pr <= 0 || typeof head !== 'string'
      || !/^[0-9a-fA-F]{40}$/.test(head)) continue;
    if (!Array.isArray(row.labels) || (row.state && row.state !== 'OPEN')) continue;
    const held = row.labels.some(l => ['red-team:pending', 'red-team:blocked'].includes(labelName(l)));
    // Slice 1 only settles an existing hold label; it never adds one to, or demotes, an unheld PR (other paths own those).
    if (!held) continue;
    try {
      const key = { repo, pr, head, env: { ...process.env, ...env } };
      const live = provider ? provider.readPrState(repo, pr) : row;
      if (live?.headRefOid !== head || !Array.isArray(live.labels)) throw Error('live head or labels unreadable');
      const comments = provider ? provider.readComments(repo, pr) : row.comments;
      let status = readStatus(key);
      if (status?.result === 'ran' && status?.seal?.schema !== SEAL_SCHEMA) {
        const sealed = sealStored({ status: { repo, pr, head }, sealOnly: true,
          listComments: () => comments,
          postComment: () => { throw Error('seal-only never posts'); } });
        if (!['sealed', 'skipped'].includes(sealed?.status)) throw Error('red-team seal failed; retry next tick');
        status = readStatus(key);
      }
      const evaluate = (status, comments) => {
        const disposition = strictPostedResult({ comments, pr, head }).ok
          ? readRedTeamDisposition({ comments, repo, pr, head, env: key.env }) : null;
        return readResult({ status, comments, repo, pr, head, disposition });
      };
      const result = evaluate(status, comments), names = live.labels.map(labelName);
      if (!['clear', 'blocked', 'pending'].includes(result?.outcome)) throw Error('result outcome unreadable');
      // A block is stale only on a moved head: no own or carried result comment AND no stored status (of any shape) for it.
      if (result.outcome === 'pending' && names.includes('red-team:blocked')
        && (status !== null || redTeamResultCommentForHead(comments, pr, head) || !olderHeadResult(comments, pr, head))) continue;
      const desired = `red-team:${result.outcome}`;
      const plan = { add: names.includes(desired) ? null : desired,
        remove: names.filter(n => RED_TEAM_STATUS_LABELS.includes(n) && n !== desired) };
      if (!plan.add && !plan.remove.length) continue;
      // Unchanged candidates consume no write budget, so later PRs make progress.
      if (++writes > 32) { log('red-team label write cap reached; retry remaining PRs next tick'); break; }
      const fingerprint = JSON.stringify(status), original = JSON.stringify(result);
      const writer = provider ?? createGhProvider();
      const guarded = headGuardedProvider(writer, head, () => {
        const fresh = readStatus(key), thread = writer.readComments(repo, pr);
        if (JSON.stringify(fresh) !== fingerprint || JSON.stringify(evaluate(fresh, thread)) !== original) throw Error('red-team evidence changed before label write');
      });
      if (sync) {
        const injected = { ...guarded, setLabels: (r, p, change) => {
          if (r !== repo || Number(p) !== pr || JSON.stringify(change) !== JSON.stringify(plan)) throw Error('writer disagrees with validated result');
          return guarded.setLabels(r, p, change);
        } };
        const written = sync({ repo, pr, head, env, log, provider: injected });
        if (written?.add !== plan.add || JSON.stringify(written?.remove) !== JSON.stringify(plan.remove)) throw Error('writer disagrees with validated result');
      } else {
        if (plan.add) guarded.ensureLabel(repo, plan.add, RED_TEAM_STATUS_LABEL_META[plan.add]);
        guarded.setLabels(repo, pr, plan);
      }
      const labels = row.labels.filter(label => !plan.remove.includes(labelName(label)));
      if (plan.add && !labels.some(label => labelName(label) === plan.add)) labels.push(plan.add);
      if (updated === rawPrs) updated = rawPrs.slice();
      updated[index] = { ...row, labels };
      applied.push({ pr, head, ...plan });
    } catch (error) {
      errors.push({ pr, head, error });
      log(`red-team result label sync failed for PR #${pr}; retry next tick`);
    }
  }
  return { rawPrs: updated, applied, errors };
}
