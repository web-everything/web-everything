/** Pure port of ship/change-evidence v0.1 tools/build-fixture.mjs build().
 * Comments use their latest edit; checks use completion time, then run id, on the landed SHA.
 * No IO and no gate decisions: missing evidence is an explicit unknown verdict.
 */
import { createHash } from 'node:crypto';
import { isTrustedMarkerAuthor } from '../marker-authorship.mjs';
import { requiredChecksFromRules, requiredChecksFromBranch } from '../required-status-checks.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TIER = { asserted: 0, replayed: 1, probe: 2 };
const EVALUATOR = 'https://everstandards.dev/ship/tools/change-evidence-build';
const actorOf = (actor, app) => {
  const login = actor?.login;
  const canonical = String(login ?? '').trim().toLowerCase();
  if (!canonical) return { kind: 'unknown' };
  const bot = actor.type === 'Bot' || actor.is_bot === true || (app?.id && app?.slug);
  if (bot) {
    const slug = String(app?.slug ?? canonical.replace(/^app\//, '').replace(/\[bot\]$/, '')).trim().toLowerCase();
    return { id: `https://github.com/apps/${slug}`, kind: 'bot', native: login };
  }
  return { id: `https://github.com/${canonical}`, kind: 'person', native: login };
};
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
  branchRules, branchProtection, config, configBytes, recordedAt: AT, recorder: BUILDER }) {
  const mergeSha = pr.mergeCommit.oid;
  if (!/^[0-9a-f]{40}$/.test(mergeSha) || mc.sha !== mergeSha || !mc.commit?.tree?.sha || !mc.parents?.[0]?.sha)
    throw Error('forge did not verify the landed commit');
  if (JSON.stringify(JSON.parse(String(configBytes))) !== JSON.stringify(config)) throw Error('policy bytes differ from config');
  // A checked-in snapshot cannot assert which checks the protected branch requires today.
  const rules = Array.isArray(branchRules) && branchRules.filter(r => r?.type === 'required_status_checks');
  const ruleChecks = rules && rules.flatMap(r => Array.isArray(r.parameters?.required_status_checks)
    ? r.parameters.required_status_checks : [null]);
  const classic = branchProtection?.protection?.enabled === false ? null : branchProtection?.protection?.required_status_checks;
  if (classic != null && (typeof classic !== 'object' || Array.isArray(classic)
    || (!Array.isArray(classic.contexts) && !Array.isArray(classic.checks))
    || (classic.contexts !== undefined && !Array.isArray(classic.contexts))
    || (classic.checks !== undefined && !Array.isArray(classic.checks)))) throw Error('unreadable classic branch protection');
  let liveNames;
  try { liveNames = [...new Set([...requiredChecksFromRules(branchRules), ...requiredChecksFromBranch(branchProtection)])]; }
  catch (error) { throw Error(`unreadable branch protection: ${error.message}`); }
  const checks = ruleChecks && [...ruleChecks,
    ...(classic?.contexts ?? []).map(context => ({ context })),
    ...(classic?.checks ?? []).map(c => c && ({ context: c.context, integration_id: c.app_id }))];
  const snapshot = config.clauses.tested.requiredChecks;
  if (!checks?.length || checks.some(c => !c || typeof c.context !== 'string' || !c.context.trim()
    || (c.integration_id != null && (!Number.isSafeInteger(c.integration_id) || c.integration_id < 1)))
    || !Array.isArray(snapshot) || !snapshot.length || snapshot.some(name => typeof name !== 'string' || !name.trim())
    || new Set(snapshot).size !== snapshot.length
    || JSON.stringify(liveNames.sort()) !== JSON.stringify([...snapshot].sort()))
    throw Error('required-check snapshot differs from or lacks readable branch protection; refresh the policy before retrying');
  const cfgDigest = { sha256: sha256(configBytes) };
  const REPO = pr.url.split('/pull/')[0];
  const policy = { uri: `${config.id}#merge-policy`, digest: cfgDigest };
  const author = actorOf(pr.author), head = pr.headRefOid, at = pr.mergedAt;
  const base = (kind, ev) => ({ policy, evaluatedAt: AT, evaluator: EVALUATOR, ...ev });
  const tierOf = (k) => config.tiers[k];
  const producerAllowed = (clause, producer, defaults = []) => (clause.trustedProducers ?? defaults).includes(producer);
  const eligible = (clause, kind) => clause.acceptKinds.includes(kind)
    && Object.hasOwn(TIER, clause.minTier) && Object.hasOwn(TIER, tierOf(kind))
    && TIER[tierOf(kind)] >= TIER[clause.minTier];
  const beforeMerge = t => Number.isFinite(Date.parse(t)) && Date.parse(t) <= Date.parse(at);
  // Backfill must evaluate the merge-time snapshot, including comment edits.
  events = events.filter(e => beforeMerge(e.created_at));
  const commentTime = c => c.updated_at ?? c.created_at;
  const latestComments = new Map();
  const ambiguousComments = new Set();
  for (const c of comments) {
    const prior = latestComments.get(c.id);
    // An unreadable edit time cannot safely revive a dated version.
    if (!prior || !Number.isFinite(Date.parse(commentTime(c)))
      || Date.parse(commentTime(c)) > Date.parse(commentTime(prior))) {
      latestComments.set(c.id, c); ambiguousComments.delete(c.id);
    } else if (Date.parse(commentTime(c)) === Date.parse(commentTime(prior)) && c.body !== prior.body) {
      ambiguousComments.add(c.id);
    }
  }
  const allComments = [...latestComments.values()];
  comments = allComments.filter(c => !ambiguousComments.has(c.id) && beforeMerge(c.created_at) && beforeMerge(commentTime(c)))
    .sort((a, b) => Date.parse(commentTime(a)) - Date.parse(commentTime(b)) || a.id - b.id);


  // tested: the ruleset's required checks, on the commit that landed (merge-queue run)
  const tc = config.clauses.tested, tEv = [], missing = [], bad = [], off = [], unlisted = [];
  for (const name of tc.requiredChecks) {
    const candidates = runs.filter(x => x.name === name && beforeMerge(x.completed_at));
    const allowed = x => producerAllowed(tc, checkProducer(x), ['https://github.com/apps/github-actions'])
      && checks.filter(c => c.context === name).every(c => c.integration_id == null || c.integration_id === x.app?.id);
    if (candidates.some(x => checkProducer(x) && !allowed(x))) unlisted.push(name);
    const r = candidates.filter(x => allowed(x) && x.head_sha === mergeSha)
      .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at) || b.id - a.id)[0];
    if (!r && candidates.some(allowed)) { off.push(name); continue; }
    if (!r || r.status !== 'completed' || !eligible(tc, 'ci-check')) { missing.push(name); continue; }
    tEv.push({ kind: 'ci-check', uri: r.html_url, digest: { gitCommit: r.head_sha }, provenanceTier: tierOf('ci-check'), native: { producer: checkProducer(r), name, id: r.id, conclusion: r.conclusion, at: r.completed_at, app: r.app?.slug, appId: r.app?.id } });
    if (r.conclusion !== 'success') bad.push(`${name}=${r.conclusion}`);
  }
  const tested = bad.length ? base('tested', { verdict: 'fail', detail: bad.join(', ') }) : missing.length ? base('tested', { verdict: 'unknown', reason: !tEv.length && unlisted.length ? 'unverifiable' : 'missing', detail: `no run for ${missing}` }) : off.length ? base('tested', { verdict: 'unknown', reason: 'stale', detail: `ran on another commit: ${off}` }) : base('tested', { verdict: 'pass' });
  tested.examined = { count: tEv.length, unit: 'required checks', description: `required_status_checks of the main ruleset, latest completed run on ${mergeSha}` }; tested.evidence = tEv;

  // Legacy review comments bind the acceptance's own SHA to its prevention marker.
  // A nearby timestamp alone is never a binding.
  const rEv = [], rc = config.clauses.reviewed;
  const commentActor = c => actorOf(c.user, c.performed_via_github_app);
  const sharedTrusted = new Set(allComments.filter(c => {
    const actor = commentActor(c);
    const login = actor.kind === 'bot' ? `${actor.id.split('/').at(-1)}[bot]` : c.user?.login;
    if (!isTrustedMarkerAuthor({ user: { login }, viewerDidAuthor: false })) return false;
    return true;
  }));
  const producers = rc.trustedProducers ?? [];
  let unlistedReview = false;
  const independent = c => Boolean(commentActor(c).id) && commentActor(c).id !== author.id;
  const trustedProducer = c => producers.includes(commentActor(c).id) && sharedTrusted.has(c);
  const trusted = c => independent(c) && trustedProducer(c);
  const rejection = c => /^(?:(?:🔁|❌|⛔|🚫) )?(?:human )?review — (?:rejected|changes requested|blocked)(?:\r?\n|$)/u.test(c.body);
  // An unorderable rejection cannot be superseded safely, even by a dated acceptance.
  const undatedRejection = allComments.some(c => trustedProducer(c) && rejection(c)
    && (!Number.isFinite(Date.parse(c.created_at))
      || (c.updated_at != null && !Number.isFinite(Date.parse(c.updated_at)))));
  const marker = (c, name, length = 40) => new RegExp(`^<!-- ${name}: ([0-9a-f]{${length}}) -->$`, 'm').exec(c.body)?.[1];
  let accepted;
  for (const c of comments) {
    if (!producers.includes(commentActor(c).id)
      && (/^✅ review — accepted/u.test(c.body) || /^📌 review — acceptance re-stamped/u.test(c.body))) unlistedReview = true;
    if (!trusted(c)) continue;
    if (rejection(c)) {
      // Revocation invalidates the active acceptance and every carry derived from it.
      accepted = undefined; rEv.length = 0; continue;
    }
    if (/^✅ review — accepted/.test(c.body)) {
      accepted = undefined;
      rEv.length = 0;
      const ownSha = marker(c, 'reviewed-sha');
      const matches = comments.filter(d => trusted(d) && commentActor(d).id === commentActor(c).id
        && new RegExp(`^<!-- approval-prevention-filed:${ownSha} -->`).test(d.body)
        && Date.parse(commentTime(d)) >= Date.parse(commentTime(c))
        && Date.parse(commentTime(d)) - Date.parse(commentTime(c)) < 5 * 60e3);
      const mark = ownSha && matches.length === 1 && matches[0];
      const sha = mark && ownSha;
      if (sha) {
        accepted = c;
        rEv.push({ kind: 'review-verdict', uri: c.html_url, digest: { gitCommit: sha }, provenanceTier: tierOf('review-verdict'), native: { producer: commentActor(c).id, actor: commentActor(c).id, at: commentTime(c), commentId: c.id, bodySha256: sha256(c.body), shaSource: `approval-prevention-filed marker in comment ${mark.id}` } });
      }
    }
    const re = marker(c, 'reviewed-sha'), diff = marker(c, 'reviewed-diff', 64);
    // Historical restamps assert preservation; the fixture has no replayable diff proof.
    // Require the complete ceremony and an earlier active independent acceptance.
    if (re && accepted && Date.parse(commentTime(accepted)) < Date.parse(commentTime(c))
      && /^📌 review — acceptance re-stamped after a rebase \(no new review\)/u.test(c.body)
      && c.body.includes(`head moved to ${re} by this drain's own content-preserving rebase`)
      && diff && marker(c, 'reviewed-contribution', 64)
      && diff === marker(accepted, 'reviewed-diff', 64)
      && marker(c, 'reviewed-contribution', 64) === marker(accepted, 'reviewed-contribution', 64)) {
      rEv.push({ kind: 'review-restamp', uri: c.html_url, digest: { gitCommit: re }, provenanceTier: tierOf('review-restamp'), native: { producer: commentActor(c).id, actor: commentActor(c).id, at: commentTime(c), commentId: c.id, bodySha256: sha256(c.body), reviewedDiff: diff } });
    }
  }
  const rOk = rEv.filter((e) => eligible(rc, e.kind));
  const reviewed = undatedRejection ? base('reviewed', { verdict: 'fail', detail: 'trusted rejection has an unreadable timestamp; acceptance cannot supersede it' })
    : rOk.some((e) => e.digest.gitCommit === head) ? base('reviewed', { verdict: 'pass' })
    : !rOk.length && unlistedReview ? base('reviewed', { verdict: 'unknown', reason: 'unverifiable' })
    : rEv.length ? base('reviewed', { verdict: 'unknown', reason: 'stale', detail: `accepted review covers ${[...new Set(rOk.map((e) => e.digest.gitCommit.slice(0, 12)))]}, head is ${head.slice(0, 12)}` })
    : base('reviewed', { verdict: 'unknown', reason: !rOk.length && unlistedReview ? 'unverifiable' : 'missing' });
  reviewed.examined = { count: rEv.length, unit: 'review records', description: 'review-loop comments: accepted verdicts and re-stamps' }; reviewed.evidence = rEv;

  // approved: review:accepted label events by a listed approver, not the author, not removed before merge
  const ac = config.clauses.approved, aEv = [];
  const headAt = (t) => commits.filter((c) => Date.parse(c.commit.committer.date) <= Date.parse(t)).map((c) => c.sha).at(-1) ?? pr.commits[0].oid;
  for (const e of events.filter((x) => x.event === 'labeled' && x.label?.name === 'review:accepted' && ac.approvers.includes(actorOf(x.actor).id))) {
    const removed = events.some((x) => x.event === 'unlabeled' && x.label?.name === 'review:accepted' && Date.parse(x.created_at) > Date.parse(e.created_at) && Date.parse(x.created_at) <= Date.parse(at));
    aEv.push({ kind: 'approval-label', uri: `${pr.url}#event-${e.id}`, digest: { gitCommit: headAt(e.created_at) }, provenanceTier: tierOf('approval-label'), native: { producer: actorOf(e.actor).id, actor: actorOf(e.actor).id, label: e.label.name, at: e.created_at, eventId: e.id, presentAtMerge: !removed } });
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
        merged: { at, by: actorOf(pr.mergedBy), method: events.slice(0, events.findIndex(e => e.event === 'merged' && e.commit_id === mergeSha) + 1).filter(e => ['added_to_merge_queue', 'removed_from_merge_queue'].includes(e.event)).at(-1)?.event === 'added_to_merge_queue' ? 'merge-queue' : 'merge', ref: `refs/heads/${pr.baseRefName}`, digest: { gitCommit: mergeSha } },
      },
      governance: { org: config.org, config: config.id, version: config.version, digest: cfgDigest, ...(config.sources ? { sources: config.sources.map(({ uri, digest }) => ({ uri, digest })) } : {}) },
      verdict: overall, clauses, ...(ai.length ? { aiProvenance: ai } : {}),
    },
  };

  return rec;
}
