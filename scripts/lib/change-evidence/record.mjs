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
const checkProducer = run => run.app?.slug ? `https://github.com/apps/${run.app.slug}` : undefined;
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
  const tierOf = (k) => config.tiers[k];
  const producerAllowed = (clause, producer, defaults = []) => (clause.trustedProducers ?? defaults).includes(producer);
  const eligible = (clause, kind) => clause.acceptKinds.includes(kind)
    && Object.hasOwn(TIER, clause.minTier) && Object.hasOwn(TIER, tierOf(kind))
    && TIER[tierOf(kind)] >= TIER[clause.minTier];
  const beforeMerge = t => Number.isFinite(Date.parse(t)) && Date.parse(t) <= Date.parse(at);
  // Backfill must evaluate the merge-time snapshot, including comment edits.
  events = events.filter(e => beforeMerge(e.created_at));
  comments = comments.filter(c => beforeMerge(c.created_at) && (!c.updated_at || beforeMerge(c.updated_at)))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);


  // tested: the ruleset's required checks, on the commit that landed (merge-queue run)
  const tc = config.clauses.tested, tEv = [], missing = [], bad = [], off = [], unlisted = [];
  for (const name of tc.requiredChecks) {
    const candidates = runs.filter(x => x.name === name && beforeMerge(x.completed_at));
    const allowed = x => producerAllowed(tc, checkProducer(x), ['https://github.com/apps/github-actions']);
    if (candidates.some(x => checkProducer(x) && !allowed(x))) unlisted.push(name);
    const r = candidates.filter(allowed).sort((a, b) => b.id - a.id)[0];
    if (!r || r.status !== 'completed' || !eligible(tc, 'ci-check')) { missing.push(name); continue; }
    tEv.push({ kind: 'ci-check', uri: r.html_url, digest: { gitCommit: r.head_sha }, provenanceTier: tierOf('ci-check'), native: { producer: checkProducer(r), name, id: r.id, conclusion: r.conclusion, at: r.completed_at, app: r.app?.slug, appId: r.app?.id } });
    if (r.conclusion !== 'success') bad.push(`${name}=${r.conclusion}`); if (r.head_sha !== mergeSha) off.push(name);
  }
  const tested = bad.length ? base('tested', { verdict: 'fail', detail: bad.join(', ') }) : missing.length ? base('tested', { verdict: 'unknown', reason: !tEv.length && unlisted.length ? 'unverifiable' : 'missing', detail: `no run for ${missing}` }) : off.length ? base('tested', { verdict: 'unknown', reason: 'stale', detail: `ran on another commit: ${off}` }) : base('tested', { verdict: 'pass' });
  tested.examined = { count: tEv.length, unit: 'required checks', description: `required_status_checks of the main ruleset, latest completed run on ${mergeSha}` }; tested.evidence = tEv;

  // Legacy review comments bind the acceptance's own SHA to its prevention marker.
  // A nearby timestamp alone is never a binding.
  const rEv = [], rc = config.clauses.reviewed;
  const sharedTrusted = new Set(comments.filter(c => isTrustedMarkerAuthor({ ...c, viewerDidAuthor: false })));
  const producers = rc.trustedProducers ?? ['https://github.com/apps/plateau-reviewer', 'https://github.com/apps/plateau-merger'];
  let unlistedReview = false;
  const independent = c => c.user?.login?.toLowerCase() !== pr.author.login.toLowerCase();
  const trusted = c => independent(c) && producers.includes(actorOf(c.user?.login ?? '').id)
    && (sharedTrusted.has(c)
      || (process.env.WE_AUTOMATION_LOGINS === undefined && process.env.WE_OPERATOR_LOGINS === undefined
        && ['plateau-reviewer[bot]', 'plateau-merger[bot]'].includes(c.user.login)));
  const marker = (c, name, length = 40) => new RegExp(`^<!-- ${name}: ([0-9a-f]{${length}}) -->$`, 'm').exec(c.body)?.[1];
  let accepted;
  for (const c of comments) {
    if (!producers.includes(actorOf(c.user?.login ?? '').id)
      && (/^✅ review — accepted/u.test(c.body) || /^📌 review — acceptance re-stamped/u.test(c.body))) unlistedReview = true;
    if (!trusted(c)) continue;
    if (/^(?:(?:🔁|❌|⛔|🚫) )?(?:human )?review — (?:rejected|changes requested|blocked)(?:\r?\n|$)/u.test(c.body)) {
      // Revocation invalidates the active acceptance and every carry derived from it.
      accepted = undefined; rEv.length = 0; continue;
    }
    if (c.user.login === 'plateau-reviewer[bot]' && /^✅ review — accepted/.test(c.body)) {
      accepted = undefined;
      rEv.length = 0;
      const ownSha = marker(c, 'reviewed-sha');
      const matches = comments.filter(d => trusted(d) && d.user.login === c.user.login
        && new RegExp(`^<!-- approval-prevention-filed:${ownSha} -->`).test(d.body)
        && Date.parse(d.created_at) >= Date.parse(c.created_at)
        && Date.parse(d.created_at) - Date.parse(c.created_at) < 5 * 60e3);
      const mark = ownSha && matches.length === 1 && matches[0];
      const sha = mark && ownSha;
      if (sha) {
        accepted = c;
        rEv.push({ kind: 'review-verdict', uri: c.html_url, digest: { gitCommit: sha }, provenanceTier: tierOf('review-verdict'), native: { producer: actorOf(c.user.login).id, actor: actorOf(c.user.login).id, at: c.created_at, commentId: c.id, bodySha256: sha256(c.body), shaSource: `approval-prevention-filed marker in comment ${mark.id}` } });
      }
    }
    const re = marker(c, 'reviewed-sha'), diff = marker(c, 'reviewed-diff', 64);
    // Historical restamps assert preservation; the fixture has no replayable diff proof.
    // Require the complete ceremony and an earlier active independent acceptance.
    if (re && accepted && Date.parse(accepted.created_at) < Date.parse(c.created_at)
      && /^📌 review — acceptance re-stamped after a rebase \(no new review\)/u.test(c.body)
      && c.body.includes(`head moved to ${re} by this drain's own content-preserving rebase`)
      && diff && marker(c, 'reviewed-contribution', 64)
      && marker(accepted, 'reviewed-diff', 64) && marker(accepted, 'reviewed-contribution', 64)) {
      rEv.push({ kind: 'review-restamp', uri: c.html_url, digest: { gitCommit: re }, provenanceTier: tierOf('review-restamp'), native: { producer: actorOf(c.user.login).id, actor: actorOf(c.user.login).id, at: c.created_at, commentId: c.id, bodySha256: sha256(c.body), reviewedDiff: diff } });
    }
  }
  const rOk = rEv.filter((e) => eligible(rc, e.kind));
  const reviewed = rOk.some((e) => e.digest.gitCommit === head) ? base('reviewed', { verdict: 'pass' })
    : !rOk.length && unlistedReview ? base('reviewed', { verdict: 'unknown', reason: 'unverifiable' })
    : rEv.length ? base('reviewed', { verdict: 'unknown', reason: 'stale', detail: `accepted review covers ${[...new Set(rOk.map((e) => e.digest.gitCommit.slice(0, 12)))]}, head is ${head.slice(0, 12)}` })
    : base('reviewed', { verdict: 'unknown', reason: !rOk.length && unlistedReview ? 'unverifiable' : 'missing' });
  reviewed.examined = { count: rEv.length, unit: 'review records', description: 'review-loop comments: accepted verdicts and re-stamps' }; reviewed.evidence = rEv;

  // approved: review:accepted label events by a listed approver, not the author, not removed before merge
  const ac = config.clauses.approved, aEv = [];
  const headAt = (t) => commits.filter((c) => Date.parse(c.commit.committer.date) <= Date.parse(t)).map((c) => c.sha).at(-1) ?? pr.commits[0].oid;
  for (const e of events.filter((x) => x.event === 'labeled' && x.label?.name === 'review:accepted' && ac.approvers.includes(actorOf(x.actor.login).id))) {
    const removed = events.some((x) => x.event === 'unlabeled' && x.label?.name === 'review:accepted' && Date.parse(x.created_at) > Date.parse(e.created_at) && Date.parse(x.created_at) <= Date.parse(at));
    aEv.push({ kind: 'approval-label', uri: `${pr.url}#event-${e.id}`, digest: { gitCommit: headAt(e.created_at) }, provenanceTier: tierOf('approval-label'), native: { producer: actorOf(e.actor.login).id, actor: actorOf(e.actor.login).id, label: e.label.name, at: e.created_at, eventId: e.id, presentAtMerge: !removed } });
  }
  const aTrusted = aEv.filter(e => producerAllowed(ac, e.native.producer, ac.approvers));
  const aOk = aTrusted.filter((e) => eligible(ac, e.kind) && e.native.presentAtMerge && ac.approvers.includes(e.native.actor) && (!ac.separationOfDuties || e.native.actor !== author.id));
  const approved = aOk.length ? base('approved', { verdict: 'pass' }) : aTrusted.some(e => eligible(ac, e.kind)) ? base('approved', { verdict: 'fail', detail: 'review:accepted not by a listed approver other than the author, or removed before merge' }) : base('approved', { verdict: 'unknown', reason: aEv.length && !aTrusted.length ? 'unverifiable' : 'missing' });
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
