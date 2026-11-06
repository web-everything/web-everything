/**
 * LIVE: #6418, #6414, #6193, #6345 — pending survives when the daemon declines a red team.
 * Replay the production skip runner with its refusal guards with injected evidence and IO.
 * No processes, network, or persisted run state; production modules always come from sourceRoot.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const RECOVERY = 'scripts/lib/review-red-team-on-skip.mjs';

export default {
  id: 'redteam-pending-label-never-settles',
  title: 'an open PR carrying red-team:pending that the daemon declines to dispatch a red team for never has the label settled',
  card: 'LIVE: #6418, #6414, #6193, #6345',
  fixedBy: { sha: 'pending', where: 'lane/redteam-pending-label-never-settles', paths: [RECOVERY] },
  fixPresent() {
    return true;
  },
  async run({ sourceRoot = ROOT } = {}) {
    const violations = [];
    const check = (ok, message) => { if (!ok) violations.push(message); };
    try {
      const load = path => import(pathToFileURL(join(sourceRoot, path)).href);
      let recovery;
      try { recovery = await load(RECOVERY); }
      catch (error) {
        violations.push(`recovery module import failed: ${error.message ?? error}`);
        return { violations };
      }
      const required = ['runRedTeamOnSkip'];
      check(required.every(name => typeof recovery[name] === 'function'), 'recovery module missing required replay exports');
      if (violations.length) return { violations };
      const { runRedTeamOnSkip } = recovery;
      const { renderRedTeamComment } = await load('scripts/operations/review-extra-seats.mjs');
      const { CONSTELLATION_REPOS } = await load('scripts/lib/constellation-repos.mjs');
      const repo = CONSTELLATION_REPOS.we.slug, pr = 6418;
      const head = 'a'.repeat(40), old = 'b'.repeat(40);
      const acceptedAt = Date.parse('2026-10-25T12:00:00Z');
      const trusted = body => ({ body, createdAt: new Date(acceptedAt).toISOString(), author: { login: 'web-everything' } });
      const accept = trusted(`✅ review — accepted\n<!-- reviewed-sha: ${head} -->`);
      const payload = (verdict = 'accept') => ({ verdict: { verdict, humanRequired: false },
        findings: { read: { netBasis: { rev: head } } } });
      const evidence = over => ({ loopPayload: payload(), inFlight: false, queued: false,
        recorded: false, seatRecorded: false, ...over });
      const unfinished = { ok: false, reason: 'review-unfinished' };
      const replay = (name, over = {}) => {
        const calls = { pending: [], sync: [], escalate: [], dispatch: [], settle: [] };
        const raw = { number: pr, state: 'OPEN', headRefOid: head,
          labels: ['review:accepted', 'red-team:pending'], comments: [accept], reviews: [], ...over.raw };
        const out = runRedTeamOnSkip({ repo, env: {},
          plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }] }, rawPrs: [raw],
          setting: { enabled: true, retryCooldownMin: 30 }, now: () => acceptedAt + 10_000,
          lastDispatch: new Map(), capacity: { lanes: 1, budget: { left: 1 }, remainingStarts: 1 },
          readEvidence: over.readEvidence ?? (() => evidence()), readStatus: () => over.status ?? null,
          headNeverReviewed: over.headNeverReviewed ?? (() => false),
          readWitness: null, readCarry: () => null, readReviews: () => [], readComments: () => raw.comments,
          provider: { readPrState: () => raw, setLabels: () => { throw Error('unexpected direct label write'); } },
          proveMove: () => ({ ok: false }),
          settlePending: key => {
            calls.pending.push(key);
            raw.labels = raw.labels.filter(label => !key.remove.includes(label));
          },
          syncLabels: key => calls.sync.push(key), escalate: key => calls.escalate.push(key),
          dispatch: key => { calls.dispatch.push(key); return { jobPid: 42 }; },
          settle: key => { calls.settle.push(key); return { outcome: 'policy-clear' }; },
          abandon: () => { throw Error('unexpected stale recovery'); },
          log: () => {},
        });
        const row = out.rows?.[0];
        check(row != null, `${name}: runner produced no decision`);
        check(!row?.settleError, `${name}: settlement failed: ${row?.settleError}`);
        return { name, raw, row, calls };
      };
      const effects = (f, expected) => {
        for (const [kind, calls] of Object.entries(f.calls)) {
          check(calls.length === (expected[kind] ?? 0), `${f.name}: unexpected ${kind} count ${calls.length}`);
          for (const call of calls) check(call.repo === repo && call.pr === pr,
            `${f.name}: ${kind} targeted the wrong PR`);
        }
        for (const call of f.calls.pending) check(call.head === head
          && JSON.stringify(call.remove) === '["red-team:pending"]', `${f.name}: removed more than pending`);
      };
      const notOwed = replay('unaccepted stored review does not owe', {
        raw: { labels: ['red-team:pending', 'keep-me'], comments: [] },
        readEvidence: () => evidence({ loopPayload: payload('needs-human'), status: { status: 'finished', result: 'not-owed' } }),
        status: { status: 'finished', result: 'not-owed' },
      });
      effects(notOwed, { escalate: 1 });
      check(notOwed.row?.action === 'skip' && notOwed.row?.escalate === true && !notOwed.row?.settle
        && JSON.stringify(notOwed.raw.labels) === '["red-team:pending","keep-me"]',
        'unaccepted not-owed review lost its pending hold instead of escalating');

      const acceptedClear = replay('accepted exact-head not-owed review legitimately clears', {
        readEvidence: () => evidence({ status: { status: 'finished', result: 'not-owed' } }),
        status: { status: 'finished', result: 'not-owed' },
      });
      effects(acceptedClear, { settle: 1, sync: 1 });
      check(acceptedClear.row?.action === 'clear' && acceptedClear.calls.settle[0]?.accepted === true
        && acceptedClear.calls.settle[0]?.head === head
        && acceptedClear.calls.settle[0]?.comments?.[0] === accept,
        'accepted exact-head not-owed review did not publish its legitimate policy-clear');

      const result = trusted(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'soak',
        findings: [], foldedVerdict: 'accept' }));
      const posted = replay('result already on head', { raw: { comments: [accept, result] },
        readEvidence: () => evidence({ recorded: true, status: { status: 'finished',
          result: { status: 'ran', comment: 'posted', foldedVerdict: 'accept' } } }),
      });
      effects(posted, { escalate: 1 });
      check(posted.row?.action === 'skip' && posted.row?.why === 'red-team result already on head'
        && posted.row?.escalate === true && !posted.row?.settle
        && posted.row?.escalationContext === 'red-team result already on head but red-team:pending is still set; the drain/job label sync did not settle it'
        && posted.raw.labels.includes('red-team:pending'), 'posted result changed labels instead of escalating its pending hold');

      const needsReview = () => evidence({ loopPayload: undefined });
      const selfBlock = replay('pending self-block on head needing review', { readEvidence: needsReview });
      effects(selfBlock, { dispatch: 1 });
      check(selfBlock.row?.action === 'review' && !selfBlock.row?.escalate && !selfBlock.row?.settle
        && selfBlock.raw.labels.includes('red-team:pending'), 'R640 full review failed or lost its merge hold');
      const next = replay('self-block next tick', { raw: selfBlock.raw, readEvidence: needsReview });
      effects(next, { dispatch: 1 });
      check(next.row?.action === 'review' && next.raw.labels.includes('red-team:pending'),
        'R640 next tick failed to review or removed pending');
      const conflict = replay('real blocked conflict', { raw: { labels: ['review:accepted', 'red-team:pending', 'red-team:blocked'] },
        readEvidence: needsReview });
      effects(conflict, { escalate: 1 });
      check(conflict.row?.escalate === true && conflict.raw.labels.length === 3, 'real conflict was removed instead of escalated');

      const neverReviewed = replay('R640 unfinished other-head review allows full review', {
        readEvidence: () => unfinished, headNeverReviewed: () => true,
      });
      effects(neverReviewed, { dispatch: 1 });
      check(neverReviewed.row?.action === 'review'
        && neverReviewed.row?.why === 'head never reviewed; a review is always allowed'
        && !neverReviewed.calls.dispatch[0]?.redTeamOnly
        && neverReviewed.raw.labels.includes('red-team:pending'), 'never-reviewed head failed full review or changed pending');

      const held = replay('review-unfinished escalates, never dispatches', { readEvidence: () => unfinished });
      effects(held, { escalate: 1 });
      check(held.row?.action === 'skip' && held.row?.why === 'review-unfinished' && held.row?.escalate === true
        && held.row?.escalationContext === 'review-unfinished: an unfinished review run holds this head; a human must answer or cancel the pending confirmation'
        && held.raw.labels.includes('red-team:pending'), 'unfinished review lost its hold or was not escalated');

      for (const [name, options, why] of [
        ['owed review in flight', { readEvidence: () => evidence({ inFlight: true }) }, 'red-team pass in flight'],
        ['unreadable comments', { raw: { comments: undefined } }, 'PR comments unreadable'],
        ['confirmed break', { readEvidence: () => evidence({ recorded: true, seatRecorded: true,
          completedRecorded: true }), status: { status: 'finished', result: { status: 'ran', comment: 'posted',
          foldedVerdict: 'changes', findings: [{ summary: 'confirmed break', confirmedByRecheck: true }] } } },
        'result posted; comment not visible yet'],
        ['newer unfinished review', { readEvidence: () => unfinished }, 'review-unfinished'],
      ]) {
        const control = replay(name, options);
        effects(control, name === 'newer unfinished review' ? { escalate: 1 } : {});
        check(control.row?.action === 'skip' && control.row?.why === why, `${name}: closed path did not retain its hold`);
      }
    } catch (error) { violations.push(`scenario failed: ${error.stack ?? error}`); }
    return { violations };
  },
  judge: report => report.violations,
};
