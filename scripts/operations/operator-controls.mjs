/** Operator decision 2026-10-13. Pure plans; all mutations are bound in operator-controls-io. */
import { createHash } from 'node:crypto';
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { OPERATOR_LOGINS, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { planRoundExtension } from './extend-rounds.mjs';
import { countGrantedRoundExtensions } from '../conveyor/round-extension-mark.mjs';
import { decideRearm } from '../conveyor/rearm-review.mjs';
import { CONSTELLATION_REPOS, DEFAULT_REPO_KEY } from '../lib/constellation-repos.mjs';
import { previousCiFailurePending } from '../conveyor/await-verify.mjs';
import { AWAIT_VERIFY_LIMITS } from '../conveyor/await-verify-pass.mjs';
import { buildOperatorActionComment } from './operator-action-shape.mjs';

export const CONTROL_OPS = Object.freeze(['unpark', 'retry-prepare', 'rearm', 'refresh', 'grant-rounds', 'clear-claim', 'ci-heal-reset']);
export const MAX_OPERATOR_RESETS = 2;
export const OPERATOR_CONTROL_EFFECT = 'operator.control';
export function validateOperatorAttribution({ actor, channel, reason }) {
  if (typeof actor !== 'string' || !OPERATOR_LOGINS.includes(actor.toLowerCase())) throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this action is the operator's`);
  if (typeof reason !== 'string' || !reason.trim()) throw new Error("--reason is required: the operator's words, verbatim");
  if (typeof channel !== 'string' || !channel.trim() || /[\r\n\u2028\u2029]/.test(channel)) throw new Error('--channel is required and must be one line');
  return { actor: actor.toLowerCase(), channel: channel.trim(), reason };
}
// The renderer lives in the leaf module so the carry-forward reader can re-render and compare a note (no import cycle).
export { buildOperatorActionComment };
export function parseOperatorActions(comments = []) {
  return comments.filter(isTrustedMarkerAuthor).flatMap(c => String(c.body ?? '').split(/\r\n|[\r\n\u2028\u2029]/).flatMap(line => {
    const m = /^<!-- operator-action: (.*?) -->$/.exec(line);
    if (!m) return [];
    try { const r = JSON.parse(m[1]); return r.version === 1 && CONTROL_OPS.includes(r.op) && typeof r.key === 'string' ? [r] : []; } catch { return []; }
  }));
}
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const stateDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const isPrepareHold = h => ['prepare-unstamped', 'prepare-stamp-pending'].includes(h.reason ?? h.meta?.reason);
export function controlFingerprint(name, read, input) {
  if (input.item) return stateDigest({ holds: read.holds ?? [], failures: read.failures ?? [] });
  if (name === 'clear-claim') return stateDigest(read.claims ?? []);
  if (name === 'ci-heal-reset') return stateDigest({ head: read.head, awaitVerify: read.awaitVerify });
  return stateDigest({ head: read.head, state: read.state, labels: [...(read.labels ?? [])].sort(),
    ...(name === 'refresh' ? { main: read.main, containsMain: read.containsMain, crossRepo: read.crossRepo, headRef: read.headRef, requiredCheck: read.requiredCheck } : {}),
    ...(name === 'grant-rounds' ? { granted: countGrantedRoundExtensions(read.comments, input) } : {}) });
}
export function validateControlInput(name, input) {
  validateOperatorAttribution(input);
  if (!CONTROL_OPS.includes(name)) throw new Error('unknown operator control');
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo ?? '')) throw new Error('--repo must be <owner/repo>');
  const pr = input.pr ?? 0, item = input.item ?? '', file = input.file ?? '';
  if (!Number.isSafeInteger(pr) || pr < 0 || typeof item !== 'string' || typeof file !== 'string') throw new Error('invalid target');
  if (Number(pr > 0) + Number(Boolean(item)) + Number(Boolean(file)) !== 1) throw new Error('give exactly one target: --pr, --item or --file');
  if (item && (!['unpark', 'retry-prepare'].includes(name) || !/^[1-9]\d*$/.test(item))) throw new Error('--item must be a positive numeric card id for unpark or retry-prepare');
  if (item && input.repo !== CONSTELLATION_REPOS.we.slug) throw new Error(`item controls support only the ${CONSTELLATION_REPOS.we.slug} repository`);
  if (name === 'retry-prepare' && !item) throw new Error('retry-prepare requires --item');
  if (file && (name !== 'clear-claim' || file.startsWith('/') || file.split('/').includes('..') || /[\r\n]/.test(file))) throw new Error('--file must be a repo path for clear-claim');
  if (name === 'grant-rounds' && !['fix', 'review'].includes(input.kind ?? 'fix')) throw new Error('--kind must be fix or review');
  if (name === 'clear-claim' && !['fix', 'ci-heal'].includes(input.kind ?? 'fix')) throw new Error('--kind must be fix or ci-heal');
  if (name === 'ci-heal-reset' && (!pr || typeof input.head !== 'string' || !/^[a-f\d]{7,40}$(?![\s\S])/i.test(input.head))) throw new Error('ci-heal-reset requires --pr and --head (7–40 hexadecimal characters)');
}
export function planOperatorControl(name, read, input) {
  validateControlInput(name, input);
  const attribution = validateOperatorAttribution(input), target = input.item ? `item:${input.item}` : input.file ? `file:${input.file}` : `pr:${input.pr}`;
  let why = '', steps = [], undo = '', extension, resets;
  if (name === 'unpark') {
    undo = input.item ? 'the daemon re-parks on the next failure; to re-hold now: placeBuildDispatchHold' : 'restore review:human through the review ceremony';
    if (input.item) {
      if ((read.holds ?? []).some(isPrepareHold)) throw new Error('prepare hold: use retry-prepare');
      if (!read.holds?.length && !read.failures?.length) why = 'no builder hold or failure record';
      if (read.holds?.length) steps.push(`releaseBuildDispatchHold({repo:we, num:${input.item}})`);
      if (read.failures?.length) steps.push(`clearBuildFailure(${input.item})`);
    } else if (!read.labels?.includes('review:human')) why = 'PR has no review:human';
    else if (read.state !== 'OPEN') throw new Error('the PR must be open to unpark');
    else steps.push(`review-set-label.mjs ${input.pr} --to=clear-human with actor, channel and verbatim reason (its ceremony refusals still apply)`);
  } else if (name === 'retry-prepare') {
    undo = 'the daemon re-holds on the next prepare failure; to re-hold now: placeBuildDispatchHold with the previous prepare reason';
    if (!read.failures?.some(f => f.held && !f.completed) && !read.holds?.some(isPrepareHold)) why = 'no held uncompleted prepare failure or prepare hold';
    if (read.failures?.some(f => f.held && !f.completed)) steps.push('set held:false, retry:true on this item’s held uncompleted prepare records via the prepare ledger atomic save path');
    if (read.holds?.some(isPrepareHold)) steps.push(`release prepare hold for we item ${input.item}`);
  } else if (name === 'rearm') {
    undo = 'request changes again through review-set-label.mjs --to=changes';
    const decision = decideRearm({ currentLabels: read.labels });
    if (read.state !== 'OPEN') why = 'PR is not open';
    else if (!decision.allowed) why = decision.reason;
    else steps.push(`rearm-review.mjs ${input.pr} --actor=${attribution.actor}; add ${decision.addLabel || 'no label'}; remove ${(decision.removeLabels ?? []).filter(label => read.labels.includes(label)).join(', ') || 'no labels'}; keep the human hold`);
  } else if (name === 'refresh') {
    undo = 'restore the previous head only through a reviewed content-preserving git repair';
    if (read.crossRepo) throw new Error('refresh refuses cross-repo heads');
    if (read.state !== 'OPEN' || read.containsMain) why = read.state !== 'OPEN' ? 'PR is not open' : 'PR head already contains remote main';
    else steps.push(`refreshOntoMain(${read.headRef}) in ${input.checkout || 'the script repo root'}; recordRefreshed(${input.repo}#${input.pr}, newHead)`);
  } else if (name === 'grant-rounds') {
    undo = 'round grants are append-only; there is no supported revocation';
    extension = planRoundExtension({ ...read, now: read.now }, { ...input, by: input.n ?? 1 });
    steps.push(`post verified round extension +${input.n ?? 1} via github.round-extension; kind=${input.kind ?? 'fix'} (raises every cap today)`);
  } else if (name === 'ci-heal-reset') {
    const full = sha => typeof sha === 'string' && /^[a-f\d]{40}$(?![\s\S])/i.test(sha);
    const matches = sha => full(sha) && sha.toLowerCase().startsWith(input.head.toLowerCase());
    const liveHead = String(read.head ?? '').toLowerCase();
    const lower = sha => String(sha ?? '').toLowerCase();
    if (!full(read.head)) throw new Error('head moved: state changed since the exhausted record');
    if (!Array.isArray(read.awaitVerify)) throw new Error('await-verify records unavailable');
    const rows = read.awaitVerify.filter(({ record }) => record.repo === input.repo && record.pr === input.pr);
    // An unpushed repair: the record names the withheld repair sha while the remote still holds the head it was based on
    // (previousCi.headSha, pinned by the harness). Only that recorded pair is accepted; any other head move still refuses.
    const unpushedRepair = record => full(record.sha) && lower(record.previousCi?.headSha) === liveHead && lower(record.sha) !== liveHead
      && !(record.earlyPush?.ok && lower(record.earlyPush.sha) === lower(record.sha));
    const matching = rows.filter(({ record }) => (lower(record.sha) === liveHead && matches(read.head)) || (unpushedRepair(record) && (matches(read.head) || matches(record.sha))));
    if (rows.length && !matching.length) throw new Error('head moved: state changed since the exhausted record');
    resets = matching.filter(({ record }) => previousCiFailurePending(record) && Number.isSafeInteger(record.resumeFailures) && record.resumeFailures >= AWAIT_VERIFY_LIMITS.maxResumeFailures);
    if (matching.some(({ record }) => record.operatorResets !== undefined && !(Number.isSafeInteger(record.operatorResets) && record.operatorResets >= 0))) throw new Error('invalid operatorResets counter; escalate');
    if (matching.some(({ record }) => (record.operatorResets ?? 0) >= MAX_OPERATOR_RESETS)) throw new Error(`ci-heal-reset limit reached (${MAX_OPERATOR_RESETS} per pr@head); escalate for a human repair instead of resetting again`);
    undo = 'restore each record’s previousResumeFailures through an operator-reviewed store repair; the normal resume failure cap still applies';
    if (!resets.length) why = 'no matching exhausted await-verify record';
    steps = resets.map(({ key }) => `writeStoredAwaitVerify(${key}) with resumeFailures:0; preserve every other field`);
  } else {
    undo = 'the next eligible daemon tick reacquires a claim; a released stale owner is not resurrected';
    if (!read.claims?.length) why = 'no matching fix claim';
    if (read.claims?.some(c => c.live !== false)) throw new Error('refusing LIVE or unknown-liveness claim');
    steps = (read.claims ?? []).map(c => `releaseFixDispatchClaim(${c.meta.repo}#${c.meta.pr}, kind=${c.meta.kind}, owner=${c.owner})`);
  }
  const fingerprint = controlFingerprint(name, read, input);
  // A key names one plan (pre-state + plan time), not a state: labels, holds and claims recur on the
  // same head, and a fresh action there must apply. Replaying the same payload keeps its key and dedupes.
  const planKey = digest => `${digest}@${read.now}`;
  const record = { version: 1, op: name, repo: input.repo, ...(input.pr ? { pr: input.pr } : {}), ...(input.item ? { item: input.item } : {}),
    ...attribution, at: read.now, key: `${name}:${input.repo}:${target}:${planKey(fingerprint)}`, details: { undo, ...(['grant-rounds', 'clear-claim'].includes(name) ? { kind: input.kind ?? 'fix' } : {}), ...(name === 'grant-rounds' ? { n: input.n ?? 1 } : {}), ...(name === 'refresh' ? { previousHead: read.head, headRef: read.headRef, main: read.main } : {}), ...(input.file ? { file: input.file } : {}) } };
  if (name === 'ci-heal-reset') record.details = { ...record.details, pr: input.pr, head: read.head,
    previousResumeFailures: resets[0]?.record.resumeFailures,
    records: resets.map(({ key, record: r }) => ({ key, head: r.sha, previousResumeFailures: r.resumeFailures })) };
  const records = name === 'clear-claim' ? (read.claims ?? []).map(c => ({ ...record, pr: c.meta.pr, key: `${name}:${input.repo}:pr:${c.meta.pr}:${planKey(stateDigest(c))}`, details: { ...record.details, kind: c.meta.kind } })) : [record];
  if (!why) steps.push(input.item ? 'append operator-action record to operator-actions.jsonl' : 'post one operator-action comment per PR target');
  return { op: name, target, action: why ? 'noop' : 'apply', ...(why ? { why } : {}), steps, undo, record, records,
    body: buildOperatorActionComment(record), fingerprint, input, claims: read.claims, extension, ...(resets ? { resets } : {}) };
}
export function operatorControlOperation(name, { readContext } = {}) {
  const optional = (type, value) => ({ type, required: false, default: value });
  const input = { repo: optional('string', CONSTELLATION_REPOS[DEFAULT_REPO_KEY].slug), pr: optional('number', 0),
    actor: 'string', channel: 'string', reason: 'string', preview: optional('boolean', false) };
  if (['unpark', 'retry-prepare'].includes(name)) input.item = optional('string', '');
  if (name === 'clear-claim') input.file = optional('string', '');
  if (name === 'ci-heal-reset') { input.pr = 'number'; input.head = 'string'; }
  if (['grant-rounds', 'clear-claim'].includes(name)) input.kind = { ...optional('string', 'fix'), enum: name === 'grant-rounds' ? ['fix', 'review'] : ['fix', 'ci-heal'] };
  if (name === 'grant-rounds') input.n = optional('number', 1);
  if (name === 'refresh') input.checkout = optional('string', '');
  const reads = Object.keys(input).map(k => `input.${k}`);
  return op(name, { input, verdictFrom: 'plan',
    read: compute({ reads, fn: ({ input }) => { validateControlInput(name, input); return readContext(name, input); } }),
    plan: compute({ reads: ['findings.read', ...reads], fn: ({ findings, input }) => planOperatorControl(name, findings.read, input) }),
    write: effect({ reads: ['verdict', 'input.preview'], effects: ({ input, verdict }) => input.preview || verdict.action === 'noop' ? [] : [{ type: OPERATOR_CONTROL_EFFECT, payload: verdict, idempotent: true }] }),
  });
}

export function finishOperatorControl({ run, code, lines, json }) {
  return { code, lines: json || !run?.verdict ? lines : [...lines, JSON.stringify(run.verdict, null, 2)] };
}
