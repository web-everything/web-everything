/** Pure port of ship/change-evidence v0.1 tools/build-fixture.mjs build().
 * Comments/events retain forge thread order; required checks use the highest run id.
 * No IO and no gate decisions: missing evidence is an explicit unknown verdict.
 */
import { createHash } from 'node:crypto';
import { isTrustedMarkerAuthor } from '../marker-authorship.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TIER = { asserted: 0, replayed: 1, probe: 2 };
const EVALUATOR = 'https://everstandards.dev/ship/tools/change-evidence-build';
const actorOf = login => login.startsWith('app/') || login.endsWith('[bot]')
  ? { id: `https://github.com/apps/${login.replace(/^app\//, '').replace(/\[bot\]$/, '')}`, kind: 'bot', native: login }
  : { id: `https://github.com/${login}`, kind: 'person', native: login };
const evidenceKey = e => JSON.stringify([e.kind, e.uri ?? null, e.digest]);
function fold(clauses) {
  const req = clauses.filter(c => c.required);
  const failed = req.find(c => c.verdict.verdict === 'fail');
  if (failed) return { verdict: 'fail', from: failed.clause };
  const open = req.find(c => c.verdict.verdict !== 'pass');
  return open ? { verdict: 'unknown', reason: open.verdict.reason ?? 'inconclusive', from: open.clause }
    : req.length ? { verdict: 'pass' } : { verdict: 'unknown', reason: 'missing' };
}
export function buildChangeEvidence({ pr, events, comments, mergeCommit: mc, commits, checkRuns: runs,
  config, configBytes, recordedAt: AT, recorder: BUILDER }) {
  const mergeSha = pr.mergeCommit.oid;
  if (!/^[0-9a-f]{40}$/.test(mergeSha) || mc.sha !== mergeSha || !mc.commit?.tree?.sha || !mc.parents?.[0]?.sha)
    throw Error('forge did not verify the landed commit');
  if (JSON.stringify(JSON.parse(String(configBytes))) !== JSON.stringify(config)) throw Error('policy bytes differ from config');
  const cfgDigest = { sha256: sha256(configBytes) };
  const REPO = pr.url.split('/pull/')[0];
  const policy = { uri: `${config.id}#merge-policy`, digest: cfgDigest };
  const author = actorOf(pr.author.login), head = pr.headRefOid, at = pr.mergedAt;
  const base = (kind, ev) => ({ policy, evaluatedAt: AT, evaluator: EVALUATOR, ...ev });
  const tierOf = (k) => config.tiers[k] ?? 'asserted';

  // tested: the ruleset's required checks, on the commit that landed (merge-queue run)
  const tc = config.clauses.tested, tEv = [], missing = [], bad = [], off = [];
  for (const name of tc.requiredChecks) {
    const r = runs.filter((x) => x.name === name).sort((a, b) => b.id - a.id)[0];
    if (!r || r.status !== 'completed') { missing.push(name); continue; }
    tEv.push({ kind: 'ci-check', uri: r.html_url, digest: { gitCommit: r.head_sha }, provenanceTier: tierOf('ci-check'), native: { name, id: r.id, conclusion: r.conclusion, at: r.completed_at, app: r.app?.slug } });
    if (r.conclusion !== 'success') bad.push(`${name}=${r.conclusion}`); if (r.head_sha !== mergeSha) off.push(name);
  }
  const tested = bad.length ? base('tested', { verdict: 'fail', detail: bad.join(', ') }) : missing.length ? base('tested', { verdict: 'unknown', reason: 'missing', detail: `no run for ${missing}` }) : off.length ? base('tested', { verdict: 'unknown', reason: 'stale', detail: `ran on another commit: ${off}` }) : base('tested', { verdict: 'pass' });
  tested.examined = { count: tEv.length, unit: 'required checks', description: `required_status_checks of the main ruleset, latest completed run on ${mergeSha}` }; tested.evidence = tEv;

  // reviewed: the review loop's accepted verdict (sha from the approval marker posted with it) and drain re-stamps
  const rEv = [];
  for (const c of comments) {
    if (c.user.login === 'plateau-reviewer[bot]' && /^✅ review — accepted/.test(c.body)) {
      const mark = comments.find((d) => d.user.login === 'plateau-reviewer[bot]' && /approval-prevention-filed:([0-9a-f]{40})/.test(d.body) && Math.abs(Date.parse(d.created_at) - Date.parse(c.created_at)) < 5 * 60e3);
      const sha = mark && /approval-prevention-filed:([0-9a-f]{40})/.exec(mark.body)[1];
      if (sha) rEv.push({ kind: 'review-verdict', uri: c.html_url, digest: { gitCommit: sha }, provenanceTier: tierOf('review-verdict'), native: { actor: actorOf(c.user.login).id, at: c.created_at, commentId: c.id, bodySha256: sha256(c.body), shaSource: `approval-prevention-filed marker in comment ${mark.id}` } });
    }
    const re = /reviewed-sha: ([0-9a-f]{40})/.exec(c.body);
    // The historical drain App is a pinned producer in the standard's fixture;
    // current house/operator principals additionally use the shared marker policy.
    const trustedRestamp = c.user.login === 'plateau-merger[bot]' || isTrustedMarkerAuthor({ ...c, viewerDidAuthor: false });
    if (re && trustedRestamp && /re-stamped/.test(c.body)) rEv.push({ kind: 'review-restamp', uri: c.html_url, digest: { gitCommit: re[1] }, provenanceTier: tierOf('review-restamp'), native: { actor: actorOf(c.user.login).id, at: c.created_at, commentId: c.id, bodySha256: sha256(c.body), reviewedDiff: /reviewed-diff: ([0-9a-f]+)/.exec(c.body)?.[1] } });
  }
  const rc = config.clauses.reviewed, rOk = rEv.filter((e) => rc.acceptKinds.includes(e.kind) && TIER[e.provenanceTier] >= TIER[rc.minTier]);
  const reviewed = rOk.some((e) => e.digest.gitCommit === head) ? base('reviewed', { verdict: 'pass' })
    : rEv.length ? base('reviewed', { verdict: 'unknown', reason: 'stale', detail: `accepted review covers ${[...new Set(rOk.map((e) => e.digest.gitCommit.slice(0, 12)))]}, head is ${head.slice(0, 12)}` })
    : base('reviewed', { verdict: 'unknown', reason: 'missing' });
  reviewed.examined = { count: rEv.length, unit: 'review records', description: 'review-loop comments: accepted verdicts and re-stamps' }; reviewed.evidence = rEv;

  // approved: review:accepted label events by a listed approver, not the author, not removed before merge
  const ac = config.clauses.approved, aEv = [];
  const headAt = (t) => commits.filter((c) => Date.parse(c.commit.committer.date) <= Date.parse(t)).map((c) => c.sha).at(-1) ?? pr.commits[0].oid;
  for (const e of events.filter((x) => x.event === 'labeled' && x.label?.name === 'review:accepted' && ac.approvers.includes(actorOf(x.actor.login).id))) {
    const removed = events.some((x) => x.event === 'unlabeled' && x.label?.name === 'review:accepted' && Date.parse(x.created_at) > Date.parse(e.created_at) && Date.parse(x.created_at) <= Date.parse(at));
    aEv.push({ kind: 'approval-label', uri: `${pr.url}#event-${e.id}`, digest: { gitCommit: headAt(e.created_at) }, provenanceTier: tierOf('approval-label'), native: { actor: actorOf(e.actor.login).id, label: e.label.name, at: e.created_at, eventId: e.id, presentAtMerge: !removed } });
  }
  const aOk = aEv.filter((e) => e.native.presentAtMerge && ac.approvers.includes(e.native.actor) && (!ac.separationOfDuties || e.native.actor !== author.id));
  const approved = aOk.length ? base('approved', { verdict: 'pass' }) : aEv.length ? base('approved', { verdict: 'fail', detail: 'review:accepted not by a listed approver other than the author, or removed before merge' }) : base('approved', { verdict: 'unknown', reason: 'missing' });
  approved.examined = { count: aEv.length, unit: 'label events', description: 'review:accepted label events on the PR timeline' }; approved.evidence = aEv;

  const order = (o) => { const { verdict, reason, owedBy, attempted, policy: p, evaluatedAt, evaluator, examined, evidence, detail } = o; return Object.fromEntries(Object.entries({ verdict, reason, owedBy, attempted, policy: p, evaluatedAt, evaluator, examined, evidence, detail }).filter(([, v]) => v !== undefined)); };
  const clauses = [['tested', tested], ['reviewed', reviewed], ['approved', approved]].map(([id, v]) => ({ clause: id, required: config.clauses[id].required, verdict: order(v) }));
  const f = fold(clauses), seen = new Set(), union = [];
  for (const e of clauses.flatMap((c) => c.verdict.evidence)) if (!seen.has(evidenceKey(e))) { seen.add(evidenceKey(e)); union.push(e); }
  const overall = order({ verdict: f.verdict, ...(f.reason ? { reason: f.reason } : {}), policy, evaluatedAt: AT, evaluator: EVALUATOR, examined: { count: clauses.length, unit: 'clauses' }, evidence: union, ...(f.from ? { detail: `decided by clause ${f.from}` } : {}) });

  const ai = [];
  for (const c of commits) {
    const sess = /^Claude-Session: (\S+)/m.exec(c.commit.message)?.[1];
    for (const m of c.commit.message.matchAll(/^Co-Authored-By: (.+)$/gmi)) if (/claude|codex|gemini|gpt|copilot/i.test(m[1])) ai.push({ commit: { gitCommit: c.sha }, agent: m[1].trim(), role: 'co-author', ...(sess ? { session: sess } : {}), provenanceTier: 'asserted', source: 'commit-trailer' });
  }
  const rec = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `git+${REPO}@refs/heads/${pr.baseRefName}`, uri: `${REPO}/commit/${mergeSha}`, digest: { gitCommit: mergeSha, gitTree: mc.commit.tree.sha } }],
    predicateType: 'https://everstandards.dev/ship/change-evidence/v0.1',
    predicate: {
      id: `tag:everstandards.dev,${AT.slice(0, 10)}:evidence/ship-change/${new URL(REPO).host}${new URL(REPO).pathname}/pull/${pr.number}-${mergeSha}`,
      recordedAt: AT, recorder: BUILDER,
      change: {
        nativeId: pr.url, number: pr.number, title: pr.title, repository: REPO, author,
        base: { ref: `refs/heads/${pr.baseRefName}`, digest: { gitCommit: mc.parents[0].sha } },
        head: { ref: `refs/heads/${pr.headRefName}`, digest: { gitCommit: head } },
        merged: { at, by: actorOf(pr.mergedBy.login), method: events.slice(0, events.findIndex(e => e.event === 'merged' && e.commit_id === mergeSha) + 1).filter(e => ['added_to_merge_queue', 'removed_from_merge_queue'].includes(e.event)).at(-1)?.event === 'added_to_merge_queue' ? 'merge-queue' : 'merge', ref: `refs/heads/${pr.baseRefName}`, digest: { gitCommit: mergeSha } },
      },
      governance: { org: config.org, config: config.id, version: config.version, digest: cfgDigest, ...(config.sources ? { sources: config.sources.map(({ uri, digest }) => ({ uri, digest })) } : {}) },
      verdict: overall, clauses, ...(ai.length ? { aiProvenance: ai } : {}),
    },
  };

  return rec;
}
